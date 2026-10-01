import { describe, expect, it } from 'vitest';
import { loadTransactions } from '../src/analytics/common.js';
import { upcomingCardCharges } from '../src/analytics/cards.js';
import { budgetStatus } from '../src/analytics/budgets.js';
import { buildForecast } from '../src/analytics/forecast.js';
import { matchPlanned, plannedPayments, listPlanned, unlinkPlanned } from '../src/analytics/planned.js';
import { monthPlan } from '../src/analytics/commitments.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';

function setup() {
  const db = testDb();
  addAccount(db, 'leumi:1', 'bank');
  addAccount(db, 'max:1', 'card', 1, 'leumi:1');
  // the card charges on the 2nd of the next month
  for (const m of ['07', '08', '09']) {
    for (const d of ['05', '15']) {
      addTx(db, { account: 'max:1', date: `2026-${m}-${d}`, processedDate: `2026-${String(Number(m) + 1).padStart(2, '0')}-02`, description: 'סופר', amount: -300, kind: 'expense' });
    }
  }
  const cat = Number(db.prepare(`INSERT INTO categories (name) VALUES ('ריהוט')`).run().lastInsertRowid);
  const plan = (over: Record<string, unknown> = {}) => Number(db.prepare(`INSERT INTO planned_items (description, amount, date, account_id, installments, category_id)
    VALUES (@description, @amount, @date, @account, @installments, @category)`).run({ description: 'ספה', amount: 1500, date: '2026-10-05', account: 'max:1', installments: 1, category: cat, ...over }).lastInsertRowid);
  return { db, cat, plan };
}

describe('planned expenses', () => {
  it('adds a planned card purchase to the statement it will land in', () => {
    const { db, plan } = setup();
    plan();
    const nov = upcomingCardCharges(db, loadTransactions(db), '2026-09-30').find(c => c.chargeDate.startsWith('2026-11'))!;
    expect(nov).toMatchObject({ projectedPlanned: 1500, plannedItems: [{ name: 'ספה', amount: 1500, n: 1, of: 1 }] });
    // on top of the usual everyday purchases (600)
    expect(nov.expectedAmount).toBe(2100);
  });

  it('spreads installments over consecutive statements', () => {
    const { db, plan } = setup();
    plan({ installments: 3 });
    const [item] = listPlanned(db);
    expect(plannedPayments(item, loadTransactions(db)).map(p => [p.chargeMonth, p.amount])).toEqual([['2026-11', 500], ['2026-12', 500], ['2027-01', 500]]);
  });

  it('matches the real row when it arrives, moves the category to it and stops counting', () => {
    const { db, cat, plan } = setup();
    const id = plan();
    const real = addTx(db, { account: 'max:1', date: '2026-10-06', processedDate: '2026-11-02', description: 'איקאה', amount: -1460, kind: 'expense' });
    expect(matchPlanned(db)).toEqual({ matched: 1, ambiguous: 0 });
    expect(db.prepare(`SELECT status, matched_txn_id FROM planned_items WHERE id = ?`).get(id)).toEqual({ status: 'matched', matched_txn_id: real });
    expect(loadTransactions(db).find(t => t.id === real)).toMatchObject({ categoryId: cat, categorySource: 'manual' });
    const nov = upcomingCardCharges(db, loadTransactions(db), '2026-09-30').find(c => c.chargeDate.startsWith('2026-11'))!;
    expect(nov.projectedPlanned).toBe(0);
  });

  it('never matches a row again after "not this one"', () => {
    const { db, plan } = setup();
    const id = plan();
    addTx(db, { account: 'max:1', date: '2026-10-06', processedDate: '2026-11-02', description: 'אחר', amount: -1500, kind: 'expense' });
    expect(matchPlanned(db).matched).toBe(1);
    unlinkPlanned(db, id);
    expect(matchPlanned(db).matched).toBe(0);
    expect(listPlanned(db)[0]).toMatchObject({ id, status: 'planned', matchedTxnId: null });
  });

  it('leaves it to the user when several rows could be it', () => {
    const { db, plan } = setup();
    plan();
    addTx(db, { account: 'max:1', date: '2026-10-06', processedDate: '2026-11-02', description: 'א', amount: -1500, kind: 'expense' });
    addTx(db, { account: 'max:1', date: '2026-10-09', processedDate: '2026-11-02', description: 'ב', amount: -1520, kind: 'expense' });
    expect(matchPlanned(db)).toEqual({ matched: 0, ambiguous: 1 });
    const p = monthPlan(db, {}, { cycleKey: '2026-10', asOf: '2026-09-30' });
    expect(p.planned.items[0].candidates).toHaveLength(2);
  });

  it('counts in the budget and the month plan of the month it falls in', () => {
    const { db, cat, plan } = setup();
    plan();
    db.prepare(`INSERT INTO budgets (category_id, monthly_amount, effective_from) VALUES (?, 1000, '2026-01')`).run(cat);
    const b = budgetStatus(db, { cycleKey: '2026-10', asOf: '2026-09-30' }).find(x => x.categoryId === cat)!;
    expect(b).toMatchObject({ planned: 1500, projected: 1500, spent: 0 });
    const p = monthPlan(db, {}, { cycleKey: '2026-10', asOf: '2026-09-30' });
    expect(p.planned).toMatchObject({ total: 1500, items: [{ description: 'ספה', amount: 1500, status: 'planned' }] });
  });

  it('puts a planned bank payment in the balance forecast', () => {
    const { db, plan } = setup();
    addBalance(db, 'leumi:1', 5000);
    plan({ account: 'leumi:1', date: '2026-10-12', amount: 800, description: 'חשמלאי' });
    const f = buildForecast(db, { asOf: '2026-09-30' });
    expect(f.events.find(e => e.kind === 'planned')).toMatchObject({ date: '2026-10-12', amount: -800, accountId: 'leumi:1', name: 'חשמלאי' });
  });
});
