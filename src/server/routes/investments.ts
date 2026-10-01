import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { today } from '../../analytics/common.js';
import { portfolio } from '../../analytics/investments.js';
import { fetchQuote, refreshHistory, refreshQuotes, saveQuote, searchSymbols } from '../../analytics/quotes.js';
import { pickColumns, snake, toApi } from '../crud.js';

/** Stock-market holdings: live value, yield, history. Prices come from Yahoo Finance (only the symbols are sent). */
const COLUMNS = ['symbol', 'name', 'quantity', 'currency', 'buyPrice', 'buyDate', 'baselinePrice', 'baselineDate', 'manualPrice',
  'manualPriceDate', 'broker', 'ownerMemberId', 'notes', 'archived'].map(snake);

type Row = Record<string, any>;

/** Wait for a refresh, but never hold the page longer than `ms` — the cached prices are shown meanwhile. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>(r => setTimeout(r, ms))]).catch(() => undefined);

export async function refreshPrices(db: DB, maxAgeMs = 60_000, force = false): Promise<void> {
  await within(Promise.all([refreshQuotes(db, force ? 0 : maxAgeMs), refreshHistory(db, force)]), 8000);
}

export function investmentRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/investments', async () => {
    await refreshPrices(db);
    return portfolio(db);
  });

  app.post('/api/investments/refresh', async () => {
    await refreshPrices(db, 0, true);
    return portfolio(db);
  });

  app.get('/api/investments/search', async req => {
    const q = String((req.query as { q?: string }).q ?? '').trim();
    // Yahoo's search is Latin-only
    if (q.length < 1 || /[֐-׿]/.test(q)) return [];
    return searchSymbols(q).catch(() => []);
  });

  app.get('/api/investments/quote', async (req, reply) => {
    const symbol = String((req.query as { symbol?: string }).symbol ?? '').trim();
    if (!symbol) return reply.code(400).send({ error: 'symbol is required' });
    try {
      const q = await fetchQuote(symbol);
      return q;
    } catch (err) {
      return reply.code(404).send({ error: `לא נמצא מחיר עבור ${symbol}: ${(err as Error).message}` });
    }
  });

  app.post('/api/investments/holdings', async (req, reply) => {
    const values = pickColumns(req.body as Row, COLUMNS) as Row;
    values.symbol = String(values.symbol ?? '').trim().toUpperCase();
    if (!values.symbol) return reply.code(400).send({ error: 'symbol is required' });
    if (!(Number(values.quantity) > 0)) return reply.code(400).send({ error: 'quantity must be positive' });

    if (values.manual_price != null) {
      values.currency ??= 'ILS';
      values.manual_price_date ??= today();
      if (values.buy_price == null) { values.baseline_price = values.manual_price; values.baseline_date = today(); }
    } else {
      let quote;
      try { quote = await fetchQuote(values.symbol); } catch (err) {
        return reply.code(400).send({ error: `לא נמצא מחיר עבור ${values.symbol} — בדקו את הסימול, או הזינו מחיר ידני (${(err as Error).message})` });
      }
      saveQuote(db, quote);
      values.symbol = quote.symbol;
      values.currency = quote.currency;
      // no buy price: the yield starts from today's price
      if (values.buy_price == null) { values.baseline_price = quote.price; values.baseline_date = today(); }
    }
    const keys = Object.keys(values);
    const res = db.prepare(`INSERT INTO holdings (${keys.join(', ')}) VALUES (${keys.map(k => `@${k}`).join(', ')})`).run(values);
    refreshHistory(db).catch(() => undefined);
    return toApi(db.prepare(`SELECT * FROM holdings WHERE id = ?`).get(res.lastInsertRowid) as Row);
  });

  app.patch('/api/investments/holdings/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const values = pickColumns(req.body as Row, COLUMNS) as Row;
    delete values.symbol; // a different symbol is a different holding
    if ('manual_price' in values && values.manual_price != null && !('manual_price_date' in values)) values.manual_price_date = today();
    const keys = Object.keys(values);
    if (!keys.length) return reply.code(400).send({ error: 'no fields' });
    const res = db.prepare(`UPDATE holdings SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @__id`)
      .run({ ...values, __id: id });
    if (!res.changes) return reply.code(404).send({ error: 'not found' });
    if ('buy_date' in values || 'manual_price' in values) refreshHistory(db).catch(() => undefined);
    return toApi(db.prepare(`SELECT * FROM holdings WHERE id = ?`).get(id) as Row);
  });

  app.delete('/api/investments/holdings/:id', async req => {
    db.prepare(`DELETE FROM holdings WHERE id = ?`).run(Number((req.params as { id: string }).id));
    return { ok: true };
  });
}
