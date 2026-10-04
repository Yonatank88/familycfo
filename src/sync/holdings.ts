import type { DB } from '../db/connection.js';
import { today } from '../util.js';
import { fetchQuote, saveQuote, type Quote } from '../analytics/quotes.js';
import type { AssetClass } from './assets.js';

/**
 * Positions read from a broker, wallet or exchange (src/sync/*) → `holdings`, priced live from Yahoo when it can be.
 * Each source owns its rows (`holdings.source`): a re-sync updates the quantity and price, a position that is gone is
 * archived, one that comes back is restored.
 */
export interface SyncedPosition {
  /** the source's own symbol — used when there's no Yahoo symbol */
  symbol: string;
  /** the Yahoo Finance symbol to price it live (AAPL, TEVA.TA, ETH-USD); null = nothing to quote (options, bonds, cash) */
  yahoo: string | null;
  name?: string | null;
  quantity: number;
  /** currency of `price`, major units */
  currency: string;
  assetClass: AssetClass;
  /** the source's own price per unit: the price when there's no quote, and a check that the quote is the same thing */
  price: number | null;
  /** what the position cost in total, in `currency` (IBKR's cost basis, an exchange's average cost); undefined = not
   * determined this run (the stored one stays), null = unknown */
  costBasis?: number | null;
  /** where costBasis came from: broker | trades */
  costSource?: 'broker' | 'trades' | null;
  /** YYYY-MM-DD the position was opened; undefined = not determined this run (the stored one stays) */
  openedAt?: string | null;
}

export interface SyncedAccount {
  /** `${source id}:${account}` — e.g. ibkr:U1234567 */
  source: string;
  broker: string;
  positions: SyncedPosition[];
}

export interface SyncResult { added: number; updated: number; removed: number; manual: number }

/** A quote further than this from the source's own price is a different instrument with the same ticker (e.g. a token). */
const MAX_QUOTE_GAP = 0.2;
const QUOTE_MAX_AGE_MS = 24 * 3600_000;

/** The symbol's quote: the cached one when fresh, else fetched (and cached). null = Yahoo doesn't know it. */
async function quoteFor(db: DB, symbol: string, fetcher: (symbol: string) => Promise<Quote>): Promise<{ price: number; currency: string } | null> {
  const cached = db.prepare(`SELECT price, currency FROM quotes WHERE symbol = ? AND price IS NOT NULL AND error IS NULL AND fetched_at >= ?`)
    .get(symbol, new Date(Date.now() - QUOTE_MAX_AGE_MS).toISOString()) as { price: number; currency: string } | undefined;
  if (cached) return cached;
  try {
    const q = await fetcher(symbol);
    saveQuote(db, { ...q, symbol });
    return q;
  } catch {
    return null;
  }
}

/** Live (from the quote) when Yahoo has the symbol and its price agrees with the source's; else the source's price. */
async function priceOf(db: DB, p: SyncedPosition, fetcher: (symbol: string) => Promise<Quote>) {
  const q = p.yahoo ? await quoteFor(db, p.yahoo, fetcher) : null;
  const agrees = q && (!p.price || (q.currency === p.currency && Math.abs(q.price / p.price - 1) <= MAX_QUOTE_GAP));
  return agrees ? { live: true as const, price: q!.price, currency: q!.currency } : { live: false as const, price: p.price, currency: p.currency };
}

/**
 * Upsert every position of the accounts read from source `sourceId` (by source + symbol), and archive this source's
 * holdings that weren't in them. Only call it with a complete read — a failed fetch must not archive anything.
 */
export async function syncHoldings(db: DB, sourceId: string, accounts: SyncedAccount[],
  opts: { fetchQuote?: (symbol: string) => Promise<Quote>; asOf?: string } = {}): Promise<SyncResult> {
  const fetcher = opts.fetchQuote ?? fetchQuote;
  const day = opts.asOf ?? today();
  const now = new Date().toISOString();
  const result: SyncResult = { added: 0, updated: 0, removed: 0, manual: 0 };

  // quotes first (network), then one transaction for the writes
  const rows: { account: SyncedAccount; p: SyncedPosition; symbol: string; price: Awaited<ReturnType<typeof priceOf>> }[] = [];
  for (const account of accounts) {
    for (const p of account.positions) {
      if (!p.quantity) continue;
      rows.push({ account, p, symbol: (p.yahoo ?? p.symbol).toUpperCase(), price: await priceOf(db, p, fetcher) });
    }
  }

  const find = db.prepare(`SELECT id FROM holdings WHERE source = ? AND symbol = ?`).pluck();
  const insert = db.prepare(`INSERT INTO holdings (source, symbol, name, quantity, currency, asset_class, manual_price,
    manual_price_date, broker, cost_basis, cost_basis_source, opened_at, synced_at)
    VALUES (@source, @symbol, @name, @quantity, @currency, @assetClass, @manualPrice, @manualDate, @broker, @costBasis, @costSource, @openedAt, @now)`);
  // cost and opening date not determined this run (undefined) keep what is stored
  const update = db.prepare(`UPDATE holdings SET name = COALESCE(@name, name), quantity = @quantity, currency = @currency,
    asset_class = @assetClass, manual_price = @manualPrice, manual_price_date = @manualDate, broker = @broker,
    cost_basis = CASE WHEN @keepCost THEN cost_basis ELSE @costBasis END,
    cost_basis_source = CASE WHEN @keepCost THEN cost_basis_source ELSE @costSource END,
    opened_at = CASE WHEN @keepOpened THEN opened_at ELSE @openedAt END, archived = 0,
    synced_at = @now, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id`);
  const seen: number[] = [];

  db.transaction(() => {
    for (const { account, p, symbol, price } of rows) {
      const values = {
        symbol, name: p.name ?? null, quantity: p.quantity, currency: price.currency, assetClass: p.assetClass,
        manualPrice: price.live ? null : price.price, manualDate: price.live ? null : day,
        broker: account.broker, source: account.source, costBasis: p.costBasis ?? null, now,
        costSource: p.costBasis == null ? null : p.costSource ?? null, openedAt: p.openedAt ?? null,
      };
      if (!price.live) result.manual++;
      const id = find.get(account.source, symbol) as number | undefined;
      if (id != null) {
        update.run({ ...values, id, keepCost: p.costBasis === undefined ? 1 : 0, keepOpened: p.openedAt === undefined ? 1 : 0 });
        seen.push(id);
        result.updated++;
      } else {
        seen.push(Number(insert.run(values).lastInsertRowid));
        result.added++;
      }
    }
    result.removed = db.prepare(`UPDATE holdings SET archived = 1, synced_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE (source = ? OR source LIKE ? || ':%') AND archived = 0 AND id NOT IN (SELECT value FROM json_each(?))`)
      .run(now, sourceId, sourceId, JSON.stringify(seen)).changes;
  })();
  return result;
}
