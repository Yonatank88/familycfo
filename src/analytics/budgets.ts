import type { DB } from '../db/connection.js';
import {
  cycleByKey, cycleFor, cycleStartDay, daysBetween, filterTx, loadTransactions, median,
  recentCycles, round, today,
} from './common.js';
import { summarizeCycle } from './cashflow.js';
import { plannedSpend } from './planned.js';

export interface BudgetStatus {
  budgetId: number | null;
  categoryId: number;
  categoryName: string;
  parentId: number | null;
  memberId: number | null;
  budget: number | null;
  spent: number;
  pct: number | null;
  /** planned expenses (entered in advance) not charged yet that fall in this cycle */
  planned: number;
  /** spend extrapolated to the end of the cycle, plus the planned expenses */
  projected: number;
  remaining: number | null;
  /** median of the last 3 complete cycles — used as the suggested budget */
  typical: number;
  status: 'ok' | 'warning' | 'over' | 'none';
}

/** Budget vs actual for one cycle (#3). Budgets with member_id null are household-wide. */
export function budgetStatus(db: DB, opts: { cycleKey?: string; memberId?: number; asOf?: string } = {}): BudgetStatus[] {
  const asOf = opts.asOf ?? today();
  const startDay = cycleStartDay(db);
  const cycle = opts.cycleKey ? cycleByKey(opts.cycleKey, startDay) : cycleFor(asOf, startDay);
  const all = loadTransactions(db);
  const txs = filterTx(all, { memberId: opts.memberId });
  const current = summarizeCycle(txs, cycle);
  const past = recentCycles(cycle.start, 4, startDay).slice(0, -1).map(c => summarizeCycle(txs, c));

  const budgets = db.prepare(`
    SELECT b.* FROM budgets b
    WHERE b.effective_from <= ? AND b.member_id IS ?
      AND b.effective_from = (SELECT MAX(effective_from) FROM budgets b2
        WHERE b2.category_id = b.category_id AND b2.member_id IS b.member_id AND b2.effective_from <= ?)
  `).all(cycle.key, opts.memberId ?? null, cycle.key) as
    { id: number; category_id: number; member_id: number | null; monthly_amount: number }[];

  const categories = db.prepare(`SELECT id, name, parent_id FROM categories WHERE kind = 'expense'`).all() as { id: number; name: string; parent_id: number | null }[];
  // a parent category's budget covers its own rows plus all its sub-categories
  const inCategory = (catId: number) => (c: { categoryId: number | null; parentId: number | null }) => c.categoryId === catId || c.parentId === catId;
  const sumOf = (list: { categoryId: number | null; parentId: number | null; spend: number; fixed: number; dynamic: number }[], catId: number) =>
    list.filter(inCategory(catId)).reduce((acc, c) => ({ spend: acc.spend + c.spend, fixed: acc.fixed + c.fixed, dynamic: acc.dynamic + c.dynamic }),
      { spend: 0, fixed: 0, dynamic: 0 });
  const elapsed = Math.min(1, Math.max(0.05, (daysBetween(cycle.start, asOf) + 1) / (daysBetween(cycle.start, cycle.end) + 1)));
  const isCurrent = asOf >= cycle.start && asOf <= cycle.end;
  // planned expenses count in the cycle they fall in (past cycles: only what was really charged)
  const planned = cycle.end >= asOf
    ? plannedSpend(db, all, cycle.start, cycle.end, asOf).filter(p => opts.memberId == null || p.memberId === opts.memberId) : [];
  const parentOf = new Map((db.prepare(`SELECT id, parent_id FROM categories`).all() as { id: number; parent_id: number | null }[]).map(c => [c.id, c.parent_id]));
  const plannedIn = (catId: number) => planned.filter(p => p.categoryId === catId || (p.categoryId != null && parentOf.get(p.categoryId) === catId))
    .reduce((s, p) => s + p.amount, 0);

  return categories.map(cat => {
    const spent = sumOf(current.byCategory, cat.id);
    const b = budgets.find(x => x.category_id === cat.id);
    const typical = round(median(past.map(p => sumOf(p.byCategory, cat.id).spend)));
    const spentAmount = round(spent.spend);
    // fixed costs don't grow linearly through the month, so only extrapolate the dynamic part
    const plannedAmount = round(plannedIn(cat.id));
    const projected = round((isCurrent ? spent.fixed + spent.dynamic / elapsed : spentAmount) + plannedAmount);
    const budget = b?.monthly_amount ?? null;
    const pct = budget ? round((spentAmount / budget) * 100, 0) : null;
    return {
      budgetId: b?.id ?? null,
      categoryId: cat.id,
      categoryName: cat.name,
      parentId: cat.parent_id,
      memberId: b?.member_id ?? null,
      budget,
      spent: spentAmount,
      pct,
      planned: plannedAmount,
      projected,
      remaining: budget != null ? round(budget - spentAmount) : null,
      typical,
      status: budget == null ? 'none' : spentAmount >= budget ? 'over' : pct! >= 80 || projected > budget ? 'warning' : 'ok',
    } satisfies BudgetStatus;
  }).filter(s => s.budget != null || s.spent > 0 || s.typical > 0 || s.planned > 0)
    .sort((a, b) => (b.budget ?? 0) - (a.budget ?? 0) || b.spent - a.spent);
}
