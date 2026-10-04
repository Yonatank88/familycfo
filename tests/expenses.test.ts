import { describe, expect, it } from 'vitest';
import { expenseRowsOf, expenses } from '../src/analytics/summary.js';
import { cleanMerchantName } from '../src/util.js';
import { expenseBreakdown, expenseRowsIn, nextCharge, remainingInstallments } from '../src/analytics/expenses.js';
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
    expect(april.merchants[0].name).toBe('Shufersal');
  });

  it('lists the rows of a month and merchant', () => {
    const rows = expenseRowsOf(db, '2026-04', { merchant: 'shufersal' }, '2026-05-15');
    expect(rows.map(r => r.amount).sort((a, b) => a - b)).toEqual([-50, 100, 200]);
    expect(rows[0]).toHaveProperty('account');
  });

  it('totals spend by top-level category, uncategorised rows apart', () => {
    const food = Number(db.prepare(`INSERT INTO categories (name) VALUES ('Food')`).run().lastInsertRowid);
    const grocery = Number(db.prepare(`INSERT INTO categories (name, parent_id) VALUES ('Groceries', ?)`).run(food).lastInsertRowid);
    db.prepare(`UPDATE transactions SET category_id = ? WHERE description LIKE 'Shufersal%'`).run(grocery);
    const april = expenses(db, 12, '2026-05-15').months[0];
    expect(april.categories).toEqual([
      { key: String(food), name: 'Food', total: 250, count: 3 },
      { key: 'none', name: 'Uncategorized', total: 30, count: 1 },
    ]);
    expect(expenseRowsOf(db, '2026-04', { category: String(food) }, '2026-05-15')).toHaveLength(3);
    db.prepare(`UPDATE transactions SET category_id = NULL`).run();
    db.prepare(`DELETE FROM categories`).run();
  });

  it('keeps only the last N months with data', () => {
    expect(expenses(db, 1, '2026-05-15').months.map(m => m.month)).toEqual(['2026-05']);
  });
});

describe('merchant name cleaner', () => {
  it('drops a numeric reference after the name', () => {
    expect(cleanMerchantName('ACME STORE/123456')).toBe('ACME STORE');
    expect(cleanMerchantName('Shufersal 456')).toBe('Shufersal');
    expect(cleanMerchantName('PAYPAL *SPOTIFY - 4521')).toBe('PAYPAL *SPOTIFY');
  });
  it('drops a numeric reference before the name (Hebrew statements put it first)', () => {
    expect(cleanMerchantName('12345678/1234/סופר פארם')).toBe('סופר פארם');
    expect(cleanMerchantName('4521 - רמי לוי שיווק')).toBe('רמי לוי שיווק');
  });
  it('drops the installment note on a second line', () => {
    expect(cleanMerchantName('4521 - איקאה נתניה\n(תשלום 2 מתוך 3)')).toBe('איקאה נתניה');
  });
  it('keeps short numbers that are part of the name, and never returns empty', () => {
    expect(cleanMerchantName('7 Eleven')).toBe('7 Eleven');
    expect(cleanMerchantName('Cafe 12')).toBe('Cafe 12');
    expect(cleanMerchantName('123456')).toBe('123456');
  });
});

describe('expenses by card', () => {
  const db = testDb();
  addAccount(db, 'oneZero:1', 'bank');
  addAccount(db, 'isracard:1', 'card');
  addAccount(db, 'max:2', 'card');
  // a card purchase this month and last month
  addTx(db, { account: 'isracard:1', date: '2026-05-03', processedDate: '2026-06-02', description: 'Cafe 12', amount: -40, kind: 'expense' });
  addTx(db, { account: 'isracard:1', date: '2026-04-10', processedDate: '2026-05-02', description: 'Shop', amount: -100, kind: 'expense' });
  // installments 1..3 of 300 each: 1 charged, 2 and 3 to come; plus a second plan fully charged
  addTx(db, { account: 'max:2', date: '2026-04-01', processedDate: '2026-05-02', description: 'IKEA', amount: -300, kind: 'expense', txnType: 'installments', installmentNumber: 1, installmentTotal: 3 });
  addTx(db, { account: 'max:2', date: '2026-04-01', processedDate: '2026-06-02', description: 'IKEA', amount: -300, kind: 'expense', txnType: 'installments', installmentNumber: 2, installmentTotal: 3 });
  addTx(db, { account: 'max:2', date: '2026-01-01', processedDate: '2026-03-02', description: 'Phone', amount: -50, kind: 'expense', txnType: 'installments', installmentNumber: 2, installmentTotal: 2 });
  addTx(db, { account: 'max:2', date: '2026-05-10', processedDate: '2026-06-09', description: 'Books', amount: -20, kind: 'expense' });
  // bank: a debit, a standing order — and a card bill, which never counts
  addTx(db, { account: 'oneZero:1', date: '2026-05-04', description: 'Electric company', amount: -250, kind: 'expense' });
  addTx(db, { account: 'oneZero:1', date: '2026-05-02', description: 'ישראכרט', amount: -140, kind: 'card_payment' });

  it('one source per card plus Bank; card bills never count', () => {
    const b = expenseBreakdown(db, '1Y', undefined, undefined, '2026-05-15');
    expect(b.month).toBe('2026-05');
    expect(b.sources.map(s => [s.key, s.spent, s.previous])).toEqual([
      ['isracard:1', 40, 100], ['max:2', 320, 0], ['bank', 250, 0],
    ]);
    expect(b.bars.find(m => m.month === '2026-05')?.total).toBe(610);
    expect(expenseRowsIn(db, { source: 'bank' }, '2026-05-15').map(r => r.amount)).toEqual([250]);
  });

  it('next charge = the earliest processed date after today, everything charged on it', () => {
    const b = expenseBreakdown(db, '1Y', undefined, undefined, '2026-05-15');
    expect(b.sources.find(s => s.key === 'max:2')?.nextCharge).toEqual({ date: '2026-06-02', amount: 300 });
    expect(nextCharge(db, 'isracard:1', '2026-05-15')).toEqual({ date: '2026-06-02', amount: 40 });
    expect(nextCharge(db, 'isracard:1', '2026-06-02')).toBeNull();
  });

  it('remaining installments = payments after the last one charged, at the latest amount', () => {
    expect(remainingInstallments(db, 'max:2', '2026-05-15')).toEqual({ payments: 2, plans: 1, amount: 600 });
    expect(remainingInstallments(db, 'max:2', '2026-06-05')).toEqual({ payments: 1, plans: 1, amount: 300 });
  });

  it('filters by source; rows carry installment n/N and a cleaned merchant', () => {
    const b = expenseBreakdown(db, '1Y', 'isracard:1', '2026-04', '2026-05-15');
    expect(b.total).toBe(140);
    expect(b.merchants.map(m => m.name)).toEqual(['Shop']); // the month's (April)
    const rows = expenseRowsIn(db, { source: 'max:2', month: '2026-05' }, '2026-05-15');
    expect(rows.map(r => [r.merchant, r.installment])).toEqual([['Books', null], ['IKEA', [1, 3]]]);
  });

  it('a selected month: each source\'s spend in it and the month before, every category with share and the previous month', () => {
    const food = Number(db.prepare(`INSERT INTO categories (name) VALUES ('Food')`).run().lastInsertRowid);
    db.prepare(`UPDATE transactions SET category_id = ? WHERE description IN ('Cafe 12', 'Shop')`).run(food);
    const b = expenseBreakdown(db, '1Y', undefined, '2026-04', '2026-05-15');
    expect(b.month).toBe('2026-04');
    expect(b.months.slice(0, 3)).toEqual(['2026-05', '2026-04', '2026-03']);
    expect(b.sources.map(s => [s.key, s.spent])).toEqual([['isracard:1', 100], ['max:2', 0], ['bank', 0]]);
    expect(b.monthTotal).toBe(100);
    expect(b.categories).toEqual([{ key: String(food), name: 'Food', total: 100, count: 1, share: 100, previous: 0 }]);
    const may = expenseBreakdown(db, '1Y', undefined, '2026-05', '2026-05-15');
    expect(may.categories.find(c => c.key === String(food))).toMatchObject({ total: 40, previous: 100 });
    expect(may.categories.reduce((s, c) => s + c.share, 0)).toBeCloseTo(100, 0);
    // a month after today falls back to this month
    expect(expenseBreakdown(db, '1Y', undefined, '2026-09', '2026-05-15').month).toBe('2026-05');
    db.prepare(`UPDATE transactions SET category_id = NULL`).run();
    db.prepare(`DELETE FROM categories`).run();
  });
});
