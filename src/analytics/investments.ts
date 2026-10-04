import type { DB } from '../db/connection.js';
import { round, today } from '../util.js';
import { rateToIls } from './fx.js';

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
  /** synced from a broker / wallet / exchange (src/sync/): when — the sync owns its quantity and price */
  syncedAt: string | null;
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
    broker: h.broker ?? null, ownerMemberId: h.owner_member_id ?? null, notes: h.notes ?? null, syncedAt: h.source ? h.synced_at ?? null : null,
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
