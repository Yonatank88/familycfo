import { describe, expect, it } from 'vitest';
import { averageCost, parseIbkrDate, type CoinEvent } from '../src/sync/history.js';
import { coinEvents, exchangeHistory, krakenCoin, ledgerEvents, type ExchangeClient } from '../src/sync/exchange.js';
import { ibkrOpenedAt, parseFlexStatement } from '../src/sync/ibkr.js';
import { syncHoldings } from '../src/sync/holdings.js';
import { testDb } from './helpers.js';

const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
const usd = async (c: string) => ({ USD: 1, USDT: 1, BTC: 50_000, BNB: 500 } as Record<string, number>)[c] ?? null;

describe('IBKR openDateTime', () => {
  it('parses the Flex date formats', () => {
    expect(parseIbkrDate('20240115;093000')).toBe('2024-01-15');
    expect(parseIbkrDate('20240115')).toBe('2024-01-15');
    expect(parseIbkrDate('2024-01-15, 09:30:00')).toBe('2024-01-15');
    expect(parseIbkrDate('2024-01-15 09:30:00')).toBe('2024-01-15');
    expect(parseIbkrDate('')).toBeNull();
    expect(parseIbkrDate('20241315')).toBeNull();
  });

  it('takes the summary row, else the earliest lot of the same contract', () => {
    expect(ibkrOpenedAt({ conid: '1', openDateTime: '20230301;100000' }, [{ conid: '1', openDateTime: '20220101' }])).toBe('2023-03-01');
    expect(ibkrOpenedAt({ conid: '1', openDateTime: '' }, [
      { conid: '1', openDateTime: '20230601;100000' }, { conid: '1', openDateTime: '20220105;100000' }, { conid: '2', openDateTime: '20200101' },
    ])).toBe('2022-01-05');
    expect(ibkrOpenedAt({ conid: '1', openDateTime: '' }, [])).toBeNull();
  });

  it('carries it and the broker cost on the position', () => {
    const raw = { FlexQueryResponse: { FlexStatements: { FlexStatement: { accountId: 'U1', OpenPositions: { OpenPosition: [
      { levelOfDetail: 'SUMMARY', conid: '9', symbol: 'AAPL', assetCategory: 'STK', listingExchange: 'NASDAQ', currency: 'USD', position: '10', positionValue: '2000', costBasisMoney: '1500', openDateTime: '' },
      { levelOfDetail: 'LOT', conid: '9', symbol: 'AAPL', openDateTime: '20210610;093000' },
    ] } } } } };
    const [account] = parseFlexStatement(raw, { type: 'ibkr', token: 't', queryId: 'q' });
    expect(account.positions[0]).toMatchObject({ symbol: 'AAPL', costBasis: 1500, costSource: 'broker', openedAt: '2021-06-10' });
  });
});

describe('average cost', () => {
  const buy = (d: string, quantity: number, costUsd: number | null): CoinEvent => ({ at: at(d), type: 'buy', quantity, costUsd });
  const sell = (d: string, quantity: number): CoinEvent => ({ at: at(d), type: 'sell', quantity });

  it('averages the buys and keeps the average through a partial sell', () => {
    const r = averageCost([buy('2024-01-10', 1, 100), buy('2024-02-10', 1, 300), sell('2024-03-01', 1)], 1);
    expect(r).toEqual({ openedAt: '2024-01-10', costBasis: 200, costSource: 'trades' });
  });

  it('opens at the first buy after the position was last empty', () => {
    const r = averageCost([buy('2023-01-01', 2, 100), sell('2023-06-01', 2), buy('2024-05-05', 1, 400)], 1);
    expect(r).toEqual({ openedAt: '2024-05-05', costBasis: 400, costSource: 'trades' });
  });

  it('a transfer in has no cost: opened at the deposit, cost unknown', () => {
    const r = averageCost([{ at: at('2022-07-07'), type: 'in', quantity: 3 }], 3);
    expect(r).toEqual({ openedAt: '2022-07-07', costBasis: null, costSource: null });
  });

  it('bought and transferred in: unknown unless the transfer is dust', () => {
    expect(averageCost([buy('2024-01-01', 1, 100), { at: at('2024-02-01'), type: 'in', quantity: 1 }], 2).costBasis).toBeNull();
    expect(averageCost([buy('2024-01-01', 1, 100), { at: at('2024-02-01'), type: 'in', quantity: 0.001 }], 1.001).costBasis).toBeCloseTo(100);
  });

  it('a sell takes the unknown units pro rata', () => {
    // 1 bought + 1 deposited, sell 1.5: 0.25 known-cost + 0.25 unknown remain → still half unknown
    const r = averageCost([buy('2024-01-01', 1, 100), { at: at('2024-01-02'), type: 'in', quantity: 1 }, sell('2024-01-03', 1.5)], 0.5);
    expect(r.costBasis).toBeNull();
    expect(r.openedAt).toBe('2024-01-01');
  });

  it('rewards up to 5% count at zero cost; more is unexplained', () => {
    expect(averageCost([buy('2024-01-01', 1, 100)], 1.03).costBasis).toBe(100);
    expect(averageCost([buy('2024-01-01', 1, 100)], 2).costBasis).toBeNull();
    // fewer units than bought (fees, untracked moves): at the average
    expect(averageCost([buy('2024-01-01', 2, 100)], 1).costBasis).toBe(50);
  });

  it('nothing to go by', () => {
    expect(averageCost([], 5)).toEqual({ openedAt: null, costBasis: null, costSource: null });
  });
});

describe('exchange history', () => {
  it('converts trade costs and fees to USD; a coin fee shrinks the bought units', async () => {
    const events = await coinEvents('ETH', [
      { symbol: 'ETH/BTC', side: 'buy', amount: 1, cost: 0.04, timestamp: at('2024-01-01'), fee: { cost: 1, currency: 'BNB' } },
      { symbol: 'ETH/USDT', side: 'buy', amount: 2, cost: 4000, timestamp: at('2024-02-01'), fee: { cost: 0.002, currency: 'ETH' } },
      { symbol: 'ETH/USDT', side: 'sell', amount: 0.5, cost: 1500, timestamp: at('2024-03-01') },
      { symbol: 'BTC/USDT', side: 'buy', amount: 1, cost: 50_000, timestamp: at('2024-03-02') },
    ], [], usd);
    expect(events).toEqual([
      { at: at('2024-01-01'), type: 'buy', quantity: 1, costUsd: 2000 + 500 },
      { at: at('2024-02-01'), type: 'buy', quantity: 1.998, costUsd: 4000 },
      { at: at('2024-03-01'), type: 'sell', quantity: 0.5 },
    ]);
  });

  it('Binance: trades per held coin on the quote markets that exist, deposits as transfers in, never fails on a refusal', async () => {
    const calls: string[] = [];
    const ex: ExchangeClient = {
      fetchBalance: async () => ({ total: {} }), fetchTickers: async () => ({}),
      loadMarkets: async () => ({ 'SOL/USDT': {}, 'SOL/BTC': {} }),
      fetchMyTrades: async symbol => {
        calls.push(symbol!);
        return symbol === 'SOL/USDT' ? [{ id: '1', symbol, side: 'buy', amount: 10, cost: 1000, timestamp: at('2024-04-01') }] : [];
      },
      fetchDeposits: async since => (since === undefined ? [] : [] as never[]),
      fetchWithdrawals: async () => { throw new Error('Invalid API-key, IP, or permissions for action'); },
    };
    ex.fetchDeposits = async (_code, since) => (since! <= at('2023-12-01') && since! + 90 * 86_400_000 > at('2023-12-01')
      ? [{ currency: 'DOT', amount: 5, timestamp: at('2023-12-01'), status: 'ok' }] : []);
    const h = await exchangeHistory(ex, 'binance', new Map([['SOL', 10], ['DOT', 5]]), usd);
    expect(calls).toEqual(['SOL/USDT', 'SOL/BTC']);
    expect(h.costs.get('SOL')).toEqual({ openedAt: '2024-04-01', costBasis: 1000, costSource: 'trades' });
    expect(h.costs.get('DOT')).toEqual({ openedAt: '2023-12-01', costBasis: null, costSource: null });
    expect(h.warnings).toEqual(['withdrawal history: Invalid API-key, IP, or permissions for action', 'convert history: not supported']);
  });

  it('Binance Convert: a coin that came in via Convert gets its opening date and cost, read in windows of at most 30 days', async () => {
    const windows: [number, number][] = [];
    const ex: ExchangeClient = {
      fetchBalance: async () => ({ total: {} }), fetchTickers: async () => ({}), loadMarkets: async () => ({}),
      fetchMyTrades: async () => [],
      fetchDeposits: async (_c, since) => (since! <= at('2024-01-02') && since! + 90 * 86_400_000 > at('2024-01-02')
        ? [{ currency: 'USDT', amount: 1000, timestamp: at('2024-01-02'), status: 'ok' }] : []),
      fetchWithdrawals: async () => [],
      fetchConvertTradeHistory: async (_c, since, _l, params) => {
        const until = Number(params?.until);
        windows.push([since!, until]);
        const rows = [
          { id: 'a', timestamp: at('2024-01-10'), fromCurrency: 'USDT', fromAmount: 500, toCurrency: 'BNB', toAmount: 1, info: { orderStatus: 'SUCCESS' } },
          { id: 'b', timestamp: at('2024-02-10'), fromCurrency: 'USDT', fromAmount: 400, toCurrency: 'BNB', toAmount: 1, info: { orderStatus: 'SUCCESS' } },
          { id: 'c', timestamp: at('2024-02-11'), fromCurrency: 'USDT', fromAmount: 400, toCurrency: 'BNB', toAmount: 1, info: { orderStatus: 'FAIL' } },
          { id: 'd', timestamp: at('2024-03-10'), fromCurrency: 'BNB', fromAmount: 1, toCurrency: 'USDT', toAmount: 450, info: { orderStatus: 'SUCCESS' } },
        ];
        return rows.filter(r => r.timestamp >= since! && r.timestamp <= until);
      },
    };
    const h = await exchangeHistory(ex, 'binance', new Map([['BNB', 1]]), usd);
    expect(windows.every(([a, b]) => b - a <= 30 * 86_400_000)).toBe(true);
    expect(windows[0][0]).toBe(at('2024-01-02') - 30 * 86_400_000); // a month before the first deposit
    // two units bought for 900, one sold at the average: one unit, cost 450, opened at the first conversion
    expect(h.costs.get('BNB')).toEqual({ openedAt: '2024-01-10', costBasis: 450, costSource: 'trades' });
    expect((h.raw.convert as unknown[]).length).toBe(4);
    expect(h.warnings).toEqual([]);
  });

  it('Binance dust converted to BNB is a BNB buy at the dust coin\'s value, net of the charge', async () => {
    const ex: ExchangeClient = {
      fetchBalance: async () => ({ total: {} }), fetchTickers: async () => ({}), loadMarkets: async () => ({}), fetchMyTrades: async () => [],
      // ccxt flips this one to BNB/USDT buy (that market exists); the raw row is what counts
      fetchMyDustTrades: async () => [{ symbol: 'BNB/USDT', side: 'buy', amount: 0.02, cost: 10, timestamp: at('2024-06-01'),
        info: { fromAsset: 'USDT', amount: '10', transferedAmount: '0.0196', serviceChargeAmount: '0.0004', operateTime: at('2024-06-01') } } as never],
    };
    const h = await exchangeHistory(ex, 'binance', new Map([['BNB', 0.0196]]), usd);
    expect(h.costs.get('BNB')).toEqual({ openedAt: '2024-06-01', costBasis: 10, costSource: 'trades' });
    // a dust coin with no USD price: valued at the BNB it gave
    ex.fetchMyDustTrades = async () => [{ info: { fromAsset: 'NOPRICE', amount: '7', transferedAmount: '0.02', operateTime: at('2024-06-01') } } as never];
    const h2 = await exchangeHistory(ex, 'binance', new Map([['BNB', 0.02]]), usd);
    expect(h2.costs.get('BNB')).toEqual({ openedAt: '2024-06-01', costBasis: 10, costSource: 'trades' });
  });

  it('Binance: the held coin as quote (selling BTC for USDT buys USDT); a refused Convert endpoint is a warning', async () => {
    const calls: string[] = [];
    const ex: ExchangeClient = {
      fetchBalance: async () => ({ total: {} }), fetchTickers: async () => ({}),
      loadMarkets: async () => ({ 'BTC/USDT': {}, 'BTC/FDUSD': {}, 'DOGE/USDT': {} }),
      fetchMyTrades: async symbol => {
        calls.push(symbol!);
        return symbol === 'BTC/USDT' ? [{ id: '1', symbol, side: 'sell', amount: 0.1, cost: 5000, timestamp: at('2024-05-01'),
          fee: { cost: 5, currency: 'USDT' } }] : [];
      },
      fetchConvertTradeHistory: async () => { throw new Error('This endpoint has been disabled'); },
    };
    const h = await exchangeHistory(ex, 'binance', new Map([['USDT', 4995]]), usd);
    expect(calls.sort()).toEqual(['BTC/USDT']); // DOGE is neither held, moved nor a major
    expect(h.costs.get('USDT')).toEqual({ openedAt: '2024-05-01', costBasis: 5000, costSource: 'trades' });
    expect(h.warnings).toEqual(['convert history: This endpoint has been disabled']);
  });

  it('every endpoint refused: nothing derived, the stored values stay', async () => {
    const no = async () => { throw new Error('permission denied'); };
    const ex: ExchangeClient = { fetchBalance: async () => ({ total: {} }), fetchTickers: async () => ({}), fetchMyTrades: no, fetchLedger: no };
    const h = await exchangeHistory(ex, 'kraken', new Map([['ETH', 1]]), usd);
    expect(h.costs.size).toBe(0);
    expect(h.warnings).toHaveLength(2);
  });

  it('Kraken ledger: trade legs give the cost, rewards are free, earn / held balances are the coin', async () => {
    const e = (ref: string, currency: string, type: string, amount: number, d: string, fee = 0, subtype = '') =>
      ({ referenceId: ref, currency, amount: Math.abs(amount), direction: amount < 0 ? 'out' : 'in', timestamp: at(d), fee: { cost: fee }, info: { type, subtype } });
    const ledger = [
      e('A', 'XRP', 'receive', 100, '2024-01-01'), e('A', 'USD.HOLD', 'spend', -60, '2024-01-01', 1),
      e('B', 'XRP.F', 'staking', 2, '2024-02-01'),
      e('C', 'XRP', 'transfer', -50, '2024-02-02', 0, 'autoallocation'), e('C2', 'XRP.F', 'transfer', 50, '2024-02-02', 0, 'autoallocation'),
      e('D', 'XRP', 'trade', -51, '2024-03-01'), e('D', 'ZUSD.F', 'trade', 40, '2024-03-01'),
    ];
    expect(krakenCoin('ZUSD.F')).toBe('USD');
    expect(krakenCoin('USD.HOLD')).toBe('USD');
    const events = await ledgerEvents('XRP', ledger, usd);
    expect(events).toEqual([
      { at: at('2024-01-01'), type: 'buy', quantity: 100, costUsd: 61 },
      { at: at('2024-02-01'), type: 'buy', quantity: 2, costUsd: 0 },
      { at: at('2024-03-01'), type: 'sell', quantity: 51 },
    ]);
    // 102 units for 61, 51 sold at the average → 51 left for 30.5
    expect(averageCost(events, 51)).toEqual({ openedAt: '2024-01-01', costBasis: 30.5, costSource: 'trades' });
  });
});

describe('holdings keep what a run did not determine', () => {
  it('stores opened_at and the cost source; undefined keeps them, null clears them', async () => {
    const db = testDb();
    const sync = (p: Record<string, unknown>) => syncHoldings(db, 'kraken', [{ source: 'kraken:spot', broker: 'Kraken', positions: [
      { symbol: 'ZZZ', yahoo: null, quantity: 1, currency: 'USD', assetClass: 'crypto', price: 10, ...p },
    ] }]);
    const row = () => db.prepare(`SELECT opened_at, cost_basis, cost_basis_source FROM holdings`).get();
    await sync({ openedAt: '2024-01-01', costBasis: 5, costSource: 'trades' });
    expect(row()).toEqual({ opened_at: '2024-01-01', cost_basis: 5, cost_basis_source: 'trades' });
    await sync({});
    expect(row()).toEqual({ opened_at: '2024-01-01', cost_basis: 5, cost_basis_source: 'trades' });
    await sync({ openedAt: null, costBasis: null });
    expect(row()).toEqual({ opened_at: null, cost_basis: null, cost_basis_source: null });
  });
});
