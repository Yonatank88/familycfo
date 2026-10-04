import { describe, expect, it } from 'vitest';
import { cashFlow, cashFlowRows } from '../src/analytics/cashflow.js';
import { addAccount, addTx, testDb } from './helpers.js';

describe('cash flow', () => {
  const db = testDb();
  addAccount(db, 'oneZero:1', 'bank');
  addAccount(db, 'hapoalim:2', 'bank');
  addAccount(db, 'max:9', 'card');
  addTx(db, { account: 'oneZero:1', date: '2026-04-01', description: 'Salary', amount: 10_000, kind: 'income' });
  addTx(db, { account: 'oneZero:1', date: '2026-04-03', description: 'ARNONA 123456', amount: -800, kind: 'expense' });
  // a card bill no scraped card explains is a debit purchase: Out
  addTx(db, { account: 'oneZero:1', date: '2026-04-10', description: 'ויזה', amount: -1_200, kind: 'expense' });
  // not in, not out
  addTx(db, { account: 'oneZero:1', date: '2026-04-10', description: 'כאל', amount: -2_000, kind: 'card_payment' });
  addTx(db, { account: 'oneZero:1', date: '2026-04-12', description: 'To Hapoalim', amount: -3_000, kind: 'transfer' });
  addTx(db, { account: 'hapoalim:2', date: '2026-04-12', description: 'From One Zero', amount: 3_000, kind: 'transfer' });
  // moved to savings / investments: its own figure
  addTx(db, { account: 'hapoalim:2', date: '2026-04-20', description: 'Interactive Brokers', amount: -5_000, kind: 'savings' });
  addTx(db, { account: 'hapoalim:2', date: '2026-05-02', description: 'Refund', amount: 150, kind: 'refund' });
  // card rows never count
  addTx(db, { account: 'max:9', date: '2026-04-15', description: 'Cafe', amount: -40, kind: 'expense' });
  // after this month
  addTx(db, { account: 'oneZero:1', date: '2026-06-02', description: 'Future', amount: -99, kind: 'expense' });

  it('counts in / out per month, leaving out own transfers and explained card bills; savings apart', () => {
    // 3M from mid-May starts in February; nothing before April's first row is data
    const r = cashFlow(db, '3M', undefined, '2026-05-15');
    expect(r.months).toEqual([
      { month: '2026-04', in: 10_000, out: 2_000, net: 8_000, moved: 5_000 },
      { month: '2026-05', in: 150, out: 0, net: 150, moved: 0 },
    ]);
    expect(r.totals).toEqual({ in: 10_150, out: 2_000, net: 8_150, moved: 5_000 });
    expect(r.accounts.map(a => a.id)).toEqual(['hapoalim:2', 'oneZero:1']);
  });

  it('filters to one account', () => {
    const r = cashFlow(db, '3M', 'hapoalim:2', '2026-05-15');
    expect(r.totals).toEqual({ in: 150, out: 0, net: 150, moved: 5_000 });
  });

  it("lists a month's rows split in / out, descriptions cleaned", () => {
    const r = cashFlowRows(db, '2026-04', undefined, '2026-05-15');
    expect(r.in.map(x => x.amount)).toEqual([10_000]);
    expect(r.out.map(x => [x.description, x.amount])).toEqual([['ויזה', -1_200], ['ARNONA', -800]]);
    expect(r.moved.map(x => x.amount)).toEqual([-5_000]);
  });
});
