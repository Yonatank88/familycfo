import type { DB } from '../db/connection.js';
import { addDays, today } from './common.js';
import { normalizeCurrency } from './fx.js';

/**
 * Live market prices from Yahoo Finance's public chart / search endpoints (no key). Only symbols are sent —
 * never quantities, values or who holds them.
 */
const BASE = 'https://query1.finance.yahoo.com';
const HEADERS = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };

export interface Quote {
  symbol: string;
  name: string | null;
  currency: string;
  price: number;
  previousClose: number | null;
  exchange: string | null;
  instrumentType: string | null;
  marketTime: string | null;
}

export interface SymbolMatch { symbol: string; name: string; exchange: string | null; type: string | null }

/** Yahoo quotes some markets in minor units: Tel Aviv in agorot (ILA), London in pence (GBp). Store major units. */
export function majorUnits(currency: string | null | undefined): { currency: string; factor: number } {
  if (currency === 'ILA') return { currency: 'ILS', factor: 0.01 };
  if (currency === 'GBp' || currency === 'GBX') return { currency: 'GBP', factor: 0.01 };
  if (currency === 'ZAc') return { currency: 'ZAR', factor: 0.01 };
  return { currency: normalizeCurrency(currency), factor: 1 };
}

const cleanSymbol = (s: string) => s.trim().toUpperCase();

async function chart(symbol: string, params: string): Promise<any> {
  const res = await fetch(`${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => null) as any;
  const result = body?.chart?.result?.[0];
  if (!res.ok || !result) throw new Error(body?.chart?.error?.description ?? `HTTP ${res.status}`);
  return result;
}

export async function fetchQuote(symbol: string): Promise<Quote> {
  const { meta } = await chart(cleanSymbol(symbol), 'range=1d&interval=1d');
  if (typeof meta?.regularMarketPrice !== 'number') throw new Error('no price');
  const { currency, factor } = majorUnits(meta.currency);
  // with range=1d, the chart's previous close is yesterday's close
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  return {
    symbol: meta.symbol ?? cleanSymbol(symbol),
    name: meta.longName ?? meta.shortName ?? null,
    currency,
    price: meta.regularMarketPrice * factor,
    previousClose: typeof prev === 'number' ? prev * factor : null,
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
    instrumentType: meta.instrumentType ?? null,
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

/** Daily closes from `from` (YYYY-MM-DD) until today, dated in the exchange's own time zone. */
export async function fetchHistory(symbol: string, from: string): Promise<{ date: string; close: number }[]> {
  const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const r = await chart(cleanSymbol(symbol), `period1=${period1}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`);
  const { factor } = majorUnits(r.meta?.currency);
  const offset = Number(r.meta?.gmtoffset ?? 0);
  const closes: (number | null)[] = r.indicators?.quote?.[0]?.close ?? [];
  return ((r.timestamp ?? []) as number[])
    .map((ts, i) => ({ date: new Date((ts + offset) * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((p): p is { date: string; close: number } => typeof p.close === 'number')
    .map(p => ({ date: p.date, close: p.close * factor }));
}

/** Find symbols by name or ticker (Latin only — Yahoo's search rejects Hebrew). */
export async function searchSymbols(q: string): Promise<SymbolMatch[]> {
  const res = await fetch(`${BASE}/v1/finance/search?q=${encodeURIComponent(q.trim())}&quotesCount=10&newsCount=0&listsCount=0`,
    { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const body = await res.json().catch(() => null) as any;
  return ((body?.quotes ?? []) as any[])
    .filter(x => x.symbol && ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CRYPTOCURRENCY'].includes(x.quoteType))
    .map(x => ({ symbol: x.symbol, name: x.longname ?? x.shortname ?? x.symbol, exchange: x.exchDisp ?? x.exchange ?? null, type: x.typeDisp ?? x.quoteType ?? null }));
}

export function saveQuote(db: DB, q: Quote): void {
  db.prepare(`
    INSERT INTO quotes (symbol, name, currency, price, previous_close, exchange, instrument_type, market_time, fetched_at, error)
    VALUES (@symbol, @name, @currency, @price, @previousClose, @exchange, @instrumentType, @marketTime, @fetchedAt, NULL)
    ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, currency = excluded.currency, price = excluded.price,
      previous_close = excluded.previous_close, exchange = excluded.exchange, instrument_type = excluded.instrument_type,
      market_time = excluded.market_time, fetched_at = excluded.fetched_at, error = NULL
  `).run({ ...q, fetchedAt: new Date().toISOString() });
  db.prepare(`UPDATE holdings SET currency = ? WHERE symbol = ? AND manual_price IS NULL AND (currency IS NULL OR currency <> ?)`)
    .run(q.currency, q.symbol, q.currency);
}

/** A rate from Yahoo fills a day the Bank of Israel hasn't published (yet); it never replaces a BOI rate. */
function saveMarketRate(db: DB, date: string, currency: string, rate: number): void {
  db.prepare(`
    INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES (?, ?, ?, 'yahoo')
    ON CONFLICT(date, currency) DO UPDATE SET rate_to_ils = excluded.rate_to_ils WHERE fx_rates.source = 'yahoo'
  `).run(date, currency, rate);
}

const quotedSymbols = (db: DB) =>
  db.prepare(`SELECT DISTINCT symbol FROM holdings WHERE archived = 0 AND manual_price IS NULL`).pluck().all() as string[];
const foreignCurrencies = (db: DB) => db.prepare(`
  SELECT DISTINCT currency FROM holdings WHERE archived = 0 AND currency IS NOT NULL AND currency <> 'ILS'
`).pluck().all() as string[];

let inFlight: Promise<{ updated: number; failed: number }> | null = null;

/** Refresh the quotes of every held symbol older than `maxAgeMs` (plus today's rate of their currencies). */
export function refreshQuotes(db: DB, maxAgeMs = 60_000): Promise<{ updated: number; failed: number }> {
  inFlight ??= (async () => {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const stale = quotedSymbols(db).filter(s => {
      const at = db.prepare(`SELECT fetched_at FROM quotes WHERE symbol = ?`).pluck().get(s) as string | undefined;
      return !at || at < cutoff;
    });
    let updated = 0, failed = 0;
    await Promise.all(stale.map(async symbol => {
      try {
        saveQuote(db, await fetchQuote(symbol));
        updated++;
      } catch (err) {
        failed++;
        db.prepare(`INSERT INTO quotes (symbol, fetched_at, error) VALUES (?, ?, ?)
          ON CONFLICT(symbol) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error`)
          .run(symbol, new Date().toISOString(), (err as Error).message);
      }
    }));
    if (stale.length) {
      await Promise.all(foreignCurrencies(db).map(async cur => {
        try { saveMarketRate(db, today(), cur, (await fetchQuote(`${cur}ILS=X`)).price); } catch { /* keep the last known rate */ }
      }));
    }
    return { updated, failed };
  })().finally(() => { inFlight = null; });
  return inFlight;
}

const historyFetchedAt = new Map<string, number>();
const HISTORY_TTL = 6 * 3600_000;

/** Start date of a holding's track record: bought, else the baseline, else when it was added. */
export const startOf = (h: { buy_date?: string | null; baseline_date?: string | null; created_at?: string | null }) =>
  (h.buy_date ?? h.baseline_date ?? h.created_at ?? today()).slice(0, 10);

/** Daily closes (and FX rates) from each symbol's earliest holding start — at most every few hours per symbol. */
export async function refreshHistory(db: DB, force = false): Promise<number> {
  const rows = db.prepare(`SELECT symbol, currency, buy_date, baseline_date, created_at FROM holdings WHERE archived = 0`).all() as Record<string, string | null>[];
  const from = new Map<string, string>();
  for (const h of rows) {
    const start = addDays(startOf(h), -7);
    const keys = [String(h.symbol)];
    if (h.currency && h.currency !== 'ILS') keys.push(`${h.currency}ILS=X`);
    for (const k of keys) if (!from.has(k) || start < from.get(k)!) from.set(k, start);
  }
  const manual = new Set(db.prepare(`SELECT symbol FROM holdings WHERE manual_price IS NOT NULL`).pluck().all() as string[]);
  let points = 0;
  await Promise.all([...from.entries()].map(async ([symbol, start]) => {
    if (manual.has(symbol)) return;
    const covered = db.prepare(`SELECT MIN(date) FROM quote_history WHERE symbol = ?`).pluck().get(symbol) as string | null;
    const fresh = Date.now() - (historyFetchedAt.get(symbol) ?? 0) < HISTORY_TTL;
    if (!force && fresh && covered && covered <= addDays(start, 7)) return;
    try {
      const fx = symbol.match(/^([A-Z]{3})ILS=X$/);
      const history = await fetchHistory(symbol, start);
      db.transaction(() => {
        for (const p of history) {
          if (fx) {
            db.prepare(`INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES (?, ?, ?, 'yahoo') ON CONFLICT(date, currency) DO NOTHING`)
              .run(p.date, fx[1], p.close);
          }
          db.prepare(`INSERT INTO quote_history (symbol, date, close) VALUES (?, ?, ?) ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close`)
            .run(symbol, p.date, p.close);
        }
      })();
      historyFetchedAt.set(symbol, Date.now());
      points += history.length;
    } catch (err) {
      console.warn(`  price history of ${symbol} not refreshed:`, (err as Error).message);
    }
  }));
  return points;
}
