import type { DB } from '../db/connection.js';

// JS `\b` only knows ASCII word characters, so Hebrew words need an explicit end-of-word lookahead
const WORD_END = `(?=$|[\\s\\-–'"״׳])`;

/**
 * The bank's prefix before a card company's name on a bill row: One Zero writes "חיוב מ-ישראכרט בע\"מ",
 * "<ref>/<card>/ישראכרט בע\"מ" or "<ref>/מקס איט פיננסים"; Otsar Hahayal "0289 - כרטיסי אשראי לי".
 */
export const CARD_BILL_PREFIX = /^(?:חיוב מ-|(?:\d+\/){1,2}|\d+ - )/;

/** Bank-account rows that pay a credit-card bill (the purchases are already stored per card). */
export const CARD_PAYMENT_PATTERN = new RegExp(
  `^(?:${CARD_BILL_PREFIX.source.slice(1)})?(ויזה|כאל|ישראכרט|מקס|לאומי קארד|לאומיקארד|לאומי מאסטרקרד|מאסטרקרד|מסטרקרד|`
  // "כרטיסי אשראי לישראל" is Cal's company name, cut short by the bank
  + `כרטיסי אשראי ל\\S*|אמריקן אקספרס|דיינרס|max|visa|isracard|cal)${WORD_END}`, 'i');

/** A card-bill description without the bank's prefix — what the card company patterns read. */
export const cardBillBody = (description: string) => description.trim().replace(CARD_BILL_PREFIX, '');

/** Standing orders into savings plans / deposits. */
export const SAVINGS_PATTERN = /לחיסכון|לחסכון|פיקדון|פקדון|קופת גמל|השקעה ב/;

/** Money sent to the household's broker and crypto exchanges, or buying crypto for a wallet — savings, not spend. */
export const INVESTMENT_PATTERN = new RegExp([
  'interactive\\s*brokers', '\\bibkr\\b', '\\bib llc\\b', 'binance', 'kraken', 'payward', 'coinbase', 'bit2c', 'bits of gold',
  'moonpay', 'ramp network', 'transak', 'אינטראקטיב', 'בינאנס', 'קראקן', 'קרקן', 'ביטס אוף גולד',
].join('|'), 'i');

/** Brokers, exchanges and investment houses money is sent to as savings — matched by name, or by a cut-short name. */
export const INVESTMENT_NAMES = [
  'interactive brokers', 'ibkr', 'ib llc', 'binance', 'kraken', 'payward', 'coinbase', 'bit2c', 'bits of gold', 'etoro',
  'meitav', 'ibi', 'excellence', 'altshuler', 'moonpay', 'transak',
  'אינטראקטיב', 'בינאנס', 'קראקן', 'קרקן', 'ביטס אוף גולד', 'איטורו', 'מיטב', 'אי.בי.אי', 'אקסלנס', 'אלטשולר',
];
/** A cut-short name counts from this many letters (shorter names must appear whole). */
const MIN_PREFIX = 6;
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]/g, '');
/** Words of a description, split where Latin meets Hebrew too (One Zero glues them: "Interactivהעברה ל"). */
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9\u0590-\u05ff.]+|(?<=[a-z0-9])(?=[\u0590-\u05ff])|(?<=[\u0590-\u05ff])(?=[a-z0-9])/)
  .map(compact).filter(Boolean);

/**
 * Whether a description names one of `INVESTMENT_NAMES`: a word that is the name ("ibkr"), starts with it, or is
 * at least six letters of its start ("Interactiv" — One Zero cuts descriptions); a multi-word name also matches whole.
 */
export function matchesInvestment(description: string): boolean {
  if (INVESTMENT_PATTERN.test(description)) return true;
  const ws = words(description);
  const all = compact(description);
  return INVESTMENT_NAMES.some(name => {
    const n = compact(name);
    if (name.includes(' ') && all.includes(n)) return true;
    return ws.some(w => w === n || (n.length >= 5 && w.startsWith(n)) || (w.length >= MIN_PREFIX && n.startsWith(w)));
  });
}

const MATACH = `מט["״׳']{0,2}ח`;
/**
 * Buying or selling foreign currency between the household's own ILS and FX accounts (Hapoalim "מטח-קניה" — also
 * its automatic overdraft cover of an FX account —, Otsar Hahayal "רכישת מטח נוכחי", One Zero "המרת מטבע"): money
 * changing currency, not spend.
 */
export const FX_EXCHANGE_PATTERN = new RegExp(
  `${MATACH}-?\\s?(קניה|מכירה)|(רכישת|קניית|מכירת|המרת) ${MATACH}|המרה ל${MATACH}|המרת מטבע|^forex (purchase|sale)`, 'i');
/** A foreign-trade purchase (Hapoalim "רכישה-סחר חוץ"): buying currency for a wire abroad — spend, unless it lands in an own FX account. */
export const FOREIGN_TRADE_PATTERN = /רכישה-?\s?סחר חוץ/;

/** The account holders a bank names on its own rows: One Zero writes "העברה מ- <holder> ל- <payee>". */
const HOLDER_PATTERN = /^העברה מ-\s*(.+?)\s+ל-\s*(.+)$/;
/** A transfer to a named payee: "העברה ל<name>" (One Zero) or "העברה מ- <holder> ל- <name>". */
export function transferPayee(description: string): string | null {
  const d = description.trim();
  const m = d.match(HOLDER_PATTERN) ?? d.match(/^()העברה ל-?\s*(.+)$/);
  return m ? m[2].trim() : null;
}
/** Whether a payee is one of the holders (bank names are cut short, so a prefix of at least five letters counts). */
const isHolder = (payee: string, holders: string[]) => holders.some(h => payee === h || payee.startsWith(`${h} `)
  || (payee.length >= 5 && h.startsWith(payee)));

/** Every holder name the bank rows show (see HOLDER_PATTERN). */
export function accountHolders(db: DB): string[] {
  const ds = db.prepare(`SELECT DISTINCT t.description FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.kind = 'bank' AND t.description LIKE 'העברה מ-%'`).pluck().all() as string[];
  return [...new Set(ds.map(d => d.trim().match(HOLDER_PATTERN)?.[1].trim()).filter((h): h is string => !!h))];
}

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

  const holders = accountHolders(db);
  const update = db.prepare(`UPDATE transactions SET kind = ?, kind_source = 'auto' WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) update.run(kindFor({ ...r, holders }), r.id);
  })();
}

export function kindFor(r: { description: string; charged_amount: number; account_kind: string; category_kind: string | null; holders?: string[] }): string {
  // currency changing hands between own accounts, either leg
  if (r.account_kind === 'bank' && FX_EXCHANGE_PATTERN.test(r.description)) return 'transfer';
  // money a holder sends to themself (an account of theirs that isn't scraped)
  if (r.account_kind === 'bank' && r.charged_amount < 0 && r.holders?.length) {
    const payee = transferPayee(r.description);
    if (payee && isHolder(payee, r.holders)) return 'transfer';
  }
  if (r.account_kind === 'bank' && r.charged_amount < 0 && CARD_PAYMENT_PATTERN.test(r.description.trim())) {
    return 'card_payment';
  }
  if (r.category_kind === 'card_payment' && r.account_kind === 'bank') return 'card_payment';
  if (r.account_kind === 'bank' && r.charged_amount < 0 && SAVINGS_PATTERN.test(r.description)) return 'savings';
  if (r.charged_amount < 0 && matchesInvestment(r.description)) return 'savings';
  if (r.category_kind === 'transfer' || r.category_kind === 'savings') return r.category_kind;
  if (r.charged_amount > 0) {
    return r.category_kind === 'income' || r.account_kind === 'bank' ? 'income' : 'refund';
  }
  return 'expense';
}
