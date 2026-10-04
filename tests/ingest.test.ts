import { describe, expect, it } from 'vitest';
import { deriveKinds, kindFor } from '../src/ingest/classify.js';
import { matchImmediateCardDebits, matchInternalTransfers, reconcileCardBills } from '../src/ingest/transfers.js';
import { addAccount, addTx, kindOf, testDb } from './helpers.js';

const bank = (description: string, charged_amount: number) => ({ description, charged_amount, account_kind: 'bank', category_kind: null });

describe('kinds', () => {
  it('derives expense, income, refund, card payment and savings', () => {
    expect(kindFor(bank('סופר פארם', -50))).toBe('expense');
    expect(kindFor(bank('משכורת', 10_000))).toBe('income');
    expect(kindFor({ description: 'זיכוי', charged_amount: 30, account_kind: 'card', category_kind: null })).toBe('refund');
    expect(kindFor(bank('ויזה', -2000))).toBe('card_payment');
    expect(kindFor(bank('מסטרקרד', -900))).toBe('card_payment'); // Hapoalim's spelling
    expect(kindFor(bank('חיוב מ-ישראכרט בע"מ', -900))).toBe('card_payment'); // One Zero
    expect(kindFor(bank('13795992/8172/ישראכרט בע"מ', -900))).toBe('card_payment'); // One Zero
    expect(kindFor(bank('העברה לחיסכון', -500))).toBe('savings');
  });

  it('money sent to the broker, exchanges and wallet on-ramps is savings, not spend', () => {
    for (const d of ['Interactive Brokers LLC', 'IBKR', 'BINANCE.COM', 'Kraken', 'Payward Ltd', 'MoonPay', 'העברה לבינאנס']) {
      expect(kindFor(bank(d, -1000))).toBe('savings');
    }
    // a card purchase on an exchange is savings too
    expect(kindFor({ description: 'BINANCE', charged_amount: -300, account_kind: 'card', category_kind: null })).toBe('savings');
    // a withdrawal back from the broker isn't an investment outflow
    expect(kindFor(bank('Interactive Brokers', 1000))).toBe('income');
    expect(kindFor(bank('Super market', -1000))).toBe('expense');
  });

  it('deriveKinds writes the kind of every row', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1', 'bank');
    const a = addTx(db, { account: 'oneZero:1', date: '2026-05-01', description: 'Interactive Brokers', amount: -5000 });
    const b = addTx(db, { account: 'oneZero:1', date: '2026-05-01', description: 'Cafe', amount: -20 });
    deriveKinds(db, 'all');
    expect(kindOf(db, a)).toBe('savings');
    expect(kindOf(db, b)).toBe('expense');
  });
});

describe('card bills', () => {
  it('keeps a bill the scraped card explains and demotes one no card explains', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    addAccount(db, 'isracard:1234', 'card');
    addTx(db, { account: 'isracard:1234', date: '2026-04-05', processedDate: '2026-05-02', description: 'A', amount: -300 });
    addTx(db, { account: 'isracard:1234', date: '2026-04-09', processedDate: '2026-05-02', description: 'B', amount: -200 });
    const bill = addTx(db, { account: 'hapoalim:1', date: '2026-05-02', description: 'ישראכרט', amount: -500, kind: 'card_payment' });
    const stray = addTx(db, { account: 'hapoalim:1', date: '2026-05-20', description: 'מקס', amount: -40, kind: 'card_payment' });
    expect(reconcileCardBills(db)).toMatchObject({ kept: 1, demoted: 1 });
    expect(kindOf(db, bill)).toBe('card_payment');
    expect(kindOf(db, stray)).toBe('expense');
  });

  it('one card charge paid by two bank debits matches both; a bill names its card by number', () => {
    const db = testDb();
    addAccount(db, 'otsarHahayal:1', 'bank');
    addAccount(db, 'visaCal:0289', 'card');
    addAccount(db, 'visaCal:0297', 'card');
    addTx(db, { account: 'visaCal:0289', date: '2026-08-10', processedDate: '2026-08-23', description: 'A', amount: -270 });
    addTx(db, { account: 'visaCal:0289', date: '2026-08-11', processedDate: '2026-08-23', description: 'B', amount: -100 });
    addTx(db, { account: 'visaCal:0297', date: '2026-08-11', processedDate: '2026-08-23', description: 'C', amount: -270 });
    const first = addTx(db, { account: 'otsarHahayal:1', date: '2026-08-23', description: '0289 - כרטיסי אשראי לי', amount: -270, kind: 'card_payment' });
    const second = addTx(db, { account: 'otsarHahayal:1', date: '2026-08-24', description: '0289 - כרטיסי אשראי לי', amount: -100, kind: 'card_payment' });
    const wrongCard = addTx(db, { account: 'otsarHahayal:1', date: '2026-08-23', description: '0297 - כרטיסי אשראי לי', amount: -370, kind: 'card_payment' });
    reconcileCardBills(db);
    expect(kindOf(db, first)).toBe('card_payment');
    expect(kindOf(db, second)).toBe('card_payment');
    expect(kindOf(db, wrongCard)).toBe('expense'); // 0297's charge doesn't explain it, even though 0289's would
  });

  it('a statement-sized bill from before the card data starts stays an expense', () => {
    const db = testDb();
    addAccount(db, 'onezero:1', 'bank');
    addAccount(db, 'isracard:1234', 'card');
    addTx(db, { account: 'isracard:1234', date: '2026-07-10', processedDate: '2026-08-02', description: 'A', amount: -900 });
    addTx(db, { account: 'isracard:1234', date: '2026-06-10', processedDate: '2026-07-02', description: 'Z', amount: -50 });
    const old = addTx(db, { account: 'onezero:1', date: '2026-03-02', description: 'חיוב מ-ישראכרט בע"מ', amount: -4000, kind: 'card_payment' });
    const inRange = addTx(db, { account: 'onezero:1', date: '2026-08-02', description: 'חיוב מ-ישראכרט בע"מ', amount: -4000, kind: 'card_payment' });
    reconcileCardBills(db);
    expect(kindOf(db, old)).toBe('expense');
    expect(kindOf(db, inRange)).toBe('card_payment');
  });

  it('a bill on the card\'s first charge day counts once: the card rows charged with it are covered by it', () => {
    const db = testDb();
    addAccount(db, 'onezero:1', 'bank');
    addAccount(db, 'isracard:1234', 'card');
    // the first charge day: only part of what the bill pays for was scraped
    const first = addTx(db, { account: 'isracard:1234', date: '2026-06-20', processedDate: '2026-07-02', description: 'A', amount: -300, kind: 'expense' });
    const refund = addTx(db, { account: 'isracard:1234', date: '2026-06-21', processedDate: '2026-07-02', description: 'R', amount: 20, kind: 'refund' });
    const manual = addTx(db, { account: 'isracard:1234', date: '2026-06-22', processedDate: '2026-07-02', description: 'M', amount: -50, kind: 'expense' });
    db.prepare(`UPDATE transactions SET kind_source = 'manual' WHERE id = ?`).run(manual);
    const later = addTx(db, { account: 'isracard:1234', date: '2026-07-10', processedDate: '2026-08-02', description: 'B', amount: -900, kind: 'expense' });
    const bill = addTx(db, { account: 'onezero:1', date: '2026-07-02', description: 'חיוב מ-ישראכרט בע"מ', amount: -4000, kind: 'card_payment' });
    expect(reconcileCardBills(db)).toMatchObject({ demoted: 1, covered: 2 });
    expect(kindOf(db, bill)).toBe('expense');
    expect([kindOf(db, first), kindOf(db, refund)]).toEqual(['card_covered', 'card_covered']);
    expect(kindOf(db, manual)).toBe('expense'); // a kind set by hand is never touched
    expect(kindOf(db, later)).toBe('expense');
    // the next pipeline run (kinds reset, then card bills) lands in the same place
    deriveKinds(db, 'all');
    expect(reconcileCardBills(db)).toMatchObject({ demoted: 1, covered: 2 });
    expect(kindOf(db, first)).toBe('card_covered');
  });

  it('once more history explains the first-day bill, the rows it covered are spend again', () => {
    const db = testDb();
    addAccount(db, 'onezero:1', 'bank');
    addAccount(db, 'isracard:1234', 'card');
    const first = addTx(db, { account: 'isracard:1234', date: '2026-06-20', processedDate: '2026-07-02', description: 'A', amount: -3000, kind: 'expense' });
    const refund = addTx(db, { account: 'isracard:1234', date: '2026-06-21', processedDate: '2026-07-02', description: 'R', amount: 20, kind: 'refund' });
    addTx(db, { account: 'isracard:1234', date: '2026-07-10', processedDate: '2026-08-02', description: 'B', amount: -900, kind: 'expense' });
    const bill = addTx(db, { account: 'onezero:1', date: '2026-07-02', description: 'חיוב מ-ישראכרט בע"מ', amount: -4000, kind: 'card_payment' });
    reconcileCardBills(db);
    expect(kindOf(db, first)).toBe('card_covered');
    // an older scrape fills in the rest of that charge day, and an earlier one
    addTx(db, { account: 'isracard:1234', date: '2026-06-15', processedDate: '2026-07-02', description: 'C', amount: -1020, kind: 'expense' });
    addTx(db, { account: 'isracard:1234', date: '2026-05-15', processedDate: '2026-06-02', description: 'D', amount: -100, kind: 'expense' });
    deriveKinds(db, 'all');
    expect(reconcileCardBills(db)).toMatchObject({ covered: 0 });
    expect(kindOf(db, bill)).toBe('card_payment');
    expect([kindOf(db, first), kindOf(db, refund)]).toEqual(['expense', 'refund']);
  });

  it('pairs a debit card charge with its purchase, one to one', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    addAccount(db, 'isracard:1234', 'card');
    const p1 = addTx(db, { account: 'isracard:1234', date: '2026-05-01', description: 'Ad', amount: -79 });
    addTx(db, { account: 'isracard:1234', date: '2026-05-01', description: 'Ad', amount: -79 });
    const b1 = addTx(db, { account: 'hapoalim:1', date: '2026-05-02', description: 'ויזה', amount: -79 });
    const b2 = addTx(db, { account: 'hapoalim:1', date: '2026-05-03', description: 'ויזה', amount: -79 });
    const b3 = addTx(db, { account: 'hapoalim:1', date: '2026-05-03', description: 'ויזה', amount: -79 });
    deriveKinds(db, 'all');
    expect(matchImmediateCardDebits(db).matched).toBe(2);
    expect(kindOf(db, b1)).toBe('card_payment');
    expect(db.prepare(`SELECT matched_txn_id FROM transactions WHERE id = ?`).pluck().get(b1)).toBe(p1);
    // two purchases: only two of the three bank rows can be paired
    expect([b2, b3].filter(id => db.prepare(`SELECT matched_txn_id FROM transactions WHERE id = ?`).pluck().get(id) != null)).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) FROM transactions WHERE matched_txn_id IS NOT NULL`).pluck().get()).toBe(2);
  });

  it('pairs a transfer between own bank accounts', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1', 'bank');
    addAccount(db, 'hapoalim:1', 'bank');
    const out = addTx(db, { account: 'hapoalim:1', date: '2026-05-01', description: 'העברה', amount: -9600, kind: 'expense' });
    const inn = addTx(db, { account: 'oneZero:1', date: '2026-05-03', description: 'העברה', amount: 9600, kind: 'income' });
    const other = addTx(db, { account: 'oneZero:1', date: '2026-05-20', description: 'העברה', amount: 9600, kind: 'income' });
    expect(matchInternalTransfers(db)).toBe(1);
    expect([kindOf(db, out), kindOf(db, inn), kindOf(db, other)]).toEqual(['transfer', 'transfer', 'income']);
  });
});
