import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { rmSync } from 'fs';
import { writeSnapshots, backfillBankHistory, backfillAccountBalances, seedAccountBalances } from '../src/analytics/snapshots.js';
import { cashFlow } from '../src/analytics/cashflow.js';
import { history, summary } from '../src/analytics/summary.js';
import { valueHolding } from '../src/analytics/investments.js';
import { openDb } from '../src/db/connection.js';
import { addAccount, addBalance, addHolding, addTx, rate, testDb } from './helpers.js';
import type { DB } from '../src/db/connection.js';

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

  it('a mutual fund holding is its own bucket, shown as Funds', () => {
    const db = testDb();
    addHolding(db, { source: 'bank:funds', symbol: '5111111', quantity: 1, currency: 'ILS', assetClass: 'mutual_fund', price: 2500 });
    addHolding(db, { source: 'bank:funds', symbol: 'TEVA.TA', quantity: 10, currency: 'ILS', assetClass: 'stock', price: 50 });
    writeSnapshots(db, [{ source: 'bank:funds', kind: 'investment', success: true }], '2026-05-01');
    expect(snaps(db)).toEqual([
      { date: '2026-05-01', source: 'bank:funds', bucket: 'mutual_fund', value_ils: 2500 },
      { date: '2026-05-01', source: 'bank:funds', bucket: 'stock', value_ils: 500 },
    ]);
    expect(summary(db, '2026-05-01')).toMatchObject({ investments: 3000, allocation: { type: [{ key: 'funds', label: 'Funds', value: 2500 }, { key: 'stock', label: 'Stocks & ETFs', value: 500 }] } });
  });

  it('gain since purchase comes from the cost basis, in the holding currency', () => {
    const db = testDb();
    rate(db, '2026-05-01', 'USD', 3.5);
    addHolding(db, { source: 'ibkr:U1', symbol: 'VOO', quantity: 10, currency: 'USD', assetClass: 'stock', price: 500 });
    addHolding(db, { source: 'kraken:spot', symbol: 'ETH-USD', quantity: 1, currency: 'USD', assetClass: 'crypto', price: 2000 });
    db.prepare(`UPDATE holdings SET cost_basis = 4000 WHERE symbol = 'VOO'`).run();
    const [eth, voo] = (db.prepare(`SELECT * FROM holdings ORDER BY symbol`).all() as Record<string, unknown>[]).map(r => valueHolding(db, r, '2026-05-01'));
    expect(voo).toMatchObject({ gain: 1000, gainIls: 3500, gainPct: 25 });
    expect(eth).toMatchObject({ gain: null, gainIls: null, gainPct: null });
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

/** The baseline and every step after it. */
const VERSIONS = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];

describe('database', () => {
  it('refuses a database with another schema', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/familycfo-old-${process.pid}.db`;
    const old = new Database(path);
    old.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT); INSERT INTO schema_version VALUES (16, 'x')`);
    old.close();
    expect(() => openDb(path)).toThrow(/unsupported database schema/);
    rmSync(path, { force: true });
  });

  it('upgrades a baseline database with the later steps, keeping every holding', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/familycfo-base-${process.pid}.db`;
    openDb(path).close();
    const db = new Database(path);
    expect(db.prepare(`SELECT version FROM schema_version ORDER BY version`).pluck().all()).toEqual(VERSIONS);
    // back to the baseline: holdings with the old asset classes and no cost_basis, no reports
    db.exec(`DELETE FROM schema_version WHERE version > 100; DROP TABLE merchant_categories; DROP TABLE account_balance_daily; ALTER TABLE accounts DROP COLUMN source; DROP TABLE report_values; DROP TABLE reports; DROP TABLE holdings;
      CREATE TABLE holdings (id INTEGER PRIMARY KEY, source TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT, quantity REAL NOT NULL, currency TEXT,
        asset_class TEXT NOT NULL CHECK (asset_class IN ('stock','crypto','stablecoin','broker_cash')), broker TEXT, manual_price REAL,
        manual_price_date TEXT, archived INTEGER NOT NULL DEFAULT 0, synced_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (source, symbol));
      INSERT INTO holdings (id, source, symbol, quantity, currency, asset_class, archived) VALUES
        (3, 'ibkr:U1', 'VOO', 10, 'USD', 'stock', 0), (7, 'binance:spot', 'BTC-USD', 0.1, 'USD', 'crypto', 1)`);
    db.close();
    const reopened = openDb(path);
    expect(reopened.prepare(`SELECT version FROM schema_version ORDER BY version`).pluck().all()).toEqual(VERSIONS);
    expect(reopened.prepare(`SELECT id, source, symbol, quantity, asset_class, archived, cost_basis FROM holdings ORDER BY id`).all()).toEqual([
      { id: 3, source: 'ibkr:U1', symbol: 'VOO', quantity: 10, asset_class: 'stock', archived: 0, cost_basis: null },
      { id: 7, source: 'binance:spot', symbol: 'BTC-USD', quantity: 0.1, asset_class: 'crypto', archived: 1, cost_basis: null },
    ]);
    reopened.prepare(`INSERT INTO holdings (source, symbol, quantity, asset_class) VALUES ('report:x:1', 'Pension', 1, 'pension')`).run();
    reopened.close();
    rmSync(path, { force: true });
  });

  it('step 103 widens holdings.asset_class to mutual_fund, keeping every row of a 102 database', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/familycfo-102-${process.pid}.db`;
    openDb(path).close();
    const db = new Database(path);
    // back to 102: the step-102 holdings table (no mutual_fund), with rows
    db.exec(`DELETE FROM schema_version WHERE version > 102; DROP TABLE merchant_categories; DROP TABLE account_balance_daily; ALTER TABLE accounts DROP COLUMN source; DROP TABLE holdings; ALTER TABLE report_values DROP COLUMN returns;
      CREATE TABLE holdings (id INTEGER PRIMARY KEY, source TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT, quantity REAL NOT NULL, currency TEXT,
        asset_class TEXT NOT NULL CHECK (asset_class IN ('stock','crypto','stablecoin','broker_cash','pension','study_fund','provident_fund','deposit','other')),
        broker TEXT, manual_price REAL, manual_price_date TEXT, archived INTEGER NOT NULL DEFAULT 0, synced_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, cost_basis REAL, UNIQUE (source, symbol));
      INSERT INTO holdings (id, source, symbol, name, quantity, currency, asset_class, broker, manual_price, manual_price_date, archived, cost_basis) VALUES
        (2, 'ibkr:U1', 'VOO', 'Vanguard', 10, 'USD', 'stock', 'IBKR', NULL, NULL, 0, 4000),
        (5, 'report:x:1', 'Study fund ••0001', 'x', 1, 'ILS', 'study_fund', 'x', 1000, '2026-06-30', 1, NULL)`);
    const before = db.prepare(`SELECT * FROM holdings ORDER BY id`).all();
    db.close();
    const reopened = openDb(path);
    expect(reopened.prepare(`SELECT version FROM schema_version ORDER BY version`).pluck().all()).toEqual(VERSIONS);
    // every row as it was; the later steps' columns empty
    expect(reopened.prepare(`SELECT * FROM holdings ORDER BY id`).all()).toEqual(before.map(r => ({ ...(r as object), opened_at: null, cost_basis_source: null })));
    reopened.prepare(`INSERT INTO holdings (source, symbol, quantity, asset_class) VALUES ('report:y:5111111', 'Fund ••1111', 1, 'mutual_fund')`).run();
    expect(() => reopened.prepare(`INSERT INTO holdings (source, symbol, quantity, asset_class) VALUES ('x', 'y', 1, 'nope')`).run()).toThrow(/CHECK/);
    reopened.close();
    rmSync(path, { force: true });
  });
});

describe('step 104', () => {
  it('adds holdings.opened_at and cost_basis_source to a 103 database, keeping every row', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/familycfo-103-${process.pid}.db`;
    openDb(path).close();
    const db = new Database(path);
    db.exec(`DELETE FROM schema_version WHERE version > 103; DROP TABLE merchant_categories; DROP TABLE account_balance_daily; ALTER TABLE accounts DROP COLUMN source; ALTER TABLE holdings DROP COLUMN opened_at; ALTER TABLE holdings DROP COLUMN cost_basis_source;
      ALTER TABLE report_values DROP COLUMN returns;
      INSERT INTO holdings (id, source, symbol, quantity, currency, asset_class, cost_basis) VALUES (4, 'ibkr:U1', 'VOO', 10, 'USD', 'stock', 4000)`);
    const before = db.prepare(`SELECT * FROM holdings ORDER BY id`).all();
    db.close();
    const reopened = openDb(path);
    expect(reopened.prepare(`SELECT version FROM schema_version ORDER BY version`).pluck().all()).toEqual(VERSIONS);
    expect(reopened.prepare(`SELECT * FROM holdings ORDER BY id`).all()).toEqual(before.map(r => ({ ...(r as object), opened_at: null, cost_basis_source: null })));
    reopened.close();
    rmSync(path, { force: true });
  });
});

describe('step 105', () => {
  it('adds report_values.returns to a 104 database, keeping every value point', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/familycfo-104-${process.pid}.db`;
    openDb(path).close();
    const db = new Database(path);
    db.exec(`DELETE FROM schema_version WHERE version > 104; DROP TABLE merchant_categories; DROP TABLE account_balance_daily; ALTER TABLE accounts DROP COLUMN source; ALTER TABLE report_values DROP COLUMN returns;
      INSERT INTO reports (id, sha256, file, status) VALUES (1, 'x', 'f', 'applied');
      INSERT INTO report_values (report_id, holding_source, product_type, balance, currency, as_of) VALUES (1, 'report:x:1', 'pension', 5, 'ILS', '2026-06-30')`);
    const before = db.prepare(`SELECT * FROM report_values`).all();
    db.close();
    const reopened = openDb(path);
    expect(reopened.prepare(`SELECT version FROM schema_version ORDER BY version`).pluck().all()).toEqual(VERSIONS);
    expect(reopened.prepare(`SELECT * FROM report_values`).all()).toEqual(before.map(r => ({ ...(r as object), returns: null })));
    reopened.close();
    rmSync(path, { force: true });
  });
});

describe('Funds: all fund-type money is one top-level type', () => {
  const fund = (db: DB, source: string, name: string, assetClass: string, value: number) => {
    db.prepare(`INSERT INTO holdings (source, symbol, name, quantity, currency, asset_class, broker, manual_price, manual_price_date)
      VALUES (?, 'x', ?, 1, 'ILS', ?, 'Provider', ?, '2026-05-01')`).run(source, name, assetClass, value);
    db.prepare(`INSERT INTO daily_snapshots (date, source, bucket, value_ils, as_of) VALUES ('2026-05-01', ?, ?, ?, '2026-05-01')`).run(source, assetClass, value);
  };
  const setup = () => {
    const db = testDb();
    fund(db, 'report:a:11110001', 'Alpha Pension', 'pension', 400);
    fund(db, 'report:a:22220002', 'Alpha Study', 'study_fund', 300);
    fund(db, 'report:a:33330003', 'Alpha Study', 'study_fund', 200);
    fund(db, 'report:b:44440004', 'Beta Provident', 'provident_fund', 100);
    fund(db, 'report:c:55550005', 'Gamma Tracker', 'mutual_fund', 50);
    addHolding(db, { source: 'ibkr:U1', symbol: 'VOO', quantity: 1, currency: 'ILS', assetClass: 'stock', price: 500 });
    writeSnapshots(db, [{ source: 'ibkr', kind: 'investment', success: true }], '2026-05-01');
    return db;
  };

  it('groups pension, study, provident and mutual funds into Funds in the allocation and the chart, keeping the stored class', () => {
    const db = setup();
    const s = summary(db, '2026-05-01');
    expect(s.allocation.type).toEqual([{ key: 'funds', label: 'Funds', value: 1050 }, { key: 'stock', label: 'Stocks & ETFs', value: 500 }]);
    const h = history(db, 'All', 'type', '2026-05-01');
    expect(h.series).toEqual([{ key: 'stock', label: 'Stocks & ETFs' }, { key: 'funds', label: 'Funds' }]);
    expect(h.points.at(-1)!.values).toEqual({ stock: 500, funds: 1050 });
    expect(db.prepare(`SELECT DISTINCT bucket FROM daily_snapshots ORDER BY 1`).pluck().all())
      .toEqual(['mutual_fund', 'pension', 'provident_fund', 'stock', 'study_fund']);
  });

  it('gives holdings and accounts the type Funds with the sub-type, named as printed (••last4 only to tell twins apart)', () => {
    const s = summary(setup(), '2026-05-01');
    const funds = s.holdings.filter(h => h.type === 'funds').map(h => [h.label, h.subType]);
    expect(funds).toEqual([['Alpha Pension', 'Pension'], ['\u2068Alpha Study\u2069 ••0002', 'Study fund'], ['\u2068Alpha Study\u2069 ••0003', 'Study fund'],
      ['Beta Provident', 'Provident fund'], ['Gamma Tracker', 'Mutual fund']]);
    expect(s.holdings.find(h => h.symbol === 'VOO')).toMatchObject({ type: 'stock', subType: null, label: 'VOO' });
    expect(s.accounts.filter(a => a.type === 'funds').map(a => a.label)).toContain('\u2068Alpha Study\u2069 ••0002');
    expect(s.allocation.source.map(x => x.label)).toContain('\u2068Alpha Study\u2069 ••0003');
  });
});

describe('per-account daily balances', () => {
  const days = (db: DB) => db.prepare(`SELECT date, account_id, balance, currency, value_ils FROM account_balance_daily ORDER BY account_id, date`).all();

  it('writes one row per bank account (FX at that day\'s rate) only for sources that succeeded, and backfills history', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1', 'bank');
    addAccount(db, 'oneZero:1-USD', 'bank', 'USD');
    addAccount(db, 'hapoalim:1', 'bank');
    for (const [d, r] of [['2026-05-01', 3.6], ['2026-05-02', 3.7], ['2026-05-03', 3.8]] as const) rate(db, d, 'USD', r);
    // ILS: running balances (exact); USD: walked back from the latest balance over its rows
    addTx(db, { account: 'oneZero:1', date: '2026-05-01', description: 'a', amount: -100, raw: { runningBalance: 900, valueDate: '2026-05-01' } });
    addTx(db, { account: 'oneZero:1', date: '2026-05-02', description: 'b', amount: 50, raw: { runningBalance: 950, valueDate: '2026-05-02' } });
    addBalance(db, 'oneZero:1', 950, '2026-05-03T05:00:00Z');
    addTx(db, { account: 'oneZero:1-USD', date: '2026-05-02', description: 'fx in', amount: 10 });
    addBalance(db, 'oneZero:1-USD', 100, '2026-05-03T05:00:00Z');
    addBalance(db, 'hapoalim:1', 500, '2026-05-03T05:00:00Z');
    writeSnapshots(db, [{ source: 'oneZero', kind: 'bank', success: true }, { source: 'hapoalim', kind: 'bank', success: false }], '2026-05-03');
    expect(days(db)).toEqual([
      { date: '2026-05-01', account_id: 'oneZero:1', balance: 900, currency: 'ILS', value_ils: 900 },
      { date: '2026-05-02', account_id: 'oneZero:1', balance: 950, currency: 'ILS', value_ils: 950 },
      { date: '2026-05-03', account_id: 'oneZero:1', balance: 950, currency: 'ILS', value_ils: 950 },
      { date: '2026-05-02', account_id: 'oneZero:1-USD', balance: 100, currency: 'USD', value_ils: 370 },
      { date: '2026-05-03', account_id: 'oneZero:1-USD', balance: 100, currency: 'USD', value_ils: 380 },
    ]);
  });

  it('running balances overwrite, walked-back days only fill; a day without a rate is left out', () => {
    const db = testDb();
    addAccount(db, 'otsarHahayal:1-USD', 'bank', 'USD');
    rate(db, '2026-05-02', 'USD', 3.7);
    addTx(db, { account: 'otsarHahayal:1-USD', date: '2026-05-01', description: 'x', amount: 5 });
    addBalance(db, 'otsarHahayal:1-USD', 20, '2026-05-02T05:00:00Z');
    db.prepare(`INSERT INTO account_balance_daily VALUES ('2026-05-02', 'otsarHahayal:1-USD', 99, 'USD', 1, NULL)`).run();
    const flagged: string[] = [];
    backfillAccountBalances(db, 'otsarHahayal', '2026-05-03', flagged);
    expect(days(db)).toEqual([
      { date: '2026-05-01', account_id: 'otsarHahayal:1-USD', balance: 20, currency: 'USD', value_ils: 74 },
      { date: '2026-05-02', account_id: 'otsarHahayal:1-USD', balance: 99, currency: 'USD', value_ils: 1 },
    ]);
    addAccount(db, 'otsarHahayal:1-EUR', 'bank', 'EUR');
    addBalance(db, 'otsarHahayal:1-EUR', 7, '2026-05-02T05:00:00Z');
    backfillAccountBalances(db, 'otsarHahayal', '2026-05-03', flagged);
    expect(flagged).toEqual(['otsarHahayal:1-EUR on 2026-05-02 (EUR)']);
    expect(days(db)).toHaveLength(2);
  });

  it('seeds a bank with no rows at its latest bank snapshot; the Bank chart has a line per account with its native balance', () => {
    const db = testDb();
    addAccount(db, 'otsarHahayal:1', 'bank');
    addAccount(db, 'otsarHahayal:1-USD', 'bank', 'USD');
    rate(db, '2026-05-02', 'USD', 4);
    addBalance(db, 'otsarHahayal:1', 1000, '2026-05-02T05:00:00Z');
    addBalance(db, 'otsarHahayal:1-USD', 10, '2026-05-02T05:00:00Z');
    db.prepare(`INSERT INTO daily_snapshots VALUES ('2026-05-02', 'otsarHahayal', 'bank', 1040, NULL)`).run();
    expect(seedAccountBalances(db)).toBe(2);
    expect(seedAccountBalances(db)).toBe(0);
    const b = cashFlow(db, '1M', undefined, '2026-05-03').balances;
    expect(b.series.map(s => [s.key, s.currency])).toEqual([['otsarHahayal:1', 'ILS'], ['otsarHahayal:1-USD', 'USD']]);
    expect(b.points.at(-1)).toEqual({ date: '2026-05-03', values: { 'otsarHahayal:1': 1000, 'otsarHahayal:1-USD': 40 },
      native: { 'otsarHahayal:1': 1000, 'otsarHahayal:1-USD': 10 } });
    expect(cashFlow(db, '1M', 'otsarHahayal:1-USD', '2026-05-03').balances.series.map(s => s.key)).toEqual(['otsarHahayal:1-USD']);
  });
});
