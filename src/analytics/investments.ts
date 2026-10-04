import type { DB } from '../db/connection.js';
import { round, today } from '../util.js';
import { rateToIls } from './fx.js';
import type { AssetClass } from '../sync/assets.js';

/** A synced holding at its latest price (the quote's, else the source's own), in its currency and in ILS. */
export interface HoldingValue {
  id: number;
  /** the investment source id (ibkr, wallets, binance…) */
  source: string;
  symbol: string;
  name: string;
  quantity: number;
  currency: string;
  assetClass: AssetClass;
  price: number | null;
  priceSource: 'quote' | 'source' | 'none';
  value: number;
  /** null when there is no exchange rate for its currency — it's left out of totals, never valued 1:1 */
  valueIls: number | null;
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
  return {
    id: h.id, source: String(h.source).split(':')[0], symbol: h.symbol, name: h.name || h.quote_name || h.symbol,
    quantity: h.quantity, currency, assetClass: h.asset_class,
    price, priceSource: manual ? 'source' : price != null ? 'quote' : 'none',
    value: round(value), valueIls: rate == null ? null : round(value * rate),
  };
}

/** Every current holding (of one source, when given) at its latest price. */
export const holdingValues = (db: DB, asOf = today(), source?: string) => loadHoldings(db, source).map(h => valueHolding(db, h, asOf));
