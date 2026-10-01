import type { DB } from '../db/connection.js';

const BOI_URL = 'https://boi.org.il/PublicApi/GetExchangeRates';

/**
 * Rate to convert 1 unit of `currency` into ILS on `date` (latest rate on or before it,
 * else the earliest known). Returns null when no rate is known.
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

export function toIls(db: DB, amount: number, currency: string, date: string): number {
  const rate = rateToIls(db, currency, date);
  return rate == null ? amount : amount * rate;
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
