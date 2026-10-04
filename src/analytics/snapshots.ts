import type { DB } from '../db/connection.js';
import { localDate } from '../ingest/normalize.js';
import { addDays, round, today } from '../util.js';
import { rateToIls } from './fx.js';
import { holdingValues } from './investments.js';

/** One source's outcome in a run: a bank / card company, or an investment source. */
export interface SourceOutcome {
  source: string;
  kind: 'bank' | 'investment';
  success: boolean;
}

export interface SnapshotResult {
  written: number;
  backfilled: number;
  /** what had no exchange rate and was left out (never valued 1:1) */
  flagged: string[];
}

interface Row { bucket: string; value: number; asOf: string | null }

/** `balances.timestamp` (SQLite UTC "YYYY-MM-DD HH:MM:SS") → ISO. */
const sqliteToIso = (ts: string | null) => (ts ? `${ts.replace(' ', 'T')}${ts.endsWith('Z') ? '' : 'Z'}` : null);

/**
 * Today's value of a bank / card company: its bank accounts' latest balances (Bank) and its cards' charges not yet
 * billed (Cards owed, negative). A card balance never counts as Bank.
 */
function bankRows(db: DB, company: string, date: string, flagged: string[]): Row[] {
  const accounts = db.prepare(`
    SELECT a.id, a.kind, COALESCE(a.currency, 'ILS') AS currency, b.balance, b.timestamp
    FROM accounts a LEFT JOIN balances b ON b.id = (SELECT MAX(id) FROM balances WHERE account_id = a.id)
    WHERE COALESCE(a.source, a.company) = ? AND a.active = 1
  `).all(company) as { id: string; kind: string; currency: string; balance: number | null; timestamp: string | null }[];
  const rows: Row[] = [];

  const banks = accounts.filter(a => a.kind === 'bank' && a.balance != null);
  if (banks.length) {
    let value = 0;
    for (const a of banks) {
      const rate = rateToIls(db, a.currency, date);
      if (rate == null) { flagged.push(`${a.id} (${a.currency})`); continue; }
      value += a.balance! * rate;
    }
    const asOf = banks.map(a => sqliteToIso(a.timestamp)).filter(Boolean).sort().at(-1) ?? null;
    rows.push({ bucket: 'bank', value, asOf });
  }

  const cards = accounts.filter(a => a.kind === 'card');
  if (cards.length) {
    const charges = db.prepare(`
      SELECT processed_date, charged_amount, COALESCE(charged_currency, 'ILS') AS currency FROM transactions
      WHERE account_id IN (SELECT value FROM json_each(?)) AND processed_date IS NOT NULL
    `).all(JSON.stringify(cards.map(c => c.id))) as { processed_date: string; charged_amount: number; currency: string }[];
    let owed = 0;
    for (const c of charges) {
      if (localDate(c.processed_date) <= date) continue;
      const rate = rateToIls(db, c.currency, date);
      if (rate == null) { flagged.push(`${company} card charges (${c.currency})`); continue; }
      owed += c.charged_amount * rate;
    }
    const asOf = cards.map(a => sqliteToIso(a.timestamp)).filter(Boolean).sort().at(-1) ?? null;
    rows.push({ bucket: 'cards_owed', value: owed, asOf });
  }
  return rows;
}

/** Today's value of an investment source per asset class, after the quote refresh. */
function investmentRows(db: DB, source: string, date: string, flagged: string[]): Row[] {
  const asOf = db.prepare(`SELECT as_of FROM source_runs WHERE source = ? AND ok = 1 ORDER BY id DESC LIMIT 1`).pluck().get(source) as string | null;
  const byClass = new Map<string, number>();
  for (const h of holdingValues(db, date, source)) {
    if (h.valueIls == null) { flagged.push(`${source}:${h.symbol} (${h.currency})`); continue; }
    byClass.set(h.assetClass, (byClass.get(h.assetClass) ?? 0) + h.valueIls);
  }
  return [...byClass].map(([bucket, value]) => ({ bucket, value, asOf }));
}

/**
 * Write today's snapshot of every source that succeeded in this run (a failed source keeps its last snapshot — nothing
 * is carried forward and stamped as today), and backfill the bank history of the bank sources.
 */
export function writeSnapshots(db: DB, outcomes: SourceOutcome[], date = today()): SnapshotResult {
  const flagged: string[] = [];
  let written = 0, backfilled = 0;
  const clear = db.prepare(`DELETE FROM daily_snapshots WHERE date = ? AND source = ?`);
  const insert = db.prepare(`INSERT INTO daily_snapshots (date, source, bucket, value_ils, as_of) VALUES (?, ?, ?, ?, ?)`);

  for (const o of outcomes.filter(x => x.success)) {
    const rows = o.kind === 'bank' ? bankRows(db, o.source, date, flagged) : investmentRows(db, o.source, date, flagged);
    db.transaction(() => {
      clear.run(date, o.source);
      for (const r of rows) { insert.run(date, o.source, r.bucket, round(r.value), r.asOf); written++; }
    })();
    if (o.kind === 'bank') {
      writeAccountBalances(db, o.source, date, flagged);
      backfilled += backfillBankHistory(db, o.source, date, flagged);
      backfillAccountBalances(db, o.source, date, flagged);
    }
  }
  if (flagged.length) console.warn(`  no exchange rate, left out of the snapshot: ${flagged.join(', ')}`);
  return { written, backfilled, flagged };
}

/** End-of-day balances of one account in its own currency, by date (only the days its data covers). */
export function accountDailyBalances(db: DB, accountId: string, until: string): { balances: Map<string, number>; exact: boolean } {
  const raws = db.prepare(`SELECT raw_json FROM transactions WHERE account_id = ? AND raw_json LIKE '%runningBalance%'`)
    .pluck().all(accountId) as string[];
  const movements = raws.map(r => { try { return JSON.parse(r); } catch { return null; } })
    .filter(m => m && m.runningBalance != null && m.valueDate)
    .map(m => ({ day: String(m.valueDate).slice(0, 10), at: String(m.movementTimestamp ?? m.valueDate), balance: Number(m.runningBalance) }))
    .filter(m => Number.isFinite(m.balance))
    .sort((a, b) => (a.day === b.day ? a.at.localeCompare(b.at) : a.day.localeCompare(b.day)));

  const out = new Map<string, number>();
  if (movements.length) {
    // the balance after the day's last movement, carried over the days without one
    const endOfDay = new Map<string, number>();
    for (const m of movements) endOfDay.set(m.day, m.balance);
    let balance: number | undefined;
    for (let d = movements[0].day; d <= until; d = addDays(d, 1)) {
      if (endOfDay.has(d)) balance = endOfDay.get(d);
      if (balance != null) out.set(d, balance);
    }
    return { balances: out, exact: true };
  }

  // no running balances: walk back from the latest balance using only posted transactions dated on/before it
  const anchor = db.prepare(`SELECT balance, timestamp FROM balances WHERE account_id = ? ORDER BY id DESC LIMIT 1`).get(accountId) as
    { balance: number; timestamp: string } | undefined;
  if (!anchor) return { balances: out, exact: false };
  const anchorDay = localDate(sqliteToIso(anchor.timestamp)!);
  const txns = (db.prepare(`
    SELECT date, charged_amount FROM transactions WHERE account_id = ? AND COALESCE(status, 'completed') = 'completed'
  `).all(accountId) as { date: string; charged_amount: number }[])
    .map(t => ({ day: localDate(t.date), amount: t.charged_amount })).filter(t => t.day <= anchorDay);
  if (!txns.length) return { balances: out, exact: false };
  const byDay = new Map<string, number>();
  for (const t of txns) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.amount);
  const first = txns.map(t => t.day).sort()[0];
  let balance = anchor.balance;
  for (let d = anchorDay; d >= first; d = addDays(d, -1)) {
    if (d <= until) out.set(d, balance);
    balance -= byDay.get(d) ?? 0; // the balance at the end of the day before
  }
  return { balances: out, exact: false };
}

/**
 * Bank history of one company before today, from the movements' running balances (exact; they overwrite) or, without
 * them, reconstructed from the latest balance (only fills days that have no snapshot).
 */
export function backfillBankHistory(db: DB, company: string, date: string, flagged: string[] = []): number {
  const accounts = db.prepare(`SELECT id, COALESCE(currency, 'ILS') AS currency FROM accounts WHERE COALESCE(source, company) = ? AND kind = 'bank' AND active = 1`)
    .all(company) as { id: string; currency: string }[];
  const until = addDays(date, -1);
  const totals = new Map<string, { value: number; exact: boolean }>();
  for (const a of accounts) {
    const { balances, exact } = accountDailyBalances(db, a.id, until);
    for (const [d, balance] of balances) {
      const rate = rateToIls(db, a.currency, d);
      if (rate == null) { flagged.push(`${a.id} on ${d} (${a.currency})`); continue; }
      const t = totals.get(d) ?? { value: 0, exact: true };
      totals.set(d, { value: t.value + balance * rate, exact: t.exact && exact });
    }
  }
  const upsert = db.prepare(`INSERT INTO daily_snapshots (date, source, bucket, value_ils, as_of) VALUES (?, ?, 'bank', ?, ?)
    ON CONFLICT(date, source, bucket) DO UPDATE SET value_ils = excluded.value_ils, as_of = excluded.as_of`);
  const fill = db.prepare(`INSERT OR IGNORE INTO daily_snapshots (date, source, bucket, value_ils, as_of) VALUES (?, ?, 'bank', ?, ?)`);
  let n = 0;
  db.transaction(() => {
    for (const [d, t] of totals) n += (t.exact ? upsert : fill).run(d, company, round(t.value), d).changes;
  })();
  return n;
}

const upsertAccountDay = (db: DB) => db.prepare(`INSERT INTO account_balance_daily (date, account_id, balance, currency, value_ils, as_of)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date, account_id) DO UPDATE SET balance = excluded.balance, currency = excluded.currency,
  value_ils = excluded.value_ils, as_of = excluded.as_of`);
const fillAccountDay = (db: DB) => db.prepare(`INSERT OR IGNORE INTO account_balance_daily (date, account_id, balance, currency, value_ils, as_of)
  VALUES (?, ?, ?, ?, ?, ?)`);

const bankAccountsOf = (db: DB, company: string) =>
  db.prepare(`SELECT id, COALESCE(currency, 'ILS') AS currency FROM accounts WHERE COALESCE(source, company) = ? AND kind = 'bank' AND active = 1`)
    .all(company) as { id: string; currency: string }[];

/** Today's row per bank account of a company that succeeded in this run: its latest balance, valued at today's rate. */
export function writeAccountBalances(db: DB, company: string, date: string, flagged: string[] = []): number {
  const latest = db.prepare(`SELECT balance, timestamp FROM balances WHERE account_id = ? ORDER BY id DESC LIMIT 1`);
  const upsert = upsertAccountDay(db);
  let n = 0;
  db.transaction(() => {
    for (const a of bankAccountsOf(db, company)) {
      const b = latest.get(a.id) as { balance: number; timestamp: string } | undefined;
      if (!b) continue;
      const rate = rateToIls(db, a.currency, date);
      if (rate == null) { flagged.push(`${a.id} (${a.currency})`); continue; }
      n += upsert.run(date, a.id, b.balance, a.currency, round(b.balance * rate), sqliteToIso(b.timestamp)).changes;
    }
  })();
  return n;
}

/**
 * Each bank account's history before `date`, like the bank snapshots: running balances are exact (they overwrite),
 * balances walked back from the latest one only fill missing days; the latest balance also fills its own day. Each
 * day is valued at that day's rate (no rate: left out and flagged).
 */
export function backfillAccountBalances(db: DB, company: string, date: string, flagged: string[] = []): number {
  const until = addDays(date, -1);
  const latest = db.prepare(`SELECT balance, timestamp FROM balances WHERE account_id = ? ORDER BY id DESC LIMIT 1`);
  const upsert = upsertAccountDay(db), fill = fillAccountDay(db);
  let n = 0;
  db.transaction(() => {
    for (const a of bankAccountsOf(db, company)) {
      const { balances, exact } = accountDailyBalances(db, a.id, until);
      const anchor = latest.get(a.id) as { balance: number; timestamp: string } | undefined;
      const anchorDay = anchor ? localDate(sqliteToIso(anchor.timestamp)!) : null;
      if (anchor && anchorDay! <= until && !balances.has(anchorDay!)) balances.set(anchorDay!, anchor.balance);
      for (const [d, balance] of balances) {
        const rate = rateToIls(db, a.currency, d);
        if (rate == null) { flagged.push(`${a.id} on ${d} (${a.currency})`); continue; }
        n += (exact ? upsert : fill).run(d, a.id, balance, a.currency, round(balance * rate), d).changes;
      }
    }
  })();
  return n;
}

/**
 * A bank whose accounts have no daily rows yet (data from before account_balance_daily) gets them at its latest bank
 * snapshot's date — a point a successful run already wrote — and the history before it.
 */
export function seedAccountBalances(db: DB, flagged: string[] = []): number {
  const pending = db.prepare(`
    SELECT s.source, MAX(s.date) AS date FROM daily_snapshots s WHERE s.bucket = 'bank'
      AND NOT EXISTS (SELECT 1 FROM account_balance_daily d JOIN accounts a ON a.id = d.account_id WHERE COALESCE(a.source, a.company) = s.source)
    GROUP BY s.source
  `).all() as { source: string; date: string }[];
  let n = 0;
  for (const p of pending) n += writeAccountBalances(db, p.source, p.date, flagged) + backfillAccountBalances(db, p.source, p.date, flagged);
  return n;
}
