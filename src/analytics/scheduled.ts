import type { DB } from '../db/connection.js';
import { addDays, loadTransactions, median, merchantKey, round, today, type Tx } from './common.js';
import { inferBillingAccounts } from './cards.js';

export interface ScheduledItem {
  id: number;
  name: string;
  kind: 'income' | 'fixed_expense' | 'loan' | 'mortgage' | 'card_charge';
  amount: number;
  amount_mode: 'fixed' | 'estimated';
  day_of_month: number;
  bank_account_id: string | null;
  member_id: number | null;
  category_id: number | null;
  match_pattern: string | null;
  card_account_id: string | null;
  start_date: string | null;
  end_date: string | null;
  status: 'suggested' | 'confirmed' | 'dismissed';
}

export function listScheduled(db: DB, includeDismissed = false): ScheduledItem[] {
  return db.prepare(`SELECT * FROM scheduled_items ${includeDismissed ? '' : `WHERE status != 'dismissed'`}
    ORDER BY day_of_month, name`).all() as ScheduledItem[];
}

/**
 * Suggest scheduled items from history: recurring bank-account inflows (salary on the 1st/10th),
 * standing orders and loan/mortgage debits, and one card_charge per card on its usual charge day.
 * Items the user confirmed, edited or dismissed are never overwritten.
 */
export function suggestScheduledItems(db: DB): number {
  const txs = loadTransactions(db);
  const owner = new Map((db.prepare(`SELECT id, owner_member_id FROM accounts`).all() as { id: string; owner_member_id: number | null }[])
    .map(a => [a.id, a.owner_member_id]));
  const series = db.prepare(`
    SELECT s.*, a.kind AS account_kind FROM recurring_series s JOIN accounts a ON a.id = s.account_id
    WHERE s.active = 1 AND a.kind = 'bank' AND a.is_savings = 0 AND COALESCE(a.currency, 'ILS') = 'ILS'
  `).all() as { merchant_key: string; account_id: string; kind: string; typical_amount: number;
    typical_day: number; category_id: number | null; }[];

  const upsert = db.prepare(`
    INSERT INTO scheduled_items (name, kind, amount, amount_mode, day_of_month, bank_account_id,
      member_id, category_id, match_pattern, card_account_id, status)
    VALUES (@name, @kind, @amount, @amountMode, @day, @bankAccountId, @memberId, @categoryId,
      @matchPattern, @cardAccountId, 'suggested')
    ON CONFLICT(kind, name, bank_account_id) DO UPDATE SET
      -- keep following history until the user types an amount (which sets amount_mode = 'fixed')
      amount = CASE WHEN scheduled_items.status = 'suggested' OR scheduled_items.amount_mode = 'estimated' THEN excluded.amount ELSE scheduled_items.amount END,
      day_of_month = CASE WHEN scheduled_items.status = 'suggested' OR scheduled_items.amount_mode = 'estimated' THEN excluded.day_of_month ELSE scheduled_items.day_of_month END
  `);

  let count = 0;
  db.transaction(() => {
    // card charges suggested before the paying bank account was known (bank_account_id NULL)
    // are superseded by the item that has the account — drop the stale copies
    db.prepare(`DELETE FROM scheduled_items WHERE kind = 'card_charge' AND bank_account_id IS NULL
      AND card_account_id IN (SELECT card_account_id FROM scheduled_items WHERE kind = 'card_charge' AND bank_account_id IS NOT NULL)`).run();
    // debit cards have no monthly charge (each purchase is already a bank row)
    db.prepare(`DELETE FROM scheduled_items WHERE status = 'suggested' AND kind = 'card_charge'
      AND card_account_id IN (SELECT id FROM accounts WHERE is_debit = 1)`).run();
    // savings deposits and foreign-currency accounts aren't part of the day-to-day cash flow
    db.prepare(`DELETE FROM scheduled_items WHERE status = 'suggested' AND bank_account_id IN
      (SELECT id FROM accounts WHERE is_savings = 1 OR COALESCE(currency, 'ILS') != 'ILS')`).run();
    for (const s of series) {
      const kind = s.kind === 'salary' || s.kind === 'income' ? 'income'
        : s.kind === 'loan' ? (/משכנת|mortgage/i.test(s.merchant_key) ? 'mortgage' : 'loan')
        : 'fixed_expense';
      const sample = txs.find(t => t.accountId === s.account_id && t.merchant === s.merchant_key);
      upsert.run({
        name: sample?.description ?? s.merchant_key,
        kind,
        amount: kind === 'income' ? s.typical_amount : -s.typical_amount,
        amountMode: s.kind === 'subscription' ? 'fixed' : 'estimated',
        day: Math.min(31, Math.max(1, s.typical_day || 1)),
        bankAccountId: s.account_id,
        memberId: owner.get(s.account_id) ?? null,
        categoryId: s.category_id,
        matchPattern: s.merchant_key,
        cardAccountId: null,
      });
      count++;
    }

    // recurring transfers between own accounts (e.g. Hapoalim → Leumi to fund the mortgage and card):
    // one outflow item on the source and one inflow item on the destination, so each account's forecast is right
    for (const t of recurringTransfers(txs)) {
      const name = `העברה ${t.fromName} → ${t.toName}`;
      for (const side of [
        { kind: 'fixed_expense', amount: -t.amount, account: t.from, pattern: t.fromMerchant },
        { kind: 'income', amount: t.amount, account: t.to, pattern: t.toMerchant },
      ]) {
        upsert.run({ name, kind: side.kind, amount: side.amount, amountMode: 'estimated', day: t.day,
          bankAccountId: side.account, memberId: owner.get(side.account) ?? null, categoryId: null,
          matchPattern: side.pattern, cardAccountId: null });
        count++;
      }
    }

    const billing = inferBillingAccounts(db, txs);
    const cards = db.prepare(`SELECT id, display_name FROM accounts WHERE kind = 'card' AND active = 1 AND is_debit = 0`).all() as { id: string; display_name: string | null }[];
    for (const card of cards) {
      const typical = cardChargeProfile(txs, card.id);
      if (!typical) continue;
      upsert.run({
        name: `חיוב ${card.display_name ?? card.id}`,
        kind: 'card_charge',
        amount: -typical.amount,
        amountMode: 'estimated',
        day: typical.day,
        bankAccountId: billing.get(card.id) ?? null,
        memberId: owner.get(card.id) ?? null,
        categoryId: null,
        matchPattern: null,
        cardAccountId: card.id,
      });
      count++;
    }
  })();
  count += suggestCardCommitments(db, txs);
  return count;
}

/**
 * Fixed payments charged to a card (kindergarten, classes, insurance, subscriptions): a merchant
 * in a fixed category charged in at least 2 of the last 6 months and seen in the last 2. Several
 * charges a month (e.g. one per child) add up to one monthly amount. Suggested for the user to
 * confirm; they have no bank account, so the forecast gets them through the card charge instead.
 */
export function suggestCardCommitments(db: DB, txs: Tx[], asOf = today()): number {
  const since = addDays(asOf, -183);
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    if (t.accountKind !== 'card' || t.kind !== 'expense' || !t.fixed || t.txnType === 'installments') continue;
    if (t.date < since || t.date > asOf || t.amount >= 0) continue;
    const key = `${t.accountId}|${t.merchant}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const existing = db.prepare(`SELECT id, status, amount_mode FROM scheduled_items WHERE card_account_id = ? AND match_pattern = ? AND kind != 'card_charge'`);
  const insert = db.prepare(`INSERT INTO scheduled_items (name, kind, amount, amount_mode, day_of_month, bank_account_id, member_id,
    category_id, match_pattern, card_account_id, status) VALUES (?, 'fixed_expense', ?, 'estimated', ?, NULL, ?, ?, ?, ?, 'suggested')`);
  const update = db.prepare(`UPDATE scheduled_items SET amount = ?, day_of_month = ? WHERE id = ?`);
  const rename = db.prepare(`UPDATE scheduled_items SET name = ? WHERE id = ?`);
  let count = 0;
  for (const rows of groups.values()) {
    const byMonth = new Map<string, number>();
    for (const t of rows) byMonth.set(t.date.slice(0, 7), (byMonth.get(t.date.slice(0, 7)) ?? 0) - t.amount);
    const last = rows.reduce((m, t) => (t.date > m ? t.date : m), '');
    if (byMonth.size < 2 || last < addDays(asOf, -62)) continue;
    const amount = -round(median([...byMonth.values()]));
    const day = Math.min(28, Math.max(1, Math.round(median(rows.map(t => Number(t.date.slice(8, 10)))))));
    const sample = rows[rows.length - 1];
    // "FACEBK  Q1W2E3R4T5" → "FACEBK": drop the per-charge codes from the name
    const name = /\d/.test(sample.description) && /^[\x00-\x7f]+$/.test(sample.merchant) ? sample.merchant.toUpperCase() : sample.description.trim();
    const cur = existing.get(sample.accountId, sample.merchant) as { id: number; status: string; amount_mode: string } | undefined;
    if (cur) {
      if (cur.status === 'suggested' || cur.amount_mode === 'estimated') update.run(amount, day, cur.id);
      if (cur.status === 'suggested') rename.run(name, cur.id);
      continue;
    }
    insert.run(name, amount, day, sample.memberId, sample.categoryId, sample.merchant, sample.accountId);
    count++;
  }
  return count;
}

export interface RecurringTransfer {
  from: string; to: string; fromName: string; toName: string;
  fromMerchant: string; toMerchant: string; amount: number; day: number; months: number;
}

/** Own-account transfer pairs that happen in at least 3 of the last 6 months (median amount and day). */
export function recurringTransfers(txs: Tx[], asOf = new Date().toISOString().slice(0, 10)): RecurringTransfer[] {
  const since = new Date(`${asOf}T12:00:00Z`);
  since.setUTCMonth(since.getUTCMonth() - 6);
  const transfers = txs.filter(t => t.kind === 'transfer' && t.accountKind === 'bank' && t.date >= since.toISOString().slice(0, 10));
  const pairs = new Map<string, { out: Tx; in: Tx }[]>();
  for (const out of transfers.filter(t => t.amount < 0)) {
    const inn = transfers.find(t => t.amount > 0 && t.accountId !== out.accountId && Math.abs(t.amount + out.amount) < 0.01
      && Math.abs(Date.parse(t.date) - Date.parse(out.date)) <= 3 * 86_400_000);
    if (!inn) continue;
    const key = `${out.accountId}|${inn.accountId}`;
    pairs.set(key, [...(pairs.get(key) ?? []), { out, in: inn }]);
  }
  const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const nameOf = (id: string) => ({ hapoalim: 'הפועלים', leumi: 'לאומי', discount: 'דיסקונט', mizrahi: 'מזרחי' } as Record<string, string>)[id.split(':')[0]] ?? id;
  return [...pairs.values()]
    .filter(list => new Set(list.map(p => p.out.date.slice(0, 7))).size >= 3)
    .map(list => ({
      from: list[0].out.accountId, to: list[0].in.accountId,
      fromName: nameOf(list[0].out.accountId), toName: nameOf(list[0].in.accountId),
      fromMerchant: list[0].out.merchant, toMerchant: list[0].in.merchant,
      amount: Math.round(med(list.map(p => -p.out.amount))),
      day: med(list.map(p => Number(p.out.date.slice(8, 10)))),
      months: new Set(list.map(p => p.out.date.slice(0, 7))).size,
    }));
}

/**
 * Typical monthly charge and its usual day. Best source: the statement rows on the bank account
 * (e.g. Hapoalim "ויזה" with the card's last 4 digits as reference); otherwise the card's own
 * rows grouped by charge date.
 */
function cardChargeProfile(txs: Tx[], cardId: string): { amount: number; day: number } | null {
  const suffix = cardId.split(':')[1]?.slice(-4);
  const bills = txs
    .filter(t => t.accountKind === 'bank' && t.kind === 'card_payment' && t.matchedTxnId == null && -t.amount >= 1000
      && suffix && t.bankIdentifier === suffix)
    .sort((a, b) => a.processedDate.localeCompare(b.processedDate))
    .slice(-3);
  if (bills.length) {
    const amounts = bills.map(b => -b.amount).sort((a, b) => a - b);
    const days = bills.map(b => Number(b.processedDate.slice(8, 10))).sort((a, b) => a - b);
    return { amount: amounts[Math.floor(amounts.length / 2)], day: days[Math.floor(days.length / 2)] };
  }
  const byDate = new Map<string, { amount: number; count: number }>();
  for (const t of txs) {
    if (t.accountId !== cardId) continue;
    if (t.settledByTxnId != null) continue; // charged to the bank immediately, not on the statement
    const cur = byDate.get(t.processedDate) ?? { amount: 0, count: 0 };
    byDate.set(t.processedDate, { amount: cur.amount - t.amount, count: cur.count + 1 });
  }
  // a statement charges many purchases on one date; single rows are purchases without a charge date
  const statements = [...byDate.entries()].filter(([, s]) => s.amount > 0 && s.count >= 3)
    .sort(([a], [b]) => a.localeCompare(b)).slice(-3);
  if (!statements.length) return null;
  const amounts = statements.map(([, s]) => s.amount).sort((a, b) => a - b);
  const days = statements.map(([d]) => Number(d.slice(8, 10))).sort((a, b) => a - b);
  return { amount: amounts[Math.floor(amounts.length / 2)], day: days[Math.floor(days.length / 2)] };
}
