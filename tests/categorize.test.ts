import { describe, expect, it, vi } from 'vitest';
import { categorizeMerchants, type MerchantAnswer, type MerchantCategorizer, type MerchantInput } from '../src/categorize/index.js';
import { categorizeTransactions } from '../src/ingest/classify.js';
import { runPipeline } from '../src/pipeline.js';
import { merchantKey } from '../src/util.js';
import type { DB } from '../src/db/connection.js';
import { addAccount, addTx, testDb } from './helpers.js';

function seed(db: DB): Record<string, number> {
  const ids: Record<string, number> = {};
  const add = (name: string, parent: string | null, kind = 'expense') => {
    ids[name] = Number(db.prepare(`INSERT INTO categories (name, parent_id, kind) VALUES (?, ?, ?)`).run(name, parent ? ids[parent] : null, kind).lastInsertRowid);
  };
  add('מזון וטואלטיקה', null); add('סופרמרקט', 'מזון וטואלטיקה');
  add('רכב ותחבורה', null); add('דלק וחשמל', 'רכב ותחבורה');
  add('בילוי ומסעדות', null); add('מסעדות ובילויים', 'בילוי ומסעדות');
  add('אחר', null); add('לא ידוע', 'אחר');
  add('העברות כספים', null, 'transfer');
  addAccount(db, 'max:1', 'card');
  addAccount(db, 'onezero:1', 'bank');
  return ids;
}

/** A mocked AI: answers from a merchant → [category, confidence] table, records what it was asked. */
function mockAi(table: Record<string, [string, number]>) {
  const calls: MerchantInput[][] = [];
  const fn: MerchantCategorizer = async merchants => {
    calls.push(merchants);
    return merchants.map((m): MerchantAnswer => ({ merchant: m.merchant, category: table[m.merchant]?.[0] ?? 'לא ידוע', confidence: table[m.merchant]?.[1] ?? 0.2 }));
  };
  return { fn: vi.fn(fn), calls };
}

const row = (db: DB, id: number) => db.prepare(`SELECT category_id, category_source FROM transactions WHERE id = ?`).get(id) as { category_id: number | null; category_source: string | null };
const quiet = { log: () => {} };

describe('merchant normalisation', () => {
  it('strips reference numbers, card suffixes, the bank prefix, company forms and city tails', () => {
    expect(merchantKey('4521 - שופרסל דיל תל אביב')).toBe('שופרסל דיל');
    expect(merchantKey('שופרסל דיל בע"מ')).toBe('שופרסל דיל');
    expect(merchantKey('חיוב מ-ישראכרט בע"מ')).toBe('ישראכרט');
    expect(merchantKey('13795992/8172/ישראכרט בע"מ')).toBe('ישראכרט');
    expect(merchantKey('PAYPAL *SPOTIFY*P45704')).toBe('paypal spotify');
    expect(merchantKey('PAYPAL *SPOTIFY*P469E8')).toBe('paypal spotify');
    expect(merchantKey('סופר יודה הרצל 50 א')).toBe('סופר יודה הרצל');
    expect(merchantKey('משרד הפנים תל-אביב')).toBe('משרד הפנים');
    expect(merchantKey('איקאה נתניה\n(תשלום 2 מתוך 3)')).toBe('איקאה');
    expect(merchantKey('G2A.COM')).toBe('g2a com');
    expect(merchantKey('ירושלים')).toBe('ירושלים'); // never strips the whole name
  });

  it('keeps a municipality\'s city, spelled one way, its property tax and its other services apart', () => {
    for (const d of ['עיריית ת"א', 'עיריית תל אביב', 'עיריית תל אביב יפו א', 'עיריית תל אביב-יפו,א', 'עיריית תל אביב-יפו-ארנונה']) {
      expect(merchantKey(d)).toBe('עיריית תל אביב');
    }
    expect(merchantKey('עיריית תל אביב חנייה')).toBe('עיריית תל אביב חניה');
    expect(merchantKey('עיריית תא יפו חניה ח')).toBe('עיריית תל אביב חניה');
    expect(merchantKey('עיריית רמת גן')).toBe('עיריית רמת גן');
  });
});

describe('AI merchant categorizer', () => {
  it('groups rows by merchant, asks once per merchant, and writes the category with source ai', async () => {
    const db = testDb(); const c = seed(db);
    const a = addTx(db, { account: 'max:1', date: '2026-05-01', description: '4521 - שופרסל דיל תל אביב', amount: -100, kind: 'expense' });
    const b = addTx(db, { account: 'max:1', date: '2026-05-02', description: 'שופרסל דיל בע"מ', amount: -50, kind: 'expense' });
    const f = addTx(db, { account: 'onezero:1', date: '2026-05-03', description: 'פז אפליקצית-YELLOW', amount: -200, kind: 'expense' });
    const ai = mockAi({ 'שופרסל דיל': ['סופרמרקט', 0.95], 'פז אפליקצית yellow': ['דלק וחשמל', 0.9] });
    const res = await categorizeMerchants(db, { categorizer: ai.fn, ...quiet });
    expect(ai.fn).toHaveBeenCalledTimes(1);
    expect(ai.calls[0].map(m => m.merchant).sort()).toEqual(['פז אפליקצית yellow', 'שופרסל דיל']);
    expect(ai.calls[0].find(m => m.merchant === 'שופרסל דיל')!.examples.sort()).toEqual(['שופרסל דיל בע"מ', 'שופרסל דיל תל אביב']);
    expect(row(db, a)).toEqual({ category_id: c['סופרמרקט'], category_source: 'ai' });
    expect(row(db, b)).toEqual({ category_id: c['סופרמרקט'], category_source: 'ai' });
    expect(row(db, f)).toEqual({ category_id: c['דלק וחשמל'], category_source: 'ai' });
    expect(res).toMatchObject({ merchants: 2, asked: 2, answered: 2, rows: 3, failed: null });
    expect(db.prepare(`SELECT merchant, category_id, source, model FROM merchant_categories ORDER BY merchant`).all()).toEqual([
      { merchant: 'פז אפליקצית yellow', category_id: c['דלק וחשמל'], source: 'ai', model: 'claude-sonnet-5-5' },
      { merchant: 'שופרסל דיל', category_id: c['סופרמרקט'], source: 'ai', model: 'claude-sonnet-5-5' },
    ]);
  });

  it('only offers spend categories', async () => {
    const db = testDb(); seed(db);
    addTx(db, { account: 'max:1', date: '2026-05-01', description: 'X', amount: -1, kind: 'expense' });
    const categorizer = vi.fn<MerchantCategorizer>(async () => []);
    await categorizeMerchants(db, { categorizer, ...quiet });
    expect(categorizer.mock.calls[0][1].map(c => c.name)).not.toContain('העברות כספים');
    expect(categorizer.mock.calls[0][1].find(c => c.name === 'סופרמרקט')).toEqual({ name: 'סופרמרקט', parent: 'מזון וטואלטיקה', kind: 'expense' });
  });

  it('a cached merchant is categorised without asking the AI', async () => {
    const db = testDb(); const c = seed(db);
    addTx(db, { account: 'max:1', date: '2026-05-01', description: 'רמי לוי 123', amount: -10, kind: 'expense' });
    await categorizeMerchants(db, { categorizer: mockAi({ 'רמי לוי': ['סופרמרקט', 0.9] }).fn, ...quiet });
    const later = addTx(db, { account: 'max:1', date: '2026-06-01', description: 'רמי לוי 456', amount: -20, kind: 'expense' });
    const ai = mockAi({});
    const res = await categorizeMerchants(db, { categorizer: ai.fn, ...quiet });
    expect(ai.fn).not.toHaveBeenCalled();
    expect(row(db, later)).toEqual({ category_id: c['סופרמרקט'], category_source: 'ai' });
    expect(res).toMatchObject({ asked: 0, rows: 1 });
  });

  it('never touches manual or scraper categories, or rows that are not spend', async () => {
    const db = testDb(); const c = seed(db);
    const manual = addTx(db, { account: 'max:1', date: '2026-05-01', description: 'שופרסל', amount: -10, kind: 'expense', categoryId: c['דלק וחשמל'] });
    db.prepare(`UPDATE transactions SET category_source = 'manual' WHERE id = ?`).run(manual);
    const scraper = addTx(db, { account: 'max:1', date: '2026-05-01', description: 'קפה רומנו', amount: -10, kind: 'expense', categoryId: c['מסעדות ובילויים'] });
    db.prepare(`UPDATE transactions SET category_source = 'scraper' WHERE id = ?`).run(scraper);
    const transfer = addTx(db, { account: 'onezero:1', date: '2026-05-01', description: 'העברה לדני', amount: -10, kind: 'transfer' });
    const income = addTx(db, { account: 'onezero:1', date: '2026-05-01', description: 'משכורת', amount: 10, kind: 'income' });
    const cardPayment = addTx(db, { account: 'onezero:1', date: '2026-05-01', description: 'מקס', amount: -10, kind: 'card_payment' });
    const ai = mockAi({ 'שופרסל': ['סופרמרקט', 0.99], 'קפה רומנו': ['סופרמרקט', 0.99] });
    for (const all of [false, true]) await categorizeMerchants(db, { categorizer: ai.fn, all, ...quiet });
    expect(ai.fn).not.toHaveBeenCalled();
    expect(row(db, manual)).toEqual({ category_id: c['דלק וחשמל'], category_source: 'manual' });
    expect(row(db, scraper)).toEqual({ category_id: c['מסעדות ובילויים'], category_source: 'scraper' });
    for (const id of [transfer, income, cardPayment]) expect(row(db, id)).toEqual({ category_id: null, category_source: null });
  });

  it('--all re-asks merchants the AI categorised before, and moves their rows', async () => {
    const db = testDb(); const c = seed(db);
    const id = addTx(db, { account: 'max:1', date: '2026-05-01', description: 'דרגון', amount: -10, kind: 'expense' });
    await categorizeMerchants(db, { categorizer: mockAi({ 'דרגון': ['סופרמרקט', 0.6] }).fn, ...quiet });
    const ai = mockAi({ 'דרגון': ['מסעדות ובילויים', 0.9] });
    await categorizeMerchants(db, { categorizer: ai.fn, ...quiet });
    expect(ai.fn).not.toHaveBeenCalled();
    await categorizeMerchants(db, { categorizer: ai.fn, all: true, ...quiet });
    expect(ai.fn).toHaveBeenCalledTimes(1);
    expect(row(db, id)).toEqual({ category_id: c['מסעדות ובילויים'], category_source: 'ai' });
  });

  it('a low-confidence or unknown answer lands in the unknown category, cached so it is not asked again', async () => {
    const db = testDb(); const c = seed(db);
    const bit = addTx(db, { account: 'onezero:1', date: '2026-05-01', description: 'BIT העברה', amount: -10, kind: 'expense' });
    const odd = addTx(db, { account: 'max:1', date: '2026-05-01', description: 'yduj', amount: -10, kind: 'expense' });
    const ai = vi.fn<MerchantCategorizer>(async () => [
      { merchant: 'bit העברה', category: 'סופרמרקט', confidence: 0.3 },
      { merchant: 'yduj', category: 'Not a category', confidence: 0.9 },
    ]);
    await categorizeMerchants(db, { categorizer: ai, ...quiet });
    expect(row(db, bit)).toEqual({ category_id: c['לא ידוע'], category_source: 'ai' });
    expect(row(db, odd)).toEqual({ category_id: c['לא ידוע'], category_source: 'ai' });
    expect(db.prepare(`SELECT confidence FROM merchant_categories WHERE merchant = 'yduj'`).pluck().get()).toBe(0);
    addTx(db, { account: 'onezero:1', date: '2026-06-01', description: 'BIT העברה', amount: -10, kind: 'expense' });
    await categorizeMerchants(db, { categorizer: ai, ...quiet });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('learns the scraper category behind an answer as an alias, so it resolves without the AI next time', async () => {
    const db = testDb(); const c = seed(db);
    const id = addTx(db, { account: 'max:1', date: '2026-05-01', description: 'לופה', amount: -10, kind: 'expense' });
    db.prepare(`UPDATE transactions SET source_category = 'מסעדות ובתי קפה' WHERE id = ?`).run(id);
    expect(categorizeTransactions(db)).toBe(0);
    const ai = mockAi({ 'לופה': ['מסעדות ובילויים', 0.9] });
    const res = await categorizeMerchants(db, { categorizer: ai.fn, ...quiet });
    expect(ai.calls[0][0].hint).toBe('מסעדות ובתי קפה');
    expect(res.aliases).toBe(1);
    expect(db.prepare(`SELECT category_id FROM category_aliases WHERE name = 'מסעדות ובתי קפה'`).pluck().get()).toBe(c['מסעדות ובילויים']);
    const next = addTx(db, { account: 'max:1', date: '2026-06-01', description: 'מקום חדש', amount: -10, kind: 'expense' });
    db.prepare(`UPDATE transactions SET source_category = 'מסעדות ובתי קפה' WHERE id = ?`).run(next);
    expect(categorizeTransactions(db)).toBe(1);
    expect(row(db, next)).toEqual({ category_id: c['מסעדות ובילויים'], category_source: 'scraper' });
  });

  it('asks in batches of at most 150 merchants', async () => {
    const db = testDb(); seed(db);
    for (let i = 0; i < 160; i++) addTx(db, { account: 'max:1', date: '2026-05-01', description: `merchant ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, amount: -1, kind: 'expense' });
    const ai = mockAi({});
    await categorizeMerchants(db, { categorizer: ai.fn, ...quiet });
    expect(ai.calls.map(c => c.length)).toEqual([150, 10]);
  });

  it('a failing CLI is logged and never fails the run or the pipeline', async () => {
    const db = testDb(); seed(db);
    const id = addTx(db, { account: 'max:1', date: '2026-05-01', description: 'שופרסל', amount: -10, kind: 'expense' });
    const failing: MerchantCategorizer = async () => { throw new Error('Claude Code (claude) is not installed or not on PATH'); };
    const log = vi.fn();
    const res = await categorizeMerchants(db, { categorizer: failing, log });
    expect(res.failed).toMatch(/not installed/);
    expect(log).toHaveBeenCalled();
    expect(row(db, id)).toEqual({ category_id: null, category_source: null });
    expect(db.prepare(`SELECT COUNT(*) FROM merchant_categories`).pluck().get()).toBe(0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runPipeline(db, { fetchRates: false, categorizer: failing })).resolves.toMatchObject({ merchantRows: 0 });
    vi.restoreAllMocks();
  });
});
