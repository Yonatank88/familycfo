import type { SyncedAccount, SyncedPosition } from './holdings.js';
import { cryptoYahooSymbol } from './wallets.js';

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
  ownerMemberId?: number;
  /** balances worth less than this (USD) are left out; default 1 */
  minUsd?: number;
}

/** The part of a ccxt exchange this uses — tests pass a fake. */
export interface ExchangeClient {
  name?: string;
  fetchBalance(): Promise<{ total: Record<string, number | undefined> } & Record<string, unknown>>;
  fetchTickers(symbols?: string[]): Promise<Record<string, { last?: number | null }>>;
}

const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'USDP', 'USD']);

async function ccxtClient(cfg: ExchangeSource): Promise<ExchangeClient> {
  const ccxt = await import('ccxt').catch(() => {
    throw new Error('ccxt is not installed — run: npm install ccxt');
  }) as unknown as Record<string, new (opts: object) => ExchangeClient>;
  const Exchange = ccxt[cfg.exchange] ?? (ccxt as any).default?.[cfg.exchange];
  if (typeof Exchange !== 'function') throw new Error(`ccxt has no exchange "${cfg.exchange}"`);
  return new Exchange({ apiKey: cfg.apiKey, secret: cfg.secret, password: cfg.password, enableRateLimit: true });
}

/** Balances → positions priced in USD (against USDT). Binance's Simple Earn shows as LD<coin>; it's the coin. */
export function exchangePositions(total: Record<string, number | undefined>, tickers: Record<string, { last?: number | null }>, minUsd = 1): SyncedPosition[] {
  const held = new Map<string, number>();
  for (const [coin, amount] of Object.entries(total)) {
    if (!amount || amount <= 0) continue;
    const c = coin.length > 4 && coin.startsWith('LD') ? coin.slice(2) : coin;
    held.set(c, (held.get(c) ?? 0) + amount);
  }
  const positions: SyncedPosition[] = [];
  for (const [coin, quantity] of held) {
    const price = STABLE.has(coin) ? 1 : tickers[`${coin}/USDT`]?.last ?? null;
    if (price == null || quantity * price < minUsd) continue;
    positions.push({ symbol: coin, yahoo: cryptoYahooSymbol(coin), quantity, currency: 'USD', price });
  }
  return positions;
}

export async function fetchExchange(cfg: ExchangeSource, client?: ExchangeClient): Promise<{ raw: unknown; accounts: SyncedAccount[] }> {
  if (!cfg.apiKey || !cfg.secret) throw new Error(`${cfg.exchange}: apiKey and secret are required`);
  const ex = client ?? await ccxtClient(cfg);
  const balance = await ex.fetchBalance();
  const coins = Object.entries(balance.total ?? {}).filter(([, v]) => (v ?? 0) > 0)
    .map(([c]) => (c.length > 4 && c.startsWith('LD') ? c.slice(2) : c)).filter(c => !STABLE.has(c));
  let tickers: Record<string, { last?: number | null }> = {};
  try {
    if (coins.length) tickers = await ex.fetchTickers([...new Set(coins)].map(c => `${c}/USDT`));
  } catch {
    // a bulk request with one unknown pair fails as a whole: price one by one
    for (const c of new Set(coins)) {
      try { Object.assign(tickers, await ex.fetchTickers([`${c}/USDT`])); } catch { /* no USDT market: left unpriced */ }
    }
  }
  const id = cfg.id ?? cfg.exchange;
  return {
    raw: { balance, tickers },
    accounts: [{ source: `${id}:spot`, broker: cfg.label ?? ex.name ?? cfg.exchange, ownerMemberId: cfg.ownerMemberId ?? null,
      positions: exchangePositions(balance.total ?? {}, tickers, cfg.minUsd ?? 1) }],
  };
}
