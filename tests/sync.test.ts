import { describe, expect, it } from 'vitest';
import { baseCoin, coinAssetClass, ibkrAssetClass, STABLECOINS } from '../src/sync/assets.js';
import { parseFlexStatement } from '../src/sync/ibkr.js';
import { exchangePositions } from '../src/sync/exchange.js';
import { cryptoYahooSymbol, walletPositions, usdPrices } from '../src/sync/wallets.js';
import { syncHoldings } from '../src/sync/holdings.js';
import { testDb } from './helpers.js';

describe('asset classes', () => {
  it('maps IBKR categories: securities, crypto, cash', () => {
    expect(['STK', 'ETF', 'FUND'].map(ibkrAssetClass)).toEqual(['stock', 'stock', 'stock']);
    expect(ibkrAssetClass('CRYPTO')).toBe('crypto');
    expect(ibkrAssetClass('CASH')).toBe('broker_cash');
  });

  it('maps coins: fiat is broker cash, stablecoins (bridged too) are stablecoins, the rest crypto', () => {
    expect(coinAssetClass('USD')).toBe('broker_cash');
    expect(coinAssetClass('EUR')).toBe('broker_cash');
    expect(['USDT', 'USDC', 'DAI', 'FDUSD', 'PYUSD'].map(coinAssetClass)).toEqual(Array(5).fill('stablecoin'));
    expect(coinAssetClass('USDC.e')).toBe('stablecoin');
    expect(baseCoin('USDC.e')).toBe('USDC');
    expect(coinAssetClass('ETH')).toBe('crypto');
    expect(coinAssetClass('FRAX')).toBe('crypto');
    expect(STABLECOINS.has('FRAX')).toBe(false);
    expect(cryptoYahooSymbol('USDC.e')).toBe('USDC-USD');
  });

  it('parses an IBKR statement: stock, crypto and cash positions with their classes', () => {
    const raw = { FlexQueryResponse: { FlexStatements: { FlexStatement: {
      accountId: 'U1', toDate: '20261002',
      OpenPositions: { OpenPosition: [
        { assetCategory: 'STK', symbol: 'VOO', listingExchange: 'ARCA', currency: 'USD', position: '10', positionValue: '5000', costBasisMoney: '4200', levelOfDetail: 'SUMMARY' },
        { assetCategory: 'CRYPTO', symbol: 'BTC', currency: 'USD', position: '0.1', positionValue: '6000', levelOfDetail: 'SUMMARY' },
      ] },
      CashReport: { CashReportCurrency: [{ currency: 'BASE_SUMMARY', endingCash: '999' }, { currency: 'USD', endingCash: '250' }] },
    } } } };
    const [account] = parseFlexStatement(raw, { type: 'ibkr', token: 't', queryId: 'q' });
    expect(account.source).toBe('ibkr:U1');
    expect(account.positions.map(p => [p.symbol, p.yahoo, p.assetClass])).toEqual([
      ['VOO', 'VOO', 'stock'], ['BTC', 'BTC-USD', 'crypto'], ['CASH.USD', null, 'broker_cash'],
    ]);
    expect(account.positions[2]).toMatchObject({ quantity: 250, price: 1, name: 'Cash USD' });
    expect(account.positions.map(p => p.costBasis ?? null)).toEqual([4200, null, null]);
  });

  it('prices exchange balances from tickers; stablecoins are never assumed to be $1', () => {
    const positions = exchangePositions(
      { BTC: 0.5, LDUSDT: 100, USDC: 50, USD: 20, DOGE: 1 },
      { 'BTC/USDT': { last: 60_000 }, 'USDC/USDT': { last: 0.9995 }, 'DOGE/USDT': { last: 0.1 } },
    );
    const by = Object.fromEntries(positions.map(p => [p.symbol, p]));
    expect(by.BTC).toMatchObject({ price: 60_000, assetClass: 'crypto' });
    // no USDT/USD market: kept unpriced, for Yahoo (USDT-USD) to price
    expect(by.USDT).toMatchObject({ quantity: 100, price: null, yahoo: 'USDT-USD', assetClass: 'stablecoin' });
    expect(by.USDC).toMatchObject({ price: 0.9995, assetClass: 'stablecoin' });
    expect(by.USD).toMatchObject({ currency: 'USD', price: 1, assetClass: 'broker_cash' });
    expect(by.DOGE).toBeUndefined(); // dust
  });

  it('cSSV has no price of its own: it borrows SSV\'s, even from another wallet, and gets no Yahoo symbol', () => {
    const cssv = { network: 'eth-mainnet', tokenAddress: '0x2', tokenBalance: '0x' + (10n * 10n ** 18n).toString(16), tokenMetadata: { symbol: 'cSSV', decimals: 18 }, tokenPrices: [] };
    const ssv = { network: 'eth-mainnet', tokenAddress: '0x3', tokenBalance: '0x' + (2n * 10n ** 18n).toString(16), tokenMetadata: { symbol: 'SSV', decimals: 18 }, tokenPrices: [{ currency: 'usd', value: '3' }] };
    expect(walletPositions([cssv])).toEqual([]); // no SSV price anywhere → nothing to value it with
    const [p] = walletPositions([cssv], 1, usdPrices([ssv]));
    expect(p).toMatchObject({ symbol: 'CSSV', yahoo: null, quantity: 10, price: 3, assetClass: 'crypto' });
  });

  it('wallet tokens get their class', () => {
    const [p] = walletPositions([{ network: 'eth-mainnet', tokenAddress: '0x1', tokenBalance: '0x3B9ACA00', tokenMetadata: { symbol: 'USDC', decimals: 6 }, tokenPrices: [{ currency: 'usd', value: '1.0001' }] }]);
    expect(p).toMatchObject({ symbol: 'USDC', quantity: 1000, assetClass: 'stablecoin' });
  });

  it('stores the class and prices an unpriced stablecoin from its quote', async () => {
    const db = testDb();
    await syncHoldings(db, 'binance', [{ source: 'binance:spot', broker: 'Binance', positions: [
      { symbol: 'USDT', yahoo: 'USDT-USD', quantity: 100, currency: 'USD', assetClass: 'stablecoin', price: null },
    ] }], { fetchQuote: async symbol => ({ symbol, name: null, currency: 'USD', price: 0.9991, previousClose: null, exchange: null, instrumentType: null, marketTime: null }) });
    expect(db.prepare(`SELECT symbol, asset_class, manual_price FROM holdings`).get()).toEqual({ symbol: 'USDT-USD', asset_class: 'stablecoin', manual_price: null });
    expect(db.prepare(`SELECT price FROM quotes WHERE symbol = 'USDT-USD'`).pluck().get()).toBe(0.9991);
  });
});
