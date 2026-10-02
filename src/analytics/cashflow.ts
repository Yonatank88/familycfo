import type { DB } from '../db/connection.js';
import {
  cycleByKey, cycleFor, cycleStartDay, dateInCycle, filterTx, incomeOf, loadTransactions, median, recentCycles,
  refundOf, round, spendOf, today, trimmedMean, type Cycle, type Tx, type TxFilter,
} from './common.js';

export interface CategorySpend {
  categoryId: number | null;
  name: string;
  parentId: number | null;
  parentName: string | null;
  spend: number;
  fixed: number;
  dynamic: number;
  count: number;
}

export interface CycleSummary {
  cycle: Cycle;
  income: number;
  spend: number;
  fixed: number;
  dynamic: number;
  net: number;
  savingsDeposits: number;
  /** rows in the cycle — used to skip months the database has no data for */
  txCount: number;
  byCategory: CategorySpend[];
  byMember: Record<number, { income: number; spend: number }>;
}

export function summarizeCycle(txs: Tx[], cycle: Cycle): CycleSummary {
  const inCycle = txs.filter(t => t.effectiveDate >= cycle.start && t.effectiveDate <= cycle.end);
  const cats = new Map<string, CategorySpend>();
  const byMember: CycleSummary['byMember'] = {};
  let income = 0, spend = 0, fixed = 0, savingsDeposits = 0;

  for (const t of inCycle) {
    const s = spendOf(t) - refundOf(t);
    const inc = incomeOf(t);
    income += inc;
    spend += s;
    if (t.fixed) fixed += s;
    if (t.kind === 'savings') savingsDeposits += -t.amount;

    if (s !== 0) {
      const key = String(t.categoryId ?? 'none');
      const c = cats.get(key) ?? { categoryId: t.categoryId, name: t.categoryName ?? 'ללא קטגוריה', parentId: t.categoryParentId, parentName: t.categoryParentName, spend: 0, fixed: 0, dynamic: 0, count: 0 };
      c.spend += s;
      if (t.fixed) c.fixed += s; else c.dynamic += s;
      c.count++;
      cats.set(key, c);
    }
    const m = (byMember[t.memberId] ??= { income: 0, spend: 0 });
    m.income += inc;
    m.spend += s;
  }

  const r = (o: Record<number, { income: number; spend: number }>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { income: round(v.income), spend: round(v.spend) }]));
  return {
    cycle,
    income: round(income),
    spend: round(spend),
    fixed: round(fixed),
    dynamic: round(spend - fixed),
    net: round(income - spend),
    savingsDeposits: round(savingsDeposits),
    txCount: inCycle.length,
    byCategory: [...cats.values()].map(c => ({ ...c, spend: round(c.spend), fixed: round(c.fixed), dynamic: round(c.dynamic) }))
      .sort((a, b) => b.spend - a.spend),
    byMember: r(byMember),
  };
}

export function cashflowHistory(db: DB, opts: TxFilter & { cycles?: number; asOf?: string } = {}): CycleSummary[] {
  const txs = filterTx(loadTransactions(db), opts);
  return recentCycles(opts.asOf ?? today(), opts.cycles ?? 6, cycleStartDay(db)).map(c => summarizeCycle(txs, c));
}

export function cycleSummary(db: DB, key: string | undefined, filter: TxFilter = {}): CycleSummary {
  const startDay = cycleStartDay(db);
  const cycle = key ? cycleByKey(key, startDay) : cycleFor(today(), startDay);
  return summarizeCycle(filterTx(loadTransactions(db), filter), cycle);
}

export interface IncomeExpectation {
  recurring: { name: string; accountId: string; typicalAmount: number; typicalDay: number; memberId: number }[];
  recurringTotal: number;
  irregularAverage: number;
  expectedMonthly: number;
}

/** Expected monthly income (#4): recurring income series + average of the irregular rest. */
export function expectedIncome(db: DB, filter: TxFilter = {}, asOf = today()): IncomeExpectation {
  const txs = filterTx(loadTransactions(db), filter);
  const cycles = recentCycles(asOf, 7, cycleStartDay(db)).slice(0, -1); // 6 complete cycles
  const series = db.prepare(`SELECT merchant_key, account_id, typical_amount, typical_day FROM recurring_series
    WHERE active = 1 AND kind IN ('salary','income')`).all() as { merchant_key: string; account_id: string; typical_amount: number; typical_day: number }[];
  const isRecurring = (t: Tx) => series.some(s => s.merchant_key === t.merchant && s.account_id === t.accountId);

  const recurring = series
    .map(s => {
      const sample = txs.find(t => t.merchant === s.merchant_key && t.accountId === s.account_id);
      return sample ? { name: sample.description, accountId: s.account_id, typicalAmount: s.typical_amount, typicalDay: s.typical_day, memberId: sample.memberId } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const irregular = cycles.map(c => txs
    .filter(t => t.effectiveDate >= c.start && t.effectiveDate <= c.end && !isRecurring(t))
    .reduce((s, t) => s + incomeOf(t), 0));
  const recurringTotal = round(recurring.reduce((s, r) => s + r.typicalAmount, 0));
  const irregularAverage = round(median(irregular));
  return { recurring, recurringTotal, irregularAverage, expectedMonthly: round(recurringTotal + irregularAverage) };
}

export interface MonthIncome {
  cycle: Cycle;
  /** household income already in the accounts this cycle */
  received: number;
  /** recurring income (salaries, allowances) that hasn't arrived yet this cycle */
  pending: number;
  /** received + pending — the income of this month, used everywhere a month is planned */
  total: number;
  /** each recurring income: what arrived, or what's still expected and when */
  recurring: { name: string; accountId: string; memberId: number; amount: number; date: string; received: boolean }[];
  /** other income that arrived (one-off, refunds from outside, etc.) */
  other: number;
}

/**
 * The income of one cycle: what already arrived + recurring income still expected before it ends.
 * Past cycles are just what arrived. (The typical month used for long-term savings is expectedIncome.)
 */
export function monthIncome(db: DB, filter: TxFilter = {}, cycle?: Cycle, asOf = today()): MonthIncome {
  cycle ??= cycleFor(asOf, cycleStartDay(db));
  const txs = filterTx(loadTransactions(db), filter);
  const inCycle = txs.filter(t => t.effectiveDate >= cycle.start && t.effectiveDate <= cycle.end && incomeOf(t) > 0);
  const series = db.prepare(`SELECT merchant_key, account_id, typical_amount, typical_day FROM recurring_series
    WHERE active = 1 AND kind IN ('salary','income')`).all() as { merchant_key: string; account_id: string; typical_amount: number; typical_day: number }[];

  const recurring: MonthIncome['recurring'] = [];
  const counted = new Set<number>();
  for (const s of series) {
    const sample = txs.find(t => t.merchant === s.merchant_key && t.accountId === s.account_id);
    if (!sample) continue;
    const rows = inCycle.filter(t => t.merchant === s.merchant_key && t.accountId === s.account_id);
    if (rows.length) {
      rows.forEach(t => counted.add(t.id));
      recurring.push({ name: sample.description, accountId: s.account_id, memberId: sample.memberId,
        amount: round(rows.reduce((sum, t) => sum + incomeOf(t), 0)), date: rows[0].effectiveDate, received: true });
      continue;
    }
    // not in yet: expected on its usual day — unless the cycle is over
    const date = dateInCycle(cycle, s.typical_day);
    if (cycle.end >= asOf) {
      recurring.push({ name: sample.description, accountId: s.account_id, memberId: sample.memberId,
        amount: round(s.typical_amount), date: date < asOf ? asOf : date, received: false });
    }
  }
  const received = round(inCycle.reduce((sum, t) => sum + incomeOf(t), 0));
  const pending = round(recurring.filter(r => !r.received).reduce((sum, r) => sum + r.amount, 0));
  return {
    cycle, received, pending, total: round(received + pending),
    recurring: recurring.sort((a, b) => a.date.localeCompare(b.date)),
    other: round(inCycle.filter(t => !counted.has(t.id)).reduce((sum, t) => sum + incomeOf(t), 0)),
  };
}

/** Average fixed / dynamic spend over the last complete cycles (trimmed). */
export function spendBaseline(db: DB, filter: TxFilter = {}, cycles = 6, asOf = today()) {
  const all = cashflowHistory(db, { ...filter, cycles: cycles + 1, asOf }).slice(0, -1);
  // months the database has (almost) no rows for — before the first scrape, or a gap — would drag
  // the averages to zero and make it look like there's lots left to save; use only covered months
  const maxRows = Math.max(0, ...all.map(h => h.txCount));
  const covered = all.filter(h => h.txCount >= maxRows * 0.4 && h.spend > 0);
  const history = covered.length ? covered : all;
  return {
    income: round(trimmedMean(history.map(h => h.income))),
    fixed: round(trimmedMean(history.map(h => h.fixed))),
    dynamic: round(trimmedMean(history.map(h => h.dynamic))),
    history,
  };
}
