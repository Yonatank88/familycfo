import type { DB } from '../db/connection.js';
import { ONLINE_SHOP_PATTERN } from '../categorize/rules.js';
import { today } from '../util.js';
import { expenseRows } from './summary.js';

/**
 * Each spend row's nature, automatic: monthly (the constant base), everyday (what changes week to week) or one-off
 * (rare and large, and trips). Stored in `transactions.nature` (step 111) and recomputed every pipeline run.
 */

export type Nature = 'monthly' | 'everyday' | 'one_off';
export const NATURES: Nature[] = ['monthly', 'everyday', 'one_off'];

/** Recurring: the merchant charged in at least this many months of any window of this many months holding the row… */
export const RECURRING_WINDOW_MONTHS = 6;
export const RECURRING_MIN_MONTHS = 3;
/** …at an amount within this fraction of the window's median charge… */
export const RECURRING_AMOUNT_TOLERANCE = 0.25;
/** …with at least this share of the window's charges at that amount… */
export const RECURRING_MIN_STABLE_SHARE = 0.75;
/** …and at most this many charges in a typical month (a supermarket visited weekly isn't a subscription). */
export const RECURRING_MAX_CHARGES_PER_MONTH = 2;
/** Categories never recurring by repetition alone: the café or grocer visited about monthly is still everyday. */
export const RECURRING_EXCLUDED_CATEGORIES = ['Groceries', 'Going out'];
/**
 * A price change: after this many consecutive recurring months, the next month's single charge stays monthly within
 * this ratio of the last one.
 */
export const PRICE_CHANGE_RUN_MONTHS = 2;
export const PRICE_CHANGE_MAX_RATIO = 2;
/** One-off: a merchant seen at most this many times in this many months (centred on the row)… */
export const ONE_OFF_WINDOW_MONTHS = 12;
export const ONE_OFF_MAX_SEEN = 2;
/** …with an amount at least this multiple of the household's median spend row, and at least this much (ILS). */
export const ONE_OFF_MEDIAN_MULTIPLE = 3;
export const ONE_OFF_MIN_AMOUNT = 500;

/** Categories whose rows are monthly / one-off by definition. */
export const MONTHLY_CATEGORY = 'Bills';
export const ONE_OFF_CATEGORY = 'Travel & abroad';

export interface NatureInput {
  id: number;
  merchant: string;
  /** YYYY-MM the row counts in (installments on their charge date) */
  month: string;
  /** ILS, positive = spend, negative = refund */
  amount: number;
  /** its top-level category name, or null */
  category: string | null;
  installment: boolean;
  standingOrder: boolean;
}

const monthIndex = (m: string) => { const [y, mo] = m.split('-').map(Number); return y * 12 + (mo - 1); };
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const near = (a: number, m: number) => m > 0 && Math.abs(a - m) <= RECURRING_AMOUNT_TOLERANCE * m;

/** The recurring charges of one merchant (positive, not installments): the ids that repeat monthly at a stable amount. */
function recurringIds(charges: { id: number; m: number; amount: number }[]): Set<number> {
  const out = new Set<number>();
  if (charges.length < RECURRING_MIN_MONTHS) return out;
  for (const r of charges) {
    for (let start = r.m - RECURRING_WINDOW_MONTHS + 1; start <= r.m && !out.has(r.id); start++) {
      const inWindow = charges.filter(c => c.m >= start && c.m < start + RECURRING_WINDOW_MONTHS);
      const perMonth = new Map<number, number[]>();
      for (const c of inWindow) perMonth.set(c.m, [...(perMonth.get(c.m) ?? []), c.amount]);
      if (perMonth.size < RECURRING_MIN_MONTHS) continue;
      if (median([...perMonth.values()].map(v => v.length)) > RECURRING_MAX_CHARGES_PER_MONTH) continue;
      const typical = median(inWindow.map(c => c.amount));
      const stable = [...perMonth.values()].filter(v => v.some(a => near(a, typical))).length;
      const stableShare = inWindow.filter(c => near(c.amount, typical)).length / inWindow.length;
      if (stable >= RECURRING_MIN_MONTHS && stableShare >= RECURRING_MIN_STABLE_SHARE && near(r.amount, typical)) out.add(r.id);
    }
  }
  // a price change: after a run of recurring months, the next month's only charge stays recurring within the ratio
  // (judged against the run itself, so one changed price doesn't carry the next)
  const byMonth = new Map<number, typeof charges>();
  for (const c of charges) byMonth.set(c.m, [...(byMonth.get(c.m) ?? []), c]);
  const base = new Set(out);
  for (const m of [...byMonth.keys()].sort((a, b) => a - b)) {
    const list = byMonth.get(m)!;
    if (list.length !== 1 || base.has(list[0].id)) continue;
    const run = Array.from({ length: PRICE_CHANGE_RUN_MONTHS }, (_, i) => (byMonth.get(m - 1 - i) ?? []).filter(c => base.has(c.id)));
    if (run.some(l => !l.length)) continue;
    const ratio = list[0].amount / run[0].at(-1)!.amount;
    if (ratio <= PRICE_CHANGE_MAX_RATIO && ratio >= 1 / PRICE_CHANGE_MAX_RATIO) out.add(list[0].id);
  }
  return out;
}

/** The nature of every row. `asOfMonth` (default the latest month) ends the year the household median is taken over. */
export function classifyNatures(rows: NatureInput[], asOfMonth?: string): Map<number, Nature> {
  const out = new Map<number, Nature>();
  if (!rows.length) return out;
  const end = monthIndex(asOfMonth ?? rows.map(r => r.month).sort().at(-1)!);
  const spend = rows.filter(r => r.amount > 0);
  const recent = spend.filter(r => monthIndex(r.month) > end - 12 && monthIndex(r.month) <= end);
  const householdMedian = median((recent.length ? recent : spend).map(r => r.amount));

  const byMerchant = new Map<string, NatureInput[]>();
  for (const r of rows) byMerchant.set(r.merchant, [...(byMerchant.get(r.merchant) ?? []), r]);

  for (const list of byMerchant.values()) {
    const charges = list.filter(r => r.amount > 0 && !r.installment && !RECURRING_EXCLUDED_CATEGORIES.includes(r.category ?? ''))
      .map(r => ({ id: r.id, m: monthIndex(r.month), amount: r.amount }));
    const recurring = recurringIds(charges);
    const positive = list.filter(r => r.amount > 0);
    const decide = (r: NatureInput): Nature => {
      if (r.installment || r.standingOrder || r.category === MONTHLY_CATEGORY) return 'monthly';
      if (r.category === ONE_OFF_CATEGORY) return 'one_off';
      if (recurring.has(r.id)) return 'monthly';
      const m = monthIndex(r.month);
      const half = ONE_OFF_WINDOW_MONTHS / 2;
      const seen = positive.filter(p => { const pm = monthIndex(p.month); return pm >= m - half && pm < m + half; }).length;
      if (seen <= ONE_OFF_MAX_SEEN && r.amount >= ONE_OFF_MIN_AMOUNT && r.amount >= ONE_OFF_MEDIAN_MULTIPLE * householdMedian) return 'one_off';
      return 'everyday';
    };
    for (const r of positive) out.set(r.id, decide(r));
    // a refund takes the nature of the merchant's nearest charge; one with no charge is everyday
    for (const r of list.filter(x => x.amount <= 0)) {
      const m = monthIndex(r.month);
      const nearest = [...positive].sort((a, b) => Math.abs(monthIndex(a.month) - m) - Math.abs(monthIndex(b.month) - m))[0];
      out.set(r.id, nearest ? out.get(nearest.id)! : r.installment || r.standingOrder || r.category === MONTHLY_CATEGORY ? 'monthly'
        : r.category === ONE_OFF_CATEGORY ? 'one_off' : 'everyday');
    }
  }
  return out;
}

const STANDING_ORDER_PATTERN = /הוראת[\s-]?קבע|הו["״]ק(?=$|[\s\-])/;
const flag = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * A standing order / direct debit: the bank's or card's own marker (Isracard `isdirectDebit`, Cal "הוראת קבע", a bank
 * description saying so). An online shop charging a stored card isn't one.
 */
export function isStandingOrder(description: string, raw: unknown): boolean {
  if (ONLINE_SHOP_PATTERN.test(description)) return false;
  if (STANDING_ORDER_PATTERN.test(description)) return true;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return flag(r.isdirectDebit) || flag(r.isNewDirectDebit) || r.trnType === 'הוראת קבע';
}

/** Recompute `transactions.nature` for every spend row; rows that aren't spend any more lose theirs. */
export function computeNatures(db: DB, asOf = today()): Record<Nature, number> {
  const rows = expenseRows(db, asOf);
  const raw = new Map((db.prepare(`SELECT id, raw_json FROM transactions WHERE kind IN ('expense', 'refund')`).all() as
    { id: number; raw_json: string | null }[]).map(r => [r.id, r.raw_json]));
  const parse = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const natures = classifyNatures(rows.map(r => ({
    id: r.id, merchant: r.merchant, month: r.month, amount: r.amount, category: r.category.key === 'none' ? null : r.category.name,
    installment: r.installment != null, standingOrder: isStandingOrder(r.description, parse(raw.get(r.id))),
  })), asOf.slice(0, 7));
  const counts: Record<Nature, number> = { monthly: 0, everyday: 0, one_off: 0 };
  const set = db.prepare(`UPDATE transactions SET nature = ? WHERE id = ?`);
  db.transaction(() => {
    db.prepare(`UPDATE transactions SET nature = NULL WHERE kind IS NULL OR kind NOT IN ('expense', 'refund')`).run();
    for (const [id, n] of natures) { set.run(n, id); counts[n]++; }
  })();
  return counts;
}
