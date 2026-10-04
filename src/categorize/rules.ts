import type { DB } from '../db/connection.js';
import { CARD_PAYMENT_PATTERN, FOREIGN_TRADE_PATTERN, findCategory, transferPayee } from '../ingest/classify.js';

/**
 * Spend categories decided by rule, before the AI: rows a pattern explains never reach it. Rules are re-applied every
 * run over spend rows not categorised by a person or the scraper (`category_source = 'rule'`), and they win over an AI
 * answer.
 */

export const TRANSFERS_TO_PEOPLE = 'Transfers to people';
export const CARD_NOT_ITEMISED = 'Credit card (not itemised)';
/** Categories only rules assign: never offered to the AI. */
export const RULE_ONLY_CATEGORIES = [TRANSFERS_TO_PEOPLE, CARD_NOT_ITEMISED];

/** Money sent to someone: a named transfer, a mobile transfer, Bit / PayBox (not Bit2C, the exchange). */
const TO_PEOPLE_PATTERN = /^העברה מהחשבון|^העב['׳] ל|^העברה בביט|(^|[\s\-])(ביט|bit|פייבוקס|paybox)(?=$|[\s\-*])/i;
/** A fee on an FX transfer / purchase (Hapoalim "ע' העברת מט\"ח", Otsar Hahayal "עמלת מטח"). */
const FX_FEE_PATTERN = /^ע['׳] העברת מט|עמלת מט["״]?ח/;

/** The category name a row's description decides, or null. Only spend rows (expense / refund) are asked. */
export function ruleCategory(description: string, accountKind: string): string | null {
  const d = description.trim();
  // a card bill (on a bank account) no scraped card explains: the only record of that spending, not itemised
  if (accountKind === 'bank' && CARD_PAYMENT_PATTERN.test(d)) return CARD_NOT_ITEMISED;
  if (FX_FEE_PATTERN.test(d)) return 'Bank fees';
  // a wire abroad paid by buying currency (not landing in an own FX account)
  if (FOREIGN_TRADE_PATTERN.test(d)) return 'Foreign purchases';
  if (transferPayee(d) != null || TO_PEOPLE_PATTERN.test(d)) return TRANSFERS_TO_PEOPLE;
  return null;
}

/**
 * Writes rule categories: a spend row a rule explains gets that category (`rule`), a former rule row no rule explains
 * any more goes back to uncategorised (for the AI), and a row that stopped being spend loses an automatic category.
 */
export function applyCategoryRules(db: DB): { rows: number; cleared: number } {
  const rows = db.prepare(`
    SELECT t.id, t.description, t.category_id, t.category_source, t.kind, a.kind AS account_kind
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.category_id IS NULL OR t.category_source IN ('ai', 'rule')
  `).all() as { id: number; description: string; category_id: number | null; category_source: string | null; kind: string | null; account_kind: string }[];
  const ids = new Map<string, number | undefined>();
  const idOf = (name: string) => { if (!ids.has(name)) ids.set(name, findCategory(db, name)); return ids.get(name); };
  const set = db.prepare(`UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?`);
  let n = 0, cleared = 0;
  db.transaction(() => {
    for (const r of rows) {
      const spend = r.kind === 'expense' || r.kind === 'refund';
      if (!spend) {
        if (r.category_id != null) { set.run(null, null, r.id); cleared++; }
        continue;
      }
      const name = ruleCategory(r.description, r.account_kind);
      const id = name ? idOf(name) : undefined;
      if (id != null) {
        if (r.category_id !== id || r.category_source !== 'rule') { set.run(id, 'rule', r.id); n++; }
      } else if (r.category_source === 'rule') {
        set.run(null, null, r.id); cleared++;
      }
    }
  })();
  return { rows: n, cleared };
}
