import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { transactionRoutes } from '../src/server/routes/transactions.js';
import { cycleByKey, loadTransactions } from '../src/analytics/common.js';
import { summarizeCycle } from '../src/analytics/cashflow.js';
import { bankBalances } from '../src/analytics/forecast.js';
import { MANUAL_ACCOUNT_ID } from '../src/db/migrations.js';
import { addAccount, addTx, testDb } from './helpers.js';

function setup() {
  const db = testDb();
  addAccount(db, 'bank:1', 'bank');
  const app = Fastify();
  transactionRoutes(app, db);
  return { db, app };
}

describe('manual entries', () => {
  it('adds a cash expense that counts as spend but is not a bank account', async () => {
    const { db, app } = setup();
    const cat = Number(db.prepare(`INSERT INTO categories (name) VALUES ('ניקיון')`).run().lastInsertRowid);
    addTx(db, { account: 'bank:1', date: '2026-09-03', description: 'סופר', amount: -100, kind: 'expense' });
    const res = await app.inject({ method: 'POST', url: '/api/transactions/manual',
      payload: { date: '2026-09-10', description: 'עוזרת בית', amount: 400, categoryId: cat, memberId: 2, notes: 'מזומן' } });
    expect(res.statusCode).toBe(200);
    const tx = res.json();
    expect(tx).toMatchObject({ accountId: MANUAL_ACCOUNT_ID, accountKind: 'manual', date: '2026-09-10', amount: -400, kind: 'expense',
      categoryId: cat, categorySource: 'manual', memberId: 2, notes: 'מזומן' });
    expect(summarizeCycle(loadTransactions(db), cycleByKey('2026-09')).spend).toBe(500);
    expect(bankBalances(db).map(b => b.id)).toEqual(['bank:1']);
  });

  it('edits and deletes only manual rows', async () => {
    const { db, app } = setup();
    const scraped = addTx(db, { account: 'bank:1', date: '2026-09-03', description: 'סופר', amount: -100, kind: 'expense' });
    const { id } = (await app.inject({ method: 'POST', url: '/api/transactions/manual', payload: { date: '2026-09-10', description: 'x', amount: 50 } })).json();
    const edited = await app.inject({ method: 'PUT', url: `/api/transactions/${id}/manual`, payload: { date: '2026-09-11', description: 'ספר', amount: 80, kind: 'income' } });
    expect(edited.json()).toMatchObject({ date: '2026-09-11', description: 'ספר', amount: 80, kind: 'income' });
    expect((await app.inject({ method: 'DELETE', url: `/api/transactions/${scraped}` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/transactions/${scraped}/manual`, payload: { date: '2026-09-11', description: 'a', amount: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/transactions/${id}` })).statusCode).toBe(200);
    expect(loadTransactions(db).map(t => t.id)).toEqual([scraped]);
  });

  it('rejects an entry without a description or amount', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/api/transactions/manual', payload: { date: '2026-09-10', description: ' ', amount: 0 } });
    expect(res.statusCode).toBe(400);
  });
});
