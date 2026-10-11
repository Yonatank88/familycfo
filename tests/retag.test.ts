import { describe, expect, it, vi } from 'vitest';
import { categorizeMerchants, type MerchantCategorizer } from '../src/categorize/index.js';
import { merchantCategoryOptions, setMerchantCategory } from '../src/categorize/user.js';
import { runPipeline } from '../src/pipeline.js';
import { merchantKey } from '../src/util.js';
import type { DB } from '../src/db/connection.js';
import { addAccount, addTx, testDb } from './helpers.js';

const MERCHANT = 'מסעדה טובה';

function seed(db: DB): Record<string, number> {
  const ids: Record<string, number> = {};
  for (const n of ['Going out', 'Bills', 'Travel & abroad', 'Groceries', 'Other']) {
    ids[n] = Number(db.prepare(`INSERT INTO categories (name, parent_id, kind) VALUES (?, NULL, 'expense')`).run(n).lastInsertRowid);
  }
  addAccount(db, 'max:1', 'card');
  addAccount(db, 'isracard:1', 'card');
  addAccount(db, 'onezero:1', 'bank');
  return ids;
}

/** The AI always answers Going out, sure of it. */
const goingOut = () => vi.fn<MerchantCategorizer>(async ms => ms.map(m => ({ merchant: m.merchant, category: 'Going out', confidence: 0.9 })));

const rowsOf = (db: DB, ids: number[]) => ids.map(id => db.prepare(`SELECT category_id, category_source, nature FROM transactions WHERE id = ?`).get(id) as
  { category_id: number | null; category_source: string | null; nature: string | null });

/** The merchant on two cards and the bank — one row the AI decides, one the card company categorised, one bought abroad, one refund — and another merchant. */
function scenario(db: DB) {
  const ids = [
    addTx(db, { account: 'max:1', date: '2026-03-05', description: MERCHANT, amount: -120, kind: 'expense' }),
    addTx(db, { account: 'isracard:1', date: '2026-04-10', description: MERCHANT, amount: -90, kind: 'expense' }),
    addTx(db, { account: 'max:1', date: '2026-05-02', description: MERCHANT, amount: -300, kind: 'expense', raw: { isAbroadTransaction: true } }),
    addTx(db, { account: 'onezero:1', date: '2026-05-20', description: MERCHANT, amount: -60, kind: 'expense' }),
    addTx(db, { account: 'isracard:1', date: '2026-05-21', description: MERCHANT, amount: 40, kind: 'refund' }),
  ];
  db.prepare(`UPDATE transactions SET source_category = 'Going out' WHERE id = ?`).run(ids[1]);
  const other = addTx(db, { account: 'max:1', date: '2026-05-03', description: 'קפה שכונתי', amount: -25, kind: 'expense' });
  return { ids, other };
}

describe('re-tagging a merchant', () => {
  it('backfills every row of the merchant (all accounts, all months) and recomputes their nature', async () => {
    const db = testDb();
    const cat = seed(db);
    const { ids, other } = scenario(db);
    await runPipeline(db, { fetchRates: false, categorizer: goingOut() });
    // before: the AI, the card company and the abroad rule each decided a row
    expect(new Set(rowsOf(db, ids).map(r => r.category_source))).toEqual(new Set(['ai', 'scraper', 'rule']));
    expect(rowsOf(db, ids).filter(r => r.nature === 'monthly')).toHaveLength(0);

    const key = merchantKey(MERCHANT);
    expect(setMerchantCategory(db, key, 'Bills').rows).toBe(ids.length);
    for (const r of rowsOf(db, ids)) expect(r).toEqual({ category_id: cat.Bills, category_source: 'manual', nature: 'monthly' });
    expect(rowsOf(db, [other])[0]).toMatchObject({ category_id: cat['Going out'], category_source: 'ai' });
    expect(db.prepare(`SELECT category_id, source FROM merchant_categories WHERE merchant = ?`).get(key)).toEqual({ category_id: cat.Bills, source: 'user' });
  });

  it('survives later pipeline and categoriser runs, and new rows of the merchant follow it', async () => {
    const db = testDb();
    const cat = seed(db);
    const { ids } = scenario(db);
    await runPipeline(db, { fetchRates: false, categorizer: goingOut() });
    setMerchantCategory(db, merchantKey(MERCHANT), 'Groceries');

    const ai = goingOut();
    await runPipeline(db, { fetchRates: false, categorizer: ai });
    await categorizeMerchants(db, { categorizer: ai, all: true, log: () => {} });
    await runPipeline(db, { fetchRates: false, categorizer: false });
    // a new scrape: the card company names a category, and one bought abroad
    const fresh = [
      addTx(db, { account: 'max:1', date: '2026-06-01', description: MERCHANT, amount: -80, kind: 'expense' }),
      addTx(db, { account: 'isracard:1', date: '2026-06-02', description: MERCHANT, amount: -70, kind: 'expense', raw: { countryCode: 'FRA' } }),
    ];
    db.prepare(`UPDATE transactions SET source_category = 'Going out' WHERE id = ?`).run(fresh[0]);
    await runPipeline(db, { fetchRates: false, categorizer: ai });

    for (const r of rowsOf(db, [...ids, ...fresh])) expect(r).toMatchObject({ category_id: cat.Groceries, category_source: 'manual' });
    expect(ai.mock.calls.flatMap(([ms]) => ms.map(m => m.merchant))).not.toContain(merchantKey(MERCHANT));
    expect(db.prepare(`SELECT source FROM merchant_categories WHERE merchant = ?`).pluck().get(merchantKey(MERCHANT))).toBe('user');
  });

  it('changing it again moves the rows; only spend categories are accepted', async () => {
    const db = testDb();
    const cat = seed(db);
    const { ids } = scenario(db);
    await runPipeline(db, { fetchRates: false, categorizer: goingOut() });
    setMerchantCategory(db, merchantKey(MERCHANT), 'Bills');
    expect(setMerchantCategory(db, merchantKey(MERCHANT), 'Travel & abroad').rows).toBe(ids.length);
    for (const r of rowsOf(db, ids)) expect(r).toEqual({ category_id: cat['Travel & abroad'], category_source: 'manual', nature: 'one_off' });
    expect(merchantCategoryOptions(db)).toEqual(['Going out', 'Groceries', 'Bills', 'Travel & abroad', 'Other']);
    expect(() => setMerchantCategory(db, merchantKey(MERCHANT), 'Salary')).toThrow(/category must be one of/);
  });
});
