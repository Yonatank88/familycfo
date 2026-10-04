import { describe, expect, it } from 'vitest';
import { expenseRowsOf, expenses } from '../src/analytics/summary.js';
import { addAccount, addTx, testDb } from './helpers.js';

describe('expenses', () => {
  const db = testDb();
  addAccount(db, 'oneZero:1', 'bank');
  addAccount(db, 'max:1', 'card');
  addTx(db, { account: 'oneZero:1', date: '2026-04-03', description: 'Shufersal 123', amount: -200, kind: 'expense' });
  addTx(db, { account: 'oneZero:1', date: '2026-04-20', description: 'Shufersal 456', amount: -100, kind: 'expense' });
  addTx(db, { account: 'max:1', date: '2026-04-21', description: 'Shufersal 456', amount: 50, kind: 'refund' });
  // installment 2 of 3, bought in March, charged in May → May
  addTx(db, { account: 'max:1', date: '2026-03-10', processedDate: '2026-05-02', description: 'IKEA', amount: -400, kind: 'expense', txnType: 'installments', installmentNumber: 2, installmentTotal: 3 });
  // a plain card purchase counts on its purchase date, even when charged the next month
  addTx(db, { account: 'max:1', date: '2026-04-28', processedDate: '2026-05-02', description: 'Cafe', amount: -30, kind: 'expense' });
  // not spend
  addTx(db, { account: 'oneZero:1', date: '2026-04-05', description: 'ויזה', amount: -1000, kind: 'card_payment' });
  addTx(db, { account: 'oneZero:1', date: '2026-04-05', description: 'Interactive Brokers', amount: -5000, kind: 'savings' });
  addTx(db, { account: 'oneZero:1', date: '2026-04-06', description: 'Salary', amount: 9000, kind: 'income' });
  // a future installment isn't counted yet
  addTx(db, { account: 'max:1', date: '2026-03-10', processedDate: '2026-06-02', description: 'IKEA', amount: -400, kind: 'expense', txnType: 'installments', installmentNumber: 3, installmentTotal: 3 });

  it('totals expense minus refunds per calendar month, installments on their charge date', () => {
    const r = expenses(db, 12, '2026-05-15');
    expect(r.currentMonth).toBe('2026-05');
    expect(r.months.map(m => [m.month, m.total])).toEqual([['2026-04', 280], ['2026-05', 400]]);
  });

  it('groups merchants by description without numbers', () => {
    const april = expenses(db, 12, '2026-05-15').months[0];
    expect(april.merchants[0]).toMatchObject({ key: 'shufersal', total: 250, count: 3 });
    expect(april.merchants.map(m => m.key)).toEqual(['shufersal', 'cafe']);
  });

  it('lists the rows of a month and merchant', () => {
    const rows = expenseRowsOf(db, '2026-04', 'shufersal', '2026-05-15');
    expect(rows.map(r => r.amount).sort((a, b) => a - b)).toEqual([-50, 100, 200]);
    expect(rows[0]).toHaveProperty('account');
  });

  it('keeps only the last N months with data', () => {
    expect(expenses(db, 1, '2026-05-15').months.map(m => m.month)).toEqual(['2026-05']);
  });
});
