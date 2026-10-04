import type { DB } from '../db/connection.js';
import { round, today } from '../util.js';
import { rateToIls } from './fx.js';
import type { AssetClass } from '../sync/assets.js';

/** A synced holding at its latest price (the quote's, else the source's own), in its currency and in ILS. */
export interface HoldingValue {
  id: number;
  /** the investment source id (ibkr, wallets, binance, report…) */
  source: string;
  /** the holding's own source: <source id>:<account> */
  holdingSource: string;
  broker: string | null;
  symbol: string;
  name: string;
  quantity: number;
  currency: string;
  assetClass: AssetClass;
  price: number | null;
  priceSource: 'quote' | 'source' | 'none';
  /** the date of the source's own price (a report's as-of date), when it is used */
  priceDate: string | null;
  value: number;
  /** null when there is no exchange rate for its currency — it's left out of totals, never valued 1:1 */
  valueIls: number | null;
  /** value − cost basis, when the source reports a cost in the same currency (IBKR); null otherwise */
  gain: number | null;
  gainIls: number | null;
  gainPct: number | null;
}

type Row = Record<string, any>;

function loadHoldings(db: DB, source?: string): Row[] {
  return db.prepare(`
    SELECT h.*, q.name AS quote_name, q.price AS quote_price, q.currency AS quote_currency
    FROM holdings h LEFT JOIN quotes q ON q.symbol = h.symbol
    WHERE h.archived = 0 ${source ? `AND (h.source = @source OR h.source LIKE @source || ':%')` : ''}
    ORDER BY h.symbol, h.id
  `).all(source ? { source } : {}) as Row[];
}

export function valueHolding(db: DB, h: Row, asOf = today()): HoldingValue {
  const manual = h.manual_price != null;
  const price: number | null = manual ? h.manual_price : h.quote_price ?? null;
  const currency: string = (manual ? h.currency : h.quote_currency ?? h.currency) ?? 'ILS';
  const rate = rateToIls(db, currency, asOf);
  const value = (price ?? 0) * h.quantity;
  // the cost is in the holding's own currency; a quote in another currency can't be compared with it
  const cost: number | null = h.cost_basis != null && price != null && currency === (h.currency ?? currency) ? h.cost_basis : null;
  const gain = cost == null ? null : value - cost;
  return {
    id: h.id, source: String(h.source).split(':')[0], holdingSource: h.source, broker: h.broker ?? null, symbol: h.symbol, name: h.name || h.quote_name || h.symbol,
    quantity: h.quantity, currency, assetClass: h.asset_class,
    price, priceSource: manual ? 'source' : price != null ? 'quote' : 'none', priceDate: manual ? h.manual_price_date ?? null : null,
    value: round(value), valueIls: rate == null ? null : round(value * rate),
    gain: gain == null ? null : round(gain), gainIls: gain == null || rate == null ? null : round(gain * rate),
    gainPct: gain == null || !cost ? null : round((gain / Math.abs(cost)) * 100),
  };
}

/** Every current holding (of one source, when given) at its latest price. */
export const holdingValues = (db: DB, asOf = today(), source?: string) => loadHoldings(db, source).map(h => valueHolding(db, h, asOf));
