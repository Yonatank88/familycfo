import type { DB } from '../db/connection.js';
import { today } from '../util.js';
import { fetchQuote, saveQuote, type Quote } from '../analytics/quotes.js';

/**
 * Positions read from a broker, wallet or exchange (src/sync/*) → `holdings`, so they get live Yahoo prices, show on
 * /investments and count in net worth like the ones entered by hand. Each source owns its rows (`holdings.source`):
 * a re-sync updates the quantity and price, a position that is gone is archived, one that comes back is restored.
 */
export interface SyncedPosition {
  /** the source's own symbol — used when there's no Yahoo symbol */
  symbol: string;
  /** the Yahoo Finance symbol to price it live (AAPL, TEVA.TA, ETH-USD); null = nothing to quote (options, bonds, cash) */
  yahoo: string | null;
  name?: string | null;
  quantity: number;
  /** currency of `price` and `costPrice`, major units */
  currency: string;
  /** the source's own price per unit: the price when there's no quote, and a check that the quote is the same thing */
  price: number | null;
  /** average cost per unit, when the source knows it (becomes the buy price) */
  costPrice?: number | null;
}

export interface SyncedAccount {
  /** `${source id}:${account}` — e.g. ibkr:U1234567 */
  source: string;
  /** shown as the broker; net worth has one item per broker + owner */
  broker: string;
  ownerMemberId?: number | null;
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
  const insert = db.prepare(`INSERT INTO holdings (symbol, name, quantity, currency, buy_price, baseline_price, baseline_date,
    manual_price, manual_price_date, broker, owner_member_id, source, synced_at)
    VALUES (@symbol, @name, @quantity, @currency, @buyPrice, @baselinePrice, @day, @manualPrice, @manualDate, @broker, @owner, @source, @now)`);
  // name, broker and owner are the user's to change; the sync owns what the source reports
  const update = db.prepare(`UPDATE holdings SET quantity = @quantity, currency = @currency, buy_price = COALESCE(@buyPrice, buy_price),
    manual_price = @manualPrice, manual_price_date = @manualDate, archived = 0, synced_at = @now, updated_at = CURRENT_TIMESTAMP
    WHERE id = @id`);
  const seen: number[] = [];

  db.transaction(() => {
    for (const { account, p, symbol, price } of rows) {
      const values = {
        symbol, name: p.name ?? null, quantity: p.quantity, currency: price.currency,
        buyPrice: p.costPrice ?? null,
        // no cost: the yield runs from today's price, like a holding added by hand
        baselinePrice: p.costPrice == null ? price.price : null,
        manualPrice: price.live ? null : price.price, manualDate: price.live ? null : day,
        broker: account.broker, owner: account.ownerMemberId ?? null, source: account.source, now, day,
      };
      if (!price.live) result.manual++;
      const id = find.get(account.source, symbol) as number | undefined;
      if (id != null) {
        update.run({ ...values, id });
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
