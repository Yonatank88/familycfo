import type { DB } from '../db/connection.js';
import { localDate } from '../ingest/normalize.js';
import { cleanMerchantName, merchantKey, round, today } from '../util.js';
import { rateToIls } from './fx.js';
import { byCategory, expenseRows, rangeStart, type ExpenseRow, type Range } from './summary.js';

/**
 * `/api/expenses/breakdown`: spending by where it was paid from — one source per credit-card account, and "bank" for
 * spend paid straight from the bank accounts (debits, standing orders, transfers to people, card bills no scraped card
 * explains). Same rows as /api/expenses (expense minus refunds; card_payment / transfer / savings never count).
 */

export const BANK_SOURCE = 'bank';
const sourceOf = (r: ExpenseRow) => (r.accountKind === 'card' ? r.accountId : BANK_SOURCE);

const prevMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};
const monthsBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = to; m >= from; m = prevMonth(m)) out.unshift(m);
  return out;
};
const sum = (rows: ExpenseRow[]) => round(rows.reduce((a, r) => a + r.amount, 0));

/** A card's next charge: the earliest processed date after today and everything the card charges on it. */
export function nextCharge(db: DB, accountId: string, asOf = today()): { date: string; amount: number } | null {
  const rows = (db.prepare(`
    SELECT t.processed_date, t.charged_amount, COALESCE(t.charged_currency, a.currency, 'ILS') AS currency
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id = ? AND t.processed_date IS NOT NULL
  `).all(accountId) as { processed_date: string; charged_amount: number; currency: string }[])
    .map(r => ({ ...r, day: localDate(r.processed_date) })).filter(r => r.day > asOf);
  if (!rows.length) return null;
  const date = rows.map(r => r.day).sort()[0];
  let amount = 0;
  for (const r of rows.filter(x => x.day === date)) {
    const rate = rateToIls(db, r.currency, asOf);
    if (rate != null) amount -= r.charged_amount * rate;
  }
  return { date, amount: round(amount) };
}

/**
 * A card's installment plans still being paid: per plan (merchant, purchase date, N), the payments after the last one
 * charged by today, each at the plan's latest payment amount.
 */
export function remainingInstallments(db: DB, accountId: string, asOf = today()): { payments: number; plans: number; amount: number } {
  const rows = db.prepare(`
    SELECT t.date, t.processed_date, t.description, t.charged_amount, COALESCE(t.charged_currency, a.currency, 'ILS') AS currency,
      t.installment_number AS n, t.installment_total AS total
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.account_id = ? AND t.installment_total > 1 AND t.installment_number IS NOT NULL AND t.kind IS NOT 'card_payment'
  `).all(accountId) as { date: string; processed_date: string | null; description: string; charged_amount: number; currency: string; n: number; total: number }[];
  const plans = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${merchantKey(r.description)}|${localDate(r.date)}|${r.total}`;
    plans.set(key, [...(plans.get(key) ?? []), r]);
  }
  let payments = 0, count = 0, amount = 0;
  for (const list of plans.values()) {
    const total = list[0].total;
    const charged = list.filter(r => r.processed_date && localDate(r.processed_date) <= asOf).map(r => r.n);
    const paid = charged.length ? Math.max(...charged) : Math.min(...list.map(r => r.n)) - 1;
    const left = Math.max(0, total - paid);
    if (!left) continue;
    const latest = [...list].sort((a, b) => b.n - a.n)[0];
    const rate = rateToIls(db, latest.currency, asOf);
    if (rate == null) continue;
    payments += left;
    count++;
    amount += left * -latest.charged_amount * rate;
  }
  return { payments, plans: count, amount: round(amount) };
}

export function expenseBreakdown(db: DB, range: Range, source?: string, asOf = today()) {
  const all = expenseRows(db, asOf);
  const current = asOf.slice(0, 7);
  const last = prevMonth(current);
  const first = all.map(r => r.month).sort()[0] ?? current;
  const from = (range === 'All' ? first : [rangeStart(db, range, asOf).slice(0, 7), first].sort()[1]);

  const cards = db.prepare(`SELECT id, company, COALESCE(display_name, id) AS label FROM accounts WHERE kind = 'card' AND active = 1 ORDER BY company, id`)
    .all() as { id: string; company: string; label: string }[];
  const hasBank = !!db.prepare(`SELECT 1 FROM accounts WHERE kind = 'bank' AND active = 1`).get() || all.some(r => r.accountKind === 'bank');
  const of = (key: string) => all.filter(r => sourceOf(r) === key);
  const sources = [
    ...cards.map(c => {
      const rows = of(c.id);
      return {
        key: c.id, kind: 'card' as const, company: c.company, label: c.label.replace(/\s*···\s*/, ' ••'),
        thisMonth: sum(rows.filter(r => r.month === current)), lastMonth: sum(rows.filter(r => r.month === last)),
        nextCharge: nextCharge(db, c.id, asOf), installments: remainingInstallments(db, c.id, asOf),
      };
    }),
    ...(hasBank ? [{
      key: BANK_SOURCE, kind: 'bank' as const, company: null, label: 'Bank',
      thisMonth: sum(of(BANK_SOURCE).filter(r => r.month === current)), lastMonth: sum(of(BANK_SOURCE).filter(r => r.month === last)),
      nextCharge: null, installments: null,
    }] : []),
  ];

  const rows = (source ? of(source) : all).filter(r => r.month >= from);
  const merchants = new Map<string, { total: number; count: number; names: Map<string, number> }>();
  for (const r of rows) {
    const m = merchants.get(r.merchant) ?? { total: 0, count: 0, names: new Map() };
    m.total += r.amount;
    m.count++;
    m.names.set(r.description, (m.names.get(r.description) ?? 0) + 1);
    merchants.set(r.merchant, m);
  }
  return {
    range, from, currentMonth: current, source: source ?? null,
    sources,
    total: sum(rows),
    months: monthsBetween(from, current).map(month => ({ month, total: sum(rows.filter(r => r.month === month)) })),
    categories: byCategory(rows, 8),
    merchants: [...merchants].filter(([, m]) => m.total > 0).sort((a, b) => b[1].total - a[1].total).slice(0, 8).map(([key, m]) => ({
      key, name: cleanMerchantName([...m.names].sort((a, b) => b[1] - a[1])[0][0]), total: round(m.total), count: m.count,
    })),
  };
}

/** `/api/expenses/rows` with a source and/or a range: the matching spend rows, newest first. */
export function expenseRowsIn(db: DB, filter: { month?: string; from?: string; source?: string; merchant?: string; category?: string }, asOf = today()) {
  return expenseRows(db, asOf)
    .filter(r => (!filter.month || r.month === filter.month) && (!filter.from || r.month >= filter.from)
      && (!filter.source || sourceOf(r) === filter.source)
      && (!filter.merchant || r.merchant === filter.merchant) && (!filter.category || r.category.key === filter.category))
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount)
    .map(r => ({
      id: r.id, date: r.date, description: r.description, merchant: cleanMerchantName(r.description), account: r.account,
      source: sourceOf(r), company: r.company, category: r.category.key === 'none' ? null : r.category.name, amount: r.amount, installment: r.installment,
    }));
}
