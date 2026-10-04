import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { fundGrowth, funds, type FundPoint } from '../src/analytics/funds.js';
import { importReport, reextractReport } from '../src/reports/index.js';
import { normalizeExtraction, type ExtractedProduct, type Extraction, type Extractor } from '../src/reports/extract.js';
import { testDb } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'familycfo-funds-test-'));
process.env.REPORTS_DIR = join(dir, 'store');
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => { const path = join(dir, `r${++n}.csv`); writeFileSync(path, `report ${n}`); return path; };

const point = (asOf: string, balance: number, returns: FundPoint['returns'] = null): FundPoint => ({ asOf, balance, returns });

describe('fund growth over the range', () => {
  const today = '2026-10-04';

  it('no points: nothing', () => {
    expect(fundGrowth([], '1Y', '2025-10-04', today)).toEqual({ growth: null, growthPct: null, from: null, to: null, stated: null });
  });

  it('one point, nothing stated: nothing', () => {
    expect(fundGrowth([point('2026-06-30', 100)], '1Y', '2025-10-04', today).growthPct).toBeNull();
  });

  it('one point: the stated return of the period closest to the range, marked stated', () => {
    const p = [point('2026-06-30', 100, { ytd: 3.1, m12: 8.4, m36: 21 })];
    expect(fundGrowth(p, '1Y', '2025-10-04', today)).toEqual({ growth: null, growthPct: 8.4, from: null, to: null, stated: '12M' });
    expect(fundGrowth(p, '3M', '2026-07-04', today)).toMatchObject({ growthPct: 3.1, stated: 'YTD' });
    expect(fundGrowth(p, 'All', '2023-01-01', today)).toMatchObject({ growthPct: 21, stated: '36M' });
    // only what is printed is a candidate
    expect(fundGrowth([point('2026-06-30', 100, { ytd: null, m12: null, m36: 21 })], '1M', '2026-09-04', today)).toMatchObject({ growthPct: 21, stated: '36M' });
  });

  it('two points bracketing the range: the value change between them', () => {
    const p = [point('2025-06-30', 1000), point('2025-12-31', 1100), point('2026-06-30', 1210)];
    // the last point on/before the start (2025-06-30) → the latest
    expect(fundGrowth(p, '1Y', '2025-10-04', today)).toEqual({ growth: 210, growthPct: 21, from: '2025-06-30', to: '2026-06-30', stated: null });
    // YTD: 2025-12-31 → 2026-06-30
    expect(fundGrowth(p, 'YTD', '2026-01-01', today)).toMatchObject({ growth: 110, growthPct: 10, from: '2025-12-31' });
  });

  it('no point before the start: from the first one after it', () => {
    const p = [point('2026-03-31', 500), point('2026-06-30', 550)];
    expect(fundGrowth(p, '1Y', '2025-10-04', today)).toMatchObject({ growth: 50, growthPct: 10, from: '2026-03-31' });
  });

  it('the range inside the gap between points (< 2 in it): the stated return', () => {
    const p = [point('2025-12-31', 1000, { ytd: 9, m12: 9, m36: null }), point('2026-06-30', 1050, { ytd: 4.2, m12: 7, m36: null })];
    expect(fundGrowth(p, '1M', '2026-09-04', today)).toEqual({ growth: null, growthPct: 4.2, from: null, to: null, stated: 'YTD' });
  });
});

describe('stated returns from reports', () => {
  const product = (p: Partial<ExtractedProduct> = {}): ExtractedProduct => ({
    provider: 'מגדל', productType: 'study_fund', accountNumber: '123-456789', name: 'מגדל השתלמות כללי', balance: 100_000, currency: 'ILS',
    liquidityDate: '2027-03-01', confidence: 0.95, evidence: 'x', ...p,
  });
  const report = (x: Partial<Extraction> = {}): Extraction => ({
    issuer: 'מגדל מקפת', reportType: 'quarterly', asOf: '2026-06-30', owner: 'ישראל', statedTotal: null, currency: 'ILS', products: [product()], questions: [], ...x,
  });

  it('normalizes the optional returns', () => {
    const x = normalizeExtraction({ ...report(), products: [{ ...product(), returns: { ytd: 3.2, m12: 'x', m36: null } }, { ...product(), accountNumber: '9' }] });
    expect(x.products[0].returns).toEqual({ ytd: 3.2, m12: null, m36: null });
    expect(x.products[1].returns).toBeNull();
  });

  it('stores them with the value point and shows them on the fund', async () => {
    const db = testDb();
    await importReport(db, file(), { extract: async () => report({ products: [product({ returns: { ytd: 2.5, m12: 6.1, m36: 18 } })] }) });
    const f = funds(db, '1Y', '2026-10-04').funds[0];
    expect(f).toMatchObject({ name: 'מגדל השתלמות כללי', subType: 'Study fund', valueIls: 100_000, asOf: '2026-06-30', growthPct: 6.1, stated: '12M',
      returns: { ytd: 2.5, m12: 6.1, m36: 18, asOf: '2026-06-30' } });
    expect(f.points).toEqual([{ date: '2026-06-30', valueIls: 100_000 }]);
  });

  it('re-extracts a stored report: same product, values and returns update', async () => {
    const db = testDb();
    const { report: r } = await importReport(db, file(), { extract: async () => report() });
    const again = vi.fn<Extractor>(async () => report({ issuer: 'Migdal', asOf: '2026-07-01', products: [product({ balance: 101_000, returns: { ytd: 1, m12: 2, m36: 3 } })] }));
    const out = await reextractReport(db, r.id, again);
    expect(out.questions).toEqual([]);
    // identity unchanged: issuer and date as applied
    expect(out.report).toMatchObject({ status: 'applied', issuer: 'מגדל מקפת', as_of: '2026-06-30' });
    expect(db.prepare(`SELECT holding_source, balance, returns FROM report_values`).all()).toEqual([
      { holding_source: 'report:מגדל:123456789', balance: 101_000, returns: JSON.stringify({ ytd: 1, m12: 2, m36: 3 }) },
    ]);
    expect(db.prepare(`SELECT manual_price FROM holdings`).pluck().get()).toBe(101_000);
  });

  it('re-extraction that finds a new product changes nothing', async () => {
    const db = testDb();
    const { report: r } = await importReport(db, file(), { extract: async () => report() });
    const out = await reextractReport(db, r.id, async () => report({ products: [product(), product({ accountNumber: '777', name: 'אחר' })] }));
    expect(out.questions.map(q => q.text)).toEqual(["'אחר' isn't a product of this report"]);
    expect(db.prepare(`SELECT COUNT(*) FROM report_values`).pluck().get()).toBe(1);
  });
});
