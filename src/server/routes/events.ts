import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { loadTransactions, NON_SPEND_KINDS, refundOf, round, spendOf, type Tx } from '../../analytics/common.js';
import { toApi } from '../crud.js';

interface TagRow { id: number; name: string; color: string | null; start_date: string | null; end_date: string | null; budget: number | null; notes: string | null; archived: number }

/** Net cost of an event row: spend minus refunds (both already net of the business share). */
const costOf = (t: Tx) => spendOf(t) - refundOf(t);

function summarize(txs: Tx[]) {
  const rows = txs.filter(t => !NON_SPEND_KINDS.has(t.kind));
  const total = round(rows.reduce((s, t) => s + costOf(t), 0));
  const group = (key: (t: Tx) => string) => {
    const m = new Map<string, { amount: number; count: number }>();
    for (const t of rows) {
      const k = key(t);
      const cur = m.get(k) ?? { amount: 0, count: 0 };
      m.set(k, { amount: cur.amount + costOf(t), count: cur.count + 1 });
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, amount: round(v.amount), count: v.count })).sort((a, b) => b.amount - a.amount);
  };
  const dates = rows.map(t => t.date).sort();
  return {
    total,
    spend: round(rows.reduce((s, t) => s + spendOf(t), 0)),
    refunds: round(rows.reduce((s, t) => s + refundOf(t), 0)),
    count: rows.length,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    byCategory: group(t => t.categoryName ?? 'ללא קטגוריה'),
    byMember: group(t => String(t.memberId)),
    byDay: group(t => t.date).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function eventRoutes(app: FastifyInstance, db: DB): void {
  const tagOf = (id: number) => db.prepare(`SELECT * FROM tags WHERE id = ?`).get(id) as TagRow | undefined;
  const taggedIds = (tagId: number) => new Set(db.prepare(`SELECT transaction_id FROM transaction_tags WHERE tag_id = ?`).pluck().all(tagId) as number[]);
  const originalCurrency = () => new Map((db.prepare(`SELECT id, original_currency, original_amount FROM transactions`).all() as
    { id: number; original_currency: string | null; original_amount: number }[]).map(r => [r.id, r]));

  /** Every tag with its total — the events list. */
  app.get('/api/events', async () => {
    const txs = loadTransactions(db);
    const byTag = new Map<number, Tx[]>();
    for (const t of txs) for (const tagId of t.tagIds) byTag.set(tagId, [...(byTag.get(tagId) ?? []), t]);
    return (db.prepare(`SELECT * FROM tags ORDER BY archived, COALESCE(start_date, '9999') DESC, name`).all() as TagRow[]).map(tag => {
      const s = summarize(byTag.get(tag.id) ?? []);
      return { ...toApi(tag as unknown as Record<string, unknown>), total: s.total, count: s.count, firstDate: s.firstDate, lastDate: s.lastDate };
    });
  });

  /** One event: totals, breakdowns, foreign-currency spend and its transactions. */
  app.get('/api/events/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const tag = tagOf(id);
    if (!tag) return reply.code(404).send({ error: 'not found' });
    const txs = loadTransactions(db).filter(t => t.tagIds.includes(id))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const orig = originalCurrency();

    // what was paid in each original currency (e.g. €1,200 → ₪4,650)
    const currencies = new Map<string, { original: number; ils: number; count: number }>();
    for (const t of txs.filter(t => !NON_SPEND_KINDS.has(t.kind))) {
      const o = orig.get(t.id);
      const cur = (o?.original_currency || 'ILS').replace('₪', 'ILS').replace('€', 'EUR').replace('$', 'USD');
      const c = currencies.get(cur) ?? { original: 0, ils: 0, count: 0 };
      currencies.set(cur, { original: c.original - (o?.original_amount ?? t.amount), ils: c.ils + costOf(t), count: c.count + 1 });
    }

    return {
      event: toApi(tag as unknown as Record<string, unknown>),
      ...summarize(txs),
      byCurrency: [...currencies.entries()].map(([currency, v]) => ({ currency, original: round(v.original), ils: round(v.ils), count: v.count }))
        .sort((a, b) => b.ils - a.ils),
      transactions: txs.map(t => ({ ...t, originalAmount: orig.get(t.id)?.original_amount, originalCurrency: orig.get(t.id)?.original_currency })),
    };
  });

  /**
   * Untagged transactions that probably belong to the event: anything in its date range (or a
   * custom from/to, e.g. to catch flights booked months before), foreign-currency rows first.
   */
  app.get('/api/events/:id/candidates', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { from?: string; to?: string };
    const tag = tagOf(id);
    if (!tag) return reply.code(404).send({ error: 'not found' });
    const from = q.from || tag.start_date;
    const to = q.to || tag.end_date || from;
    if (!from || !to) return { from, to, rows: [] };
    const tagged = taggedIds(id);
    const orig = originalCurrency();
    const rows = loadTransactions(db)
      .filter(t => t.date >= from && t.date <= to && !tagged.has(t.id) && (t.kind === 'expense' || t.kind === 'refund'))
      .map(t => {
        const o = orig.get(t.id);
        const foreign = !!o?.original_currency && !['ILS', '₪', 'NIS'].includes(o.original_currency.toUpperCase());
        return { ...t, originalAmount: o?.original_amount, originalCurrency: o?.original_currency, foreign };
      })
      .sort((a, b) => Number(b.foreign) - Number(a.foreign) || a.date.localeCompare(b.date));
    return { from, to, rows };
  });

  /** Tag / untag many rows at once. */
  app.post('/api/events/:id/transactions', async req => {
    const id = Number((req.params as { id: string }).id);
    const { add = [], remove = [] } = req.body as { add?: number[]; remove?: number[] };
    const ins = db.prepare(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`);
    const del = db.prepare(`DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?`);
    db.transaction(() => {
      for (const t of add) ins.run(t, id);
      for (const t of remove) del.run(t, id);
    })();
    return { added: add.length, removed: remove.length };
  });

}
