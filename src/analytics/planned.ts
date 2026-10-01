import type { DB } from '../db/connection.js';
import { addDays, dayInMonth, loadTransactions, median, merchantKey, round, SHARED_MEMBER_ID, today, type Tx } from './common.js';

/** A one-off expense known in advance that the card / bank hasn't charged yet. */
export interface PlannedItem {
  id: number;
  description: string;
  /** positive ILS, the whole purchase */
  amount: number;
  /** expected purchase date YYYY-MM-DD */
  date: string;
  accountId: string;
  accountKind: 'bank' | 'card' | 'manual';
  installments: number;
  matchPattern: string | null;
  categoryId: number | null;
  memberId: number | null;
  /** whose it is: the member chosen, else the account owner, else shared (like a transaction) */
  effectiveMemberId: number;
  tagIds: number[];
  notes: string | null;
  status: 'planned' | 'matched' | 'cancelled';
  matchedTxnId: number | null;
  /** rows the user said aren't it */
  rejectedTxnIds: number[];
}

/** One payment of a planned item: when it counts as spend and when it leaves the account. */
export interface PlannedPayment {
  itemId: number;
  description: string;
  accountId: string;
  /** 1-based payment number */
  n: number;
  amount: number;
  /** the date the payment counts on in spend / budget (purchase date; installments: the charge date) */
  spendDate: string;
  /** card: the statement month it's charged in (YYYY-MM); bank: null */
  chargeMonth: string | null;
  /** bank: the day it's debited; card: the estimated statement date */
  date: string;
}

/** How far the planned date may be from the real purchase for them to match. */
const MATCH_BEFORE_DAYS = 7;
const MATCH_AFTER_DAYS = 30;

export function listPlanned(db: DB, statuses: PlannedItem['status'][] = ['planned']): PlannedItem[] {
  const rows = db.prepare(`SELECT p.*, a.kind AS account_kind, a.owner_member_id FROM planned_items p JOIN accounts a ON a.id = p.account_id
    WHERE p.status IN (${statuses.map(() => '?').join(',')}) ORDER BY p.date, p.id`).all(...statuses) as Record<string, any>[];
  return rows.map(r => ({
    id: r.id, description: r.description, amount: r.amount, date: r.date, accountId: r.account_id, accountKind: r.account_kind,
    installments: Math.max(1, r.installments ?? 1), matchPattern: r.match_pattern, categoryId: r.category_id, memberId: r.member_id, effectiveMemberId: r.member_id ?? r.owner_member_id ?? SHARED_MEMBER_ID,
    tagIds: r.tag_ids ? JSON.parse(r.tag_ids) : [], notes: r.notes, status: r.status, matchedTxnId: r.matched_txn_id, rejectedTxnIds: r.rejected_txn_ids ? JSON.parse(r.rejected_txn_ids) : [],
  }));
}

const addMonths = (month: string, n: number) => {
  const d = new Date(`${month}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));

/** A card's billing habits from its recent rows: months from purchase to statement, and the statement day. */
export function cardTiming(txs: Tx[], cardId: string): { lag: number; day: number } {
  const rows = txs.filter(t => t.accountId === cardId && t.txnType !== 'installments' && t.processedDate !== t.date).slice(-200);
  const lags = rows.map(t => monthsBetween(t.date.slice(0, 7), t.processedDate.slice(0, 7)));
  const days = rows.map(t => Number(t.processedDate.slice(8, 10)));
  return { lag: lags.length ? Math.max(0, Math.round(median(lags))) : 1, day: days.length ? Math.round(median(days)) : 10 };
}

/** The payments of a planned item: one, or one per installment on consecutive statements / months. */
export function plannedPayments(item: PlannedItem, txs: Tx[]): PlannedPayment[] {
  const per = round(item.amount / item.installments);
  const out: PlannedPayment[] = [];
  const timing = item.accountKind === 'card' ? cardTiming(txs, item.accountId) : null;
  for (let k = 0; k < item.installments; k++) {
    // the last payment takes the rounding remainder
    const amount = k === item.installments - 1 ? round(item.amount - per * (item.installments - 1)) : per;
    if (timing) {
      const chargeMonth = addMonths(item.date.slice(0, 7), timing.lag + k);
      const [y, m] = chargeMonth.split('-').map(Number);
      const date = dayInMonth(y, m - 1, timing.day);
      out.push({ itemId: item.id, description: item.description, accountId: item.accountId, n: k + 1, amount,
        spendDate: item.installments > 1 ? date : item.date, chargeMonth, date });
    } else {
      const [y, m] = addMonths(item.date.slice(0, 7), k).split('-').map(Number);
      const date = dayInMonth(y, m - 1, Number(item.date.slice(8, 10)));
      out.push({ itemId: item.id, description: item.description, accountId: item.accountId, n: k + 1, amount,
        spendDate: date, chargeMonth: null, date });
    }
  }
  return out;
}

/** Real rows that could be this planned expense: same account, close amount, near the planned date. */
export function plannedCandidates(item: PlannedItem, txs: Tx[], claimed: Set<number>): Tx[] {
  const full = item.amount, per = item.amount / item.installments;
  const close = (value: number, target: number) => Math.abs(value - target) <= Math.max(20, target * 0.1);
  const pattern = item.matchPattern?.trim().toLowerCase();
  const from = addDays(item.date, -MATCH_BEFORE_DAYS), to = addDays(item.date, MATCH_AFTER_DAYS);
  return txs.filter(t => t.accountId === item.accountId && t.amount < 0 && !claimed.has(t.id) && !item.rejectedTxnIds.includes(t.id)
    && t.date >= from && t.date <= to
    // an installment purchase is recognised by its first payment (or by the whole amount, if the card reports that)
    && (t.installmentNumber == null || t.installmentNumber <= 1)
    && (close(-t.amount, full) || (item.installments > 1 && close(-t.amount, per)))
    && (!pattern || t.description.toLowerCase().includes(pattern) || t.merchant.includes(merchantKey(pattern))));
}

/** Row ids already taken by a matched planned item (so two items don't claim the same purchase). */
function claimedRows(db: DB): Set<number> {
  return new Set(db.prepare(`SELECT matched_txn_id FROM planned_items WHERE matched_txn_id IS NOT NULL`).pluck().all() as number[]);
}

/**
 * Link a planned item to the real row that charged it: it stops counting, and the category, member
 * and tags chosen in advance move to the real row (and its later installments).
 */
export function linkPlanned(db: DB, itemId: number, txId: number): void {
  const item = listPlanned(db, ['planned', 'matched', 'cancelled']).find(i => i.id === itemId);
  if (!item) throw new Error('planned item not found');
  const tx = db.prepare(`SELECT id, account_id, description, installment_total, category_source FROM transactions WHERE id = ?`).get(txId) as
    { id: number; account_id: string; description: string; installment_total: number | null; category_source: string | null } | undefined;
  if (!tx) throw new Error('transaction not found');
  const rows = tx.installment_total
    ? db.prepare(`SELECT id FROM transactions WHERE account_id = ? AND description = ? AND installment_total = ? AND date >= ?`)
      .pluck().all(tx.account_id, tx.description, tx.installment_total, addDays(item.date, -MATCH_BEFORE_DAYS)) as number[]
    : [tx.id];
  db.transaction(() => {
    db.prepare(`UPDATE planned_items SET status = 'matched', matched_txn_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(txId, itemId);
    for (const id of rows) {
      if (item.categoryId != null) db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'manual', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(item.categoryId, id);
      if (item.memberId != null) db.prepare(`UPDATE transactions SET member_id = ? WHERE id = ? AND member_id IS NULL`).run(item.memberId, id);
      if (item.notes) db.prepare(`UPDATE transactions SET notes = COALESCE(notes, ?) WHERE id = ?`).run(item.notes, id);
      for (const tag of item.tagIds) db.prepare(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`).run(id, tag);
    }
  })();
}

/**
 * Match planned items to rows that arrived: exactly one candidate → matched automatically.
 * Several candidates are left for the user to pick (they show on the planned list).
 */
export function matchPlanned(db: DB, txs: Tx[] = loadTransactions(db)): { matched: number; ambiguous: number } {
  const claimed = claimedRows(db);
  let matched = 0, ambiguous = 0;
  for (const item of listPlanned(db).filter(i => i.accountKind !== 'manual')) {
    const candidates = plannedCandidates(item, txs, claimed);
    if (candidates.length === 1) {
      linkPlanned(db, item.id, candidates[0].id);
      claimed.add(candidates[0].id);
      matched++;
    } else if (candidates.length > 1) ambiguous++;
  }
  return { matched, ambiguous };
}

/** Planned (not yet charged) payments that count as spend between two dates — for the budget and the month plan. */
export function plannedSpend(db: DB, txs: Tx[], from: string, to: string, asOf = today()): (PlannedPayment & { categoryId: number | null; memberId: number })[] {
  return listPlanned(db).flatMap(item => plannedPayments(item, txs)
    // a date that passed without the row arriving is still expected — count it from today
    .map(p => ({ ...p, spendDate: p.spendDate < asOf ? asOf : p.spendDate, categoryId: item.categoryId, memberId: item.effectiveMemberId })))
    .filter(p => p.spendDate >= from && p.spendDate <= to);
}

/** "Not this one": back to planned, and that row is never matched to it again. */
export function unlinkPlanned(db: DB, itemId: number): void {
  const row = db.prepare(`SELECT matched_txn_id, rejected_txn_ids FROM planned_items WHERE id = ?`).get(itemId) as
    { matched_txn_id: number | null; rejected_txn_ids: string | null } | undefined;
  if (!row) return;
  const rejected = [...new Set([...(row.rejected_txn_ids ? JSON.parse(row.rejected_txn_ids) as number[] : []), ...(row.matched_txn_id ? [row.matched_txn_id] : [])])];
  db.prepare(`UPDATE planned_items SET status = 'planned', matched_txn_id = NULL, rejected_txn_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(JSON.stringify(rejected), itemId);
}

/** Past the matching window and the real row still isn't there. */
export const isOverdue = (item: PlannedItem, asOf = today()) => item.status === 'planned' && addDays(item.date, MATCH_AFTER_DAYS) < asOf;
