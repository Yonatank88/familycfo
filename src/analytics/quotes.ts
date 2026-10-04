import type { DB } from '../db/connection.js';
import { today } from '../util.js';
import { normalizeCurrency } from './fx.js';

/**
 * Live market prices from Yahoo Finance's public chart endpoint (no key). Only symbols are sent —
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
