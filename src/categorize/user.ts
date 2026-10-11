import type { DB } from '../db/connection.js';
import { computeNatures } from '../analytics/nature.js';
import { SPEND_CATEGORIES } from '../db/schema.js';
import { merchantKey, merchantLine } from '../util.js';

/**
 * A merchant's category chosen by the user: stored in `merchant_categories` with `source = 'user'`, and every spend row
 * of the merchant (all time, every account) gets it with `category_source = 'manual'`. Rules, the scraper's category
 * and the AI only touch rows that are uncategorised or `ai` / `rule` / `scraper`, so a manual row is never replaced;
 * new rows of the merchant are brought in line every run (`applyUserCategories`, after the rules, before the AI).
 */

/** The categories a merchant can be set to: the spend categories that exist, in their order. */
export function merchantCategoryOptions(db: DB): string[] {
  const have = new Set(db.prepare(`SELECT name FROM categories WHERE kind = 'expense' AND parent_id IS NULL`).pluck().all() as string[]);
  return SPEND_CATEGORIES.filter(n => have.has(n));
}

/** Give every spend row of a user-categorised merchant its chosen category; returns the rows changed. */
export function applyUserCategories(db: DB, merchants?: string[]): number {
  const overrides = new Map((db.prepare(`SELECT merchant, category_id FROM merchant_categories WHERE source = 'user' AND category_id IS NOT NULL`)
    .all() as { merchant: string; category_id: number }[]).filter(o => !merchants || merchants.includes(o.merchant)).map(o => [o.merchant, o.category_id]));
  if (!overrides.size) return 0;
  const rows = db.prepare(`SELECT id, description, memo, category_id, category_source FROM transactions WHERE kind IN ('expense', 'refund')`)
    .all() as { id: number; description: string; memo: string | null; category_id: number | null; category_source: string | null }[];
  const set = db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?`);
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const id = overrides.get(merchantKey(merchantLine(r.description, r.memo)));
      if (id != null && (r.category_id !== id || r.category_source !== 'manual')) { set.run(id, r.id); n++; }
    }
  })();
  return n;
}

/** Set a merchant's category (a spend category's name), re-tag all its rows and recompute natures. */
export function setMerchantCategory(db: DB, merchant: string, category: string): { rows: number } {
  const key = merchant.trim();
  if (!key) throw new Error('merchant is required');
  if (!merchantCategoryOptions(db).includes(category)) throw new Error(`category must be one of ${merchantCategoryOptions(db).join(', ')}`);
  const id = db.prepare(`SELECT id FROM categories WHERE name = ? AND kind = 'expense' AND parent_id IS NULL`).pluck().get(category) as number;
  const rows = db.transaction(() => {
    db.prepare(`INSERT INTO merchant_categories (merchant, category_id, confidence, source, model) VALUES (?, ?, 1, 'user', NULL)
      ON CONFLICT (merchant) DO UPDATE SET category_id = excluded.category_id, confidence = 1, source = 'user', model = NULL,
      created_at = CURRENT_TIMESTAMP`).run(key, id);
    return applyUserCategories(db, [key]);
  })();
  computeNatures(db);
  return { rows };
}
