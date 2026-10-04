import type { DB } from '../db/connection.js';

// JS `\b` only knows ASCII word characters, so Hebrew words need an explicit end-of-word lookahead
const WORD_END = `(?=$|[\\s\\-–'"״׳])`;

/** Bank-account rows that pay a credit-card bill (the purchases are already stored per card). */
export const CARD_PAYMENT_PATTERN = new RegExp(
  // optional bank prefixes: One Zero writes "חיוב מ-ישראכרט בע\"מ" or "<ref>/<card>/ישראכרט בע\"מ"
  `^(?:חיוב מ-|\\d+/\\d+/)?(ויזה|כאל|ישראכרט|מקס|לאומי קארד|לאומיקארד|לאומי מאסטרקרד|מאסטרקרד|מסטרקרד|אמריקן אקספרס|דיינרס|max|visa|isracard|cal)${WORD_END}`, 'i');

/** Standing orders into savings plans / deposits. */
export const SAVINGS_PATTERN = /לחיסכון|לחסכון|פיקדון|פקדון|קופת גמל|השקעה ב/;

/** Money sent to the household's broker and crypto exchanges, or buying crypto for a wallet — savings, not spend. */
export const INVESTMENT_PATTERN = new RegExp([
  'interactive\\s*brokers', '\\bibkr\\b', '\\bib llc\\b', 'binance', 'kraken', 'payward', 'coinbase', 'bit2c', 'bits of gold',
  'moonpay', 'ramp network', 'transak', 'אינטראקטיב', 'בינאנס', 'קראקן', 'קרקן', 'ביטס אוף גולד',
].join('|'), 'i');

/** A category by name, following aliases left by renames and merges. */
export function findCategory(db: DB, name: string): number | undefined {
  return (db.prepare(`SELECT id FROM categories WHERE name = ?`).pluck().get(name)
    ?? db.prepare(`SELECT category_id FROM category_aliases WHERE name = ?`).pluck().get(name)) as number | undefined;
}

/** Fill in categories for uncategorized rows from the scraper's own category (directly or through an alias). */
export function categorizeTransactions(db: DB, txIds: number[] | 'all' = 'all'): number {
  const rows = (txIds === 'all'
    ? db.prepare(`SELECT id, source_category FROM transactions WHERE category_id IS NULL AND source_category IS NOT NULL`).all()
    : txIds.map(id => db.prepare(`SELECT id, source_category FROM transactions WHERE id = ? AND category_id IS NULL AND source_category IS NOT NULL`).get(id)).filter(Boolean)
  ) as { id: number; source_category: string }[];
  const set = db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'scraper' WHERE id = ?`);
  let count = 0;
  db.transaction(() => {
    for (const r of rows) {
      const id = findCategory(db, r.source_category);
      if (id) { set.run(id, r.id); count++; }
    }
  })();
  return count;
}

/**
 * Derive each row's kind (expense / income / refund / transfer / card_payment / savings)
 * unless it was set by hand. Card-bill rows on bank accounts become card_payment so
 * card purchases aren't counted twice.
 */
export function deriveKinds(db: DB, txIds: number[] | 'all'): void {
  const where = txIds === 'all' ? '' : `AND t.id IN (${txIds.map(Number).join(',') || 'NULL'})`;
  const rows = db.prepare(`
    SELECT t.id, t.description, t.charged_amount, a.kind AS account_kind, c.kind AS category_kind
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE COALESCE(t.kind_source, 'auto') = 'auto' ${where}
  `).all() as { id: number; description: string; charged_amount: number; account_kind: string; category_kind: string | null }[];

  const update = db.prepare(`UPDATE transactions SET kind = ?, kind_source = 'auto' WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) update.run(kindFor(r), r.id);
  })();
}

export function kindFor(r: { description: string; charged_amount: number; account_kind: string; category_kind: string | null }): string {
  if (r.account_kind === 'bank' && r.charged_amount < 0 && CARD_PAYMENT_PATTERN.test(r.description.trim())) {
    return 'card_payment';
  }
  if (r.category_kind === 'card_payment' && r.account_kind === 'bank') return 'card_payment';
  if (r.account_kind === 'bank' && r.charged_amount < 0 && SAVINGS_PATTERN.test(r.description)) return 'savings';
  if (r.charged_amount < 0 && INVESTMENT_PATTERN.test(r.description)) return 'savings';
  if (r.category_kind === 'transfer' || r.category_kind === 'savings') return r.category_kind;
  if (r.charged_amount > 0) {
    return r.category_kind === 'income' || r.account_kind === 'bank' ? 'income' : 'refund';
  }
  return 'expense';
}
