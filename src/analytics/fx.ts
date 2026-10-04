import type { DB } from '../db/connection.js';
import { addDays, today } from '../util.js';
import { fetchDailyCloses } from './quotes.js';

const BOI_URL = 'https://boi.org.il/PublicApi/GetExchangeRates';
const BOI_SERIES_URL = 'https://edge.boi.org.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0';

/**
 * Rate to convert 1 unit of `currency` into ILS on `date` (latest rate on or before it,
 * else the earliest known). Returns null when no rate is known — callers flag it, never use 1.
 */
export function rateToIls(db: DB, currency: string, date: string): number | null {
  const cur = normalizeCurrency(currency);
  if (cur === 'ILS') return 1;
  const row = db.prepare(`
    SELECT rate_to_ils FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1
  `).pluck().get(cur, date) as number | undefined
    ?? db.prepare(`SELECT rate_to_ils FROM fx_rates WHERE currency = ? ORDER BY date LIMIT 1`).pluck().get(cur) as number | undefined;
  return row ?? null;
}

/** Scrapers use symbols (₪ $ €) or codes; store codes. */
export function normalizeCurrency(currency: string | null | undefined): string {
  const c = (currency || 'ILS').trim().toUpperCase();
  return ({ '₪': 'ILS', 'NIS': 'ILS', 'ש"ח': 'ILS', '$': 'USD', '€': 'EUR', '£': 'GBP' } as Record<string, string>)[c] ?? c;
}

export function setRate(db: DB, date: string, currency: string, rate: number, source = 'manual'): void {
  db.prepare(`
    INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES (?, ?, ?, ?)
    ON CONFLICT(date, currency) DO UPDATE SET rate_to_ils = excluded.rate_to_ils, source = excluded.source
  `).run(date, normalizeCurrency(currency), rate, source);
}

/** Fetch today's representative rates from the Bank of Israel public API (no personal data sent). */
export async function refreshBoiRates(db: DB): Promise<number> {
  const res = await fetch(BOI_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Bank of Israel rates: HTTP ${res.status}`);
  const body = await res.json() as {
    exchangeRates?: { key: string; currentExchangeRate: number; unit: number; lastUpdate: string }[];
  };
  let count = 0;
  for (const r of body.exchangeRates ?? []) {
    setRate(db, r.lastUpdate.slice(0, 10), r.key, r.currentExchangeRate / (r.unit || 1), 'boi');
    count++;
  }
  return count;
}

/** A Yahoo rate fills a day the Bank of Israel hasn't published; it never replaces a BOI rate. */
export function saveMarketRate(db: DB, date: string, currency: string, rate: number): void {
  db.prepare(`
    INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES (?, ?, ?, 'yahoo')
    ON CONFLICT(date, currency) DO UPDATE SET rate_to_ils = excluded.rate_to_ils WHERE fx_rates.source = 'yahoo'
  `).run(date, normalizeCurrency(currency), rate);
}

/** Every foreign currency the household holds: bank accounts, holdings and their quotes. */
export function heldCurrencies(db: DB): string[] {
  return (db.prepare(`
    SELECT currency FROM accounts WHERE currency IS NOT NULL
    UNION SELECT currency FROM holdings WHERE archived = 0 AND currency IS NOT NULL
    UNION SELECT q.currency FROM quotes q JOIN holdings h ON h.symbol = q.symbol WHERE h.archived = 0 AND q.currency IS NOT NULL
  `).pluck().all() as string[]).map(normalizeCurrency).filter((c, i, all) => c !== 'ILS' && all.indexOf(c) === i);
}

/** Bank of Israel daily representative rates of one currency (CSV of its SDMX series). [] when BOI doesn't publish it. */
export async function fetchBoiSeries(currency: string, from: string, to: string): Promise<{ date: string; rate: number }[]> {
  const res = await fetch(`${BOI_SERIES_URL}/RER_${encodeURIComponent(currency)}_ILS?startperiod=${from}&endperiod=${to}&format=csv`,
    { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Bank of Israel ${currency} series: HTTP ${res.status}`);
  const [header, ...lines] = (await res.text()).trim().split(/\r?\n/);
  const cols = header.split(',');
  const at = (name: string) => cols.indexOf(name);
  const [iDate, iValue, iMult] = [at('TIME_PERIOD'), at('OBS_VALUE'), at('UNIT_MULT')];
  return lines.map(l => l.split(',')).filter(c => c[iDate] && c[iValue])
    // UNIT_MULT 2 = the rate is per 100 units (JPY)
    .map(c => ({ date: c[iDate], rate: Number(c[iValue]) / 10 ** Number(c[iMult] || 0) }))
    .filter(r => Number.isFinite(r.rate) && r.rate > 0);
}

/**
 * Daily rates of every held currency from `from` until today: Bank of Israel first; Yahoo only for the days after BOI's
 * last published one (or the whole range for a currency BOI doesn't publish). A currency with neither stays without a
 * rate, and whatever needs it is flagged.
 */
export async function backfillRates(db: DB, from: string, currencies = heldCurrencies(db), to = today()): Promise<{ boi: number; yahoo: number; missing: string[] }> {
  let boi = 0, yahoo = 0;
  const missing: string[] = [];
  for (const cur of currencies) {
    // already covered from `from`: only the last days are fetched again
    const covered = db.prepare(`SELECT MIN(date), MAX(date) FROM fx_rates WHERE currency = ? AND source = 'boi'`).get(cur) as Record<string, string | null>;
    const [minBoi, maxBoi] = Object.values(covered);
    const boiFrom = minBoi && maxBoi && minBoi <= addDays(from, 4) ? addDays(maxBoi, -7) : from;
    try {
      const rows = await fetchBoiSeries(cur, boiFrom, to);
      db.transaction(() => { for (const r of rows) setRate(db, r.date, cur, r.rate, 'boi'); })();
      boi += rows.length;
    } catch (err) {
      console.warn(`  BOI rates of ${cur} not fetched:`, (err as Error).message);
    }
    const lastBoi = db.prepare(`SELECT MAX(date) FROM fx_rates WHERE currency = ? AND source = 'boi'`).pluck().get(cur) as string | null;
    const gapFrom = lastBoi ? addDays(lastBoi, 1) : from;
    if (gapFrom <= to) {
      try {
        const closes = await fetchDailyCloses(`${cur}ILS=X`, gapFrom);
        db.transaction(() => { for (const c of closes) if (c.date >= gapFrom) saveMarketRate(db, c.date, cur, c.close); })();
        yahoo += closes.length;
      } catch { /* no Yahoo rate either */ }
    }
    if (rateToIls(db, cur, to) == null) missing.push(cur);
  }
  return { boi, yahoo, missing };
}
