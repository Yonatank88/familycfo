import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { rmSync } from 'fs';
import { writeSnapshots, backfillBankHistory } from '../src/analytics/snapshots.js';
import { history, summary } from '../src/analytics/summary.js';
import { valueHolding } from '../src/analytics/investments.js';
import { openDb } from '../src/db/connection.js';
import { addAccount, addBalance, addHolding, addTx, rate, testDb } from './helpers.js';

const snaps = (db: ReturnType<typeof testDb>) =>
  db.prepare(`SELECT date, source, bucket, value_ils FROM daily_snapshots ORDER BY date, source, bucket`).all();

describe('snapshots', () => {
  it('are written only for the sources that succeeded; a failed one keeps its last snapshot', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1', 'bank');
    addAccount(db, 'hapoalim:1', 'bank');
    addBalance(db, 'oneZero:1', 1000, '2026-05-01T05:00:00Z');
    addBalance(db, 'hapoalim:1', 500, '2026-05-01T05:00:00Z');
    writeSnapshots(db, [{ source: 'oneZero', kind: 'bank', success: true }, { source: 'hapoalim', kind: 'bank', success: true }], '2026-05-01');
    addBalance(db, 'oneZero:1', 1100, '2026-05-02T05:00:00Z');
    writeSnapshots(db, [{ source: 'oneZero', kind: 'bank', success: true }, { source: 'hapoalim', kind: 'bank', success: false }], '2026-05-02');
    expect(snaps(db)).toEqual([
      { date: '2026-05-01', source: 'hapoalim', bucket: 'bank', value_ils: 500 },
      { date: '2026-05-01', source: 'oneZero', bucket: 'bank', value_ils: 1000 },
      { date: '2026-05-02', source: 'oneZero', bucket: 'bank', value_ils: 1100 },
    ]);
    // the history still counts the failed source with its last known value
    const h = history(db, 'All', 'source', '2026-05-02');
    expect(h.points.at(-1)).toMatchObject({ date: '2026-05-02', bank: 1600, netWorth: 1600 });
  });

  it('values investments per asset class; cards never count as Bank, unbilled charges are Cards owed', () => {
    const db = testDb();
    rate(db, '2026-05-01', 'USD', 3.5);
    addHolding(db, { source: 'ibkr:U1', symbol: 'VOO', quantity: 2, currency: 'USD', assetClass: 'stock', price: 100 });
    addHolding(db, { source: 'ibkr:U1', symbol: 'CASH.USD', quantity: 10, currency: 'USD', assetClass: 'broker_cash', price: 1 });
    addAccount(db, 'max:1', 'card');
    addBalance(db, 'max:1', 9999, '2026-05-01T05:00:00Z');
    addTx(db, { account: 'max:1', date: '2026-04-28', processedDate: '2026-05-10', description: 'Shop', amount: -300 });
    addTx(db, { account: 'max:1', date: '2026-04-01', processedDate: '2026-04-10', description: 'Billed', amount: -100 });
    writeSnapshots(db, [{ source: 'ibkr', kind: 'investment', success: true }, { source: 'max', kind: 'bank', success: true }], '2026-05-01');
    expect(snaps(db)).toEqual([
      { date: '2026-05-01', source: 'ibkr', bucket: 'broker_cash', value_ils: 35 },
      { date: '2026-05-01', source: 'ibkr', bucket: 'stock', value_ils: 700 },
      { date: '2026-05-01', source: 'max', bucket: 'cards_owed', value_ils: -300 },
    ]);
    expect(summary(db, '2026-05-01')).toMatchObject({ netWorth: 435, bank: 0, investments: 735, cardsOwed: 300 });
  });

  it('flags a holding with no exchange rate instead of valuing it 1:1', () => {
    const db = testDb();
    addHolding(db, { source: 'ibkr:U1', symbol: 'VOD.L', quantity: 10, currency: 'GBP', assetClass: 'stock', price: 1 });
    const row = db.prepare(`SELECT * FROM holdings`).get() as Record<string, unknown>;
    expect(valueHolding(db, row, '2026-05-01').valueIls).toBeNull();
    const r = writeSnapshots(db, [{ source: 'ibkr', kind: 'investment', success: true }], '2026-05-01');
    expect(r.flagged).toEqual(['ibkr:VOD.L (GBP)']);
    expect(snaps(db)).toEqual([]);
    expect(summary(db, '2026-05-01').holdings[0]).toMatchObject({ valueIls: null, fxMissing: true });
  });

  it('an investment bucket with no snapshot at the start of the range shows no change', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1', 'bank');
    addBalance(db, 'oneZero:1', 1000, '2026-04-01T05:00:00Z');
    writeSnapshots(db, [{ source: 'oneZero', kind: 'bank', success: true }], '2026-04-01');
    addHolding(db, { source: 'kraken:spot', symbol: 'ETH', quantity: 1, currency: 'ILS', assetClass: 'crypto', price: 10_000 });
    writeSnapshots(db, [{ source: 'kraken', kind: 'investment', success: true }], '2026-05-01');
    const h = history(db, '1M', 'type', '2026-05-01');
    expect(h.start).toEqual({ bank: 1000, investments: null, cardsOwed: null, netWorth: null });
    expect(h.points[0].values).toEqual({ bank: 1000 });
  });
});

describe('bank history backfill', () => {
  const movement = (valueDate: string, at: string, runningBalance: number) =>
    ({ valueDate, movementTimestamp: at, runningBalance: String(runningBalance) });

  it('uses the running balance after each day\'s last movement, carried over days without one', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1', 'bank');
    addTx(db, { account: 'oneZero:1', date: '2026-04-01', description: 'a', amount: -100, raw: movement('2026-04-01', '2026-04-01T08:00:00Z', 900) });
    addTx(db, { account: 'oneZero:1', date: '2026-04-01', description: 'b', amount: -50, raw: movement('2026-04-01', '2026-04-01T12:00:00Z', 850) });
    addTx(db, { account: 'oneZero:1', date: '2026-04-03', description: 'c', amount: 1000, raw: movement('2026-04-03', '2026-04-03T09:00:00Z', 1850) });
    expect(backfillBankHistory(db, 'oneZero', '2026-04-05')).toBe(4);
    expect(snaps(db).map((s: any) => [s.date, s.value_ils])).toEqual([
      ['2026-04-01', 850], ['2026-04-02', 850], ['2026-04-03', 1850], ['2026-04-04', 1850],
    ]);
  });

  it('converts a foreign-currency account with each day\'s rate', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1-USD', 'bank', 'USD');
    rate(db, '2026-04-01', 'USD', 3.5);
    rate(db, '2026-04-02', 'USD', 4);
    addTx(db, { account: 'oneZero:1-USD', date: '2026-04-01', description: 'a', amount: 10, raw: movement('2026-04-01', '2026-04-01T08:00:00Z', 10) });
    backfillBankHistory(db, 'oneZero', '2026-04-03');
    expect(snaps(db).map((s: any) => s.value_ils)).toEqual([35, 40]);
  });

  it('without running balances, walks back from the latest balance over posted rows', () => {
    const db = testDb();
    addAccount(db, 'hapoalim:1', 'bank');
    addTx(db, { account: 'hapoalim:1', date: '2026-04-01', description: 'a', amount: -100 });
    addTx(db, { account: 'hapoalim:1', date: '2026-04-02', description: 'b', amount: 300 });
    addTx(db, { account: 'hapoalim:1', date: '2026-04-02', description: 'pending', amount: -999, status: 'pending' });
    addBalance(db, 'hapoalim:1', 1000, '2026-04-03T07:00:00Z');
    backfillBankHistory(db, 'hapoalim', '2026-04-04');
    expect(snaps(db).map((s: any) => [s.date, s.value_ils])).toEqual([['2026-04-01', 700], ['2026-04-02', 1000], ['2026-04-03', 1000]]);
  });
});

describe('database', () => {
  it('refuses a database with another schema', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/familycfo-old-${process.pid}.db`;
    const old = new Database(path);
    old.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT); INSERT INTO schema_version VALUES (16, 'x')`);
    old.close();
    expect(() => openDb(path)).toThrow(/unsupported database schema/);
    rmSync(path, { force: true });
  });
});
