import Database from 'better-sqlite3';
import { rmSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { CARD_PAYMENT_PATTERN, deriveKinds, findCategory, kindFor, matchesInvestment } from '../src/ingest/classify.js';
import { matchCurrencyExchanges, reconcileCardBills } from '../src/ingest/transfers.js';
import { CARD_NOT_ITEMISED, TRANSFERS_TO_PEOPLE, applyCategoryRules, ruleCategory } from '../src/categorize/rules.js';
import { categorizeMerchants, type MerchantCategorizer, type MerchantInput } from '../src/categorize/index.js';
import { openDb, type DB } from '../src/db/connection.js';
import { addAccount, addTx, kindOf, testDb } from './helpers.js';

const bank = (description: string, charged_amount: number) => ({ description, charged_amount, account_kind: 'bank', category_kind: null });
const category = (db: DB, id: number) => db.prepare(`SELECT c.name, t.category_source AS source FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id WHERE t.id = ?`).get(id) as { name: string | null; source: string | null };

describe('foreign currency between own accounts', () => {
  it('an FX purchase or sale is a transfer, either leg, even with only one leg scraped', () => {
    expect(kindFor(bank('מטח-קניה', -50))).toBe('transfer');           // Hapoalim (incl. automatic overdraft cover)
    expect(kindFor(bank('רכישת מטח נוכחי', -9000))).toBe('transfer'); // Otsar Hahayal
    expect(kindFor(bank('רכישת מט"ח', -9000))).toBe('transfer');
    expect(kindFor(bank('מטח-קניה', 14))).toBe('transfer');            // the FX account's side
    expect(kindFor(bank('מכירת מט"ח', -100))).toBe('transfer');
    // the fee on an FX transfer is not a transfer; a foreign-trade purchase alone is a wire abroad (spend)
    expect(kindFor(bank('ע\' העברת מט"ח', -8))).toBe('expense');
    expect(kindFor(bank('רכישה-סחר חוץ', -3000))).toBe('expense');
  });

  it('pairs the ILS leg with the FX account inflow of the same bank, by value in ILS', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    addAccount(db, 'hapoalim:1:USD', 'bank', 'USD');
    addAccount(db, 'oneZero:1:USD', 'bank', 'USD');
    db.prepare(`INSERT INTO fx_rates (date, currency, rate_to_ils) VALUES ('2026-08-27', 'USD', 3.7)`).run();
    const ft = addTx(db, { account: 'hapoalim:1', date: '2026-08-28', description: 'רכישה-סחר חוץ', amount: -3700 });
    const usd = addTx(db, { account: 'hapoalim:1:USD', date: '2026-08-28', description: 'F.T.', amount: 1000 });
    const otherBank = addTx(db, { account: 'oneZero:1:USD', date: '2026-08-28', description: 'x', amount: 1000 });
    const lone = addTx(db, { account: 'hapoalim:1', date: '2026-09-20', description: 'רכישה-סחר חוץ', amount: -500 });
    deriveKinds(db, 'all');
    expect(matchCurrencyExchanges(db)).toBe(1);
    expect([kindOf(db, ft), kindOf(db, usd), kindOf(db, otherBank), kindOf(db, lone)]).toEqual(['transfer', 'transfer', 'income', 'expense']);
    expect(db.prepare(`SELECT matched_txn_id FROM transactions WHERE id = ?`).pluck().get(ft)).toBe(usd);
  });
});

describe('investment funding with cut-short names', () => {
  it('matches a broker / exchange by a prefix of its name', () => {
    for (const d of ['Interactivהעברה ל', 'INTERACTIVE BROK', 'העברה לBinanc', 'Bit2C', 'eToro', 'מיטב דש', 'Altshuler Sh', 'IBKR', 'אלטשולר שח'])
      expect([d, matchesInvestment(d)]).toEqual([d, true]);
    for (const d of ['Inter', 'שופרסל', 'העברה ליונתן', 'BIT', 'Interior design', 'קרקע'])
      expect([d, matchesInvestment(d)]).toEqual([d, false]);
    expect(kindFor(bank('Interactivהעברה ל', -5000))).toBe('savings');
  });
});

describe('transfers to people', () => {
  it('stay spend in their own category; to the account holder themself they are a transfer', () => {
    const db = testDb();
    db.prepare(`INSERT INTO categories (name, kind) VALUES (?, 'expense')`).run(TRANSFERS_TO_PEOPLE);
    addAccount(db, 'oneZero:1', 'bank');
    const person = addTx(db, { account: 'oneZero:1', date: '2026-08-01', description: 'העברה לחנן עזר ב', amount: -2000 });
    const viaHolder = addTx(db, { account: 'oneZero:1', date: '2026-08-02', description: 'העברה מ- דנה כהן ל- גל ספיר', amount: -300 });
    const self = addTx(db, { account: 'oneZero:1', date: '2026-08-03', description: 'העברה לדנה כהן', amount: -5000 });
    const bit = addTx(db, { account: 'oneZero:1', date: '2026-08-04', description: 'BIT העברה', amount: -50 });
    deriveKinds(db, 'all');
    expect([kindOf(db, person), kindOf(db, viaHolder), kindOf(db, self), kindOf(db, bit)]).toEqual(['expense', 'expense', 'transfer', 'expense']);
    applyCategoryRules(db);
    for (const id of [person, viaHolder, bit]) expect(category(db, id)).toEqual({ name: TRANSFERS_TO_PEOPLE, source: 'rule' });
    expect(category(db, self).name).toBeNull();
    expect(ruleCategory('Bit2C', 'bank')).toBeNull();
  });
});

describe('bills of cards that are not scraped', () => {
  it('are recognised as card bills (so they reconcile once the card is scraped)', () => {
    for (const d of ['חיוב מ-מקס איט פיננסים', '34685693/מקס איט פיננסים', '0289 - כרטיסי אשראי לי', '0297 - כרטיסי אשראי לי\n(תאריך ערך 30/08)'])
      expect([d, CARD_PAYMENT_PATTERN.test(d)]).toEqual([d, true]);
    expect(kindFor(bank('34685693/מקס איט פיננסים', -3000))).toBe('card_payment');
  });

  it('stay spend, categorised "Credit card (not itemised)"; reconcile with the right company once scraped', () => {
    const db = testDb();
    db.prepare(`INSERT INTO categories (name, kind) VALUES (?, 'expense')`).run(CARD_NOT_ITEMISED);
    addAccount(db, 'otsarHahayal:1', 'bank');
    addAccount(db, 'oneZero:1', 'bank');
    const cal = addTx(db, { account: 'otsarHahayal:1', date: '2026-08-10', description: '0289 - כרטיסי אשראי לי', amount: -1500 });
    const max = addTx(db, { account: 'oneZero:1', date: '2026-08-10', description: 'חיוב מ-מקס איט פיננסים', amount: -2500 });
    deriveKinds(db, 'all');
    reconcileCardBills(db);
    applyCategoryRules(db);
    expect([kindOf(db, cal), kindOf(db, max)]).toEqual(['expense', 'expense']);
    expect([category(db, cal).name, category(db, max).name]).toEqual([CARD_NOT_ITEMISED, CARD_NOT_ITEMISED]);
    // a card row named like a card company is a purchase, not a bill
    expect(ruleCategory('4521 - MAX STOCK', 'card')).toBeNull();

    // the Cal card is scraped now and explains the bill: it's a card payment, and its automatic category goes
    addAccount(db, 'visaCal:1', 'card');
    addTx(db, { account: 'visaCal:1', date: '2026-07-20', processedDate: '2026-08-10', description: 'A', amount: -1500 });
    deriveKinds(db, 'all');
    expect(reconcileCardBills(db)).toEqual({ kept: 1, demoted: 1 });
    applyCategoryRules(db);
    expect([kindOf(db, cal), kindOf(db, max)]).toEqual(['card_payment', 'expense']);
    expect(category(db, cal).name).toBeNull();
  });
});

describe('rules and the AI', () => {
  it('rule rows never reach the AI; rule-only categories are not offered; --unknown re-asks only unknown merchants', async () => {
    const db = testDb();
    const add = (name: string, parent: number | null = null) => Number(db.prepare(`INSERT INTO categories (name, parent_id, kind) VALUES (?, ?, 'expense')`).run(name, parent).lastInsertRowid);
    const other = add('Other'); const unknown = add('Unknown', other); const supermarket = add('Supermarket');
    add(TRANSFERS_TO_PEOPLE); add(CARD_NOT_ITEMISED);
    addAccount(db, 'oneZero:1', 'bank');
    const transfer = addTx(db, { account: 'oneZero:1', date: '2026-08-01', description: 'העברה לחנן', amount: -100, kind: 'expense' });
    const shop = addTx(db, { account: 'oneZero:1', date: '2026-08-02', description: 'שופרסל', amount: -100, kind: 'expense' });
    const odd = addTx(db, { account: 'oneZero:1', date: '2026-08-03', description: 'משהו', amount: -100, kind: 'expense' });
    db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'ai' WHERE id = ?`).run(unknown, transfer);
    const asked: MerchantInput[][] = []; const offered: string[][] = [];
    const ai = (table: Record<string, string>): MerchantCategorizer => async (ms, cats) => {
      asked.push(ms); offered.push(cats.map(c => c.name));
      return ms.map(m => ({ merchant: m.merchant, category: table[m.merchant] ?? 'Unknown', confidence: table[m.merchant] ? 0.9 : 0.2 }));
    };
    await categorizeMerchants(db, { categorizer: ai({ 'שופרסל': 'Supermarket' }), log: () => {} });
    expect(asked[0].map(m => m.merchant).sort()).toEqual(['משהו', 'שופרסל']);
    expect(offered[0]).not.toContain(TRANSFERS_TO_PEOPLE);
    expect(offered[0]).not.toContain(CARD_NOT_ITEMISED);
    expect(category(db, transfer)).toEqual({ name: TRANSFERS_TO_PEOPLE, source: 'rule' }); // the rule beat the AI's answer
    expect(category(db, odd).name).toBe('Unknown');

    await categorizeMerchants(db, { categorizer: ai({ 'משהו': 'Supermarket' }), unknown: true, log: () => {} });
    expect(asked[1].map(m => m.merchant)).toEqual(['משהו']);
    expect([category(db, shop).name, category(db, odd).name]).toEqual(['Supermarket', 'Supermarket']);
    expect(supermarket).toBeGreaterThan(0);
  });
});

describe('categories in English (step 107)', () => {
  it('renames the defaults, keeps the Hebrew names as aliases, adds the rule categories, leaves user categories', () => {
    const fresh = openDb(':memory:');
    const names = fresh.prepare(`SELECT name FROM categories`).pluck().all() as string[];
    expect(names).toEqual(expect.arrayContaining(['Supermarket', 'Groceries & toiletries', 'Unknown', 'Other', TRANSFERS_TO_PEOPLE, CARD_NOT_ITEMISED]));
    expect(names.filter(n => /[֐-׿]/.test(n))).toEqual([]);
    const supermarket = findCategory(fresh, 'Supermarket');
    expect(findCategory(fresh, 'סופרמרקט')).toBe(supermarket);   // the old name
    expect(findCategory(fresh, 'מזון וצריכה')).toBe(supermarket); // a scraper's name, aliased before the rename
    // the tree shape is kept
    expect(fresh.prepare(`SELECT p.name FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.name = 'Supermarket'`).pluck().get())
      .toBe('Groceries & toiletries');

    // a 106 database: a default still in Hebrew, a category the user made, a cached merchant
    const path = `${process.env.TMPDIR ?? '/tmp'}/familycfo-107-${process.pid}.db`;
    openDb(path).close();
    const raw = new Database(path);
    raw.exec(`DELETE FROM schema_version WHERE version = 107;
      DELETE FROM category_aliases WHERE name IN ('סופרמרקט', 'מזון וטואלטיקה');
      UPDATE categories SET name = 'מזון וטואלטיקה' WHERE name = 'Groceries & toiletries';
      UPDATE categories SET name = 'סופרמרקט' WHERE name = 'Supermarket';
      INSERT INTO categories (name, kind) VALUES ('קפה', 'expense');
      INSERT INTO merchant_categories (merchant, category_id, source) SELECT 'שופרסל', id, 'ai' FROM categories WHERE name = 'סופרמרקט'`);
    const id = raw.prepare(`SELECT id FROM categories WHERE name = 'סופרמרקט'`).pluck().get();
    raw.close();
    const db = openDb(path);
    expect(db.prepare(`SELECT name FROM categories WHERE id = ?`).pluck().get(id)).toBe('Supermarket');
    expect(findCategory(db, 'סופרמרקט')).toBe(id);
    expect(db.prepare(`SELECT category_id FROM merchant_categories WHERE merchant = 'שופרסל'`).pluck().get()).toBe(id);
    expect(findCategory(db, 'קפה')).toBeDefined();
    db.close();
    rmSync(path, { force: true });
  });
});
