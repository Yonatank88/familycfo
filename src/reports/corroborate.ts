import type { DB } from '../db/connection.js';
import { today } from '../util.js';
import type { ExtractedProduct, Extraction, Question } from './extract.js';

/**
 * An extraction checked against what is already stored, deterministically: which known product each extracted one is,
 * whether the report is an edition of one already imported, and what has to be asked before it can apply.
 */
export interface Corroboration {
  /** an imported report with the same issuer and as-of date: this one replaces its products */
  editionOf: number | null;
  /** per extracted product (same order): the holding it is a value point of, new or known */
  products: { key: string; holdingSource: string; known: boolean }[];
  /** products of the previous report missing from this one, answered: closed (value 0) or kept */
  closed: string[];
  kept: string[];
  /** unanswered questions — none means the report can apply */
  questions: Question[];
}

/** A stored product: the latest value point of a holding source, from an applied report. */
export interface KnownProduct {
  holdingSource: string; provider: string; productType: string; accountNumber: string | null; name: string;
  balance: number; currency: string; asOf: string; reportId: number; reportType: string | null;
}

const SUM_TOLERANCE = 0.01;
const JUMP_LIMIT = 0.25;
const MIN_CONFIDENCE = 0.8;
const SAME_NAME = 0.6;
const SIMILAR_NAME = 0.3;

/** Lower-case, letters (Hebrew too) and digits joined by '-': "מגדל מקפת" → "מגדל-מקפת". */
export const slug = (s: string) => s.normalize('NFKC').toLowerCase().replace(/["'`׳״]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

/** An account / policy number, digits only, without leading zeros; null when it has none. */
export const normalizeAccount = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '') || null;

/** A stable key for an extracted product across revisions (questions are keyed by it). */
export const productKey = (p: Pick<ExtractedProduct, 'provider' | 'accountNumber' | 'name' | 'productType'>) =>
  `${slug(p.provider)}:${p.productType}:${normalizeAccount(p.accountNumber) ?? slug(p.name)}`;

const sameProvider = (a: string, b: string) => {
  const x = slug(a), y = slug(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/** Two account numbers are the same when equal, or when one is a masked tail (≥ 4 digits) of the other. */
const sameAccount = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.endsWith(b) || b.endsWith(a)));

/** Token overlap (Jaccard) of two names. */
export function nameSimilarity(a: string, b: string): number {
  const tokens = (s: string) => new Set(slug(s).split('-').filter(Boolean));
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  const common = [...x].filter(t => y.has(t)).length;
  return common / (x.size + y.size - common);
}

export const productLabel = (p: { name: string; accountNumber: string | null }) =>
  `${p.name}${p.accountNumber ? ` ••${p.accountNumber.slice(-4)}` : ''}`;

/** Every holding source's latest value point from an applied report (the report `exclude` left out). */
export function knownProducts(db: DB, exclude?: number | null): KnownProduct[] {
  return db.prepare(`
    SELECT v.holding_source AS holdingSource, v.provider, v.product_type AS productType, v.account_number AS accountNumber, v.name,
      v.balance, v.currency, v.as_of AS asOf, v.report_id AS reportId, r.report_type AS reportType
    FROM report_values v JOIN reports r ON r.id = v.report_id
    WHERE r.status = 'applied' AND r.id IS NOT @exclude
      AND NOT EXISTS (SELECT 1 FROM report_values w JOIN reports s ON s.id = w.report_id
        WHERE w.holding_source = v.holding_source AND s.status = 'applied' AND s.id IS NOT @exclude
          AND (w.as_of > v.as_of OR (w.as_of = v.as_of AND w.report_id > v.report_id)))
  `).all({ exclude: exclude ?? null }) as KnownProduct[];
}

/** The latest point of a holding source dated before `date` (from applied reports other than `exclude`). */
function pointBefore(db: DB, source: string, date: string, exclude: number | null) {
  return db.prepare(`
    SELECT v.balance, v.currency, v.as_of AS asOf, r.report_type AS reportType FROM report_values v JOIN reports r ON r.id = v.report_id
    WHERE v.holding_source = ? AND v.as_of < ? AND r.status = 'applied' AND r.id IS NOT ? ORDER BY v.as_of DESC, v.report_id DESC LIMIT 1
  `).get(source, date, exclude) as { balance: number; currency: string; asOf: string; reportType: string | null } | undefined;
}

/** A new holding source: report:<provider-slug>:<account> (or the type and name without one), unique. */
function newHoldingSource(p: ExtractedProduct, taken: Set<string>): string {
  const base = `report:${slug(p.provider) || 'unknown'}:${normalizeAccount(p.accountNumber) ?? `${p.productType}-${slug(p.name) || 'product'}`}`;
  let source = taken.has(base) ? `${base}:${p.productType}` : base;
  for (let n = 2; taken.has(source); n++) source = `${base}:${p.productType}-${n}`;
  taken.add(source);
  return source;
}

const fmt = (n: number, currency: string) => `${Math.round(n).toLocaleString('en-US')} ${currency}`;

export function corroborate(db: DB, reportId: number, x: Extraction, answers: Record<string, string> = {}, asOfToday = today()): Corroboration {
  const questions: Question[] = [];
  const ask = (q: Question, resolved = q.id in answers) => { if (!resolved) questions.push(q); };

  // the date: required, and not in the future (an answer doesn't help until the date itself is fixed)
  const validDate = !!x.asOf && x.asOf <= asOfToday;
  if (!validDate) {
    questions.push({ id: 'asof', text: x.asOf ? `The report's date (${x.asOf}) is in the future. What date are its balances for?`
      : 'What date are the balances in this report for?' });
  }

  // an edition: same issuer, same date, already imported
  const edition = validDate ? db.prepare(`
    SELECT id, issuer FROM reports WHERE id <> ? AND as_of = ? AND status IN ('applied', 'needs_review') ORDER BY id DESC
  `).all(reportId, x.asOf).find((r: any) => r.issuer && slug(r.issuer) === slug(x.issuer)) as { id: number } | undefined : undefined;
  const editionOf = edition?.id ?? null;

  // identity
  const known = knownProducts(db);
  const taken = new Set((db.prepare(`SELECT DISTINCT holding_source FROM report_values`).pluck().all() as string[]));
  const used = new Set<string>();
  // candidates of an identity question still open: not "missing" until it is answered
  const pending = new Set<string>();
  const products = x.products.map(p => {
    const key = productKey(p);
    const sameKind = known.filter(k => k.productType === p.productType && !used.has(k.holdingSource));
    const pick = (k: KnownProduct) => { used.add(k.holdingSource); return { key, holdingSource: k.holdingSource, known: true }; };
    const fresh = () => ({ key, holdingSource: newHoldingSource(p, taken), known: false });
    const { match, ambiguous } = identify(p, sameKind);
    if (match) return pick(match);
    if (!ambiguous) return fresh();
    const id = `same:${key}`;
    if (id in answers) {
      const a = answers[id];
      const chosen = ambiguous.find(k => a === productLabel(k) || a === k.holdingSource) ?? (a === 'Yes' && ambiguous.length === 1 ? ambiguous[0] : undefined);
      return chosen ? pick(chosen) : fresh();
    }
    for (const k of ambiguous) pending.add(k.holdingSource);
    const label = productLabel({ name: p.name, accountNumber: normalizeAccount(p.accountNumber) });
    ask(ambiguous.length === 1
      ? { id, text: `Is '${label}' the same as '${productLabel(ambiguous[0])}'?`, options: ['Yes', 'No'] }
      : { id, text: `Which product is '${label}'?`, options: [...ambiguous.map(productLabel), 'New product'] });
    return { key, holdingSource: '', known: false };
  });

  // the stated total
  if (x.statedTotal != null && x.products.length && x.products.every(p => p.currency === x.currency)) {
    const sum = x.products.reduce((s, p) => s + p.balance, 0);
    if (Math.abs(sum - x.statedTotal) > Math.abs(x.statedTotal) * SUM_TOLERANCE) {
      ask({ id: 'sum', text: `The products add up to ${fmt(sum, x.currency)}; the report's total is ${fmt(x.statedTotal, x.currency)}. Which is right?`,
        options: ['The products', 'The total — a product is wrong or missing'] });
    }
  }

  x.products.forEach((p, i) => {
    const { key, holdingSource, known: isKnown } = products[i];
    // a big move since the last point, from a report of the same kind
    if (isKnown && validDate) {
      const prev = pointBefore(db, holdingSource, x.asOf!, editionOf);
      if (prev && prev.currency === p.currency && prev.balance && (prev.reportType ?? null) === x.reportType
        && Math.abs(p.balance / prev.balance - 1) > JUMP_LIMIT) {
        ask({ id: `jump:${holdingSource}`, text: `'${p.name}' went from ${fmt(prev.balance, p.currency)} (${prev.asOf}) to ${fmt(p.balance, p.currency)}. Is that right?`,
          options: ['Yes', 'No'] });
      }
    }
    if (p.confidence < MIN_CONFIDENCE) {
      ask({ id: `confidence:${key}`, text: `Is the balance of '${p.name}' ${fmt(p.balance, p.currency)}?`, options: ['Yes', 'No'] });
    }
  });

  // a product of the previous report from this issuer (or of the edition this replaces) that isn't in this one
  const closed: string[] = [], kept: string[] = [];
  if (validDate) {
    const previous = editionOf ?? (db.prepare(`SELECT id, issuer FROM reports WHERE id <> ? AND status = 'applied' AND as_of < ? ORDER BY as_of DESC, id DESC`)
      .all(reportId, x.asOf).find((r: any) => r.issuer && slug(r.issuer) === slug(x.issuer)) as { id: number } | undefined)?.id;
    if (previous != null) {
      const matched = new Set(products.map(p => p.holdingSource));
      const prevValues = db.prepare(`SELECT holding_source, name, account_number FROM report_values WHERE report_id = ? AND balance <> 0`).all(previous) as
        { holding_source: string; name: string; account_number: string | null }[];
      for (const v of prevValues.filter(v => !matched.has(v.holding_source) && !pending.has(v.holding_source))) {
        const id = `missing:${v.holding_source}`;
        if (answers[id] === 'Closed') closed.push(v.holding_source);
        else if (id in answers) kept.push(v.holding_source);
        else ask({ id, text: `'${productLabel({ name: v.name, accountNumber: v.account_number })}' was in the previous report and isn't in this one. Was it closed?`,
          options: ['Closed', 'Keep it'] });
      }
    }
  }

  // the AI's own questions
  for (const q of x.questions) ask({ ...q, id: `ai:${q.id}` });

  return { editionOf, products, closed, kept, questions };
}

/**
 * Which known product (same type) an extracted one is: by account number and provider; without an account number to
 * go by, by provider and name. `ambiguous` = the candidates to ask about.
 */
export function identify(p: ExtractedProduct, sameKind: KnownProduct[]): { match?: KnownProduct; ambiguous?: KnownProduct[] } {
  const account = normalizeAccount(p.accountNumber);
  if (account) {
    const byAccount = sameKind.filter(k => k.accountNumber && sameAccount(k.accountNumber, account));
    const exact = byAccount.filter(k => sameProvider(k.provider, p.provider));
    if (exact.length === 1) return { match: exact[0] };
    if (byAccount.length) return { ambiguous: byAccount };
  }
  // a known product with a different account number is a different product
  const candidates = sameKind.filter(k => sameProvider(k.provider, p.provider) && (!account || !k.accountNumber));
  if (!candidates.length) return {};
  const strong = candidates.filter(k => nameSimilarity(k.name, p.name) >= SAME_NAME);
  const similar = candidates.filter(k => nameSimilarity(k.name, p.name) >= SIMILAR_NAME);
  if (strong.length === 1 && similar.length === 1) return { match: strong[0] };
  return { ambiguous: candidates };
}
