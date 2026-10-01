import type { DB } from '../db/connection.js';
import { addDays, cycleFor, cycleStartDay, filterTx, loadTransactions, median, recentCycles, round, spendOf, today, type TxFilter } from './common.js';
import { spendBaseline, summarizeCycle, expectedIncome } from './cashflow.js';
import { buildForecast } from './forecast.js';

export interface SavingsCapacity {
  expectedIncome: number;
  averageFixed: number;
  averageDynamic: number;
  /** one-off large expenses of the last year spread per month (vacations, repairs...) */
  irregularReserve: number;
  /** cycles the averages were taken from (months without data are skipped) */
  monthsUsed: string[];
  /** negative = spending exceeds income */
  monthlyCapacity: number;
  allocation: { fundId: number; name: string; amount: number }[];
}

const LARGE_ONE_OFF = 1500;

/** How much can be put aside every month (#13). */
export function savingsCapacity(db: DB, filter: TxFilter = {}, asOf = today()): SavingsCapacity {
  const baseline = spendBaseline(db, filter, 6, asOf);
  const income = expectedIncome(db, filter, asOf).expectedMonthly || baseline.income;

  // large non-fixed expenses in the last 12 months, excluded from "dynamic" and reserved instead
  const txs = filterTx(loadTransactions(db), filter)
    .filter(t => t.effectiveDate >= addDays(asOf, -365) && t.effectiveDate < cycleFor(asOf, cycleStartDay(db)).start);
  const oneOffs = txs.filter(t => !t.fixed && spendOf(t) >= LARGE_ONE_OFF);
  const monthsCovered = Math.max(1, Math.min(12, new Set(txs.map(t => t.effectiveDate.slice(0, 7))).size));
  const irregularReserve = round(oneOffs.reduce((s, t) => s + spendOf(t), 0) / monthsCovered);
  const oneOffPerMonth = irregularReserve; // already inside the dynamic average
  const dynamic = Math.max(0, baseline.dynamic - oneOffPerMonth);

  // may be negative: spending more than the income leaves nothing to put aside (shown as a shortfall)
  const capacity = round(income - baseline.fixed - dynamic - irregularReserve);
  const funds = db.prepare(`SELECT id, name, monthly_target FROM sinking_funds ORDER BY id`).all() as { id: number; name: string; monthly_target: number }[];
  const targetsTotal = funds.reduce((s, f) => s + f.monthly_target, 0);
  const defaultSplit = [0.5, 0.3, 0.2];
  const allocation = funds.map((f, i) => ({
    fundId: f.id,
    name: f.name,
    amount: round(Math.max(0, capacity) * (targetsTotal > 0 ? f.monthly_target / targetsTotal : defaultSplit[i] ?? 0)),
  }));

  return {
    expectedIncome: round(income),
    averageFixed: baseline.fixed,
    averageDynamic: round(dynamic),
    irregularReserve,
    monthsUsed: baseline.history.map(h => h.cycle.key),
    monthlyCapacity: capacity,
    allocation,
  };
}

export interface TightMonthPlan {
  isTight: boolean;
  reasons: string[];
  /** ILS that must be saved in the rest of the cycle to stay above the buffer */
  gap: number;
  cuts: { categoryId: number | null; name: string; spentSoFar: number; typical: number; projected: number; suggestedCut: number }[];
}

/** Is this a tight month, and where to cut (#14). */
export function tightMonthPlan(db: DB, asOf = today()): TightMonthPlan {
  const forecast = buildForecast(db, { asOf });
  const startDay = cycleStartDay(db);
  const cycle = cycleFor(asOf, startDay);
  const txs = loadTransactions(db);
  const current = summarizeCycle(txs, cycle);
  const past = recentCycles(cycle.start, 4, startDay).slice(0, -1).map(c => summarizeCycle(txs, c));
  const elapsed = Math.max(0.05, (Date.parse(asOf) - Date.parse(cycle.start)) / (Date.parse(cycle.end) - Date.parse(cycle.start) + 86_400_000));

  const reasons: string[] = [];
  const lowestInCycle = forecast.total.points.filter(p => p.date <= cycle.end).reduce((m, p) => Math.min(m, p.expected), Infinity);
  const gap = round(Math.max(0, forecast.buffer - lowestInCycle));
  if (gap > 0) reasons.push(`היתרה הכוללת צפויה לרדת ל-₪${Math.round(lowestInCycle).toLocaleString('he-IL')} — מתחת לכרית של ₪${forecast.buffer.toLocaleString('he-IL')}`);

  const typicalTotal = median(past.map(p => p.dynamic));
  const projectedDynamic = current.dynamic / elapsed;
  if (typicalTotal > 0 && projectedDynamic > typicalTotal * 1.15) {
    reasons.push(`ההוצאות המשתנות בקצב של ₪${Math.round(projectedDynamic).toLocaleString('he-IL')} לעומת ₪${Math.round(typicalTotal).toLocaleString('he-IL')} בחודש רגיל`);
  }

  const discretionaryIds = new Set(txs.filter(t => t.discretionary).map(t => t.categoryId));
  const cuts = current.byCategory
    .filter(c => discretionaryIds.has(c.categoryId) && c.dynamic > 0)
    .map(c => {
      const typical = median(past.map(p => p.byCategory.find(x => x.categoryId === c.categoryId)?.dynamic ?? 0));
      const projected = c.dynamic / elapsed;
      return { categoryId: c.categoryId, name: c.name, spentSoFar: round(c.dynamic), typical: round(typical), projected: round(projected), excess: Math.max(0, projected - typical) };
    })
    .sort((a, b) => b.excess - a.excess || b.projected - a.projected);

  // cut excess first, then spread any remaining gap over the largest discretionary categories
  let need = Math.max(gap, cuts.reduce((s, c) => s + c.excess, 0));
  const plan = cuts.map(c => {
    const remainingInCycle = Math.max(0, c.projected - c.spentSoFar);
    const cut = Math.min(need, remainingInCycle, Math.max(c.excess, gap > 0 ? remainingInCycle * 0.3 : 0));
    need -= cut;
    return { categoryId: c.categoryId, name: c.name, spentSoFar: c.spentSoFar, typical: c.typical, projected: c.projected, suggestedCut: round(cut) };
  }).filter(c => c.suggestedCut > 0);

  return { isTight: reasons.length > 0, reasons, gap, cuts: plan };
}
