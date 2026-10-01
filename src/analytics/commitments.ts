import type { DB } from '../db/connection.js';
import { commitmentMatchers, cycleByKey, cycleFor, cycleStartDay, dateInCycle, daysBetween, filterTx, loadTransactions, round, spendOf, today,
  type Cycle, type TxFilter } from './common.js';
import { inferBillingAccounts, installmentPlans, upcomingCardCharges } from './cards.js';
import { monthIncome } from './cashflow.js';
import { isOverdue, listPlanned, plannedCandidates, plannedSpend } from './planned.js';

export interface Commitment {
  id: number;
  name: string;
  kind: string;
  status: 'confirmed' | 'suggested';
  categoryId: number | null;
  categoryName: string | null;
  parentId: number | null;
  parentName: string | null;
  /** 'bank' = debited from the account; 'card' = part of that card's monthly charge */
  method: 'bank' | 'card';
  accountId: string;
  memberId: number | null;
  day: number;
  /** the date it's due inside this cycle */
  dueDate: string;
  expected: number;
  actual: number;
  state: 'paid' | 'partial' | 'pending' | 'missing';
  txIds: number[];
  estimated: boolean;
  liabilityId: number | null;
  /** the bank account the money actually leaves: the account itself, or the card's billing account */
  payingAccountId: string | null;
  /** card items: the statement date it's (or will be) charged on */
  chargeDate: string | null;
}

export interface MonthPlan {
  cycle: Cycle;
  asOf: string;
  commitments: Commitment[];
  /** confirmed commitments only */
  fixed: { expected: number; paid: number; remaining: number; total: number };
  /** payments marked fixed (by category or by hand) that aren't in the list */
  otherFixed: { amount: number; count: number };
  installments: { total: number; paid: number; items: { description: string; accountId: string; amount: number; date: string; number: number | null; of: number | null; known: boolean }[] };
  /** the month's income: arrived + recurring still expected (see monthIncome) */
  income: number;
  incomeReceived: number;
  incomePending: number;
  /** one-off expenses entered in advance: the ones falling in this cycle (charged ✓ or still expected) */
  planned: { total: number; items: MonthPlanned[] };
  /** income − fixed − installments − planned (not charged yet) */
  forVariable: number;
  variableSpent: number;
  variableLeft: number;
  daysLeft: number;
  perDayLeft: number;
  /** card → the bank account its statement is paid from (explicit setting, else detected) */
  billing: Record<string, string | null>;
}

export interface MonthPlanned {
  id: number; description: string; accountId: string; accountKind: string; date: string; installments: number;
  /** what of it falls in this cycle */
  amount: number;
  status: 'planned' | 'matched';
  matchedTxnId: number | null;
  categoryId: number | null; memberId: number;
  overdue: boolean;
  /** rows that could be it, when there's more than one (the user picks) */
  candidates: { id: number; description: string; date: string; amount: number }[];
}

interface Row {
  id: number; name: string; kind: string; status: 'confirmed' | 'suggested'; amount: number; amount_mode: string; day_of_month: number;
  bank_account_id: string | null; card_account_id: string | null; member_id: number | null; category_id: number | null;
  liability_id: number | null; start_date: string | null; end_date: string | null;
}

/**
 * The month from its start: what's fixed and known in advance (mortgage, loans, kindergarten,
 * classes, bills — in the list), the installments due, and what that leaves for variable spend.
 */
export function monthPlan(db: DB, filter: TxFilter = {}, opts: { cycleKey?: string; asOf?: string } = {}): MonthPlan {
  const asOf = opts.asOf ?? today();
  const startDay = cycleStartDay(db);
  const cycle = opts.cycleKey ? cycleByKey(opts.cycleKey, startDay) : cycleFor(asOf, startDay);
  const all = loadTransactions(db);
  const txs = filterTx(all, filter);
  const inCycle = txs.filter(t => t.effectiveDate >= cycle.start && t.effectiveDate <= cycle.end);

  const cats = new Map((db.prepare(`SELECT c.id, c.name, c.parent_id, p.name AS parent_name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id`)
    .all() as { id: number; name: string; parent_id: number | null; parent_name: string | null }[]).map(c => [c.id, c]));
  const owners = new Map((db.prepare(`SELECT id, owner_member_id FROM accounts`).all() as { id: string; owner_member_id: number | null }[])
    .map(a => [a.id, a.owner_member_id]));
  const rows = (db.prepare(`SELECT * FROM scheduled_items WHERE status IN ('confirmed','suggested')
    AND kind IN ('fixed_expense','loan','mortgage') AND COALESCE(card_account_id, bank_account_id) IS NOT NULL`).all() as Row[])
    .filter(r => (!r.start_date || r.start_date <= cycle.end) && (!r.end_date || r.end_date >= cycle.start))
    .filter(r => filter.memberId == null || (r.member_id ?? owners.get((r.card_account_id ?? r.bank_account_id)!)) === filter.memberId);
  const matchers = new Map(commitmentMatchers(db, ['confirmed', 'suggested']).map(m => [m.id, m]));
  const billing = inferBillingAccounts(db, all);
  const cardCharges = rows.some(r => r.card_account_id) ? upcomingCardCharges(db, all, asOf) : [];

  // payments matching the same bank row (e.g. three mortgage tracks, one debit) share it by expected amount
  const byRow = new Map<number, Row[]>();
  const hits = new Map<number, number[]>();
  for (const r of rows) {
    const m = matchers.get(r.id);
    const ids = m ? inCycle.filter(t => t.amount < 0 && m.matches(t.accountId, t.description)).map(t => t.id) : [];
    hits.set(r.id, ids);
    for (const id of ids) byRow.set(id, [...(byRow.get(id) ?? []), r]);
  }
  const txById = new Map(inCycle.map(t => [t.id, t]));
  const commitments: Commitment[] = rows.map((r): Commitment => {
    const expected = round(Math.abs(r.amount));
    let actual = 0;
    for (const id of hits.get(r.id)!) {
      const sharing = byRow.get(id)!;
      const weight = Math.abs(r.amount) / sharing.reduce((s, x) => s + Math.abs(x.amount), 0);
      actual += spendOf(txById.get(id)!) * weight;
    }
    actual = round(actual);
    const dueDate = dateInCycle(cycle, r.day_of_month);
    const state: Commitment['state'] = actual >= expected * 0.9 ? 'paid' : actual > 0 ? 'partial' : dueDate < asOf ? 'missing' : 'pending';
    const cat = r.category_id != null ? cats.get(r.category_id) : undefined;
    const accountId = (r.card_account_id ?? r.bank_account_id)!;
    // a card payment leaves the bank with the card's statement: the one that charged it, or the one it's projected into
    let chargeDate: string | null = null;
    if (r.card_account_id) {
      const charged = hits.get(r.id)!.map(id => txById.get(id)!.processedDate).sort().at(-1);
      chargeDate = charged ?? cardCharges.find(c => c.cardAccountId === r.card_account_id
        && c.fixedItems.some(f => f.scheduledId === r.id && f.purchaseDate.slice(0, 7) === dueDate.slice(0, 7)))?.chargeDate ?? null;
    }
    return {
      id: r.id, name: r.name, kind: r.kind, status: r.status,
      categoryId: r.category_id, categoryName: cat?.name ?? null,
      parentId: cat ? cat.parent_id ?? cat.id : null, parentName: cat ? cat.parent_name ?? cat.name : null,
      method: r.card_account_id ? 'card' : 'bank', accountId,
      memberId: r.member_id ?? owners.get(accountId) ?? null,
      day: r.day_of_month, dueDate, expected, actual, state, txIds: hits.get(r.id)!,
      estimated: r.amount_mode === 'estimated', liabilityId: r.liability_id,
      payingAccountId: r.card_account_id ? billing.get(r.card_account_id) ?? null : r.bank_account_id,
      chargeDate,
    };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.expected - a.expected);

  const confirmed = commitments.filter(c => c.status === 'confirmed');
  const fixedExpected = round(confirmed.reduce((s, c) => s + c.expected, 0));
  const fixedPaid = round(confirmed.reduce((s, c) => s + Math.min(c.actual, c.expected), 0));
  const fixedTotal = round(confirmed.reduce((s, c) => s + Math.max(c.actual, c.expected), 0));
  const listed = new Set(confirmed.flatMap(c => c.txIds));
  const other = inCycle.filter(t => t.fixed && !listed.has(t.id) && t.txnType !== 'installments' && spendOf(t) > 0);
  const otherFixed = { amount: round(other.reduce((s, t) => s + spendOf(t), 0)), count: other.length };

  // installments: rows charged in this cycle (scraped, including the months ahead) + ones not reported yet
  const instRows = inCycle.filter(t => t.txnType === 'installments' && spendOf(t) > 0);
  const items = instRows.map(t => ({ description: t.description, accountId: t.accountId, amount: round(spendOf(t)), date: t.effectiveDate,
    number: t.installmentNumber, of: t.installmentTotal, known: true }));
  for (const p of installmentPlans(txs, asOf)) {
    for (const x of p.projected.filter(x => x.date >= cycle.start && x.date <= cycle.end)) {
      items.push({ description: p.description, accountId: p.cardAccountId, amount: x.amount, date: x.date, number: null, of: p.total, known: false });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  const instTotal = round(items.reduce((s, i) => s + i.amount, 0));
  const instPaid = round(items.filter(i => i.known && i.date <= asOf).reduce((s, i) => s + i.amount, 0));

  const monthly = monthIncome(db, filter, cycle, asOf);
  const income = monthly.total;
  // planned one-offs: still expected ones reduce what's left; charged ones are already real rows (matched)
  const claimed = new Set(db.prepare(`SELECT matched_txn_id FROM planned_items WHERE matched_txn_id IS NOT NULL`).pluck().all() as number[]);
  const inThisCycle = new Map<number, number>();
  for (const p of plannedSpend(db, all, cycle.start, cycle.end, asOf)) inThisCycle.set(p.itemId, (inThisCycle.get(p.itemId) ?? 0) + p.amount);
  const plannedItems: MonthPlanned[] = listPlanned(db, ['planned', 'matched'])
    .filter(i => filter.memberId == null || i.effectiveMemberId === filter.memberId)
    .flatMap((i): MonthPlanned[] => {
      if (i.status === 'matched') {
        const t = all.find(x => x.id === i.matchedTxnId);
        if (!t || t.effectiveDate < cycle.start || t.effectiveDate > cycle.end) return [];
        return [{ id: i.id, description: i.description, accountId: i.accountId, accountKind: i.accountKind, date: i.date, installments: i.installments,
          amount: round(spendOf(t)), status: 'matched', matchedTxnId: i.matchedTxnId, categoryId: i.categoryId, memberId: i.effectiveMemberId, overdue: false, candidates: [] }];
      }
      const amount = inThisCycle.get(i.id);
      if (amount == null) return [];
      const candidates = plannedCandidates(i, all, claimed);
      return [{ id: i.id, description: i.description, accountId: i.accountId, accountKind: i.accountKind, date: i.date, installments: i.installments,
        amount: round(amount), status: 'planned', matchedTxnId: null, categoryId: i.categoryId, memberId: i.effectiveMemberId, overdue: isOverdue(i, asOf),
        candidates: candidates.length > 1 ? candidates.map(t => ({ id: t.id, description: t.description, date: t.date, amount: t.amount })) : [] }];
    });
  const plannedPending = round(plannedItems.filter(i => i.status === 'planned').reduce((s, i) => s + i.amount, 0));
  const forVariable = round(income - fixedTotal - otherFixed.amount - instTotal - plannedPending);
  const variableSpent = round(inCycle.filter(t => !t.fixed && t.txnType !== 'installments').reduce((s, t) => s + spendOf(t), 0));
  const variableLeft = round(forVariable - variableSpent);
  const daysLeft = asOf > cycle.end ? 0 : Math.max(1, daysBetween(asOf < cycle.start ? cycle.start : asOf, cycle.end) + 1);

  return {
    cycle, asOf, commitments,
    fixed: { expected: fixedExpected, paid: fixedPaid, remaining: round(fixedExpected - fixedPaid), total: fixedTotal },
    otherFixed,
    installments: { total: instTotal, paid: instPaid, items },
    planned: { total: plannedPending, items: plannedItems },
    income, incomeReceived: monthly.received, incomePending: monthly.pending, forVariable, variableSpent, variableLeft, daysLeft,
    perDayLeft: daysLeft ? round(Math.max(0, variableLeft) / daysLeft) : 0,
    billing: Object.fromEntries(billing),
  };
}
