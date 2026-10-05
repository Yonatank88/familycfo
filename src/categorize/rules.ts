import type { DB } from '../db/connection.js';
import { CARD_PAYMENT_PATTERN, FOREIGN_TRADE_PATTERN, findCategory, transferPayee } from '../ingest/classify.js';

/**
 * Spend categories decided by rule, before the AI: rows a pattern explains never reach it. Rules are re-applied every
 * run over spend rows not categorised by a person (`category_source = 'rule'`), and they win over an AI answer. Only
 * the abroad rule also wins over the scraper's own category.
 */

export const TRANSFERS_TO_PEOPLE = 'Transfers to people';
export const CARD_NOT_ITEMISED = 'Credit card (not itemised)';
export const TRAVEL_ABROAD = 'Travel & abroad';
export const CONSUMERISM = 'Consumerism';
export const BILLS = 'Bills';
/** Categories only rules assign: never offered to the AI. */
export const RULE_ONLY_CATEGORIES = [TRANSFERS_TO_PEOPLE, CARD_NOT_ITEMISED];

/** Money sent to someone: a named transfer, a mobile transfer, Bit / PayBox (not Bit2C, the exchange). */
const TO_PEOPLE_PATTERN = /^העברה מהחשבון|^העב['׳] ל|^העברה בביט|(^|[\s\-])(ביט|bit|פייבוקס|paybox)(?=$|[\s\-*])/i;
/** A fee on an FX transfer / purchase (Hapoalim "ע' העברת מט\"ח", Otsar Hahayal "עמלת מטח"). */
const FX_FEE_PATTERN = /^ע['׳] העברת מט|עמלת מט["״]?ח/;

/** Foreign digital subscriptions: charged abroad, but a bill paid from home. */
export const SUBSCRIPTION_PATTERN = new RegExp(['spotify', 'netflix', 'apple\\.com', 'itunes', 'icloud', 'google', 'youtube',
  'microsoft', 'openai', 'chatgpt', 'anthropic', 'claude\\.ai', 'figma', 'disney', 'adobe', 'dropbox', 'github', 'notion', 'canva',
  'linkedin', 'audible', 'patreon', 'duolingo', 'zoom\\.us', 'amazon prime', 'prime video', 'hbo', 'paramount', 'deezer', 'wix'].join('|'), 'i');
/** Foreign online shops: charged abroad, but bought from home. */
export const ONLINE_SHOP_PATTERN = new RegExp(['aliexpress', 'alipay', 'amazon', 'amzn', 'temu', 'shein', 'ebay', 'etsy', 'iherb',
  'asos', 'g2a', 'banggood', 'joom', 'wish\\.com', 'next direct', 'zalando', 'lightinthebox', 'gearbest'].join('|'), 'i');
/** A payment through PayPal that names no merchant: where it was bought isn't known. */
const BARE_PAYPAL = /^paypal\b/i;

export interface AbroadSignals { accountKind: string; originalCurrency: string | null; raw: unknown }
const flag = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const unflag = (v: unknown) => v === false || v === 0 || v === '0' || v === 'false';

/**
 * Whether a card purchase was made in another country: Isracard / Amex mark a non-Israel deal (`isIsraelDeal`, the
 * "תיירות יוצאת…" rows) with its `countryCode`, Cal marks `isAbroadTransaction`; without those flags a card charge in a
 * foreign currency counts. Bank rows never do (FX accounts spend in their own currency).
 */
export function isAbroad(s: AbroadSignals): boolean {
  if (s.accountKind !== 'card') return false;
  const raw = (s.raw && typeof s.raw === 'object' ? s.raw : {}) as Record<string, unknown>;
  if ('isIsraelDeal' in raw || 'countryCode' in raw) {
    const country = typeof raw.countryCode === 'string' ? raw.countryCode.trim().toUpperCase() : '';
    return unflag(raw.isIsraelDeal) || (!!country && country !== 'ISR' && country !== 'IL');
  }
  if ('isAbroadTransaction' in raw) return flag(raw.isAbroadTransaction);
  return !!s.originalCurrency && s.originalCurrency !== 'ILS';
}

/**
 * The category of a purchase abroad: a foreign digital subscription stays a bill, a foreign online shop stays
 * consumerism, a bare PayPal payment is left to the merchant categoriser; everything else is travel.
 */
export function abroadCategory(description: string): string | null {
  const d = description.trim();
  if (SUBSCRIPTION_PATTERN.test(d)) return BILLS;
  if (ONLINE_SHOP_PATTERN.test(d)) return CONSUMERISM;
  if (BARE_PAYPAL.test(d)) return null;
  return TRAVEL_ABROAD;
}

/** The category name a row's description (and, for a card row, where it was bought) decides, or null. Only spend rows are asked. */
export function ruleCategory(description: string, accountKind: string, abroad = false): string | null {
  const d = description.trim();
  // a card bill (on a bank account) no scraped card explains: the only record of that spending, not itemised
  if (accountKind === 'bank' && CARD_PAYMENT_PATTERN.test(d)) return CARD_NOT_ITEMISED;
  if (FX_FEE_PATTERN.test(d)) return BILLS;
  // a wire abroad paid by buying currency (not landing in an own FX account)
  if (FOREIGN_TRADE_PATTERN.test(d)) return TRAVEL_ABROAD;
  if (transferPayee(d) != null || TO_PEOPLE_PATTERN.test(d)) return TRANSFERS_TO_PEOPLE;
  if (abroad) return abroadCategory(d);
  return null;
}

/**
 * Writes rule categories: a spend row a rule explains gets that category (`rule`), a former rule row no rule explains
 * any more goes back to its scraper category or uncategorised (for the AI), and a row that stopped being spend loses an
 * automatic category. A row the scraper categorised is overridden only by the abroad rule.
 */
export function applyCategoryRules(db: DB): { rows: number; cleared: number } {
  const rows = db.prepare(`
    SELECT t.id, t.description, t.category_id, t.category_source, t.source_category, t.kind, t.original_currency, t.raw_json,
      a.kind AS account_kind
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.category_id IS NULL OR t.category_source IN ('ai', 'rule', 'scraper')
  `).all() as { id: number; description: string; category_id: number | null; category_source: string | null; source_category: string | null;
    kind: string | null; original_currency: string | null; raw_json: string | null; account_kind: string }[];
  const ids = new Map<string, number | undefined>();
  const idOf = (name: string) => { if (!ids.has(name)) ids.set(name, findCategory(db, name)); return ids.get(name); };
  const set = db.prepare(`UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?`);
  let n = 0, cleared = 0;
  db.transaction(() => {
    for (const r of rows) {
      const spend = r.kind === 'expense' || r.kind === 'refund';
      if (!spend) {
        if (r.category_id != null && r.category_source !== 'scraper') { set.run(null, null, r.id); cleared++; }
        continue;
      }
      let raw: unknown = null;
      try { raw = r.raw_json ? JSON.parse(r.raw_json) : null; } catch { /* unreadable raw row: no flags */ }
      const abroad = isAbroad({ accountKind: r.account_kind, originalCurrency: r.original_currency, raw });
      const name = r.category_source === 'scraper'
        ? (abroad ? abroadCategory(r.description) : null)
        : ruleCategory(r.description, r.account_kind, abroad);
      const id = name ? idOf(name) : undefined;
      if (id != null) {
        if (r.category_id !== id || r.category_source !== 'rule') { set.run(id, 'rule', r.id); n++; }
      } else if (r.category_source === 'rule') {
        const scraper = r.source_category ? findCategory(db, r.source_category) : undefined;
        set.run(scraper ?? null, scraper != null ? 'scraper' : null, r.id); cleared++;
      }
    }
  })();
  return { rows: n, cleared };
}
