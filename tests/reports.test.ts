import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { answerReport, deleteReport, importReport, reportDetail } from '../src/reports/index.js';
import { nameSimilarity, normalizeAccount, productKey } from '../src/reports/corroborate.js';
import { normalizeExtraction, type ExtractedProduct, type Extraction, type Extractor } from '../src/reports/extract.js';
import { history, summary } from '../src/analytics/summary.js';
import { testDb } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'familycfo-reports-test-'));
process.env.REPORTS_DIR = join(dir, 'store');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A distinct file per call (its content decides the sha256). */
const file = (content = `report ${++n}`) => {
  const path = join(dir, `r${++n}.csv`);
  writeFileSync(path, content);
  return path;
};

const product = (p: Partial<ExtractedProduct> = {}): ExtractedProduct => ({
  provider: 'מגדל', productType: 'study_fund', accountNumber: '123-456789', name: 'מגדל השתלמות כללי', balance: 100_000, currency: 'ILS',
  liquidityDate: '2027-03-01', confidence: 0.95, evidence: 'קרן השתלמות 100,000', ...p,
});
const report = (x: Partial<Extraction> = {}): Extraction => ({
  issuer: 'מגדל מקפת', reportType: 'quarterly', asOf: '2026-06-30', owner: 'ישראל ישראלי', statedTotal: null, currency: 'ILS',
  products: [product()], questions: [], ...x,
});
/** The AI, mocked: returns the given extraction (and records its calls). */
const ai = (...extractions: Extraction[]) => vi.fn<Extractor>(async () => extractions.length > 1 ? extractions.shift()! : extractions[0]);

const holdings = (db: DB) => db.prepare(`SELECT source, symbol, manual_price, manual_price_date, asset_class, archived FROM holdings ORDER BY source`).all() as
  { source: string; symbol: string; manual_price: number; manual_price_date: string; asset_class: string; archived: number }[];
const snaps = (db: DB) => db.prepare(`SELECT date, source, bucket, value_ils FROM daily_snapshots ORDER BY source, date`).all();

describe('reports', () => {
  let db: DB;
  beforeEach(() => { db = testDb(); });

  it('applies a clean report: a holding per product and a snapshot on its date', async () => {
    const { report: r } = await importReport(db, file(), { extract: ai(report({ statedTotal: 100_000 })) });
    expect(r.status).toBe('applied');
    expect(holdings(db)).toEqual([{ source: 'report:מגדל:123456789', symbol: 'Study fund ••6789', manual_price: 100_000,
      manual_price_date: '2026-06-30', asset_class: 'study_fund', archived: 0 }]);
    expect(snaps(db)).toEqual([{ date: '2026-06-30', source: 'report:מגדל:123456789', bucket: 'study_fund', value_ils: 100_000 }]);
    const s = summary(db, '2026-07-15');
    expect(s.investments).toBe(100_000);
    expect(s.holdings[0]).toMatchObject({ sourceLabel: 'מגדל', assetClass: 'study_fund', liquidityDate: '2027-03-01' });
    expect(s.accounts.find(a => a.source.startsWith('report:'))).toMatchObject({ label: 'Study fund ••6789', sourceLabel: 'מגדל', asOf: '2026-06-30' });
    expect(history(db, 'All', 'type', '2026-07-15').series.map(x => x.label)).toEqual(['Study funds']);
  });

  it('the same file again is already imported — the AI is not called', async () => {
    const path = file('same content');
    await importReport(db, path, { extract: ai(report()) });
    const extract = ai(report());
    const again = await importReport(db, path, { extract });
    expect(again.duplicate).toBe(true);
    expect(extract).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) FROM reports`).pluck().get()).toBe(1);
  });

  it('matches a product by account number across provider spellings and masked numbers', async () => {
    await importReport(db, file(), { extract: ai(report()) });
    await importReport(db, file(), { extract: ai(report({ issuer: 'המסלקה הפנסיונית', reportType: 'consolidated', asOf: '2026-09-30',
      products: [product({ provider: 'מגדל מקפת קרנות פנסיה וגמל', accountNumber: '****6789', name: 'השתלמות', balance: 104_000 })] })) });
    expect(holdings(db)).toMatchObject([{ source: 'report:מגדל:123456789', manual_price: 104_000, manual_price_date: '2026-09-30' }]);
    expect(normalizeAccount('00-123/45')).toBe('12345');
  });

  it('matches by name without an account number; ambiguous → a question, answered → matched', async () => {
    const noAccount = (p: Partial<ExtractedProduct>) => product({ accountNumber: null, ...p });
    await importReport(db, file(), { extract: ai(report({ products: [noAccount({ name: 'מגדל השתלמות כללי' })] })) });
    const similar = await importReport(db, file(), { extract: ai(report({ asOf: '2026-09-30', products: [noAccount({ name: 'מגדל השתלמות כללי' })] })) });
    expect(similar.report.status).toBe('applied');
    expect(holdings(db)).toHaveLength(1);
    expect(nameSimilarity('מגדל השתלמות כללי', 'Migdal Study Fund')).toBe(0);

    const other = await importReport(db, file(), { extract: ai(report({ asOf: '2026-10-01', products: [noAccount({ name: 'Migdal Study Fund', balance: 101_000 })] })) });
    expect(other.report.status).toBe('needs_review');
    const q = JSON.parse(other.report.questions!);
    expect(q).toEqual([{ id: `same:${productKey(noAccount({ name: 'Migdal Study Fund' }))}`, text: "Is 'Migdal Study Fund' the same as 'מגדל השתלמות כללי'?", options: ['Yes', 'No'] }]);
    const extract = ai(report());
    const answered = await answerReport(db, other.report.id, { [q[0].id]: 'Yes' }, {}, extract);
    expect(extract).not.toHaveBeenCalled(); // identity is settled in code
    expect(answered.status).toBe('applied');
    expect(holdings(db)).toMatchObject([{ manual_price: 101_000, manual_price_date: '2026-10-01' }]);
  });

  it('a product with a different account number is a new holding', async () => {
    await importReport(db, file(), { extract: ai(report()) });
    await importReport(db, file(), { extract: ai(report({ issuer: 'other', asOf: '2026-09-30', products: [product({ accountNumber: '999-111111' })] })) });
    expect(holdings(db).map(h => h.source)).toEqual(['report:מגדל:123456789', 'report:מגדל:999111111']);
  });

  it('same issuer and date is an edition: it replaces the earlier one', async () => {
    const first = await importReport(db, file(), { extract: ai(report({ products: [product(), product({ accountNumber: '5', productType: 'pension', name: 'פנסיה', balance: 50_000 })] })) });
    const second = await importReport(db, file(), { extract: ai(report({ issuer: 'מגדל  מקפת', products: [product({ balance: 100_500 }),
      product({ accountNumber: '5', productType: 'pension', name: 'פנסיה', balance: 50_000 })] })) });
    expect(second.report.status).toBe('applied');
    expect(db.prepare(`SELECT status FROM reports WHERE id = ?`).pluck().get(first.report.id)).toBe('superseded');
    expect(db.prepare(`SELECT COUNT(*) FROM report_values WHERE report_id = ?`).pluck().get(first.report.id)).toBe(0);
    expect(holdings(db).find(h => h.asset_class === 'study_fund')!.manual_price).toBe(100_500);
    expect(snaps(db)).toHaveLength(2);
  });

  it('a newer report is a new value point; an older one only adds history', async () => {
    await importReport(db, file(), { extract: ai(report()) });
    await importReport(db, file(), { extract: ai(report({ asOf: '2026-09-30', products: [product({ balance: 110_000 })] })) });
    expect(holdings(db)[0]).toMatchObject({ manual_price: 110_000, manual_price_date: '2026-09-30' });
    const older = await importReport(db, file(), { extract: ai(report({ asOf: '2026-03-31', products: [product({ balance: 95_000 })] })) });
    expect(older.report.status).toBe('applied');
    expect(holdings(db)[0]).toMatchObject({ manual_price: 110_000, manual_price_date: '2026-09-30' });
    expect(snaps(db).map((s: any) => [s.date, s.value_ils])).toEqual([['2026-03-31', 95_000], ['2026-06-30', 100_000], ['2026-09-30', 110_000]]);
    // step-held between reports
    const points = history(db, 'All', 'type', '2026-10-01').points;
    expect(points.find(p => p.date === '2026-08-15')!.investments).toBe(100_000);
  });

  it('products that don\'t add up to the stated total (±1%) → a question', async () => {
    const ok = await importReport(db, file(), { extract: ai(report({ statedTotal: 100_900 })) });
    expect(ok.report.status).toBe('applied');
    const off = await importReport(db, file(), { extract: ai(report({ issuer: 'הראל', statedTotal: 120_000, products: [product({ provider: 'הראל', accountNumber: '77' })] })) });
    expect(off.report.status).toBe('needs_review');
    expect(JSON.parse(off.report.questions!).map((q: any) => q.id)).toEqual(['sum']);
    expect(holdings(db)).toHaveLength(1);
  });

  it('a move of more than 25% from the same kind of report → a question; another kind explains it', async () => {
    await importReport(db, file(), { extract: ai(report()) });
    const jump = await importReport(db, file(), { extract: ai(report({ asOf: '2026-09-30', products: [product({ balance: 130_000 })] })) });
    expect(JSON.parse(jump.report.questions!).map((q: any) => q.id)).toEqual(['jump:report:מגדל:123456789']);
    const otherKind = await importReport(db, file(), { extract: ai(report({ issuer: 'הר הכסף', reportType: 'consolidated', asOf: '2026-09-29', products: [product({ balance: 130_000 })] })) });
    expect(otherKind.report.status).toBe('applied');
  });

  it('a product of the previous report missing → a question; Closed archives it, Keep it leaves it', async () => {
    const two = [product(), product({ accountNumber: '5', productType: 'pension', name: 'פנסיה', balance: 50_000 })];
    await importReport(db, file(), { extract: ai(report({ products: two })) });
    const next = await importReport(db, file(), { extract: ai(report({ asOf: '2026-09-30', products: [product({ balance: 101_000 })] })) });
    const [q] = JSON.parse(next.report.questions!);
    expect(q).toMatchObject({ id: 'missing:report:מגדל:5', options: ['Closed', 'Keep it'] });
    await answerReport(db, next.report.id, { [q.id]: 'Closed' }, {}, ai(report()));
    expect(holdings(db).find(h => h.source === 'report:מגדל:5')).toMatchObject({ archived: 1 });
    expect(summary(db, '2026-10-01').investments).toBe(101_000);
  });

  it('low confidence → a question; an edited balance is used', async () => {
    const low = await importReport(db, file(), { extract: ai(report({ products: [product({ confidence: 0.5 })] })) });
    const [q] = JSON.parse(low.report.questions!);
    expect(q.id).toBe(`confidence:${productKey(product())}`);
    const revised = report({ products: [product({ confidence: 0.5 })] });
    const extract = ai(revised);
    const r = await answerReport(db, low.report.id, { [q.id]: 'No' }, { balances: { [productKey(product())]: 99_000 } }, extract);
    expect(extract).toHaveBeenCalledOnce();
    expect(r.status).toBe('applied');
    expect(holdings(db)[0].manual_price).toBe(99_000);
  });

  it('a missing or future date → a question; the answered date applies', async () => {
    const none = await importReport(db, file(), { extract: ai(report({ asOf: null })) });
    expect(JSON.parse(none.report.questions!).map((q: any) => q.id)).toEqual(['asof']);
    const future = await importReport(db, file(), { extract: ai(report({ issuer: 'x', asOf: '2999-01-01', products: [product({ accountNumber: '8' })] })) });
    expect(JSON.parse(future.report.questions!).map((q: any) => q.id)).toEqual(['asof']);
    const r = await answerReport(db, none.report.id, { asof: '30/06/2026' }, {}, ai(report({ asOf: null })));
    expect(r).toMatchObject({ status: 'applied', as_of: '2026-06-30' });
  });

  it('answers go to the AI for one revision, then corroboration runs again', async () => {
    const first = await importReport(db, file(), { extract: ai(report({ statedTotal: 150_000, questions: [{ id: 'q1', text: 'Is the second page another product?', options: ['Yes', 'No'] }] })) });
    expect(JSON.parse(first.report.questions!).map((q: any) => q.id)).toEqual(['sum', 'ai:q1']);
    const extract = ai(report({ statedTotal: 150_000, products: [product(), product({ accountNumber: '5', productType: 'pension', name: 'פנסיה', balance: 50_000 })] }));
    const r = await answerReport(db, first.report.id, { sum: 'The total — a product is wrong or missing', 'ai:q1': 'Yes' }, {}, extract);
    const [, revision] = extract.mock.calls[0];
    expect(revision!.answers).toMatchObject({ q1: 'Yes' });
    expect(revision!.questions.map(q => q.id)).toEqual(['sum', 'q1']);
    expect(r.status).toBe('applied');
    expect(holdings(db)).toHaveLength(2);
    expect(reportDetail(db, r.id)!.products.every(p => p.holdingSource)).toBe(true);
  });

  it('deleting a report removes its points and recomputes the holdings', async () => {
    await importReport(db, file(), { extract: ai(report()) });
    const newer = await importReport(db, file(), { extract: ai(report({ asOf: '2026-09-30', products: [product({ balance: 110_000 })] })) });
    deleteReport(db, newer.report.id);
    expect(holdings(db)[0]).toMatchObject({ manual_price: 100_000, manual_price_date: '2026-06-30', archived: 0 });
    expect(snaps(db)).toHaveLength(1);
    const first = db.prepare(`SELECT id FROM reports`).pluck().get() as number;
    deleteReport(db, first);
    expect(holdings(db)[0].archived).toBe(1);
    expect(snaps(db)).toHaveLength(0);
  });

  it('a failed extraction is kept as failed, and the same file can be tried again', async () => {
    const path = file('flaky');
    const failed = await importReport(db, path, { extract: async () => { throw new Error('claude exited with code 1'); } });
    expect(failed.report).toMatchObject({ status: 'failed', error: 'claude exited with code 1' });
    const retry = await importReport(db, path, { extract: ai(report()) });
    expect(retry).toMatchObject({ duplicate: false, report: { status: 'applied' } });
  });

  it('a statement\'s mutual funds become Funds holdings by fund number; its other securities stay stocks', async () => {
    const fund = (accountNumber: string, name: string, balance: number) =>
      product({ provider: 'הראל קרנות נאמנות', productType: 'mutual_fund', accountNumber, name, balance, liquidityDate: null });
    const statement = report({ issuer: 'בנק לדוגמה', reportType: 'statement', statedTotal: 60_000, products: [
      fund('5111111', 'הראל מחקה ת"א 125', 30_000), fund('5122222', 'הראל כספית שקלית', 20_000),
      product({ provider: 'בנק לדוגמה', productType: 'brokerage', accountNumber: '12-345-678901', name: 'תיק ניירות ערך', balance: 10_000, liquidityDate: null }),
    ] });
    await importReport(db, file(), { extract: ai(statement) });
    expect(holdings(db).map(h => [h.source, h.symbol, h.asset_class])).toEqual([
      ['report:בנק-לדוגמה:12345678901', 'Brokerage ••8901', 'stock'],
      ['report:הראל-קרנות-נאמנות:5111111', 'Fund ••1111', 'mutual_fund'],
      ['report:הראל-קרנות-נאמנות:5122222', 'Fund ••2222', 'mutual_fund'],
    ]);
    expect(snaps(db)).toContainEqual({ date: '2026-06-30', source: 'report:הראל-קרנות-נאמנות:5111111', bucket: 'mutual_fund', value_ils: 30_000 });
    const s = summary(db, '2026-07-15');
    expect(s.investments).toBe(60_000);
    expect(s.allocation.type).toEqual([{ key: 'mutual_fund', label: 'Funds', value: 50_000 }, { key: 'stock', label: 'Stocks & ETFs', value: 10_000 }]);
    expect(history(db, 'All', 'type', '2026-07-15').series.map(x => x.label)).toEqual(['Stocks & ETFs', 'Funds']);
    // the next statement finds each fund by its number
    const next = await importReport(db, file(), { extract: ai({ ...statement, asOf: '2026-07-31', statedTotal: null, products: [fund('5111111', 'הראל מחקה תא125', 31_000), ...statement.products.slice(1)] }) });
    expect(next.report.status).toBe('applied');
    expect(holdings(db).filter(h => h.asset_class === 'mutual_fund').map(h => [h.symbol, h.manual_price])).toEqual([['Fund ••1111', 31_000], ['Fund ••2222', 20_000]]);
  });

  it('tidies the model output', () => {
    const x = normalizeExtraction({ issuer: ' מגדל ', reportType: 'Quarterly', asOf: '30/06/2026', currency: 'ils', statedTotal: null,
      products: [{ provider: 'מגדל', productType: 'hishtalmut', balance: 5, currency: null, confidence: 2 }, { balance: 'x' }], questions: [{ text: 'ok?' }] });
    expect(x).toMatchObject({ issuer: 'מגדל', reportType: 'quarterly', asOf: null, currency: 'ILS', questions: [{ id: '1', text: 'ok?' }] });
    expect(x.products).toEqual([expect.objectContaining({ productType: 'other', currency: 'ILS', confidence: 1, accountNumber: null })]);
    expect(normalizeExtraction({ products: [{ productType: 'mutual_fund', balance: 1 }] }).products[0].productType).toBe('mutual_fund');
  });
});
