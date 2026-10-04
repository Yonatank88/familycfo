import type { DB } from '../db/connection.js';
import { SOURCE_NAMES } from '../db/ingestRepo.js';
import { localDate } from '../ingest/normalize.js';
import { addDays, cleanMerchantName, round, today } from '../util.js';
import { rateToIls } from './fx.js';
import { byCategory, rangeStart, topCategories, type Range, type TopCategory } from './summary.js';

/**
 * The bank accounts' cash flow, by calendar month: money in, money out, net. Counted like expenses: transfers between
 * own accounts and card bills a scraped card explains (card_payment) are neither in nor out; money sent to savings /
 * investments (savings) is its own figure, never Out. Everything else counts by its sign — debit purchases, card bills
 * no card explains, salary, refunds.
 */

const EXCLUDED = new Set(['transfer', 'card_payment']);

export interface FlowRow { id: number; date: string; month: string; description: string; accountId: string; account: string; amount: number; moved: boolean; kind: string | null; category: TopCategory }

const accountLabel = (a: { id: string; display_name: string | null }) => (a.display_name ?? a.id).replace(/\s*···\s*/, ' ••');

function bankAccounts(db: DB) {
  return (db.prepare(`SELECT id, company, display_name FROM accounts WHERE kind = 'bank' AND active = 1 ORDER BY company, id`).all() as
    { id: string; company: string; display_name: string | null }[]).map(a => ({ id: a.id, company: a.company, label: accountLabel(a) }));
}

/** Every counted bank row in ILS (its day's rate; a row without a rate is left out, never 1:1), nothing after this month. */
export function flowRows(db: DB, account?: string, asOf = today()): FlowRow[] {
  const rows = db.prepare(`
    SELECT t.id, t.date, t.description, t.charged_amount, COALESCE(t.charged_currency, a.currency, 'ILS') AS currency, t.kind,
      t.category_id, a.id AS account_id, a.display_name
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.kind = 'bank' AND a.active = 1 ${account ? 'AND a.id = @account' : ''}
  `).all(account ? { account } : {}) as { id: number; date: string; description: string; charged_amount: number; currency: string;
    kind: string | null; category_id: number | null; account_id: string; display_name: string | null }[];
  const topOf = topCategories(db);
  const month = asOf.slice(0, 7);
  const out: FlowRow[] = [];
  for (const r of rows) {
    if (r.kind && EXCLUDED.has(r.kind)) continue;
    const day = localDate(r.date);
    if (day.slice(0, 7) > month || !r.charged_amount) continue;
    const rate = rateToIls(db, r.currency, day);
    if (rate == null) continue;
    out.push({ id: r.id, date: day, month: day.slice(0, 7), description: cleanMerchantName(r.description), accountId: r.account_id,
      account: accountLabel({ id: r.account_id, display_name: r.display_name }), amount: round(r.charged_amount * rate), moved: r.kind === 'savings',
      kind: r.kind, category: topOf(r.category_id) });
  }
  return out;
}

const monthsBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let [y, m] = from.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= to; m === 12 ? (y++, m = 1) : m++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return out;
};

/** In / out / net of a set of rows; `moved` = what went to savings / investments (positive = out). */
export function flowTotals(rows: FlowRow[]) {
  let inflow = 0, outflow = 0, moved = 0;
  for (const r of rows) {
    if (r.moved) moved -= r.amount;
    else if (r.amount > 0) inflow += r.amount;
    else outflow -= r.amount;
  }
  return { in: round(inflow), out: round(outflow), net: round(inflow - outflow), moved: round(moved) };
}

/**
 * `/api/cashflow`: the range's months (in / out / net / moved), its spend by category, the bank accounts, and each account's daily balance from
 * the snapshots (one line per bank — the snapshots are per bank, carried over days without one).
 */
export function cashFlow(db: DB, range: Range, account?: string, asOf = today()) {
  const accounts = bankAccounts(db);
  const rows = flowRows(db, account, asOf);
  const first = rows.map(r => r.date).sort()[0];
  const start = range === 'All' ? (first ?? asOf) : rangeStart(db, range, asOf);
  // months before the first row have no data (not zero flow): left out
  const months = monthsBetween([start.slice(0, 7), first?.slice(0, 7) ?? start.slice(0, 7)].sort()[1], asOf.slice(0, 7)).map(month => ({ month, ...flowTotals(rows.filter(r => r.month === month)) }));
  const inRange = rows.filter(r => r.month >= start.slice(0, 7));

  // balances: daily_snapshots' bank bucket per company, over the range
  const companies = [...new Set(accounts.filter(a => !account || a.id === account).map(a => a.company))];
  const label = (company: string) => {
    const own = accounts.filter(a => a.company === company);
    return own.length === 1 ? own[0].label : SOURCE_NAMES[company] ?? company;
  };
  const snaps = db.prepare(`SELECT date, source, value_ils FROM daily_snapshots WHERE bucket = 'bank' AND date <= ? ORDER BY date`)
    .all(asOf) as { date: string; source: string; value_ils: number }[];
  const by = new Map(companies.map(c => [c, new Map<string, number>()]));
  for (const s of snaps) by.get(s.source)?.set(s.date, s.value_ils);
  const points: { date: string; values: Record<string, number> }[] = [];
  const last: Record<string, number> = {};
  const firstSnap = snaps.find(s => by.has(s.source))?.date;
  if (firstSnap) {
    for (let d = firstSnap; d <= asOf; d = addDays(d, 1)) {
      for (const c of companies) { const v = by.get(c)!.get(d); if (v != null) last[c] = v; }
      if (d >= start) points.push({ date: d, values: { ...last } });
    }
  }
  return {
    range, from: start,
    accounts: accounts.map(({ id, label }) => ({ id, label })),
    totals: flowTotals(inRange),
    // the range's spend (expense / refund rows) by top-level category
    categories: byCategory(inRange.filter(r => r.kind === 'expense' || r.kind === 'refund').map(r => ({ amount: -r.amount, category: r.category })), 6),
    months,
    balances: { series: companies.filter(c => by.get(c)!.size).map(c => ({ key: c, label: label(c) })), points },
  };
}

/** `/api/cashflow/rows`: one month's counted rows, split in / out (newest first); moved-to-savings rows apart. */
export function cashFlowRows(db: DB, month: string, account?: string, asOf = today()) {
  const rows = flowRows(db, account, asOf).filter(r => r.month === month)
    .sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.amount) - Math.abs(a.amount))
    .map(({ id, date, description, account: name, amount, moved }) => ({ id, date, description, account: name, amount, moved }));
  return {
    month,
    in: rows.filter(r => !r.moved && r.amount > 0),
    out: rows.filter(r => !r.moved && r.amount < 0),
    moved: rows.filter(r => r.moved),
  };
}
