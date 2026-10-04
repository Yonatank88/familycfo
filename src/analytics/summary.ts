import type { DB } from '../db/connection.js';
import { SOURCE_NAMES } from '../db/ingestRepo.js';
import { localDate } from '../ingest/normalize.js';
import { addDays, merchantKey, round, today } from '../util.js';
import { rateToIls } from './fx.js';
import { holdingValues } from './investments.js';

export type Range = '1M' | '3M' | 'YTD' | '1Y' | 'All';
export const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];

export const TYPE_LABELS: Record<string, string> = {
  bank: 'Bank', stock: 'Stocks & ETFs', mutual_fund: 'Funds', crypto: 'Crypto', stablecoin: 'Stablecoins', broker_cash: 'Broker cash',
  pension: 'Pension', study_fund: 'Study funds', provident_fund: 'Provident funds', deposit: 'Deposits', other: 'Other',
};
const INVESTMENT_BUCKETS = new Set(['stock', 'mutual_fund', 'crypto', 'stablecoin', 'broker_cash', 'pension', 'study_fund', 'provident_fund', 'deposit', 'other']);
export const STALE_MS = 36 * 3600_000;

export const sourceLabel = (source: string) => SOURCE_NAMES[source] ?? source;

/** A report product (holding source report:…) by its provider and symbol, e.g. "מגדל Study fund ••4821". */
function reportLabels(db: DB): Map<string, string> {
  return new Map((db.prepare(`SELECT source, broker, symbol FROM holdings WHERE source LIKE 'report:%'`).all() as
    { source: string; broker: string | null; symbol: string }[]).map(h => [h.source, `${h.broker ? `${h.broker} ` : ''}${h.symbol}`]));
}

/** Each report product's liquidity date (its latest value point's), when stated. */
function liquidityDates(db: DB): Map<string, string> {
  return new Map((db.prepare(`
    SELECT v.holding_source, v.liquidity_date FROM report_values v JOIN reports r ON r.id = v.report_id
    WHERE r.status = 'applied' AND v.as_of = (SELECT MAX(w.as_of) FROM report_values w JOIN reports s ON s.id = w.report_id
      WHERE w.holding_source = v.holding_source AND s.status = 'applied')
  `).all() as { holding_source: string; liquidity_date: string | null }[]).filter(r => r.liquidity_date).map(r => [r.holding_source, r.liquidity_date!]));
}

/** The first day of a range (All: the first snapshot). */
export function rangeStart(db: DB, range: Range, asOf = today()): string {
  const [y, m, d] = asOf.split('-').map(Number);
  const monthsBack = (n: number) => {
    const date = new Date(Date.UTC(y, m - 1 - n, 1));
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(d, last));
    return date.toISOString().slice(0, 10);
  };
  switch (range) {
    case '1M': return monthsBack(1);
    case '3M': return monthsBack(3);
    case 'YTD': return `${y}-01-01`;
    case '1Y': return monthsBack(12);
    default: return (db.prepare(`SELECT MIN(date) FROM daily_snapshots`).pluck().get() as string | null) ?? asOf;
  }
}

interface Snap { date: string; source: string; bucket: string; value_ils: number; as_of: string | null }

/**
 * The household by day: on each day every source counts with its latest snapshot on or before that day (a day the
 * scrape didn't run shows the last known values); a source counts only from its first snapshot.
 */
function dailyValues(db: DB, from: string, to: string): { date: string; rows: Snap[] }[] {
  const snaps = db.prepare(`SELECT * FROM daily_snapshots WHERE date <= ? ORDER BY date`).all(to) as Snap[];
  const bySource = new Map<string, Map<string, Snap[]>>();
  for (const s of snaps) {
    const days = bySource.get(s.source) ?? new Map<string, Snap[]>();
    days.set(s.date, [...(days.get(s.date) ?? []), s]);
    bySource.set(s.source, days);
  }
  const sources = [...bySource.entries()].map(([source, days]) => ({ source, dates: [...days.keys()].sort(), days }));
  const first = snaps[0]?.date;
  if (!first) return [];
  const out: { date: string; rows: Snap[] }[] = [];
  const idx = sources.map(() => -1);
  // walk from the first snapshot so the carry-over is right at `from`
  for (let d = first; d <= to; d = addDays(d, 1)) {
    const rows: Snap[] = [];
    sources.forEach((s, i) => {
      while (idx[i] + 1 < s.dates.length && s.dates[idx[i] + 1] <= d) idx[i]++;
      if (idx[i] >= 0) rows.push(...s.days.get(s.dates[idx[i]])!);
    });
    if (d >= from) out.push({ date: d, rows });
  }
  return out;
}

const sumWhere = (rows: Snap[], keep: (s: Snap) => boolean) => rows.filter(keep).reduce((a, s) => a + s.value_ils, 0);

export interface Buckets { netWorth: number; bank: number; investments: number; cardsOwed: number | null }

function bucketsOf(rows: Snap[]): Buckets {
  const bank = sumWhere(rows, s => s.bucket === 'bank');
  const investments = sumWhere(rows, s => INVESTMENT_BUCKETS.has(s.bucket));
  const hasCards = rows.some(s => s.bucket === 'cards_owed');
  const cards = sumWhere(rows, s => s.bucket === 'cards_owed');
  return { netWorth: round(bank + investments + cards), bank: round(bank), investments: round(investments), cardsOwed: hasCards ? round(-cards) : null };
}

/** `/api/history`: the stacked series (Type or Source), with the totals and the USD rate of each day. */
export function history(db: DB, range: Range, group: 'type' | 'source', asOf = today()) {
  const from = rangeStart(db, range, asOf);
  const days = dailyValues(db, from, asOf);
  const keyOf = (s: Snap) => (group === 'type' ? s.bucket : s.source);
  const keys = new Map<string, number>();
  const points = days.map(({ date, rows }) => {
    const values: Record<string, number> = {};
    for (const s of rows) {
      if (s.bucket === 'cards_owed') continue; // owed is not an asset: in net worth, not in the stack
      values[keyOf(s)] = round((values[keyOf(s)] ?? 0) + s.value_ils);
    }
    for (const [k, v] of Object.entries(values)) keys.set(k, (keys.get(k) ?? 0) + v);
    return { date, values, ...bucketsOf(rows), usdRate: rateToIls(db, 'USD', date) };
  });
  const order = group === 'type' ? Object.keys(TYPE_LABELS) : [...keys.keys()].sort((a, b) => keys.get(b)! - keys.get(a)!);
  const reports = reportLabels(db);
  const series = order.filter(k => keys.has(k)).map(key => ({ key, label: group === 'type' ? TYPE_LABELS[key] ?? key : reports.get(key) ?? sourceLabel(key) }));

  // a bucket whose sources (today's) weren't all snapshotted by the start of the range has no change — investment
  // history starts at the first sync, so an early range must not report the whole portfolio as gain
  const firstSnap = new Map((db.prepare(`SELECT source, MIN(date) AS first FROM daily_snapshots GROUP BY source`).all() as
    { source: string; first: string }[]).map(r => [r.source, r.first]));
  const lastRows = days.at(-1)?.rows ?? [];
  const covered = (keep: (bucket: string) => boolean) => {
    const sources = new Set(lastRows.filter(s => keep(s.bucket)).map(s => s.source));
    return sources.size === 0 ? null : [...sources].every(src => (firstSnap.get(src) ?? '9999') <= from);
  };
  const bankOk = covered(b => b === 'bank');
  const invOk = covered(b => INVESTMENT_BUCKETS.has(b));
  const cardsOk = covered(b => b === 'cards_owed');
  const start = points[0];
  const startValues = start ? {
    bank: bankOk ? start.bank : null,
    investments: invOk ? start.investments : null,
    cardsOwed: cardsOk ? start.cardsOwed : null,
    netWorth: bankOk !== false && invOk !== false && cardsOk !== false ? start.netWorth : null,
  } : null;
  return { range, from, series, points, start: startValues };
}

/** Latest successful run, latest run and its data time per source. */
function sourceStatus(db: DB) {
  return db.prepare(`
    SELECT r.source, r.ok, r.error, r.started_at,
      (SELECT MAX(started_at) FROM source_runs WHERE source = r.source AND ok = 1) AS last_ok,
      (SELECT as_of FROM source_runs WHERE source = r.source AND ok = 1 ORDER BY id DESC LIMIT 1) AS as_of
    FROM source_runs r WHERE r.id = (SELECT MAX(id) FROM source_runs WHERE source = r.source)
  `).all() as { source: string; ok: number; error: string | null; started_at: string; last_ok: string | null; as_of: string | null }[];
}

/** `/api/summary`: net worth and its buckets now, the accounts, the holdings and the allocation. */
export function summary(db: DB, asOf = today()) {
  const now = dailyValues(db, asOf, asOf)[0]?.rows ?? [];
  const status = new Map(sourceStatus(db).map(s => [s.source, s]));
  const stale = (source: string) => {
    const lastOk = status.get(source)?.last_ok;
    return !lastOk || Date.now() - Date.parse(lastOk) > STALE_MS;
  };

  const accounts: {
    id: string; source: string; sourceLabel: string; label: string; kind: 'bank' | 'card' | 'investment';
    valueIls: number | null; value: number | null; currency: string; asOf: string | null; lastSuccessAt: string | null; stale: boolean; fxMissing: boolean;
  }[] = [];
  const bankAccounts = db.prepare(`
    SELECT a.id, a.company, a.display_name, COALESCE(a.currency, 'ILS') AS currency, b.balance, b.timestamp
    FROM accounts a LEFT JOIN balances b ON b.id = (SELECT MAX(id) FROM balances WHERE account_id = a.id)
    WHERE a.kind = 'bank' AND a.active = 1 ORDER BY a.company, a.id
  `).all() as { id: string; company: string; display_name: string | null; currency: string; balance: number | null; timestamp: string | null }[];
  for (const a of bankAccounts) {
    const rate = rateToIls(db, a.currency, asOf);
    accounts.push({
      id: a.id, source: a.company, sourceLabel: sourceLabel(a.company), label: a.display_name ?? a.id, kind: 'bank',
      value: a.balance, currency: a.currency, valueIls: a.balance == null || rate == null ? null : round(a.balance * rate),
      asOf: a.timestamp ? `${a.timestamp.replace(' ', 'T')}Z` : null, lastSuccessAt: status.get(a.company)?.last_ok ?? null,
      stale: stale(a.company), fxMissing: a.balance != null && rate == null,
    });
  }
  const cardsBySource = new Map<string, number>();
  for (const s of now.filter(x => x.bucket === 'cards_owed')) cardsBySource.set(s.source, (cardsBySource.get(s.source) ?? 0) + s.value_ils);
  for (const [source, v] of cardsBySource) {
    accounts.push({ id: `${source}:cards`, source, sourceLabel: sourceLabel(source), label: `${sourceLabel(source)} cards owed`, kind: 'card',
      value: round(v), currency: 'ILS', valueIls: round(v), asOf: status.get(source)?.as_of ?? null,
      lastSuccessAt: status.get(source)?.last_ok ?? null, stale: stale(source), fxMissing: false });
  }

  const holdings = holdingValues(db, asOf);
  // report products are one account each (their snapshots are per product), the other sources one per source
  const isReport = (source: string) => source === 'report' || source.startsWith('report:');
  const investmentSources = [...new Set([...holdings.map(h => h.source),
    ...now.filter(s => INVESTMENT_BUCKETS.has(s.bucket)).map(s => s.source)])].filter(s => !isReport(s));
  for (const source of investmentSources) {
    const v = sumWhere(now, s => s.source === source && INVESTMENT_BUCKETS.has(s.bucket));
    accounts.push({ id: source, source, sourceLabel: sourceLabel(source), label: sourceLabel(source), kind: 'investment',
      value: round(v), currency: 'ILS', valueIls: round(v), asOf: status.get(source)?.as_of ?? null,
      lastSuccessAt: status.get(source)?.last_ok ?? null, stale: stale(source),
      fxMissing: holdings.some(h => h.source === source && h.valueIls == null) });
  }
  for (const h of holdings.filter(x => x.source === 'report')) {
    accounts.push({ id: h.holdingSource, source: h.holdingSource, sourceLabel: h.broker ?? 'Report', label: h.symbol, kind: 'investment',
      value: h.value, currency: h.currency, valueIls: h.valueIls, asOf: h.priceDate, lastSuccessAt: null, stale: false, fxMissing: h.valueIls == null });
  }
  // a source that never succeeded (e.g. a bank that needs its OTP)
  const shown = new Set(accounts.map(a => a.source));
  for (const s of status.values()) {
    if (shown.has(s.source)) continue;
    accounts.push({ id: s.source, source: s.source, sourceLabel: sourceLabel(s.source), label: sourceLabel(s.source), kind: 'bank',
      value: null, currency: 'ILS', valueIls: null, asOf: null, lastSuccessAt: s.last_ok, stale: true, fxMissing: false });
  }

  const invested = holdings.reduce((a, h) => a + (h.valueIls ?? 0), 0);
  const liquid = liquidityDates(db);
  const reports = reportLabels(db);
  const allocation = (key: (s: Snap) => string, label: (k: string) => string) => {
    const by = new Map<string, number>();
    for (const s of now) if (s.bucket !== 'cards_owed') by.set(key(s), (by.get(key(s)) ?? 0) + s.value_ils);
    return [...by].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: label(k), value: round(v) }));
  };

  return {
    asOf,
    ...bucketsOf(now),
    usdRate: rateToIls(db, 'USD', asOf),
    accounts,
    holdings: holdings
      .sort((a, b) => (b.valueIls ?? 0) - (a.valueIls ?? 0))
      .map(h => ({
        id: h.id, symbol: h.symbol, name: h.name, source: h.source, sourceLabel: h.source === 'report' ? h.broker ?? 'Report' : sourceLabel(h.source),
        assetClass: h.assetClass, liquidityDate: liquid.get(h.holdingSource) ?? null,
        quantity: h.quantity, currency: h.currency, price: h.price, value: h.value, valueIls: h.valueIls, fxMissing: h.valueIls == null,
        gainIls: h.gainIls, gainPct: h.gainPct,
        pctOfInvestments: invested && h.valueIls != null ? round((h.valueIls / invested) * 100) : null,
      })),
    allocation: {
      type: allocation(s => s.bucket, k => TYPE_LABELS[k] ?? k),
      source: allocation(s => s.source, k => reports.get(k) ?? sourceLabel(k)),
    },
  };
}

// ---- expenses ----------------------------------------------------------------------------------------------

interface ExpenseRow { id: number; date: string; month: string; description: string; merchant: string; account: string; amount: number }

/**
 * Spend rows: `kind = 'expense'` (positive amount) and refunds (negative), in ILS. Installments count on their charge
 * date (processed_date), everything else on the purchase date; calendar months; nothing after this month.
 */
function expenseRows(db: DB, asOf = today()): ExpenseRow[] {
  const rows = db.prepare(`
    SELECT t.id, t.date, t.processed_date, t.description, t.charged_amount, COALESCE(t.charged_currency, 'ILS') AS currency,
      t.kind, t.txn_type, t.installment_total, COALESCE(a.display_name, a.id) AS account
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.kind IN ('expense', 'refund')
  `).all() as { id: number; date: string; processed_date: string | null; description: string; charged_amount: number; currency: string;
    kind: string; txn_type: string | null; installment_total: number | null; account: string }[];
  const month = asOf.slice(0, 7);
  const out: ExpenseRow[] = [];
  for (const r of rows) {
    const installment = r.txn_type === 'installments' || (r.installment_total ?? 0) > 1;
    const day = localDate(installment && r.processed_date ? r.processed_date : r.date);
    if (day.slice(0, 7) > month) continue;
    const rate = rateToIls(db, r.currency, day);
    if (rate == null) continue;
    out.push({ id: r.id, date: day, month: day.slice(0, 7), description: r.description, merchant: merchantKey(r.description),
      account: r.account, amount: round(-r.charged_amount * rate) });
  }
  return out;
}

/** `/api/expenses`: the last `months` months that have spend — totals and the top merchants of each. */
export function expenses(db: DB, months = 12, asOf = today()) {
  const rows = expenseRows(db, asOf);
  const byMonth = new Map<string, ExpenseRow[]>();
  for (const r of rows) byMonth.set(r.month, [...(byMonth.get(r.month) ?? []), r]);
  const keys = [...byMonth.keys()].sort().slice(-months);
  return {
    currentMonth: asOf.slice(0, 7),
    months: keys.map(month => {
      const list = byMonth.get(month)!;
      const merchants = new Map<string, { total: number; count: number; names: Map<string, number> }>();
      for (const r of list) {
        const m = merchants.get(r.merchant) ?? { total: 0, count: 0, names: new Map() };
        m.total += r.amount;
        m.count++;
        m.names.set(r.description, (m.names.get(r.description) ?? 0) + 1);
        merchants.set(r.merchant, m);
      }
      return {
        month,
        total: round(list.reduce((a, r) => a + r.amount, 0)),
        merchants: [...merchants].sort((a, b) => b[1].total - a[1].total).slice(0, 8).map(([key, m]) => ({
          key, name: [...m.names].sort((a, b) => b[1] - a[1])[0][0], total: round(m.total), count: m.count,
        })),
      };
    }),
  };
}

/** `/api/expenses/rows`: the spend rows of a month, optionally of one merchant (its key from /api/expenses). */
export function expenseRowsOf(db: DB, month: string, merchant?: string, asOf = today()) {
  return expenseRows(db, asOf)
    .filter(r => r.month === month && (!merchant || r.merchant === merchant))
    .sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount)
    .map(({ id, date, description, account, amount }) => ({ id, date, description, account, amount }));
}
