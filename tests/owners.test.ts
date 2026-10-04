import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { configuredSources, integrations } from '../src/analytics/integrations.js';
import { configOwners, firstName } from '../src/analytics/owners.js';
import { summary } from '../src/analytics/summary.js';
import { writeSnapshots } from '../src/analytics/snapshots.js';
import { recordSourceRun } from '../src/db/ingestRepo.js';
import { applyDraft, listIntegrations, readConfigFile, writeConfigFile } from '../src/integrations/manage.js';
import { importReport, reportDetail, setReportOwner } from '../src/reports/index.js';
import type { Extraction } from '../src/reports/extract.js';
import type { Config } from '../src/scraper.js';
import { addAccount, addBalance, addHolding, testDb } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'owners-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config = {
  accounts: [
    { companyId: 'oneZero', owner: 'Dana Levi', credentials: { email: 'a@b.c', password: 'pw-secret-1' } },
    { companyId: 'hapoalim', credentials: { userCode: '', password: '' } },
  ],
  investments: [
    { type: 'ibkr', owner: '  Avi  Cohen ', token: 'tok-secret', queryId: '1' },
    { type: 'exchange', exchange: 'kraken', apiKey: 'k', secret: 's' },
  ],
} as unknown as Config;

describe('owners', () => {
  it('takes the first name only', () => {
    expect(firstName('Dana Levi')).toBe('Dana');
    expect(firstName('  יונתן קרא ')).toBe('יונתן');
    expect(firstName('')).toBeNull();
    expect(firstName(undefined)).toBeNull();
  });

  it('banks, brokers and exchanges hand their owner to their accounts and holdings, by source', () => {
    const db = testDb();
    addAccount(db, 'oneZero:111', 'bank');
    addBalance(db, 'oneZero:111', 1000);
    addAccount(db, 'hapoalim:222', 'bank');
    addBalance(db, 'hapoalim:222', 500);
    addHolding(db, { source: 'ibkr:U1', symbol: 'VOO', quantity: 1, currency: 'ILS', assetClass: 'stock', price: 100 });
    addHolding(db, { source: 'kraken:main', symbol: 'BTC-USD', quantity: 1, currency: 'ILS', assetClass: 'crypto', price: 50 });
    writeSnapshots(db, ['oneZero', 'hapoalim'].map(source => ({ source, kind: 'bank' as const, success: true }))
      .concat(['ibkr', 'kraken'].map(source => ({ source, kind: 'investment' as const, success: true }))), '2026-05-01');

    const owners = configOwners(config);
    expect([...owners]).toEqual([['oneZero', 'Dana'], ['ibkr', 'Avi']]);
    const s = summary(db, '2026-05-01', owners);
    expect(s.accounts.find(a => a.source === 'oneZero')).toMatchObject({ owner: 'Dana' });
    expect(s.accounts.find(a => a.source === 'hapoalim')).toMatchObject({ owner: null });
    expect(s.accounts.find(a => a.source === 'ibkr')).toMatchObject({ owner: 'Avi' });
    expect(s.holdings.find(h => h.symbol === 'VOO')).toMatchObject({ owner: 'Avi' });
    expect(s.holdings.find(h => h.symbol === 'BTC-USD')).toMatchObject({ owner: null });
    // without owners nothing breaks
    expect(summary(db, '2026-05-01').holdings.every(h => h.owner === null)).toBe(true);
  });

  it('shows the integration owner (first name) in /api/integrations, never a credential', () => {
    const db = testDb();
    recordSourceRun(db, { source: 'oneZero', startedAt: new Date().toISOString(), ok: true });
    const sources = configuredSources(config);
    expect(sources.find(s => s.id === 'oneZero')).toMatchObject({ owner: 'Dana' });
    expect(sources.find(s => s.id === 'hapoalim')).not.toHaveProperty('owner');
    const list = integrations(db, sources).sources;
    expect(list.find(s => s.id === 'ibkr')).toMatchObject({ owner: 'Avi' });
    expect(list.find(s => s.id === 'kraken')).toMatchObject({ owner: null });
    expect(JSON.stringify(list)).not.toMatch(/secret/);
  });

  it('is edited from the Integrations editor: set, kept when absent, cleared when blank — secrets untouched', () => {
    const file = join(dir, 'accounts.json');
    writeConfigFile(file, config, join(dir, 'backups'));
    let { config: next } = applyDraft(readConfigFile(file), { type: 'bank', companyId: 'hapoalim', fields: {}, owner: 'Noa Bar' }, 'accounts:hapoalim');
    ({ config: next } = applyDraft(next, { type: 'ibkr', fields: {} }, 'investments:ibkr'));
    ({ config: next } = applyDraft(next, { type: 'exchange', fields: {}, owner: '' }, 'investments:kraken'));
    ({ config: next } = applyDraft(next, { type: 'bank', companyId: 'oneZero', fields: {}, owner: '' }, 'accounts:oneZero'));
    const list = listIntegrations(next);
    expect(list.map(x => [x.id, x.owner])).toEqual([['oneZero', null], ['hapoalim', 'Noa Bar'], ['ibkr', '  Avi  Cohen '], ['kraken', null]]);
    // the owner sits on the entry, not among the credentials the scraper receives
    expect(next.accounts[1]).toMatchObject({ owner: 'Noa Bar', credentials: { userCode: '', password: '' } });
    expect((next.investments![0] as { token: string }).token).toBe('tok-secret');
  });

  it('a report product carries the owner printed on its report; the review panel corrects it', async () => {
    const db = testDb();
    const path = join(dir, 'r.csv');
    writeFileSync(path, 'report');
    const x: Extraction = {
      issuer: 'מגדל', reportType: 'quarterly', asOf: '2026-06-30', owner: 'ישראל ישראלי', statedTotal: null, currency: 'ILS', questions: [],
      products: [{ provider: 'מגדל', productType: 'pension', accountNumber: '123456', name: 'מגדל מקפת', balance: 1000, currency: 'ILS',
        liquidityDate: null, confidence: 0.95, evidence: '' }],
    };
    const { report } = await importReport(db, path, { extract: async () => x });
    expect(summary(db, '2026-07-01').holdings[0]).toMatchObject({ owner: 'ישראל' });
    expect(summary(db, '2026-07-01').accounts.find(a => a.source.startsWith('report:'))).toMatchObject({ owner: 'ישראל' });
    setReportOwner(db, report.id, 'Ruth Katz');
    expect(summary(db, '2026-07-01').holdings[0]).toMatchObject({ owner: 'Ruth' });
    expect(reportDetail(db, report.id)).toMatchObject({ owner: 'Ruth Katz' });
    // an integration with the same source id can't override a report's own owner
    expect(summary(db, '2026-07-01', new Map([['report', 'Someone']])).holdings[0]).toMatchObject({ owner: 'Ruth' });
  });
});
