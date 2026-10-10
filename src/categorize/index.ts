import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { DB } from '../db/connection.js';
import { runClaude } from '../ai/claude.js';
import { findCategory } from '../ingest/classify.js';
import { AMBIGUOUS_SCRAPER_CATEGORIES } from '../db/schema.js';
import { cleanMerchantName, merchantKey, merchantLine } from '../util.js';
import { RULE_ONLY_CATEGORIES, applyCategoryRules } from './rules.js';

/**
 * Fully automatic merchant categorisation, after the scraper-category step: every spend row (expense / refund) still
 * without a category is grouped by merchant (`merchantKey`, the expenses API's grouping); merchants not yet in
 * `merchant_categories` go to the user's own `claude -p` (Sonnet, no tools, structured output) in batches, and the
 * answer is cached and written to the rows (`category_source = 'ai'`). Never asks the user; never touches a row a
 * person or the scraper categorised. A scraper category the answer explains is learned as an alias.
 */

export const MODEL = 'claude-sonnet-5-5';
export const BATCH_SIZE = 150;
const MIN_CONFIDENCE = 0.5;
/** the category a low-confidence or unusable answer lands in, the first that exists */
const UNKNOWN_NAMES = ['Unknown', 'לא ידוע', 'Uncategorized', 'Other', 'אחר'];

export interface MerchantInput { merchant: string; examples: string[]; hint: string | null; foreign: boolean }
export interface CategoryInfo { name: string; parent: string | null; kind: string }
export interface MerchantAnswer { merchant: string; category: string; confidence: number }
/** The AI call — injectable, so tests never run Claude. */
export type MerchantCategorizer = (merchants: MerchantInput[], categories: CategoryInfo[]) => Promise<MerchantAnswer[]>;

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['merchant', 'category', 'confidence'],
        properties: {
          merchant: { type: 'string' },
          category: { type: 'string', description: 'one of the category names given, exactly' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

const promptText = () => readFileSync(fileURLToPath(new URL('prompt.md', import.meta.url)), 'utf8');

export const claudeCategorizer: MerchantCategorizer = async (merchants, categories) => {
  // an empty working directory: the call has no tools, nothing to read
  const dir = mkdtempSync(join(tmpdir(), 'familycfo-categorize-'));
  try {
    const prompt = `${promptText()}\n\nThe category tree (name, parent, kind):\n${JSON.stringify(categories)}\n\n`
      + `The merchants:\n${JSON.stringify(merchants)}\n`;
    const out = await runClaude({ cwd: dir, prompt, model: MODEL, schema: ANSWER_SCHEMA, timeoutMs: 5 * 60_000 }) as { results?: unknown };
    if (!Array.isArray(out?.results)) throw new Error('categorizer returned no results');
    return out.results as MerchantAnswer[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export interface CategorizeResult {
  merchants: number;   // merchants with uncategorised spend rows
  asked: number;       // sent to the AI
  answered: number;    // answers cached this run
  rows: number;        // rows given a category
  ruleRows: number;    // rows given a category by rule (src/categorize/rules.ts)
  aliases: number;     // scraper category names learned
  failed: string | null;
}

export interface CategorizeOptions {
  categorizer?: MerchantCategorizer;
  /** re-ask every merchant whose rows aren't categorised by a person or the scraper, ignoring the cache */
  all?: boolean;
  /** re-ask only the merchants the AI left in the unknown category */
  unknown?: boolean;
  log?: (msg: string) => void;
}

interface Group { merchant: string; ids: number[]; names: Map<string, number>; hints: Set<string>; foreign: boolean }

export async function categorizeMerchants(db: DB, opts: CategorizeOptions = {}): Promise<CategorizeResult> {
  const { categorizer = claudeCategorizer, all = false, unknown = false, log = console.log } = opts;
  const result: CategorizeResult = { merchants: 0, asked: 0, answered: 0, rows: 0, ruleRows: 0, aliases: 0, failed: null };

  // rules first: the rows they explain never reach the AI
  result.ruleRows = applyCategoryRules(db).rows;

  // only spend categories are offered: a merchant never changes what a row counts as (nor the rule-only ones)
  const categories = (db.prepare(`
    SELECT c.id, c.name, p.name AS parent, c.kind FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
    WHERE c.kind = 'expense' ORDER BY COALESCE(c.parent_id, c.id), c.parent_id IS NOT NULL, c.name
  `).all() as { id: number; name: string; parent: string | null; kind: string }[]).filter(c => !RULE_ONLY_CATEGORIES.includes(c.name));
  const byName = new Map(categories.map(c => [c.name, c.id]));
  const unknownId = UNKNOWN_NAMES.map(n => byName.get(n)).find(id => id != null) ?? null;

  // the rows: spend without a category — with --all also those a previous AI answer categorised, with --unknown
  // those it left in the unknown category
  const again = all ? `OR category_source = 'ai'` : unknown && unknownId != null ? `OR (category_source = 'ai' AND category_id = ${unknownId})` : '';
  const rows = db.prepare(`
    SELECT id, description, memo, source_category, original_currency FROM transactions
    WHERE kind IN ('expense', 'refund') AND (category_id IS NULL ${again})
  `).all() as { id: number; description: string; memo: string | null; source_category: string | null; original_currency: string | null }[];
  if (!rows.length) return result;

  const groups = new Map<string, Group>();
  for (const r of rows) {
    const line = merchantLine(r.description, r.memo);
    const key = merchantKey(line);
    const g: Group = groups.get(key) ?? { merchant: key, ids: [], names: new Map(), hints: new Set(), foreign: false };
    g.ids.push(r.id);
    const name = cleanMerchantName(line);
    g.names.set(name, (g.names.get(name) ?? 0) + 1);
    // a scraper category that didn't resolve (one that did would have categorised the row already)
    if (r.source_category?.trim()) g.hints.add(r.source_category.trim());
    if (r.original_currency && r.original_currency !== 'ILS') g.foreign = true;
    groups.set(key, g);
  }
  result.merchants = groups.size;

  const cached = new Map((db.prepare(`SELECT merchant, category_id, source FROM merchant_categories`).all() as
    { merchant: string; category_id: number | null; source: string }[]).map(c => [c.merchant, c]));
  const reask = (c: { category_id: number | null; source: string } | undefined) => !c
    || (all && c.source === 'ai') || (unknown && c.source === 'ai' && (c.category_id === unknownId || c.category_id == null));
  const toAsk = [...groups.values()].filter(g => reask(cached.get(g.merchant)));

  if (toAsk.length && categories.length) {
    const save = db.prepare(`INSERT INTO merchant_categories (merchant, category_id, confidence, source, model)
      VALUES (?, ?, ?, 'ai', ?) ON CONFLICT (merchant) DO UPDATE SET category_id = excluded.category_id,
      confidence = excluded.confidence, source = 'ai', model = excluded.model, created_at = CURRENT_TIMESTAMP`);
    const info = categories.map(({ name, parent, kind }) => ({ name, parent, kind }));
    for (let i = 0; i < toAsk.length; i += BATCH_SIZE) {
      const batch = toAsk.slice(i, i + BATCH_SIZE);
      result.asked += batch.length;
      let answers: MerchantAnswer[];
      try {
        answers = await categorizer(batch.map(g => ({
          merchant: g.merchant,
          examples: [...g.names].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n),
          hint: [...g.hints][0] ?? null,
          foreign: g.foreign,
        })), info);
      } catch (err) {
        // the CLI is missing or failed: what's cached still applies; these merchants are asked next run
        result.failed = (err as Error).message;
        log(`  merchant categorizer failed: ${result.failed}`);
        break;
      }
      const wanted = new Set(batch.map(g => g.merchant));
      db.transaction(() => {
        for (const a of answers) {
          if (!a || typeof a.merchant !== 'string' || !wanted.has(a.merchant)) continue;
          wanted.delete(a.merchant);
          const confidence = Number.isFinite(a.confidence) ? Math.max(0, Math.min(1, Number(a.confidence))) : 0;
          const id = byName.get(String(a.category ?? '').trim());
          const categoryId = id != null && confidence >= MIN_CONFIDENCE ? id : unknownId;
          save.run(a.merchant, categoryId, id != null ? confidence : 0, MODEL);
          cached.set(a.merchant, { merchant: a.merchant, category_id: categoryId, source: 'ai' });
          result.answered++;
        }
      })();
    }
  }

  // apply: every group with a cached category; only rows still uncategorised or categorised by the AI
  const apply = db.prepare(`UPDATE transactions SET category_id = ?, category_source = ?
    WHERE id = ? AND (category_id IS NULL OR category_source = 'ai')`);
  const learn = db.prepare(`INSERT OR IGNORE INTO category_aliases (name, category_id) VALUES (?, ?)`);
  const hintAnswers = new Map<string, Set<number>>();
  db.transaction(() => {
    for (const g of groups.values()) {
      const c = cached.get(g.merchant);
      if (!c || c.category_id == null) continue;
      for (const id of g.ids) result.rows += apply.run(c.category_id, c.source, id).changes;
      if (c.category_id === unknownId) continue;
      for (const h of g.hints) hintAnswers.set(h, (hintAnswers.get(h) ?? new Set()).add(c.category_id));
    }
    // a scraper category whose merchants all landed in one category resolves without the AI from now on
    for (const [hint, ids] of hintAnswers) {
      if (ids.size === 1 && findCategory(db, hint) == null && !AMBIGUOUS_SCRAPER_CATEGORIES.includes(hint)) result.aliases += learn.run(hint, [...ids][0]).changes;
    }
  })();
  return result;
}
