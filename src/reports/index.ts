import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { basename, extname, join } from 'path';
import type { DB } from '../db/connection.js';
import { rateToIls } from '../analytics/fx.js';
import { round, today } from '../util.js';
import type { AssetClass } from '../sync/assets.js';
import { corroborate, knownProducts, normalizeAccount, productKey, slug, type Corroboration } from './corroborate.js';
import { claudeExtractor, REPORT_TYPES, type Extraction, type Extractor, type ProductType, type Question } from './extract.js';

/**
 * Reports (pension, study fund, provident fund, mutual funds, statements…) → holdings. A file is stored by its sha256, read by the AI,
 * corroborated against what's stored, and applied — or held for review with questions. Each product is a holding
 * `report:<provider>:<account>` priced at its latest balance; every report's balances are its value points, and the
 * snapshots step-hold them between reports.
 */

/** Where imported report files are kept (git-ignored): data/reports unless REPORTS_DIR. */
const reportsDir = () => process.env.REPORTS_DIR || join('data', 'reports');

export type ReportStatus = 'extracting' | 'needs_review' | 'applied' | 'superseded' | 'failed';

export interface ReportRow {
  id: number; sha256: string; file: string; original_name: string | null; issuer: string | null; report_type: string | null;
  as_of: string | null; status: ReportStatus; extraction: string | null; questions: string | null; answers: string | null;
  error: string | null; created_at: string; applied_at: string | null;
}

/** Edits from the review panel: the report's date and product balances (by product key). */
export interface ReportEdits { asOf?: string; balances?: Record<string, number> }

const ASSET_CLASS: Record<ProductType, AssetClass> = {
  pension: 'pension', study_fund: 'study_fund', provident_fund: 'provident_fund', mutual_fund: 'mutual_fund', brokerage: 'stock', deposit: 'deposit',
  other: 'other',
};
const SYMBOL: Record<string, string> = {
  pension: 'Pension', study_fund: 'Study fund', provident_fund: 'Provident fund', mutual_fund: 'Fund', brokerage: 'Brokerage', deposit: 'Deposit',
  other: 'Other',
};

const json = <T>(s: string | null, fallback: T): T => (s ? JSON.parse(s) as T : fallback);
export const getReport = (db: DB, id: number) => db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id) as ReportRow | undefined;

/**
 * Store a report file and register it. The same file again (same sha256) is "already imported" — unless that import
 * failed, then it is tried again.
 */
export function registerReport(db: DB, path: string, originalName = basename(path)): { report: ReportRow; duplicate: boolean } {
  const ext = extname(originalName || path).toLowerCase();
  if (!REPORT_TYPES.has(ext)) throw Object.assign(new Error(`unsupported file type ${ext || '(none)'} — PDF, CSV, XLSX or an image`), { statusCode: 400 });
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const existing = db.prepare(`SELECT * FROM reports WHERE sha256 = ?`).get(sha256) as ReportRow | undefined;
  if (existing && existing.status !== 'failed') return { report: existing, duplicate: true };
  if (existing) db.prepare(`DELETE FROM reports WHERE id = ?`).run(existing.id);

  mkdirSync(reportsDir(), { recursive: true });
  const file = join(reportsDir(), `${sha256}${ext}`);
  if (!existsSync(file)) copyFileSync(path, file);
  const id = Number(db.prepare(`INSERT INTO reports (sha256, file, original_name, status) VALUES (?, ?, ?, 'extracting')`)
    .run(sha256, file, originalName).lastInsertRowid);
  return { report: getReport(db, id)!, duplicate: false };
}

/** Extract → corroborate → apply (or needs_review). Errors leave the report `failed` with the reason. */
export async function processReport(db: DB, id: number, extract: Extractor = claudeExtractor): Promise<ReportRow> {
  const report = getReport(db, id);
  if (!report) throw new Error(`no report ${id}`);
  try {
    const extraction = await extract(report.file);
    db.prepare(`UPDATE reports SET extraction = ?, issuer = ?, report_type = ?, as_of = ? WHERE id = ?`)
      .run(JSON.stringify(extraction), extraction.issuer, extraction.reportType, extraction.asOf, id);
    return settle(db, id, extraction, {});
  } catch (err) {
    db.prepare(`UPDATE reports SET status = 'failed', error = ? WHERE id = ?`).run((err as Error).message, id);
    return getReport(db, id)!;
  }
}

/** Register and process a file — the CLI's whole import. */
export async function importReport(db: DB, path: string, opts: { originalName?: string; extract?: Extractor } = {}) {
  const { report, duplicate } = registerReport(db, path, opts.originalName);
  if (duplicate) return { report, duplicate };
  return { report: await processReport(db, report.id, opts.extract), duplicate };
}

/** Corroborate; no questions → apply, else needs_review with them. */
function settle(db: DB, id: number, x: Extraction, answers: Record<string, string>): ReportRow {
  const c = corroborate(db, id, x, answers);
  if (c.questions.length) {
    db.prepare(`UPDATE reports SET status = 'needs_review', extraction = ?, issuer = ?, report_type = ?, as_of = ?, questions = ?, answers = ?, error = NULL WHERE id = ?`)
      .run(JSON.stringify(x), x.issuer, x.reportType, x.asOf, JSON.stringify(c.questions), JSON.stringify(answers), id);
  } else {
    applyReport(db, id, x, c, answers);
  }
  return getReport(db, id)!;
}

/** Question kinds the AI can act on (identity and closed products are settled in code). */
const forTheAi = (questionId: string) => !questionId.startsWith('same:') && !questionId.startsWith('missing:');

/** A date as answered: YYYY-MM-DD or the Israeli D/M/YYYY. */
function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function applyEdits(x: Extraction, edits: ReportEdits, answers: Record<string, string>): Extraction {
  const asOf = parseDate(edits.asOf) ?? (!x.asOf ? parseDate(answers.asof) : null) ?? x.asOf;
  return {
    ...x, asOf,
    products: x.products.map(p => {
      const balance = edits.balances?.[productKey(p)];
      return balance != null && Number.isFinite(balance) ? { ...p, balance, confidence: 1 } : p;
    }),
  };
}

/** The review's answers (and edits): one AI revision pass when an answer is for it, then corroborate again. */
export async function answerReport(db: DB, id: number, answers: Record<string, string>, edits: ReportEdits = {},
  extract: Extractor = claudeExtractor): Promise<ReportRow> {
  const report = getReport(db, id);
  if (!report) throw Object.assign(new Error(`no report ${id}`), { statusCode: 404 });
  if (report.status !== 'needs_review') throw Object.assign(new Error(`report ${id} is ${report.status}, not waiting for answers`), { statusCode: 409 });
  const all = { ...json<Record<string, string>>(report.answers, {}), ...answers };
  const questions = json<Question[]>(report.questions, []);
  let x = applyEdits(json<Extraction>(report.extraction, null as never), edits, all);
  try {
    if (questions.some(q => q.id in answers && forTheAi(q.id))) {
      // the AI's own questions go back under their own ids
      const theirs = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.replace(/^ai:/, ''), v]));
      const revised = await extract(report.file, { extraction: x, questions: questions.map(q => ({ ...q, id: q.id.replace(/^ai:/, '') })), answers: theirs });
      // answered questions don't come back; the household's edits stay
      x = applyEdits({ ...revised, questions: revised.questions.filter(q => !(`ai:${q.id}` in all)) }, edits, all);
    }
  } catch (err) {
    db.prepare(`UPDATE reports SET error = ? WHERE id = ?`).run((err as Error).message, id);
    throw err;
  }
  return settle(db, id, x, all);
}

/**
 * Read a stored, applied report again (e.g. after the prompt learned something new, like stated returns) and apply the
 * new reading through the same corroboration: its identity stays — the issuer, date and owner it was applied with, and
 * every product must be one it already has (a dropped product keeps its point); its values update. When the checks ask
 * something (or a product would be new), nothing changes and the questions come back.
 */
export async function reextractReport(db: DB, id: number, extract: Extractor = claudeExtractor): Promise<{ report: ReportRow; questions: Question[] }> {
  const report = getReport(db, id);
  if (!report) throw Object.assign(new Error(`no report ${id}`), { statusCode: 404 });
  if (report.status !== 'applied') throw new Error(`report ${id} is ${report.status}; only an applied report can be re-extracted`);
  const before = json<Extraction | null>(report.extraction, null);
  const own = new Set(db.prepare(`SELECT holding_source FROM report_values WHERE report_id = ?`).pluck().all(id) as string[]);
  const fresh = await extract(report.file);
  const x: Extraction = { ...fresh, issuer: before?.issuer ?? fresh.issuer, reportType: before?.reportType ?? fresh.reportType,
    asOf: before?.asOf ?? report.as_of ?? fresh.asOf, owner: before ? before.owner : fresh.owner, questions: [] };
  const answers = json<Record<string, string>>(report.answers, {});
  const c = corroborate(db, id, x, answers);
  const questions = [...c.questions];
  x.products.forEach((p, i) => {
    if (!own.has(c.products[i].holdingSource)) questions.push({ id: `new:${productKey(p)}`, text: `'${p.name}' isn't a product of this report` });
  });
  if (questions.length) return { report, questions };
  applyReport(db, id, x, c, answers);
  return { report: getReport(db, id)!, questions: [] };
}

/** Write the report's value points (replacing the edition it supersedes) and recompute the holdings they touch. */
export function applyReport(db: DB, id: number, x: Extraction, c: Corroboration, answers: Record<string, string> = {}): void {
  const touched = new Set<string>();
  const insert = db.prepare(`INSERT OR REPLACE INTO report_values (report_id, holding_source, provider, product_type, account_number, name, owner,
    balance, currency, as_of, liquidity_date, returns) VALUES (@reportId, @source, @provider, @type, @account, @name, @owner, @balance, @currency, @asOf, @liquidity, @returns)`);
  db.transaction(() => {
    // an edition: the products kept from the one it replaces ("Keep it") carry over, then it is superseded
    const previous = c.editionOf == null ? [] : db.prepare(`SELECT * FROM report_values WHERE report_id = ?`).all(c.editionOf) as Record<string, any>[];
    const superseded = db.prepare(`SELECT id FROM reports WHERE id <> ? AND as_of = ? AND status IN ('applied', 'needs_review')`).pluck()
      .all(id, x.asOf).filter(r => r === c.editionOf || sameIssuer(db, r as number, x.issuer)) as number[];
    for (const r of superseded) {
      for (const s of db.prepare(`SELECT holding_source FROM report_values WHERE report_id = ?`).pluck().all(r) as string[]) touched.add(s);
      db.prepare(`DELETE FROM report_values WHERE report_id = ?`).run(r);
      db.prepare(`UPDATE reports SET status = 'superseded' WHERE id = ?`).run(r);
    }

    x.products.forEach((p, i) => {
      const source = c.products[i].holdingSource;
      touched.add(source);
      insert.run({ reportId: id, source, provider: p.provider, type: p.productType, account: normalizeAccount(p.accountNumber), name: p.name,
        owner: x.owner, balance: p.balance, currency: p.currency, asOf: x.asOf, liquidity: p.liquidityDate, returns: p.returns ? JSON.stringify(p.returns) : null });
    });
    const latest = new Map(knownProducts(db).map(k => [k.holdingSource, k]));
    const point = (source: string, balance?: number) => {
      const from = previous.find(v => v.holding_source === source) ?? db.prepare(`SELECT * FROM report_values WHERE holding_source = ? ORDER BY as_of DESC LIMIT 1`).get(source) as Record<string, any> | undefined;
      const k = latest.get(source);
      if (!from && !k) return;
      touched.add(source);
      insert.run({ reportId: id, source, provider: from?.provider ?? k!.provider, type: from?.product_type ?? k!.productType,
        account: from?.account_number ?? k!.accountNumber, name: from?.name ?? k!.name, owner: from?.owner ?? x.owner,
        balance: balance ?? from?.balance ?? k!.balance, currency: from?.currency ?? k!.currency, asOf: x.asOf, liquidity: from?.liquidity_date ?? null,
        returns: balance === 0 ? null : from?.returns ?? null });
    };
    // closed: a zero point on this date; kept from a replaced edition: its point carries over
    for (const source of c.closed) point(source, 0);
    for (const source of c.kept) if (previous.some(v => v.holding_source === source)) point(source);

    db.prepare(`UPDATE reports SET status = 'applied', extraction = ?, issuer = ?, report_type = ?, as_of = ?, questions = '[]', answers = ?,
      error = NULL, applied_at = CURRENT_TIMESTAMP WHERE id = ?`).run(JSON.stringify(x), x.issuer, x.reportType, x.asOf, JSON.stringify(answers), id);
    for (const source of touched) recomputeHolding(db, source);
  })();
}

function sameIssuer(db: DB, reportId: number, issuer: string): boolean {
  const other = db.prepare(`SELECT issuer FROM reports WHERE id = ?`).pluck().get(reportId) as string | null;
  return !!other && slug(other) === slug(issuer);
}

/**
 * A report holding from its value points: priced at the latest point's balance (archived when it has none, or the
 * latest is 0 — closed), and one snapshot per point date, step-held by the history until the next.
 */
export function recomputeHolding(db: DB, source: string): void {
  const points = db.prepare(`
    SELECT v.* FROM report_values v JOIN reports r ON r.id = v.report_id
    WHERE v.holding_source = ? AND r.status = 'applied' ORDER BY v.as_of, v.report_id
  `).all(source) as { provider: string | null; product_type: ProductType; account_number: string | null; name: string | null;
    balance: number; currency: string; as_of: string }[];
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM daily_snapshots WHERE source = ?`).run(source);
  const latest = points.at(-1);
  if (!latest || latest.balance === 0) {
    db.prepare(`UPDATE holdings SET archived = 1, synced_at = ?, updated_at = CURRENT_TIMESTAMP WHERE source = ?`).run(now, source);
  } else {
    const values = {
      source, symbol: `${SYMBOL[latest.product_type] ?? 'Other'}${latest.account_number ? ` ••${latest.account_number.slice(-4)}` : ''}`,
      name: latest.name, currency: latest.currency, assetClass: ASSET_CLASS[latest.product_type] ?? 'other', broker: latest.provider,
      price: latest.balance, date: latest.as_of, now,
    };
    const id = db.prepare(`SELECT id FROM holdings WHERE source = ?`).pluck().get(source) as number | undefined;
    if (id == null) {
      db.prepare(`INSERT INTO holdings (source, symbol, name, quantity, currency, asset_class, broker, manual_price, manual_price_date, synced_at)
        VALUES (@source, @symbol, @name, 1, @currency, @assetClass, @broker, @price, @date, @now)`).run(values);
    } else {
      db.prepare(`UPDATE holdings SET symbol = @symbol, name = @name, quantity = 1, currency = @currency, asset_class = @assetClass, broker = @broker,
        manual_price = @price, manual_price_date = @date, archived = 0, synced_at = @now, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ ...values, id });
    }
  }
  // the last point of each date
  const byDate = new Map(points.map(p => [p.as_of, p]));
  const insert = db.prepare(`INSERT INTO daily_snapshots (date, source, bucket, value_ils, as_of) VALUES (?, ?, ?, ?, ?)`);
  for (const [date, p] of byDate) {
    const rate = rateToIls(db, p.currency, date);
    if (rate == null) { console.warn(`  no exchange rate for ${p.currency} on ${date} — ${source} left out of that day's snapshot`); continue; }
    insert.run(date, source, ASSET_CLASS[p.product_type] ?? 'other', round(p.balance * rate), date);
  }
}

/** Remove a report: its value points go, the holdings they touched are recomputed, the stored file is deleted. */
export function deleteReport(db: DB, id: number): boolean {
  const report = getReport(db, id);
  if (!report) return false;
  db.transaction(() => {
    const sources = db.prepare(`SELECT holding_source FROM report_values WHERE report_id = ?`).pluck().all(id) as string[];
    db.prepare(`DELETE FROM report_values WHERE report_id = ?`).run(id);
    db.prepare(`DELETE FROM reports WHERE id = ?`).run(id);
    for (const s of sources) recomputeHolding(db, s);
  })();
  if (!db.prepare(`SELECT 1 FROM reports WHERE file = ?`).get(report.file)) rmSync(report.file, { force: true });
  return true;
}

/** `GET /api/reports` */
export function listReports(db: DB) {
  return (db.prepare(`SELECT id, original_name, issuer, report_type, as_of, status, error, created_at, applied_at, questions,
    (SELECT COUNT(*) FROM report_values WHERE report_id = reports.id) AS products FROM reports ORDER BY COALESCE(as_of, created_at) DESC, id DESC`).all() as
    (Pick<ReportRow, 'id' | 'original_name' | 'issuer' | 'report_type' | 'as_of' | 'status' | 'error' | 'created_at' | 'applied_at' | 'questions'> & { products: number })[])
    .map(({ questions, ...r }) => ({
      id: r.id, name: r.original_name, issuer: r.issuer, reportType: r.report_type, asOf: r.as_of, status: r.status, error: r.error,
      createdAt: r.created_at, appliedAt: r.applied_at, products: r.products, questions: json<Question[]>(questions, []).length,
    }));
}

/** `GET /api/reports/:id`: the extraction with each product's key and holding, and the open questions. */
export function reportDetail(db: DB, id: number) {
  const r = getReport(db, id);
  if (!r) return null;
  const x = json<Extraction | null>(r.extraction, null);
  const c = x && r.status === 'needs_review' ? corroborate(db, id, x, json(r.answers, {}), today()) : null;
  const applied = new Map((db.prepare(`SELECT holding_source, provider, name, product_type, account_number FROM report_values WHERE report_id = ?`).all(id) as
    { holding_source: string; provider: string; product_type: ProductType; account_number: string | null; name: string }[])
    .map(v => [productKey({ provider: v.provider, accountNumber: v.account_number, name: v.name, productType: v.product_type }), v.holding_source]));
  return {
    id: r.id, name: r.original_name, issuer: r.issuer, reportType: r.report_type, asOf: r.as_of, status: r.status, error: r.error,
    createdAt: r.created_at, appliedAt: r.applied_at, owner: x?.owner ?? null, statedTotal: x?.statedTotal ?? null, currency: x?.currency ?? null,
    products: (x?.products ?? []).map((p, i) => ({
      ...p, key: productKey(p),
      holdingSource: c ? c.products[i]?.holdingSource || null : applied.get(productKey(p)) ?? null,
      known: c ? c.products[i]?.known ?? false : null,
    })),
    questions: json<Question[]>(r.questions, []),
    answers: json<Record<string, string>>(r.answers, {}),
  };
}

/**
 * Correct a report's owner (the review panel): the extraction's owner and every value point of the report — the
 * products it touches show the new owner. Blank clears it.
 */
export function setReportOwner(db: DB, id: number, owner: string): ReportRow {
  const report = getReport(db, id);
  if (!report) throw Object.assign(new Error(`no report ${id}`), { statusCode: 404 });
  const value = owner.trim().slice(0, 80) || null;
  db.transaction(() => {
    const x = json<Extraction | null>(report.extraction, null);
    if (x) db.prepare(`UPDATE reports SET extraction = ? WHERE id = ?`).run(JSON.stringify({ ...x, owner: value }), id);
    db.prepare(`UPDATE report_values SET owner = ? WHERE report_id = ?`).run(value, id);
  })();
  return getReport(db, id)!;
}

/** Reports left `extracting` by a process that stopped (the server restarted mid-extraction) can't finish. */
export function failInterrupted(db: DB): number {
  return db.prepare(`UPDATE reports SET status = 'failed', error = 'interrupted — import the file again' WHERE status = 'extracting'`).run().changes;
}
