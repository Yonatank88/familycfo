import type { DB } from '../db/connection.js';
import { localDate } from './normalize.js';
import { CARD_PAYMENT_PATTERN, FOREIGN_TRADE_PATTERN, FX_EXCHANGE_PATTERN, cardBillBody } from './classify.js';

/**
 * Which bank-row description (after the bank's prefix, `cardBillBody`) pays which card company ("ויזה" on Hapoalim is
 * the Isracard-issued Visa; "כרטיסי אשראי לישראל" is Cal; "מקס איט פיננסים" is Max).
 */
export const BILL_COMPANY_PATTERNS: Record<string, RegExp> = {
  visaCal: /^(כאל|ויזה|כרטיסי אשראי ל)/,
  isracard: /^(ישראכרט|ויזה)/,
  amex: /^אמריקן/,
  max: /^(מקס|לאומי קארד|לאומיקארד|לאומי מאסטרקרד|max)/i,
};

const STATEMENT_MIN = 1000;
const DAY = 86_400_000;

const DEBIT_MAX_LAG_DAYS = 5;

/**
 * Debit cards (e.g. Hapoalim's Isracard-issued Visa) charge every purchase to the bank a day
 * or three later as a separate "ויזה" row with the same amount — the same money twice. Pair
 * each such bank row with exactly one card purchase (same amount, 0–5 days after it, closest
 * first; one-to-one because identical charges like several ₪79 ads are common), mark it
 * card_payment and link it. Cards whose recent purchases are mostly paired become is_debit.
 */
export function matchImmediateCardDebits(db: DB): { matched: number; debitCards: string[] } {
  const bankRows = db.prepare(`
    SELECT t.id, t.date, t.description, t.charged_amount, t.bank_identifier FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.kind = 'bank' AND COALESCE(t.kind_source, 'auto') = 'auto'
    ORDER BY t.date
  `).all() as { id: number; date: string; description: string; charged_amount: number; bank_identifier: string | null }[];
  const cards = db.prepare(`SELECT id, company FROM accounts WHERE kind = 'card'`).all() as { id: string; company: string }[];
  const cardRows = db.prepare(`
    SELECT t.id, t.account_id, t.date, t.charged_amount FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.kind = 'card'
  `).all() as { id: number; account_id: string; date: string; charged_amount: number }[];

  const used = new Set<number>();
  const pairs: { bankId: number; cardId: number; cardAccount: string }[] = [];
  for (const bank of bankRows.filter(b => CARD_PAYMENT_PATTERN.test(b.description.trim()))) {
    const companies = Object.entries(BILL_COMPANY_PATTERNS).filter(([, p]) => p.test(cardBillBody(bank.description))).map(([c]) => c);
    // Hapoalim puts the card's last 4 digits in the reference of these rows — the strongest signal
    const suffix = bank.bank_identifier && /^\d{4}$/.test(bank.bank_identifier) ? bank.bank_identifier : null;
    const bySuffix = suffix ? cards.filter(c => c.id.endsWith(`:${suffix}`)) : [];
    const allowed = new Set((bySuffix.length ? bySuffix : cards.filter(c => !companies.length || companies.includes(c.company))).map(c => c.id));
    const bankDay = Date.parse(localDate(bank.date));
    const match = cardRows
      .filter(c => !used.has(c.id) && allowed.has(c.account_id) && Math.abs(c.charged_amount - bank.charged_amount) < 0.005)
      .map(c => ({ c, lag: (bankDay - Date.parse(localDate(c.date))) / DAY }))
      .filter(x => x.lag >= 0 && x.lag <= DEBIT_MAX_LAG_DAYS)
      .sort((a, b) => a.lag - b.lag)[0];
    if (!match) continue;
    used.add(match.c.id);
    pairs.push({ bankId: bank.id, cardId: match.c.id, cardAccount: match.c.account_id });
  }

  const link = db.prepare(`UPDATE transactions SET kind = 'card_payment', kind_source = 'auto', matched_txn_id = ? WHERE id = ?`);
  const debitCards: string[] = [];
  db.transaction(() => {
    db.prepare(`UPDATE transactions SET matched_txn_id = NULL WHERE COALESCE(kind_source, 'auto') = 'auto'`).run();
    for (const p of pairs) link.run(p.cardId, p.bankId);

    // a card is a debit card when most of its recent purchases were paired with a bank row
    for (const card of cards) {
      const recent = cardRows.filter(r => r.account_id === card.id && r.charged_amount < 0
        && Date.parse(localDate(r.date)) >= Date.now() - 120 * DAY);
      const paired = recent.filter(r => used.has(r.id)).length;
      const isDebit = recent.length >= 3 && paired / recent.length >= 0.6;
      db.prepare(`UPDATE accounts SET is_debit = ? WHERE id = ?`).run(isDebit ? 1 : 0, card.id);
      if (isDebit) debitCards.push(card.id);
    }
  })();
  return { matched: pairs.length, debitCards };
}

/**
 * A bank row that looks like a card bill is only a card_payment if a scraped card explains it:
 * its charges within ±4 days add up to the bill (3% tolerance), or it is statement-sized and
 * that card company is scraped (older rows lack charge dates). Otherwise it's real spend — e.g.
 * Hapoalim's small daily "ויזה" rows are debit-card purchases with no card account behind them.
 */
export function reconcileCardBills(db: DB): { kept: number; demoted: number } {
  const cards = db.prepare(`SELECT id, company FROM accounts WHERE kind = 'card'`).all() as { id: string; company: string }[];
  const cardRows = db.prepare(`
    SELECT account_id, COALESCE(processed_date, date) AS charge_date, charged_amount FROM transactions
    WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'card')
  `).all() as { account_id: string; charge_date: string; charged_amount: number }[];
  const bills = db.prepare(`
    SELECT id, date, description, charged_amount FROM transactions
    WHERE kind = 'card_payment' AND COALESCE(kind_source, 'auto') = 'auto'
  `).all() as { id: number; date: string; description: string; charged_amount: number }[];

  // per card: first and last charge date its scraped rows cover
  const coverage = new Map<string, { from: number; to: number }>();
  for (const r of cardRows) {
    const day = Date.parse(localDate(r.charge_date));
    const range = coverage.get(r.account_id);
    if (!range) coverage.set(r.account_id, { from: day, to: day });
    else { range.from = Math.min(range.from, day); range.to = Math.max(range.to, day); }
  }
  const demote = db.prepare(`UPDATE transactions SET kind = 'expense', kind_source = 'auto' WHERE id = ?`);
  let kept = 0, demoted = 0;

  db.transaction(() => {
    for (const bill of bills) {
      const companies = Object.entries(BILL_COMPANY_PATTERNS)
        .filter(([, p]) => p.test(cardBillBody(bill.description))).map(([c]) => c);
      const candidates = cards.filter(c => !companies.length || companies.includes(c.company));
      const billDay = Date.parse(localDate(bill.date));
      const amount = -bill.charged_amount;

      const close = (sum: number) => sum > 0 && Math.abs(sum - amount) <= Math.max(5, amount * 0.03);
      const matched = candidates.some(card => {
        const near = cardRows.filter(r => r.account_id === card.id && Math.abs(Date.parse(localDate(r.charge_date)) - billDay) <= 4 * DAY);
        if (close(near.reduce((s, r) => s - r.charged_amount, 0))) return true;
        // a small batch charged on its own day (e.g. several foreign purchases debited together)
        const byDay = new Map<string, number>();
        for (const r of near) byDay.set(localDate(r.charge_date), (byDay.get(localDate(r.charge_date)) ?? 0) - r.charged_amount);
        return [...byDay.values()].some(close);
      });

      // an unmatched statement-sized bill is still the card's bill — but only inside the period the scraped card data
      // covers; before that, the bill is the only record of that spending, so it stays an expense
      const covered = candidates.some(card => {
        const range = coverage.get(card.id);
        return !!range && billDay >= range.from - 5 * DAY && billDay <= range.to + 5 * DAY;
      });
      if (matched || (amount >= STATEMENT_MIN && covered)) kept++;
      else { demote.run(bill.id); demoted++; }
    }
  })();
  return { kept, demoted };
}

interface Row {
  id: number;
  account_id: string;
  date: string;
  charged_amount: number;
  kind: string | null;
  kind_source: string | null;
}

/**
 * Pair money moved between the household's own bank accounts: an outflow on one account and
 * an equal inflow on another within ±3 days (e.g. Hapoalim "העב' לאחר-נייד" −9,600 ↔ Leumi
 * "בנק הפועלים" +9,600). Both sides become kind 'transfer' so they aren't spend or income.
 */
export function matchInternalTransfers(db: DB): number {
  const rows = db.prepare(`
    SELECT t.id, t.account_id, t.date, t.charged_amount, t.kind, t.kind_source
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.kind = 'bank' AND ABS(t.charged_amount) >= 100 AND COALESCE(t.kind_source, 'auto') = 'auto'
      AND COALESCE(t.kind, '') NOT IN ('card_payment')
  `).all() as Row[];

  const outflows = rows.filter(r => r.charged_amount < 0);
  const inflows = rows.filter(r => r.charged_amount > 0);
  const used = new Set<number>();
  const mark = db.prepare(`UPDATE transactions SET kind = 'transfer', kind_source = 'auto' WHERE id = ?`);
  let pairs = 0;

  db.transaction(() => {
    for (const out of outflows) {
      const outDay = Date.parse(localDate(out.date));
      const match = inflows
        .filter(inn => !used.has(inn.id) && inn.account_id !== out.account_id
          && Math.abs(inn.charged_amount + out.charged_amount) < 0.01
          && Math.abs(Date.parse(localDate(inn.date)) - outDay) <= 3 * 86_400_000)
        .sort((a, b) => Math.abs(Date.parse(localDate(a.date)) - outDay) - Math.abs(Date.parse(localDate(b.date)) - outDay))[0];
      if (!match) continue;
      used.add(match.id);
      mark.run(out.id);
      mark.run(match.id);
      pairs++;
    }
  })();
  return pairs;
}

/**
 * Currency changing hands inside one bank: an FX purchase / sale (`FX_EXCHANGE_PATTERN`) or a foreign-trade purchase
 * (`FOREIGN_TRADE_PATTERN`) leaving one account, and the inflow it makes on an account of the same bank in another
 * currency, within ±3 days and worth the same in ILS (±3%, at that day's rate; without a rate, only when it is the one
 * candidate). Both legs become 'transfer' and are linked to each other. An FX purchase whose other leg isn't scraped is
 * a transfer already (`kindFor`); a foreign-trade purchase with no leg stays spend (a wire abroad).
 */
export function matchCurrencyExchanges(db: DB): number {
  const rows = db.prepare(`
    SELECT t.id, t.account_id, a.company, COALESCE(a.currency, 'ILS') AS currency, t.date, t.description, t.charged_amount
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.kind = 'bank' AND COALESCE(t.kind_source, 'auto') = 'auto'
  `).all() as { id: number; account_id: string; company: string; currency: string; date: string; description: string; charged_amount: number }[];
  const rateOn = db.prepare(`SELECT rate_to_ils FROM fx_rates WHERE currency = ? AND date <= ? ORDER BY date DESC LIMIT 1`).pluck();
  const ils = (r: { currency: string; date: string; charged_amount: number }) => {
    if (r.currency === 'ILS') return Math.abs(r.charged_amount);
    const rate = rateOn.get(r.currency, localDate(r.date)) as number | undefined;
    return rate == null ? null : Math.abs(r.charged_amount) * rate;
  };
  const outs = rows.filter(r => r.charged_amount < 0 && (FX_EXCHANGE_PATTERN.test(r.description) || FOREIGN_TRADE_PATTERN.test(r.description)));
  const used = new Set<number>();
  const link = db.prepare(`UPDATE transactions SET kind = 'transfer', kind_source = 'auto', matched_txn_id = ? WHERE id = ?`);
  let pairs = 0;
  db.transaction(() => {
    for (const out of outs) {
      const day = Date.parse(localDate(out.date));
      const outIls = ils(out);
      const near = rows.filter(r => r.charged_amount > 0 && !used.has(r.id) && r.company === out.company && r.currency !== out.currency
        && Math.abs(Date.parse(localDate(r.date)) - day) <= 3 * DAY);
      const scored = near.map(r => ({ r, value: ils(r) }));
      const priced = outIls == null ? [] : scored.filter(x => x.value != null && Math.abs(x.value - outIls) <= outIls * 0.03);
      const match = (priced.length ? priced : scored.length === 1 && scored[0].value == null ? scored : [])
        .sort((a, b) => Math.abs(Date.parse(localDate(a.r.date)) - day) - Math.abs(Date.parse(localDate(b.r.date)) - day))[0];
      if (!match) continue;
      used.add(match.r.id);
      link.run(match.r.id, out.id);
      link.run(out.id, match.r.id);
      pairs++;
    }
  })();
  return pairs;
}
