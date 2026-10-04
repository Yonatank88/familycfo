import type { SyncedAccount, SyncedPosition } from './holdings.js';
import { cryptoYahooSymbol } from './wallets.js';
import { FIAT, coinAssetClass, isStablecoin } from './assets.js';

/**
 * Crypto exchange balances through ccxt (Binance, or any exchange ccxt supports — same config). Use a READ-ONLY API
 * key: no trading, no withdrawals. ccxt is an optional dependency, loaded only when an exchange is configured.
 */
export interface ExchangeSource {
  type: 'exchange';
  /** default: the exchange id */
  id?: string;
  /** ccxt exchange id: binance, kraken, coinbase… */
  exchange: string;
  apiKey: string;
  secret: string;
  /** some exchanges (OKX, KuCoin) also want an API passphrase */
  password?: string;
  label?: string;
  /** balances worth less than this (USD) are left out; default 1 */
  minUsd?: number;
}

/** The part of a ccxt exchange this uses — tests pass a fake. */
export interface ExchangeClient {
  name?: string;
  fetchBalance(): Promise<{ total: Record<string, number | undefined> } & Record<string, unknown>>;
  fetchTickers(symbols?: string[]): Promise<Record<string, { last?: number | null }>>;
}

async function ccxtClient(cfg: ExchangeSource): Promise<ExchangeClient> {
  const ccxt = await import('ccxt').catch(() => {
    throw new Error('ccxt is not installed — run: npm install ccxt');
  }) as unknown as Record<string, new (opts: object) => ExchangeClient>;
  const Exchange = ccxt[cfg.exchange] ?? (ccxt as any).default?.[cfg.exchange];
  if (typeof Exchange !== 'function') throw new Error(`ccxt has no exchange "${cfg.exchange}"`);
  return new Exchange({ apiKey: cfg.apiKey, secret: cfg.secret, password: cfg.password, enableRateLimit: true });
}

/** Binance's Simple Earn shows as LD<coin>; it's the coin. */
const coinOf = (c: string) => (c.length > 4 && c.startsWith('LD') ? c.slice(2) : c);

/** The pairs that price a coin, in order: against USDT, and USDT itself against USD. */
const pricePairs = (coin: string) => (coin === 'USDT' ? ['USDT/USD', 'USDT/USDC'] : [`${coin}/USDT`]);

/**
 * Balances → positions priced in USD from the exchange's own tickers. Fiat is cash (price 1 in its own currency).
 * A stablecoin the exchange can't price is kept without a price, for Yahoo to price (never assumed to be $1).
 */
export function exchangePositions(total: Record<string, number | undefined>, tickers: Record<string, { last?: number | null }>, minUsd = 1): SyncedPosition[] {
  const held = new Map<string, number>();
  for (const [coin, amount] of Object.entries(total)) {
    if (!amount || amount <= 0) continue;
    const c = coinOf(coin);
    held.set(c, (held.get(c) ?? 0) + amount);
  }
  const positions: SyncedPosition[] = [];
  for (const [coin, quantity] of held) {
    if (FIAT.has(coin)) {
      positions.push({ symbol: coin, yahoo: null, name: `Cash ${coin}`, quantity, currency: coin, assetClass: 'broker_cash', price: 1 });
      continue;
    }
    const pair = pricePairs(coin).find(p => tickers[p]?.last != null);
    const price = pair ? tickers[pair].last! : null;
    const stable = isStablecoin(coin);
    if (price == null && !stable) continue;
    // the dust filter needs a value: an unpriced stablecoin is close enough to $1 for that
    if (quantity * (price ?? 1) < minUsd) continue;
    positions.push({ symbol: coin, yahoo: cryptoYahooSymbol(coin), quantity, currency: 'USD', assetClass: coinAssetClass(coin), price });
  }
  return positions;
}

export async function fetchExchange(cfg: ExchangeSource, client?: ExchangeClient): Promise<{ raw: unknown; accounts: SyncedAccount[]; asOf?: string | null }> {
  if (!cfg.apiKey || !cfg.secret) throw new Error(`${cfg.exchange}: apiKey and secret are required`);
  const ex = client ?? await ccxtClient(cfg);
  const balance = await ex.fetchBalance();
  const coins = [...new Set(Object.entries(balance.total ?? {}).filter(([, v]) => (v ?? 0) > 0).map(([c]) => coinOf(c)))]
    .filter(c => !FIAT.has(c));
  let tickers: Record<string, { last?: number | null }> = {};
  try {
    if (coins.length) tickers = await ex.fetchTickers(coins.flatMap(c => pricePairs(c).slice(0, 1)));
  } catch {
    // a bulk request with one unknown pair fails as a whole: price one by one
    for (const c of coins) {
      for (const pair of pricePairs(c)) {
        try { Object.assign(tickers, await ex.fetchTickers([pair])); break; } catch { /* no such market: try the next / left unpriced */ }
      }
    }
  }
  const id = cfg.id ?? cfg.exchange;
  return {
    raw: { balance, tickers },
    accounts: [{ source: `${id}:spot`, broker: cfg.label ?? ex.name ?? cfg.exchange,
      positions: exchangePositions(balance.total ?? {}, tickers, cfg.minUsd ?? 1) }],
    asOf: new Date().toISOString(),
  };
}
