import type { DB } from './connection.js';
import { dateKey, normalizeTransactions, type NormalizedTransaction, type ScrapedAccount } from '../ingest/normalize.js';
import { maskLast4 } from '../util.js';

export interface SaveResult {
  insertedIds: number[];
  updated: number;
}

/**
 * Store one scraped account: upsert the account, record its balance and insert/update
 * its transactions. Derived fields (category, kind) are never overwritten here — only data that comes from the bank.
 */
export function saveScrapedAccount(db: DB, companyId: string, account: ScrapedAccount): SaveResult & { accountId: string } {
  const accountId = `${companyId}:${account.accountNumber}`;

  db.prepare(`
    INSERT INTO accounts (id, company, kind, display_name, card_frame, currency, is_savings, last_scraped_at)
    VALUES (@id, @company, @kind, @displayName, @cardFrame, @currency, @isSavings, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      card_frame = COALESCE(excluded.card_frame, accounts.card_frame),
      currency = excluded.currency,
      is_savings = MAX(accounts.is_savings, excluded.is_savings),
      last_scraped_at = CURRENT_TIMESTAMP,
      active = 1
  `).run({
    id: accountId,
    company: companyId,
    kind: BANK_COMPANIES.has(companyId) ? 'bank' : 'card',
    displayName: friendlyAccountName(accountId),
    cardFrame: account.cardFrame ?? null,
    currency: account.currency ?? 'ILS',
    isSavings: account.savingsAccount ? 1 : 0,
  });

  const balance = account.balance
    ?? (account as { info?: { futureChargesTotal?: number } }).info?.futureChargesTotal ?? 0;
  db.prepare(`INSERT INTO balances (account_id, balance) VALUES (?, ?)`).run(accountId, balance);

  const result = saveTransactions(db, normalizeTransactions(accountId, account.txns ?? []));
  return { accountId, ...result };
}

export function saveTransactions(db: DB, txns: NormalizedTransaction[]): SaveResult {
  const byIdentifier = db.prepare(`SELECT id FROM transactions WHERE identifier = ?`).pluck();
  const legacyMatch = db.prepare(
    `SELECT id FROM transactions WHERE identifier = ? AND bank_identifier IS NULL`
  ).pluck();
  // A pending row that has since completed (completed rows get a reference and a charged amount)
  const pendingMatch = db.prepare(`
    SELECT id FROM transactions
    WHERE account_id = ? AND substr(date, 1, 10) = ? AND description = ? AND original_amount = ?
      AND (status = 'pending' OR (status IS NULL AND charged_amount = 0)) AND identifier != ?
    LIMIT 1
  `).pluck();

  // Same transaction, different reference: some banks (Hapoalim) renumber the reference between scrapes.
  // Candidates are matched one-to-one, so two identical coffees on the same day stay two rows.
  const sameRow = db.prepare(`
    SELECT id, identifier FROM transactions
    WHERE account_id = ? AND substr(date, 1, 10) = ? AND description = ? AND charged_amount = ?
      AND COALESCE(installment_number, 0) = ?
    ORDER BY id
  `);

  const updateBankFields = db.prepare(`
    UPDATE transactions SET
      identifier = @identifier, date = @date, processed_date = @processedDate, memo = @memo,
      charged_amount = @chargedAmount, charged_currency = @chargedCurrency, status = @status,
      txn_type = @txnType, installment_number = @installmentNumber,
      installment_total = @installmentTotal, bank_identifier = @bankIdentifier,
      source_category = COALESCE(@sourceCategory, source_category),
      raw_json = COALESCE(@rawJson, raw_json), updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  const insert = db.prepare(`
    INSERT INTO transactions (identifier, account_id, date, processed_date, description, memo,
      original_amount, original_currency, charged_amount, charged_currency, status, txn_type,
      installment_number, installment_total, bank_identifier, source_category, raw_json)
    VALUES (@identifier, @accountId, @date, @processedDate, @description, @memo,
      @originalAmount, @originalCurrency, @chargedAmount, @chargedCurrency, @status, @txnType,
      @installmentNumber, @installmentTotal, @bankIdentifier, @sourceCategory, @rawJson)
  `);

  const insertedIds: number[] = [];
  let updated = 0;

  const incoming = new Set(txns.map(t => t.identifier));
  const claimed = new Set<number>();
  const fuzzyMatch = (t: NormalizedTransaction): number | undefined => {
    const rows = sameRow.all(t.accountId, dateKey(t.date), t.description, t.chargedAmount, t.installmentNumber ?? 0) as { id: number; identifier: string }[];
    // skip rows another incoming transaction will match by its own identifier
    return rows.find(r => !claimed.has(r.id) && !incoming.has(r.identifier))?.id;
  };

  db.transaction(() => {
    for (const t of txns) {
      const existingId =
        (byIdentifier.get(t.identifier) as number | undefined) ??
        // rows saved before the migration carry the legacy identifier and no bank reference
        (t.bankIdentifier ? legacyMatch.get(t.legacyIdentifier) as number | undefined : undefined) ??
        (t.status !== 'pending' && t.chargedAmount !== 0
          ? pendingMatch.get(t.accountId, dateKey(t.date), t.description, t.originalAmount, t.identifier) as number | undefined
          : undefined) ??
        fuzzyMatch(t);
      if (existingId != null) claimed.add(existingId);

      if (existingId != null) {
        updateBankFields.run({ ...t, id: existingId });
        updated++;
      } else {
        const id = Number(insert.run(t).lastInsertRowid);
        claimed.add(id);
        insertedIds.push(id);
      }
    }
  })();

  return { insertedIds, updated };
}

/** One bank / investment source's outcome in a run. `asOf` = the source's own data time. */
/** source_runs.error prefix of a run that stopped because the bank asked for an SMS code no one could answer */
export const NEEDS_CODE = 'NEEDS_CODE';
/** source_runs.error prefix of an unattended run that skipped a card company because its last login was refused */
export const NEEDS_ATTENTION = 'NEEDS_ATTENTION';

export function recordSourceRun(db: DB, run: { source: string; startedAt: string; ok: boolean; error?: string | null; asOf?: string | null }): void {
  inFlight.delete(`${run.source}|${run.startedAt}`);
  db.prepare(`INSERT INTO source_runs (source, started_at, ok, error, as_of) VALUES (?, ?, ?, ?, ?)`)
    .run(run.source, run.startedAt, run.ok ? 1 : 0, run.error ?? null, run.asOf ?? null);
}

/**
 * Runs that started and have no outcome yet. A run cut short — the process exits or is stopped (Ctrl+C, a `tsx watch`
 * restart during a dashboard refresh) — is recorded as failed instead of leaving no trace in source_runs.
 */
const inFlight = new Map<string, { db: DB; source: string; startedAt: string }>();
let hooked = false;

export function beginSourceRun(db: DB, source: string, startedAt: string): void {
  inFlight.set(`${source}|${startedAt}`, { db, source, startedAt });
  if (hooked) return;
  hooked = true;
  process.on('exit', () => recordInterruptedRuns('interrupted: the process exited mid-run'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      recordInterruptedRuns(`interrupted (${signal})`);
      process.kill(process.pid, signal); // the default behaviour, now that this listener is gone
    });
  }
}

/** Record every run still in flight as failed with `reason`. */
export function recordInterruptedRuns(reason: string): void {
  for (const run of [...inFlight.values()]) {
    try {
      recordSourceRun(run.db, { source: run.source, startedAt: run.startedAt, ok: false, error: reason });
    } catch {
      inFlight.delete(`${run.source}|${run.startedAt}`); // the database is already closed
    }
  }
}

/** israeli-bank-scrapers company ids that are bank accounts (the rest are credit cards). */
export const BANK_COMPANIES = new Set([
  'hapoalim', 'leumi', 'discount', 'mercantile', 'mizrahi', 'otsarHahayal', 'union',
  'beinleumi', 'massad', 'yahav', 'oneZero', 'pagi',
]);

/** Display names of the scraped companies and the investment sources. */
export const SOURCE_NAMES: Record<string, string> = {
  hapoalim: 'Hapoalim', leumi: 'Leumi', discount: 'Discount', mizrahi: 'Mizrahi Tefahot', mercantile: 'Mercantile',
  otsarHahayal: 'Otsar Hahayal', union: 'Union', beinleumi: 'Beinleumi', massad: 'Massad', yahav: 'Yahav', oneZero: 'One Zero',
  pagi: 'Pagi', visaCal: 'Cal', isracard: 'Isracard', amex: 'American Express', max: 'Max', beyahadBishvilha: 'Beyahad Bishvilha',
  behatsdaa: 'Behatsdaa', ibkr: 'IBKR', binance: 'Binance', kraken: 'Kraken', wallets: 'Wallets',
};

/** "hapoalim:12-345-678901" → "Hapoalim ••8901" */
export function friendlyAccountName(accountId: string): string {
  const [company, number = ''] = accountId.split(':');
  const name = SOURCE_NAMES[company] ?? company;
  const deposit = number.match(/^(.*)-ID_(\d+)$/);
  if (deposit) return `${name} savings ${deposit[2]} ${maskLast4(deposit[1])}`;
  const fx = number.match(/^(.*)-([A-Z]{3})$/);
  if (fx) return `${name} ${fx[2]}`;
  const digits = number.replace(/\D/g, '');
  return `${name} ${digits ? maskLast4(digits) : number}`;
}
