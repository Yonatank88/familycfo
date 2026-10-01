import type { DB } from '../db/connection.js';
import { round, today } from './common.js';
import { rateToIls } from './fx.js';
import { startOf } from './quotes.js';

/**
 * Stock-market holdings valued from their latest quote (src/analytics/quotes.ts), in ILS.
 * Yield runs from the buy price when it's known, else from the baseline (the price when the holding was added).
 */
export interface HoldingValue {
  id: number;
  symbol: string;
  name: string;
  quantity: number;
  currency: string;
  broker: string | null;
  ownerMemberId: number | null;
  notes: string | null;
  exchange: string | null;
  instrumentType: string | null;
  buyPrice: number | null;
  buyDate: string | null;
  baselinePrice: number | null;
  baselineDate: string | null;
  manualPrice: number | null;
  manualPriceDate: string | null;
  /** price per unit now (quote currency) */
  price: number | null;
  priceSource: 'quote' | 'manual' | 'none';
  priceAsOf: string | null;
  previousClose: number | null;
  quoteError: string | null;
  rate: number;
  value: number;
  valueIls: number;
  /** what the yield is measured from: the buy, or the baseline */
  basis: 'buy' | 'baseline' | null;
  basisDate: string | null;
  cost: number | null;
  costIls: number | null;
  /** gain in the quote currency (the security itself) and in ILS (with the exchange-rate effect) */
  gain: number | null;
  gainPct: number | null;
  gainIls: number | null;
  gainIlsPct: number | null;
  dayChangePct: number | null;
  dayChangeIls: number;
}

export interface Portfolio {
  holdings: HoldingValue[];
  totals: {
    count: number;
    valueIls: number;
    costIls: number;
    gainIls: number;
    gainPct: number | null;
    dayChangeIls: number;
    dayChangePct: number | null;
    quotesAsOf: string | null;
    errors: number;
  };
  byCurrency: Record<string, number>;
  byBroker: Record<string, number>;
  history: { date: string; value: number }[];
}

type Row = Record<string, any>;

const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));

function loadHoldings(db: DB): Row[] {
  return db.prepare(`
    SELECT h.*, q.name AS quote_name, q.price AS quote_price, q.previous_close, q.currency AS quote_currency, q.exchange,
      q.instrument_type, q.market_time, q.fetched_at, q.error AS quote_error
    FROM holdings h LEFT JOIN quotes q ON q.symbol = h.symbol
    WHERE h.archived = 0 ORDER BY h.symbol, h.id
  `).all() as Row[];
}

export function valueHolding(db: DB, h: Row, asOf = today()): HoldingValue {
  const manual = h.manual_price != null;
  const price: number | null = manual ? h.manual_price : h.quote_price ?? null;
  const currency: string = (manual ? h.currency : h.quote_currency ?? h.currency) ?? 'ILS';
  const rate = rateToIls(db, currency, asOf) ?? 1;
  const value = (price ?? 0) * h.quantity;

  const basis = h.buy_price != null ? 'buy' : h.baseline_price != null ? 'baseline' : null;
  const basisPrice: number | null = h.buy_price ?? h.baseline_price ?? null;
  const basisDate: string | null = basis === 'buy' ? h.buy_date ?? null : basis === 'baseline' ? h.baseline_date ?? null : null;
  const cost = basisPrice == null ? null : basisPrice * h.quantity;
  // the cost in ILS at that day's rate — so the ILS gain includes what the exchange rate did
  const costIls = cost == null ? null : cost * (rateToIls(db, currency, basisDate ?? asOf) ?? rate);
  const valueIls = value * rate;

  // today's change only once the market traded today (US stocks are still at yesterday's close in the Israeli morning)
  const tradedToday = !!h.market_time && localDate(h.market_time) >= asOf;
  const prev = manual || !tradedToday ? null : h.previous_close ?? null;
  const dayChangePct = price != null && prev ? (price / prev - 1) * 100 : null;
  const dayChangeIls = price != null && prev ? (price - prev) * h.quantity * rate : 0;

  return {
    id: h.id, symbol: h.symbol, name: h.name || h.quote_name || h.symbol, quantity: h.quantity, currency,
    broker: h.broker ?? null, ownerMemberId: h.owner_member_id ?? null, notes: h.notes ?? null,
    exchange: h.exchange ?? null, instrumentType: manual ? null : h.instrument_type ?? null,
    buyPrice: h.buy_price ?? null, buyDate: h.buy_date ?? null, baselinePrice: h.baseline_price ?? null, baselineDate: h.baseline_date ?? null,
    manualPrice: h.manual_price ?? null, manualPriceDate: h.manual_price_date ?? null,
    price, priceSource: manual ? 'manual' : price != null ? 'quote' : 'none',
    priceAsOf: manual ? h.manual_price_date ?? null : h.market_time ?? null,
    previousClose: prev, quoteError: manual ? null : h.quote_error ?? null,
    rate, value: round(value), valueIls: round(valueIls),
    basis, basisDate, cost: cost == null ? null : round(cost), costIls: costIls == null ? null : round(costIls),
    gain: cost == null || price == null ? null : round(value - cost),
    gainPct: cost && price != null ? round((value / cost - 1) * 100) : null,
    gainIls: costIls == null || price == null ? null : round(valueIls - costIls),
    gainIlsPct: costIls && price != null ? round((valueIls / costIls - 1) * 100) : null,
    dayChangePct: dayChangePct == null ? null : round(dayChangePct), dayChangeIls: round(dayChangeIls),
  };
}

/** Every current holding at its latest price (no history) — for net worth. */
export const holdingValues = (db: DB, asOf = today()) => loadHoldings(db).map(h => valueHolding(db, h, asOf));

export function portfolio(db: DB, asOf = today()): Portfolio {
  const rows = loadHoldings(db);
  const holdings = rows.map(h => valueHolding(db, h, asOf));
  const priced = holdings.filter(h => h.price != null);
  const withCost = priced.filter(h => h.costIls != null);
  const valueIls = priced.reduce((s, h) => s + h.valueIls, 0);
  const costIls = withCost.reduce((s, h) => s + h.costIls!, 0);
  const gainIls = withCost.reduce((s, h) => s + h.gainIls!, 0);
  const dayChangeIls = holdings.reduce((s, h) => s + h.dayChangeIls, 0);
  const sumBy = (key: (h: HoldingValue) => string) => holdings.reduce<Record<string, number>>((acc, h) => {
    acc[key(h)] = round((acc[key(h)] ?? 0) + h.valueIls);
    return acc;
  }, {});
  const fetched = rows.map(r => r.fetched_at).filter(Boolean).sort();

  const history = portfolioHistory(db, rows);
  // today's point is the live value
  if (holdings.length) {
    if (history.at(-1)?.date === asOf) history.pop();
    history.push({ date: asOf, value: round(valueIls) });
  }

  return {
    holdings,
    totals: {
      count: holdings.length,
      valueIls: round(valueIls),
      costIls: round(costIls),
      gainIls: round(gainIls),
      gainPct: costIls ? round((gainIls / costIls) * 100) : null,
      dayChangeIls: round(dayChangeIls),
      dayChangePct: valueIls - dayChangeIls ? round((dayChangeIls / (valueIls - dayChangeIls)) * 100) : null,
      quotesAsOf: fetched.at(-1) ?? null,
      errors: holdings.filter(h => h.quoteError).length,
    },
    byCurrency: sumBy(h => h.currency),
    byBroker: sumBy(h => h.broker ?? ''),
    history,
  };
}

/**
 * Daily value of today's holdings since each one started (bought / baseline / added), from the stored closes.
 * Assumes the quantity didn't change since — a sold-off part isn't in the history.
 */
export function portfolioHistory(db: DB, rows: Row[] = loadHoldings(db)): { date: string; value: number }[] {
  if (!rows.length) return [];
  const series = rows.map(h => ({
    h,
    start: startOf(h),
    currency: (h.manual_price != null ? h.currency : h.quote_currency ?? h.currency) ?? 'ILS',
    closes: h.manual_price != null ? [] : db.prepare(`SELECT date, close FROM quote_history WHERE symbol = ? ORDER BY date`).all(h.symbol) as { date: string; close: number }[],
  }));
  const first = series.reduce((m, s) => (s.start < m ? s.start : m), today());
  const dates = [...new Set(series.flatMap(s => s.closes.map(c => c.date)))].filter(d => d >= first).sort();
  const rates = new Map<string, number>();
  const rate = (cur: string, d: string) => {
    const k = `${cur}|${d}`;
    if (!rates.has(k)) rates.set(k, rateToIls(db, cur, d) ?? 1);
    return rates.get(k)!;
  };
  const idx = series.map(() => -1);
  return dates.map(date => {
    let value = 0;
    series.forEach((s, i) => {
      if (date < s.start) return;
      if (s.h.manual_price != null) { value += s.h.manual_price * s.h.quantity * rate(s.currency, date); return; }
      while (idx[i] + 1 < s.closes.length && s.closes[idx[i] + 1].date <= date) idx[i]++;
      const close = s.closes[idx[i]]?.close;
      if (close != null) value += close * s.h.quantity * rate(s.currency, date);
    });
    return { date, value: round(value) };
  });
}
