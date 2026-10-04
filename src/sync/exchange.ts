import type { SyncedAccount, SyncedPosition } from './holdings.js';
import { cryptoYahooSymbol } from './wallets.js';
import { FIAT, coinAssetClass, isStablecoin } from './assets.js';
import { averageCost, type CoinEvent, type CostResult } from './history.js';
import { fetchDailyCloses } from '../analytics/quotes.js';

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

/** A ccxt trade / ledger entry / deposit, the fields this reads. */
export interface CcxtTrade {
  id?: string; timestamp?: number; symbol?: string; side?: string; amount?: number; cost?: number; price?: number;
  fee?: { cost?: number; currency?: string } | null;
}
/** A ccxt conversion (Binance Convert): `fromAmount` of `fromCurrency` became `toAmount` of `toCurrency`. */
export interface CcxtConversion {
  id?: string; timestamp?: number; fromCurrency?: string; fromAmount?: number; toCurrency?: string; toAmount?: number;
  info?: Record<string, unknown>;
}
export interface CcxtTransfer { id?: string; timestamp?: number; currency?: string; amount?: number; status?: string; type?: string;
  direction?: string; info?: Record<string, unknown> }

/** The part of a ccxt exchange this uses — tests pass a fake. */
export interface ExchangeClient {
  name?: string;
  id?: string;
  fetchBalance(): Promise<{ total: Record<string, number | undefined> } & Record<string, unknown>>;
  fetchTickers(symbols?: string[]): Promise<Record<string, { last?: number | null }>>;
  loadMarkets?(): Promise<Record<string, unknown>>;
  fetchMyTrades?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtTrade[]>;
  fetchDeposits?(code?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtTransfer[]>;
  fetchWithdrawals?(code?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtTransfer[]>;
  fetchLedger?(code?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtTransfer[]>;
  fetchMyDustTrades?(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtTrade[]>;
  fetchConvertTradeHistory?(code?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<CcxtConversion[]>;
  /** ccxt's implicit endpoint for GET /sapi/v1/convert/tradeFlow, when fetchConvertTradeHistory isn't there */
  sapiGetConvertTradeFlow?(params: Record<string, unknown>): Promise<{ list?: Record<string, unknown>[]; moreData?: boolean }>;
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

// ---- trade history: when each held coin was opened and what it cost ------------------------------------------

/** USD per unit of a currency on a day (fiat or coin); null when unknown. */
export type UsdRate = (currency: string, day: string) => Promise<number | null>;

/** USD rates from Yahoo daily closes (coins as <C>-USD, fiat as <C>USD=X), one request per currency. */
export function yahooUsdRate(from = '2017-01-01'): UsdRate {
  const cache = new Map<string, Promise<{ date: string; close: number }[]>>();
  return async (currency, day) => {
    const c = currency.toUpperCase();
    if (c === 'USD') return 1;
    const symbol = FIAT.has(c) ? `${c}USD=X` : `${c}-USD`;
    if (!cache.has(symbol)) cache.set(symbol, fetchDailyCloses(symbol, from).catch(() => []));
    const closes = await cache.get(symbol)!;
    return closes.filter(x => x.date <= day).at(-1)?.close ?? closes[0]?.close ?? null;
  };
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;
/** Binance's deposit / withdrawal history is served in 90-day windows; it starts in 2017. */
const BINANCE_START = Date.UTC(2017, 6, 1);
const BINANCE_WINDOW = 90 * DAY;
/** Quote markets whose trades build a coin's cost (the coin as base), where the market exists. */
const COST_QUOTES = ['USDT', 'USD', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'GBP', 'TRY'];
/** Coins whose markets against a held coin are read too (the held coin as quote: selling BTC for USDT buys USDT). */
const MAJOR_BASES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP'];
/** Binance Convert history is served in windows of at most 30 days, up to 1000 rows each. */
const CONVERT_WINDOW = 30 * DAY - 1;
const CONVERT_LIMIT = 1000;

/** "permission denied", "invalid api-key, IP, or permissions" … → a short reason. */
const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 160);

/**
 * A coin's events from its trades — as base (buying it), or as quote (selling another coin for it buys it at that
 * coin's USD value; buying another coin with it sells it) —, deposits and withdrawals, costs converted to USD.
 */
export async function coinEvents(coin: string, trades: CcxtTrade[], transfers: { at: number; type: 'in' | 'out'; quantity: number }[],
  usd: UsdRate): Promise<CoinEvent[]> {
  const events: CoinEvent[] = transfers.map(t => ({ at: t.at, type: t.type, quantity: t.quantity }));
  for (const t of trades) {
    const [base, quote] = String(t.symbol ?? '').split('/');
    if (quote === coin && base && base !== coin && t.timestamp && t.amount! > 0 && t.cost! > 0) {
      const day = dayOf(t.timestamp);
      const feeInCoin = t.fee?.currency === coin ? t.fee.cost ?? 0 : 0;
      if (t.side === 'buy') { events.push({ at: t.timestamp, type: 'sell', quantity: t.cost! + feeInCoin }); continue; }
      // what was given, in USD; when that coin has no USD price, what was received (the same value, at market)
      const rate = await usd(base, day);
      const own = rate == null ? await usd(coin, day) : null;
      let costUsd = rate != null ? t.amount! * rate : own != null ? t.cost! * own : null;
      if (costUsd != null && t.fee?.cost && t.fee.currency && t.fee.currency !== coin) {
        const feeRate = await usd(t.fee.currency, day);
        costUsd = feeRate == null ? costUsd : costUsd + t.fee.cost * feeRate;
      }
      events.push({ at: t.timestamp, type: 'buy', quantity: t.cost! - feeInCoin, costUsd });
      continue;
    }
    if (base !== coin || !quote || !t.timestamp || !(t.amount! > 0)) continue;
    const day = dayOf(t.timestamp);
    const feeInCoin = t.fee?.currency === coin ? t.fee.cost ?? 0 : 0;
    if (t.side === 'sell') {
      events.push({ at: t.timestamp, type: 'sell', quantity: t.amount! + feeInCoin });
      continue;
    }
    const rate = await usd(quote, day);
    let costUsd = rate == null || t.cost == null ? null : t.cost * rate;
    if (costUsd != null && t.fee?.cost && t.fee.currency && t.fee.currency !== coin) {
      const feeRate = await usd(t.fee.currency, day);
      costUsd = feeRate == null ? costUsd : costUsd + t.fee.cost * feeRate;
    }
    events.push({ at: t.timestamp, type: 'buy', quantity: t.amount! - feeInCoin, costUsd });
  }
  return events;
}

/**
 * A coin's events from Binance Convert: converting another asset into it is a buy at what was given (in USD that day);
 * converting it into another asset is a sell.
 */
export async function convertEvents(coin: string, conversions: CcxtConversion[], usd: UsdRate): Promise<CoinEvent[]> {
  const events: CoinEvent[] = [];
  for (const c of conversions) {
    const status = String(c.info?.orderStatus ?? 'SUCCESS');
    if (status !== 'SUCCESS' || !c.timestamp) continue;
    const from = coinOf(String(c.fromCurrency ?? '')), to = coinOf(String(c.toCurrency ?? ''));
    if (from === to) continue;
    if (to === coin && c.toAmount! > 0) {
      // what was given, in USD; when that asset has no USD price, what was received (the same value, at market)
      const rate = c.fromAmount! > 0 ? await usd(from, dayOf(c.timestamp)) : null;
      const own = rate == null ? await usd(coin, dayOf(c.timestamp)) : null;
      events.push({ at: c.timestamp, type: 'buy', quantity: c.toAmount!,
        costUsd: rate != null ? c.fromAmount! * rate : own != null ? c.toAmount! * own : null });
    } else if (from === coin && c.fromAmount! > 0) {
      events.push({ at: c.timestamp, type: 'sell', quantity: c.fromAmount! });
    }
  }
  return events;
}

/** Kraken's legacy asset codes ccxt leaves as they are when they carry a suffix (ZUSD.F). */
const KRAKEN_LEGACY: Record<string, string> = {
  ZUSD: 'USD', ZEUR: 'EUR', ZGBP: 'GBP', ZCAD: 'CAD', ZJPY: 'JPY', ZAUD: 'AUD', ZCHF: 'CHF', XXBT: 'BTC', XBT: 'BTC', XETH: 'ETH',
  XXRP: 'XRP', XLTC: 'LTC', XXLM: 'XLM', XXMR: 'XMR', XZEC: 'ZEC', XETC: 'ETC', XREP: 'REP', XMLN: 'MLN', XXDG: 'DOGE', XDG: 'DOGE',
};
/** A Kraken ledger asset → the coin: earn / held balances (ETH.F, DOT.S, USD.HOLD) are the coin itself. */
export const krakenCoin = (c: string) => {
  const base = c.toUpperCase().replace(/\.(HOLD|[A-Z]{1,2})$/, '');
  return KRAKEN_LEGACY[base] ?? base;
};

/**
 * A coin's events from a Kraken-style ledger, where every movement is an entry and the legs of one trade share a
 * reference id: a coin received in a trade / instant buy (receive) is a buy, its cost the other legs paid (fees
 * included) in USD; a coin given in a trade / spend is a sell; deposits / withdrawals and futures-wallet transfers move
 * it in / out at unknown cost; staking / earn rewards are units at zero cost; moves between spot and earn don't count.
 */
export async function ledgerEvents(coin: string, entries: CcxtTransfer[], usd: UsdRate): Promise<CoinEvent[]> {
  const coinOf = krakenCoin;
  const byRef = new Map<string, CcxtTransfer[]>();
  for (const e of entries) {
    const ref = String((e as { referenceId?: string }).referenceId ?? '');
    if (ref) byRef.set(ref, [...(byRef.get(ref) ?? []), e]);
  }
  const fee = (e: CcxtTransfer) => Number((e as { fee?: { cost?: number } }).fee?.cost ?? 0) || 0;
  const signed = (e: CcxtTransfer) => (e.direction === 'out' ? -1 : 1) * Math.abs(e.amount ?? 0) - fee(e);
  const events: CoinEvent[] = [];
  for (const e of entries) {
    if (coinOf(String(e.currency ?? '')) !== coin || !e.timestamp) continue;
    const change = signed(e);
    if (!change) continue;
    const type = String(e.info?.type ?? ''), subtype = String(e.info?.subtype ?? '');
    const at = e.timestamp;
    if (type === 'trade' || type === 'receive' || type === 'spend') {
      if (change < 0) { events.push({ at, type: 'sell', quantity: -change }); continue; }
      const legs = (byRef.get(String((e as { referenceId?: string }).referenceId ?? '')) ?? [])
        .filter(l => coinOf(String(l.currency ?? '')) !== coin && signed(l) < 0);
      let costUsd: number | null = legs.length ? 0 : null;
      for (const l of legs) {
        const rate = await usd(coinOf(String(l.currency)), dayOf(at));
        costUsd = rate == null || costUsd == null ? null : costUsd + -signed(l) * rate;
      }
      events.push({ at, type: 'buy', quantity: change, costUsd });
    } else if (type === 'deposit' || (type === 'transfer' && subtype === 'spotfromfutures')) {
      if (change > 0) events.push({ at, type: 'in', quantity: change });
    } else if (type === 'withdrawal' || (type === 'transfer' && subtype === 'spottofutures')) {
      if (change < 0) events.push({ at, type: 'out', quantity: -change });
    } else if ((type === 'staking' || (type === 'earn' && subtype === 'reward')) && change > 0) {
      events.push({ at, type: 'buy', quantity: change, costUsd: 0 });
    }
  }
  return events;
}

/** Every trade of a Binance market, oldest first (fromId pages of 1000). */
async function binanceTrades(ex: ExchangeClient, symbol: string): Promise<CcxtTrade[]> {
  const out: CcxtTrade[] = [];
  for (let fromId = 0; ;) {
    const page = await ex.fetchMyTrades!(symbol, undefined, 1000, { fromId });
    out.push(...page);
    if (page.length < 1000) return out;
    fromId = Number(page.at(-1)!.id) + 1;
  }
}

/** Every page of an offset-paged history (Kraken: 50 per page, newest first). */
async function offsetPages<T>(fetchPage: (ofs: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let ofs = 0; ; ofs += 50) {
    const page = await fetchPage(ofs);
    out.push(...page);
    if (page.length < 50 || ofs > 50_000) return out;
  }
}

/**
 * Binance Convert trades from `start` to now in 30-day windows (the endpoint's limit); a full window is split in two so
 * nothing is cut off. Uses ccxt's fetchConvertTradeHistory, else the raw GET /sapi/v1/convert/tradeFlow.
 */
async function binanceConverts(ex: ExchangeClient, start: number, now = Date.now()): Promise<CcxtConversion[]> {
  const fetchWindow = async (since: number, until: number): Promise<CcxtConversion[]> => {
    let list: CcxtConversion[];
    if (ex.fetchConvertTradeHistory) {
      list = await ex.fetchConvertTradeHistory(undefined, since, CONVERT_LIMIT, { until });
    } else {
      const res = await ex.sapiGetConvertTradeFlow!({ startTime: since, endTime: until, limit: CONVERT_LIMIT });
      list = (res.list ?? []).map(r => ({
        id: String(r.orderId ?? r.quoteId ?? ''), timestamp: Number(r.createTime), fromCurrency: String(r.fromAsset),
        fromAmount: Number(r.fromAmount), toCurrency: String(r.toAsset), toAmount: Number(r.toAmount), info: r,
      }));
    }
    if (list.length >= CONVERT_LIMIT && until - since > 60_000) {
      const mid = Math.floor((since + until) / 2);
      return [...await fetchWindow(since, mid), ...await fetchWindow(mid + 1, until)];
    }
    return list;
  };
  const out: CcxtConversion[] = [];
  for (let since = start; since < now; since += CONVERT_WINDOW + 1) out.push(...await fetchWindow(since, Math.min(since + CONVERT_WINDOW, now)));
  const seen = new Set<string>();
  return out.filter(c => !c.id || (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Binance deposits or withdrawals since 2017, window by window. */
async function binanceWindows(fetch: (since: number) => Promise<CcxtTransfer[]>): Promise<CcxtTransfer[]> {
  const out: CcxtTransfer[] = [];
  for (let since = BINANCE_START; since < Date.now(); since += BINANCE_WINDOW) out.push(...await fetch(since));
  return out;
}

export interface ExchangeHistory { costs: Map<string, CostResult>; raw: Record<string, unknown>; warnings: string[] }

/**
 * The held coins' opening dates and average costs from the exchange's own history (read-only endpoints): Binance —
 * trades per held coin as base against the quote markets that exist (USDT, USD, USDC, FDUSD, BUSD, BTC, EUR…) and as
 * quote, deposits and withdrawals, dust conversions to BNB, and Convert trades (30-day windows from the first
 * deposit); Kraken — all trades
 * and the ledger's deposits / withdrawals. An endpoint that is refused leaves its part out and says why in `warnings`;
 * a coin with no history gets neither (opening and gain show "—").
 */
export async function exchangeHistory(ex: ExchangeClient, exchange: string, held: Map<string, number>, usd: UsdRate = yahooUsdRate()): Promise<ExchangeHistory> {
  const warnings: string[] = [];
  const raw: Record<string, unknown> = {};
  const coins = [...held.keys()];
  const trades: CcxtTrade[] = [];
  const transfers: CcxtTransfer[] = [];
  let ledger: CcxtTransfer[] | null = null;
  let fetched = 0;
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); fetched++; } catch (err) { warnings.push(`${label}: ${reason(err)}`); }
  };

  const conversions: CcxtConversion[] = [];
  if (exchange === 'binance') {
    if (ex.fetchDeposits) await attempt('deposit history', async () => {
      const list = await binanceWindows(since => ex.fetchDeposits!(undefined, since, 1000));
      raw.deposits = list.map(t => t.info ?? t);
      transfers.push(...list.map(t => ({ ...t, direction: 'in' })));
    });
    if (ex.fetchWithdrawals) await attempt('withdrawal history', async () => {
      const list = await binanceWindows(since => ex.fetchWithdrawals!(undefined, since, 1000));
      raw.withdrawals = list.map(t => t.info ?? t);
      transfers.push(...list.map(t => ({ ...t, direction: 'out' })));
    });
  }

  if (!ex.fetchMyTrades) {
    warnings.push('trade history: not supported');
  } else if (exchange === 'binance') {
    const markets = ex.loadMarkets ? await ex.loadMarkets().catch(() => ({} as Record<string, unknown>)) : {};
    // the held coin as base against every quote market that exists, and as quote against the held coins, the coins
    // that came in / went out, and the majors — each market read once
    const bases = new Set([...coins, ...MAJOR_BASES, ...transfers.map(t => coinOf(String(t.currency ?? ''))).filter(Boolean)]);
    const symbols = new Set<string>();
    for (const coin of coins) {
      for (const quote of COST_QUOTES) if (coin !== quote && `${coin}/${quote}` in markets) symbols.add(`${coin}/${quote}`);
      for (const base of bases) if (base !== coin && `${base}/${coin}` in markets) symbols.add(`${base}/${coin}`);
    }
    await attempt('trade history', async () => {
      for (const symbol of symbols) {
        const list = await binanceTrades(ex, symbol);
        raw[`trades:${symbol}`] = list.map(t => (t as { info?: unknown }).info ?? t);
        trades.push(...list);
      }
    });
  } else {
    await attempt('trade history', async () => {
      const list = await offsetPages(ofs => ex.fetchMyTrades!(undefined, undefined, undefined, { ofs }));
      raw.trades = list.map(t => (t as { info?: unknown }).info ?? t);
      trades.push(...list);
    });
  }

  if (exchange === 'binance') {
    // small balances converted to BNB: a sale of the dust coin for the BNB it gave, net of Binance's charge (the dust
    // coin as base, BNB as quote — read from the raw rows, as ccxt flips the side when a BNB/<coin> market exists)
    if (ex.fetchMyDustTrades) await attempt('dust conversions', async () => {
      const list = await ex.fetchMyDustTrades!();
      raw.dust = list.map(t => (t as { info?: unknown }).info ?? t);
      for (const t of list) {
        const info = ((t as { info?: Record<string, unknown> }).info ?? {}) as Record<string, unknown>;
        const from = String(info.fromAsset ?? ''), amount = Number(info.amount), bnb = Number(info.transferedAmount);
        if (from && amount > 0 && bnb > 0) trades.push({ symbol: `${from}/BNB`, side: 'sell', amount, cost: bnb, timestamp: Number(info.operateTime) || t.timestamp });
      }
    });
    if (ex.fetchConvertTradeHistory || ex.sapiGetConvertTradeFlow) {
      // from the account's first deposit / trade (a month early), else from when Binance started
      const first = Math.min(...[...transfers, ...trades].map(t => t.timestamp ?? Infinity));
      const start = Number.isFinite(first) ? Math.max(BINANCE_START, first - 30 * DAY) : BINANCE_START;
      await attempt('convert history', async () => {
        const list = await binanceConverts(ex, start);
        raw.convert = list.map(c => c.info ?? c);
        conversions.push(...list);
      });
    } else warnings.push('convert history: not supported');
  } else if (ex.fetchLedger) {
    await attempt('ledger', async () => {
      const list = await offsetPages(ofs => ex.fetchLedger!(undefined, undefined, undefined, { ofs }));
      raw.ledger = list.map(t => t.info ?? t);
      ledger = list;
    });
  }

  const ok = (t: CcxtTransfer) => !t.status || t.status === 'ok';
  const costs = new Map<string, CostResult>();
  // nothing could be read: leave what is stored
  if (!fetched) return { costs, raw, warnings };
  for (const coin of coins) {
    // the ledger has every movement (both legs of a trade, instant buys, rewards); without it, trades + transfers
    if (ledger) { costs.set(coin, averageCost(await ledgerEvents(coin, ledger, usd), held.get(coin)!)); continue; }
    const moves = transfers.filter(t => coinOf(String(t.currency ?? '')) === coin && ok(t) && t.timestamp && t.amount)
      .map(t => ({ at: t.timestamp!, type: (t.direction === 'out' ? 'out' : 'in') as 'in' | 'out', quantity: Math.abs(t.amount!) }));
    const events = [...await coinEvents(coin, trades, moves, usd), ...await convertEvents(coin, conversions, usd)];
    costs.set(coin, averageCost(events, held.get(coin)!));
  }
  return { costs, raw, warnings };
}

export async function fetchExchange(cfg: ExchangeSource, client?: ExchangeClient, opts: { usd?: UsdRate } = {}): Promise<{ raw: unknown; accounts: SyncedAccount[]; asOf?: string | null; history?: unknown; warnings?: string[] }> {
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
  const positions = exchangePositions(balance.total ?? {}, tickers, cfg.minUsd ?? 1);
  // opening date and average cost of the coins kept (not fiat cash); a failure here never fails the sync
  const held = new Map(positions.filter(p => p.assetClass !== 'broker_cash').map(p => [p.symbol, p.quantity]));
  let history: ExchangeHistory | null = null;
  const warnings: string[] = [];
  if (held.size) {
    try { history = await exchangeHistory(ex, cfg.exchange, held, opts.usd); warnings.push(...history.warnings); }
    catch (err) { warnings.push(`history: ${reason(err)}`); }
  }
  for (const p of positions) {
    const c = history?.costs.get(p.symbol);
    if (!c) continue;
    p.openedAt = c.openedAt;
    p.costBasis = c.costBasis;
    p.costSource = c.costSource;
  }
  return {
    raw: { balance, tickers },
    accounts: [{ source: `${id}:spot`, broker: cfg.label ?? ex.name ?? cfg.exchange, positions }],
    asOf: new Date().toISOString(),
    history: history?.raw,
    warnings,
  };
}
