import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { toApi } from '../crud.js';

interface CategoryRow { id: number; name: string; parent_id: number | null; kind: string; default_fixed: number; discretionary: number }

const KINDS = ['expense', 'income', 'transfer', 'card_payment', 'savings'];

/**
 * Categories are a two-level tree: a parent groups sub-categories (e.g. "רכב" → "דלק", "חניונים").
 * Transactions can use either level; reports can roll sub-categories up into their parent.
 */
export function categoryRoutes(app: FastifyInstance, db: DB): void {
  const get = (id: number) => db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as CategoryRow | undefined;

  /** Validate a parent assignment; returns an error message or null. */
  const parentError = (id: number | null, parentId: number | null | undefined): string | null => {
    if (parentId == null) return null;
    if (id != null && parentId === id) return 'קטגוריה לא יכולה להיות האב של עצמה';
    const parent = get(parentId);
    if (!parent) return 'קטגוריית האב לא נמצאה';
    if (parent.parent_id != null) return 'אפשר לשייך רק לקטגוריה ראשית (שתי רמות בלבד)';
    if (id != null && db.prepare(`SELECT 1 FROM categories WHERE parent_id = ?`).get(id)) {
      return 'לקטגוריה הזו יש תתי-קטגוריות, ולכן היא חייבת להישאר ראשית';
    }
    return null;
  };

  app.get('/api/categories', async () => {
    const usage = new Map((db.prepare(`SELECT category_id, COUNT(1) AS n, SUM(charged_amount) AS total FROM transactions
      WHERE category_id IS NOT NULL GROUP BY category_id`).all() as { category_id: number; n: number; total: number }[])
      .map(u => [u.category_id, u]));
    return (db.prepare(`SELECT * FROM categories ORDER BY name`).all() as CategoryRow[]).map(c => ({
      ...toApi(c as unknown as Record<string, unknown>),
      transactions: usage.get(c.id)?.n ?? 0,
      total: usage.get(c.id)?.total ?? 0,
    }));
  });

  app.post('/api/categories', async (req, reply) => {
    const b = req.body as { name?: string; parentId?: number | null; kind?: string; defaultFixed?: number; discretionary?: number };
    const name = b.name?.trim();
    if (!name) return reply.code(400).send({ error: 'חסר שם' });
    if (db.prepare(`SELECT 1 FROM categories WHERE name = ?`).get(name)) return reply.code(409).send({ error: 'קטגוריה בשם הזה כבר קיימת' });
    const err = parentError(null, b.parentId);
    if (err) return reply.code(400).send({ error: err });
    const parent = b.parentId != null ? get(b.parentId) : undefined;
    // a new sub-category inherits its parent's kind and flags unless given
    const res = db.prepare(`INSERT INTO categories (name, parent_id, kind, default_fixed, discretionary) VALUES (?, ?, ?, ?, ?)`).run(
      name, b.parentId ?? null,
      KINDS.includes(b.kind ?? '') ? b.kind : parent?.kind ?? 'expense',
      b.defaultFixed ?? parent?.default_fixed ?? 0,
      b.discretionary ?? parent?.discretionary ?? 1,
    );
    return toApi(get(Number(res.lastInsertRowid)) as unknown as Record<string, unknown>);
  });

  app.patch('/api/categories/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = req.body as { name?: string; parentId?: number | null; kind?: string; defaultFixed?: number; discretionary?: number };
    if (!get(id)) return reply.code(404).send({ error: 'not found' });
    if ('parentId' in b) {
      const err = parentError(id, b.parentId);
      if (err) return reply.code(400).send({ error: err });
    }
    if (b.name != null) {
      const name = b.name.trim();
      if (!name) return reply.code(400).send({ error: 'חסר שם' });
      if (db.prepare(`SELECT 1 FROM categories WHERE name = ? AND id != ?`).get(name, id)) return reply.code(409).send({ error: 'קטגוריה בשם הזה כבר קיימת' });
      b.name = name;
    }
    if (b.kind != null && !KINDS.includes(b.kind)) return reply.code(400).send({ error: 'סוג לא חוקי' });
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };
    for (const [key, col] of [['name', 'name'], ['parentId', 'parent_id'], ['kind', 'kind'], ['defaultFixed', 'default_fixed'], ['discretionary', 'discretionary']] as const) {
      if (key in b) { sets.push(`${col} = @${col}`); values[col] = (b as Record<string, unknown>)[key] ?? null; }
    }
    const before = get(id)!;
    db.transaction(() => {
      if (sets.length) db.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = @id`).run(values);
      // keep the old name pointing here, so the categorizer's names don't recreate it
      if (b.name != null && b.name !== before.name) {
        db.prepare(`DELETE FROM category_aliases WHERE name = ?`).run(b.name);
        db.prepare(`INSERT OR REPLACE INTO category_aliases (name, category_id) VALUES (?, ?)`).run(before.name, id);
      }
    })();
    return toApi(get(id) as unknown as Record<string, unknown>);
  });

  /**
   * Delete a category, moving everything that uses it to `moveTo` (a merge), or to
   * "uncategorized" when moveTo is omitted. Sub-categories move up to top level.
   */
  app.delete('/api/categories/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const moveTo = (req.query as { moveTo?: string }).moveTo ? Number((req.query as { moveTo: string }).moveTo) : null;
    if (!get(id)) return reply.code(404).send({ error: 'not found' });
    if (moveTo === id) return reply.code(400).send({ error: 'אי אפשר למזג קטגוריה לתוך עצמה' });
    if (moveTo != null && !get(moveTo)) return reply.code(400).send({ error: 'קטגוריית היעד לא נמצאה' });

    let moved = 0;
    db.transaction(() => {
      moved = db.prepare(`UPDATE transactions SET category_id = ?, category_source = CASE WHEN ? IS NULL THEN NULL ELSE category_source END
        WHERE category_id = ?`).run(moveTo, moveTo, id).changes;
      // budgets: add into the target's budget for the same member/month, or drop
      const budgets = db.prepare(`SELECT * FROM budgets WHERE category_id = ?`).all(id) as { id: number; member_id: number | null; monthly_amount: number; effective_from: string }[];
      for (const bud of budgets) {
        if (moveTo != null) {
          const existing = db.prepare(`SELECT id FROM budgets WHERE category_id = ? AND member_id IS ? AND effective_from = ?`).get(moveTo, bud.member_id, bud.effective_from) as { id: number } | undefined;
          if (existing) db.prepare(`UPDATE budgets SET monthly_amount = monthly_amount + ? WHERE id = ?`).run(bud.monthly_amount, existing.id);
          else db.prepare(`UPDATE budgets SET category_id = ? WHERE id = ?`).run(moveTo, bud.id);
        }
        db.prepare(`DELETE FROM budgets WHERE id = ? AND category_id = ?`).run(bud.id, id);
      }
      db.prepare(`UPDATE category_rules SET set_category_id = ? WHERE set_category_id = ?`).run(moveTo, id);
      db.prepare(`UPDATE recurring_series SET category_id = ? WHERE category_id = ?`).run(moveTo, id);
      db.prepare(`UPDATE scheduled_items SET category_id = ? WHERE category_id = ?`).run(moveTo, id);
      db.prepare(`UPDATE categories SET parent_id = NULL WHERE parent_id = ?`).run(id);
      // a merge leaves the old name (and names that pointed to it) aimed at the target
      if (moveTo != null) {
        db.prepare(`UPDATE category_aliases SET category_id = ? WHERE category_id = ?`).run(moveTo, id);
        db.prepare(`INSERT OR REPLACE INTO category_aliases (name, category_id) VALUES (?, ?)`).run(get(id)!.name, moveTo);
      }
      db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
    })();
    return { ok: true, moved };
  });
}
