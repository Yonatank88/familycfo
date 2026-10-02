import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb } from './helpers.js';
import type { DB } from '../src/db/connection.js';
import type { Quote } from '../src/analytics/quotes.js';
import { syncHoldings, type SyncedAccount } from '../src/sync/holdings.js';
import { fetchIbkr, ibkrYahooSymbol } from '../src/sync/ibkr.js';
import { fetchWallets } from '../src/sync/wallets.js';
import { fetchExchange, type ExchangeClient } from '../src/sync/exchange.js';
import { syncInvestments } from '../src/sync/index.js';
import { portfolio } from '../src/analytics/investments.js';

vi.mock('../src/ingest/archive.js', () => ({ archiveRaw: vi.fn(() => null) }));

afterEach(() => { vi.unstubAllGlobals(); });

/** Yahoo stand-in: the listed symbols have a quote, anything else is unknown. */
const quotes = (prices: Record<string, [number, string]>) => async (symbol: string): Promise<Quote> => {
  if (!prices[symbol]) throw new Error('not found');
  const [price, currency] = prices[symbol];
  return { symbol, name: symbol, currency, price, previousClose: price, exchange: null, instrumentType: null, marketTime: null };
};

const holdings = (db: DB) => db.prepare(`SELECT symbol, quantity, currency, buy_price, baseline_price, manual_price, broker, archived
  FROM holdings ORDER BY symbol`).all() as Record<string, unknown>[];

const ibkrAccount = (positions: SyncedAccount['positions']): SyncedAccount => ({ source: 'ibkr:U1', broker: 'IBKR', ownerMemberId: 1, positions });

describe('syncing holdings from a source', () => {
  it('adds positions priced live, falls back to the source price, and keeps the cost as the buy price', async () => {
    const db = testDb();
    const r = await syncHoldings(db, 'ibkr', [ibkrAccount([
      { symbol: 'VOO', yahoo: 'VOO', quantity: 10, currency: 'USD', price: 500, costPrice: 400 },
      // no Yahoo quote for it
      { symbol: 'AAPL 270115C00200000', yahoo: null, quantity: 1, currency: 'USD', price: 1250 },
      // the ticker exists but it's something else (price far off) → the source's price
      { symbol: 'XYZ', yahoo: 'XYZ', quantity: 5, currency: 'USD', price: 10 },
      { symbol: 'CASH.USD', yahoo: null, quantity: 2000, currency: 'USD', price: 1 },
    ])], { fetchQuote: quotes({ VOO: [505, 'USD'], XYZ: [95, 'USD'] }) });

    expect(r).toEqual({ added: 4, updated: 0, removed: 0, manual: 3 });
    expect(holdings(db)).toEqual([
      { symbol: 'AAPL 270115C00200000', quantity: 1, currency: 'USD', buy_price: null, baseline_price: 1250, manual_price: 1250, broker: 'IBKR', archived: 0 },
      { symbol: 'CASH.USD', quantity: 2000, currency: 'USD', buy_price: null, baseline_price: 1, manual_price: 1, broker: 'IBKR', archived: 0 },
      { symbol: 'VOO', quantity: 10, currency: 'USD', buy_price: 400, baseline_price: null, manual_price: null, broker: 'IBKR', archived: 0 },
      { symbol: 'XYZ', quantity: 5, currency: 'USD', buy_price: null, baseline_price: 10, manual_price: 10, broker: 'IBKR', archived: 0 },
    ]);
    // the live one is valued from the cached quote
    expect(portfolio(db).holdings.find(h => h.symbol === 'VOO')!.price).toBe(505);
  });

  it('updates by source + symbol, archives what disappeared and restores what came back', async () => {
    const db = testDb();
    const fetchQuote = quotes({ 'ETH-USD': [3000, 'USD'] });
    const eth = (quantity: number) => ({ symbol: 'ETH', yahoo: 'ETH-USD', quantity, currency: 'USD', price: 3010 });
    const wallet = (positions: SyncedAccount['positions']): SyncedAccount => ({ source: 'wallets:0xabc', broker: 'ארנק', positions });
    // a holding entered by hand is never touched by a sync
    db.prepare(`INSERT INTO holdings (symbol, quantity, currency) VALUES ('ETH-USD', 1, 'USD')`).run();

    await syncHoldings(db, 'wallets', [wallet([eth(2), { symbol: 'UNI', yahoo: 'UNI-USD', quantity: 50, currency: 'USD', price: 8 }])], { fetchQuote });
    const second = await syncHoldings(db, 'wallets', [wallet([eth(2.5)])], { fetchQuote });
    expect(second).toMatchObject({ added: 0, updated: 1, removed: 1 });
    const synced = () => db.prepare(`SELECT symbol, quantity, archived FROM holdings WHERE source IS NOT NULL ORDER BY symbol`).all();
    expect(synced()).toEqual([{ symbol: 'ETH-USD', quantity: 2.5, archived: 0 }, { symbol: 'UNI-USD', quantity: 50, archived: 1 }]);
    expect(db.prepare(`SELECT quantity FROM holdings WHERE source IS NULL`).pluck().get()).toBe(1);

    await syncHoldings(db, 'wallets', [wallet([eth(2.5), { symbol: 'UNI', yahoo: 'UNI-USD', quantity: 40, currency: 'USD', price: 8 }])], { fetchQuote });
    expect(synced()).toEqual([{ symbol: 'ETH-USD', quantity: 2.5, archived: 0 }, { symbol: 'UNI-USD', quantity: 40, archived: 0 }]);
    // another source's holdings are left alone
    await syncHoldings(db, 'binance', [], { fetchQuote });
    expect(db.prepare(`SELECT COUNT(*) FROM holdings WHERE archived = 0`).pluck().get()).toBe(3);
  });
});

const xml = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });

describe('IBKR Flex', () => {
  it('maps listings to Yahoo symbols', () => {
    expect(ibkrYahooSymbol({ symbol: 'BRK B', assetCategory: 'STK', listingExchange: 'NYSE', currency: 'USD' })).toBe('BRK-B');
    expect(ibkrYahooSymbol({ symbol: 'TEVA', assetCategory: 'STK', listingExchange: 'TASE', currency: 'ILS' })).toBe('TEVA.TA');
    expect(ibkrYahooSymbol({ symbol: 'VUSA', assetCategory: 'STK', listingExchange: 'LSEETF', currency: 'GBP' })).toBe('VUSA.L');
    expect(ibkrYahooSymbol({ symbol: 'ETH', assetCategory: 'CRYPTO', currency: 'USD' })).toBe('ETH-USD');
    expect(ibkrYahooSymbol({ symbol: 'AAPL  270115C00200000', assetCategory: 'OPT', listingExchange: 'CBOE', currency: 'USD' })).toBeNull();
    expect(ibkrYahooSymbol({ symbol: 'ABC', assetCategory: 'STK', listingExchange: 'MEXI', currency: 'MXN' })).toBeNull();
  });

  it('requests the statement, waits while it is generated, and reads positions and cash', async () => {
    const urls: string[] = [];
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/SendRequest')) return xml('<FlexStatementResponse><Status>Success</Status><ReferenceCode>1234567890</ReferenceCode></FlexStatementResponse>');
      if (++polls === 1) return xml('<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress</ErrorMessage></FlexStatementResponse>');
      return xml(`<FlexQueryResponse queryName="positions" type="AF"><FlexStatements count="1"><FlexStatement accountId="U1234567">
        <OpenPositions>
          <OpenPosition accountId="U1234567" symbol="VOO" description="VANGUARD S&amp;P 500 ETF" assetCategory="STK" listingExchange="ARCA"
            currency="USD" position="10" markPrice="500" positionValue="5000" costBasisMoney="4000" levelOfDetail="SUMMARY" />
          <OpenPosition accountId="U1234567" symbol="VOO" assetCategory="STK" listingExchange="ARCA" currency="USD" position="4"
            markPrice="500" positionValue="2000" costBasisMoney="1500" levelOfDetail="LOT" />
          <OpenPosition accountId="U1234567" symbol="AAPL  270115C00200000" assetCategory="OPT" currency="USD" position="2"
            markPrice="12.5" positionValue="2500" costBasisMoney="2000" levelOfDetail="SUMMARY" />
        </OpenPositions>
        <CashReport>
          <CashReportCurrency currency="BASE_SUMMARY" endingCash="3300" />
          <CashReportCurrency currency="USD" endingCash="1000" />
          <CashReportCurrency currency="ILS" endingCash="0" />
        </CashReport>
      </FlexStatement></FlexStatements></FlexQueryResponse>`);
    }));

    const { accounts } = await fetchIbkr({ type: 'ibkr', token: 'tkn', queryId: '42', ownerMemberId: 2 }, { pollMs: 0 });
    expect(urls[0]).toContain('SendRequest?t=tkn&q=42');
    expect(urls.at(-1)).toContain('GetStatement?t=tkn&q=1234567890');
    expect(accounts).toEqual([{
      source: 'ibkr:U1234567', broker: 'IBKR', ownerMemberId: 2,
      positions: [
        { symbol: 'VOO', yahoo: 'VOO', name: 'VANGUARD S&P 500 ETF', quantity: 10, currency: 'USD', price: 500, costPrice: 400 },
        // per unit with the multiplier: 2,500 for 2 contracts
        { symbol: 'AAPL  270115C00200000', yahoo: null, name: null, quantity: 2, currency: 'USD', price: 1250, costPrice: 1000 },
        { symbol: 'CASH.USD', yahoo: null, name: 'מזומן USD', quantity: 1000, currency: 'USD', price: 1 },
      ],
    }]);
  });

  it('fails on a refused token without writing anything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => xml('<FlexStatementResponse><Status>Fail</Status><ErrorCode>1012</ErrorCode><ErrorMessage>Token has expired.</ErrorMessage></FlexStatementResponse>')));
    await expect(fetchIbkr({ type: 'ibkr', token: 't', queryId: 'q' }, { pollMs: 0 })).rejects.toThrow('1012 Token has expired.');
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ETH wallets (Alchemy)', () => {
  it('adds up a coin across networks, names native balances and drops unpriced spam and dust', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const usd = (value: string) => [{ currency: 'usd', value }];
      if (!body.pageKey) {
        return json({ data: { pageKey: 'p2', tokens: [
          // native ETH on mainnet: 1.5 ETH
          { address: '0xabc', network: 'eth-mainnet', tokenAddress: null, tokenBalance: '0x14d1120d7b160000', tokenMetadata: { symbol: null, decimals: null }, tokenPrices: usd('3000') },
          { address: '0xabc', network: 'eth-mainnet', tokenAddress: '0xspam', tokenBalance: '0x3635c9adc5dea00000', tokenMetadata: { symbol: 'CLAIM-REWARD.COM', decimals: 18 }, tokenPrices: [] },
        ] } });
      }
      return json({ data: { tokens: [
        // native ETH on Arbitrum: 0.5 ETH
        { address: '0xabc', network: 'arb-mainnet', tokenAddress: null, tokenBalance: '0x6f05b59d3b20000', tokenPrices: usd('3000') },
        // 250 USDC (6 decimals)
        { address: '0xabc', network: 'arb-mainnet', tokenAddress: '0xusdc', tokenBalance: '0xee6b280', tokenMetadata: { symbol: 'USDC', decimals: 6, name: 'USD Coin' }, tokenPrices: usd('1.0') },
        { address: '0xabc', network: 'arb-mainnet', tokenAddress: '0xdust', tokenBalance: '0x1', tokenMetadata: { symbol: 'DUST', decimals: 0 }, tokenPrices: usd('0.2') },
      ] } });
    }));

    const { accounts } = await fetchWallets({ type: 'wallets', apiKey: 'key', networks: ['eth-mainnet', 'arb-mainnet'],
      wallets: [{ address: '0xABC', label: 'הארנק הראשי' }] });
    expect(bodies[0].addresses).toEqual([{ address: '0xabc', networks: ['eth-mainnet', 'arb-mainnet'] }]);
    expect(bodies[1].pageKey).toBe('p2');
    expect(accounts).toEqual([{ source: 'wallets:0xabc', broker: 'הארנק הראשי', ownerMemberId: null, positions: [
      { symbol: 'ETH', yahoo: 'ETH-USD', name: null, quantity: 2, currency: 'USD', price: 3000 },
      { symbol: 'USDC', yahoo: 'USDC-USD', name: 'USD Coin', quantity: 250, currency: 'USD', price: 1 },
    ] }]);
  });
});

describe('exchange balances (ccxt)', () => {
  const client = (total: Record<string, number>, tickers: Record<string, number>, bulkFails = false): ExchangeClient => ({
    name: 'Binance',
    fetchBalance: async () => ({ total }),
    fetchTickers: async (symbols?: string[]) => {
      if (bulkFails && (symbols?.length ?? 0) > 1) throw new Error('binance does not have market symbol NOPE/USDT');
      const out: Record<string, { last: number }> = {};
      for (const s of symbols ?? []) {
        if (tickers[s] == null) throw new Error(`no ${s}`);
        out[s] = { last: tickers[s] };
      }
      return out;
    },
  });

  it('prices balances against USDT, merges Simple Earn (LD…) into the coin and skips dust', async () => {
    const { accounts } = await fetchExchange({ type: 'exchange', exchange: 'binance', apiKey: 'k', secret: 's' },
      client({ BTC: 0.1, LDBTC: 0.05, USDT: 120, LDO: 0.001, NOPE: 7 }, { 'BTC/USDT': 60000, 'LDO/USDT': 2 }, true));
    expect(accounts).toEqual([{ source: 'binance:spot', broker: 'Binance', ownerMemberId: null, positions: [
      { symbol: 'BTC', yahoo: 'BTC-USD', quantity: expect.closeTo(0.15, 10), currency: 'USD', price: 60000 },
      { symbol: 'USDT', yahoo: 'USDT-USD', quantity: 120, currency: 'USD', price: 1 },
    ] }]);
  });
});

describe('investment sources in the scrape', () => {
  it('records each source like a bank, and a failing one leaves its holdings as they were', async () => {
    const db = testDb();
    db.prepare(`INSERT INTO holdings (symbol, quantity, currency, source, broker) VALUES ('VOO', 3, 'USD', 'ibkr:U1', 'IBKR')`).run();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('interactivebrokers')) return new Response('', { status: 503 });
      if (url.includes('alchemy')) return json({ data: { tokens: [
        { address: '0xabc', network: 'eth-mainnet', tokenAddress: null, tokenBalance: '0xde0b6b3a7640000', tokenPrices: [{ currency: 'usd', value: '3000' }] },
      ] } });
      return json({ chart: { error: { description: 'No data found' } } }, 404); // Yahoo: no quote
    }));

    const results = await syncInvestments([
      { type: 'ibkr', token: 't', queryId: 'q' },
      { type: 'wallets', apiKey: 'k', wallets: [{ address: '0xabc' }] },
    ], db);
    expect(results.map(r => [r.company, r.success])).toEqual([['ibkr', false], ['wallets', true]]);
    expect(db.prepare(`SELECT company, success, error_message FROM scrape_runs ORDER BY id`).all())
      .toEqual([{ company: 'ibkr', success: 0, error_message: 'IBKR HTTP 503' }, { company: 'wallets', success: 1, error_message: null }]);
    expect(holdings(db).map(h => [h.symbol, h.quantity, h.manual_price, h.archived])).toEqual([['ETH-USD', 1, 3000, 0], ['VOO', 3, null, 0]]);
  });
});
