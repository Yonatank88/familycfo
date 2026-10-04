import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ScrapedAccount } from '../src/ingest/normalize.js';

// archived payloads of the fake runs go to a temp dir, never data/raw
const raw = mkdtempSync(join(tmpdir(), 'familycfo-raw-'));
process.env.RAW_DIR = raw;
afterAll(() => rmSync(raw, { recursive: true, force: true }));
afterEach(() => { delete process.env.SCRAPE_ONLY; });
// everything that may load src/ingest/archive.ts (RAW_DIR is read at load) is imported after RAW_DIR is set
const { scrapeAll, NOT_CONFIGURED } = await import('../src/scraper.js');
const { configuredSources, integrations } = await import('../src/analytics/integrations.js');
const { configOwners } = await import('../src/analytics/owners.js');
const { summary } = await import('../src/analytics/summary.js');
const { writeSnapshots } = await import('../src/analytics/snapshots.js');
const { recordSourceRun } = await import('../src/db/ingestRepo.js');
const { applyDraft, listIntegrations, removeEntry } = await import('../src/integrations/manage.js');
const { deleteSourceData } = await import('../src/integrations/data.js');
const { sourceIdOf } = await import('../src/config.js');
const { testDb } = await import('./helpers.js');

const DATE = '2026-05-01';
/** one card with a charge billed after DATE (cards owed) */
const card = (number: string, amount: number): ScrapedAccount => ({
  accountNumber: number,
  txns: [{ type: 'normal', date: '2026-04-20T00:00:00.000Z', processedDate: '2026-05-10T00:00:00.000Z', originalAmount: -amount,
    originalCurrency: 'ILS', chargedAmount: -amount, description: `Shop ${number}`, status: 'completed' }],
} as unknown as ScrapedAccount);

const cal = (hagarCredentials: Record<string, string> = { username: 'h', password: 'p' }) => ({
  accounts: [
    { id: 'visaCal', companyId: 'visaCal', owner: 'Yonatan K', credentials: { username: 'y', password: 'p' } },
    { id: 'visaCal-hagar', companyId: 'visaCal', owner: 'Hagar', credentials: hagarCredentials },
  ],
}) as never;

const fake = (seen: string[]) => async (account: { id?: string; companyId: string }) => {
  seen.push(sourceIdOf(account));
  return { success: true as const, accounts: [sourceIdOf(account) === 'visaCal' ? card('1111', 100) : card('2222', 40)] };
};

describe('two logins of one company', () => {
  it('get separate source ids, runs, accounts, snapshots, owners and raw archives', async () => {
    const db = testDb();
    const seen: string[] = [];
    const results = await scrapeAll(cal(), db, { unattended: false, runCompany: fake(seen) });
    expect(results.map(r => [r.company, r.success])).toEqual([['visaCal', true], ['visaCal-hagar', true]]);
    expect(db.prepare(`SELECT source FROM source_runs ORDER BY id`).pluck().all()).toEqual(['visaCal', 'visaCal-hagar']);
    // accounts stay <company>:<number>; the second login's carry its source id, the default one none
    expect(db.prepare(`SELECT id, company, source FROM accounts ORDER BY id`).all()).toEqual([
      { id: 'visaCal:1111', company: 'visaCal', source: null },
      { id: 'visaCal:2222', company: 'visaCal', source: 'visaCal-hagar' },
    ]);
    expect(existsSync(join(raw, 'visaCal'))).toBe(true);
    expect(existsSync(join(raw, 'visaCal-hagar'))).toBe(true);

    writeSnapshots(db, results.map(r => ({ source: r.company, kind: r.kind, success: r.success })), DATE);
    const s = summary(db, DATE, configOwners(cal()));
    const owed = s.accounts.filter(a => a.kind === 'card').map(a => [a.source, a.valueIls, a.owner]);
    expect(owed).toEqual([['visaCal', -100, 'Yonatan'], ['visaCal-hagar', -40, 'Hagar']]);

    const list = integrations(db, configuredSources(cal()), Date.parse('2026-05-01T12:00:00Z'));
    expect(list.sources.map(x => [x.key, x.label, x.owner, x.accounts])).toEqual([
      ['accounts:visaCal', 'Cal · Yonatan', 'Yonatan', 1], ['accounts:visaCal-hagar', 'Cal · Hagar', 'Hagar', 1],
    ]);

    // removing one login with its data leaves the other's
    deleteSourceData(db, 'visaCal-hagar', 'accounts');
    expect(db.prepare(`SELECT id FROM accounts`).pluck().all()).toEqual(['visaCal:1111']);
    expect(db.prepare(`SELECT source FROM source_runs`).pluck().all()).toEqual(['visaCal']);
  });

  it('SCRAPE_ONLY matches a source id (that login) or a companyId (every login of it)', async () => {
    const seen: string[] = [];
    process.env.SCRAPE_ONLY = 'visaCal-hagar';
    await scrapeAll(cal(), testDb(), { unattended: false, runCompany: fake(seen) });
    expect(seen).toEqual(['visaCal-hagar']);
    seen.length = 0;
    process.env.SCRAPE_ONLY = 'visaCal';
    await scrapeAll(cal(), testDb(), { unattended: false, runCompany: fake(seen) });
    expect(seen).toEqual(['visaCal', 'visaCal-hagar']);
  });

  it('an entry with an empty credential is skipped as Not configured — no login, no run recorded — until it once succeeded', async () => {
    const db = testDb();
    const seen: string[] = [];
    const results = await scrapeAll(cal({ username: '', password: '' }), db, { unattended: true, runCompany: fake(seen) });
    expect(seen).toEqual(['visaCal']);
    expect(results.map(r => [r.company, r.success, r.errorType ?? null])).toEqual([['visaCal', true, null], ['visaCal-hagar', false, NOT_CONFIGURED]]);
    expect(db.prepare(`SELECT source FROM source_runs`).pluck().all()).toEqual(['visaCal']);
    const status = integrations(db, configuredSources(cal({ username: '', password: '' }))).sources.map(x => [x.id, x.status]);
    expect(status).toContainEqual(['visaCal-hagar', 'not_configured']);
    // a bank logged into by hand (empty credentials) runs once it has succeeded
    recordSourceRun(db, { source: 'visaCal-hagar', startedAt: '2026-05-01T00:00:00Z', ok: true });
    seen.length = 0;
    await scrapeAll(cal({ username: '', password: '' }), db, { unattended: true, runCompany: fake(seen) });
    expect(seen).toEqual(['visaCal', 'visaCal-hagar']);
  });

  it('an entry without an id keeps its companyId as the source id (old history keys)', async () => {
    const db = testDb();
    recordSourceRun(db, { source: 'visaCal', startedAt: '2026-04-01T00:00:00Z', ok: true });
    const config = { accounts: [{ companyId: 'visaCal', credentials: { username: 'y', password: 'p' } }] } as never;
    const seen: string[] = [];
    await scrapeAll(config, db, { unattended: false, runCompany: fake(seen) });
    expect(seen).toEqual(['visaCal']);
    expect(db.prepare(`SELECT source FROM source_runs ORDER BY id`).pluck().all()).toEqual(['visaCal', 'visaCal']);
    expect(db.prepare(`SELECT source FROM accounts`).pluck().get()).toBeNull();
    expect(listIntegrations(config).map(x => [x.key, x.label])).toEqual([['accounts:visaCal', 'Cal']]);
    expect(integrations(db, configuredSources(config)).sources[0]).toMatchObject({ key: 'accounts:visaCal', label: 'Cal', runs: [{ ok: true }, { ok: true }] });
  });
});

describe('integrations editor with two logins', () => {
  it('adds another login of a company as <companyId>-<owner or n>, edits and removes by its id', () => {
    const one = applyDraft({ accounts: [], investments: [] }, { type: 'bank', companyId: 'visaCal', fields: { username: 'u1', password: 'p1' }, owner: 'Yonatan' });
    expect(one.key).toBe('accounts:visaCal');
    expect(one.config.accounts[0]).not.toHaveProperty('id');
    const two = applyDraft(one.config, { type: 'bank', companyId: 'visaCal', fields: { username: 'u2', password: 'p2' }, owner: 'Hagar Levi' });
    expect(two.key).toBe('accounts:visaCal-hagar');
    const three = applyDraft(two.config, { type: 'bank', companyId: 'visaCal', fields: { username: 'u3', password: 'p3' } });
    expect(three.key).toBe('accounts:visaCal-2');
    expect(listIntegrations(three.config).map(x => [x.key, x.label])).toEqual([
      ['accounts:visaCal', 'Cal · Yonatan'], ['accounts:visaCal-hagar', 'Cal · Hagar'], ['accounts:visaCal-2', 'Cal · visaCal-2'],
    ]);
    // an edit keeps the id and touches only that entry
    const edited = applyDraft(three.config, { type: 'bank', companyId: 'visaCal', fields: { password: 'new' }, owner: 'Hagar' }, 'accounts:visaCal-hagar');
    expect(edited.key).toBe('accounts:visaCal-hagar');
    expect(edited.config.accounts[1]).toMatchObject({ id: 'visaCal-hagar', owner: 'Hagar', credentials: { username: 'u2', password: 'new' } });
    expect(edited.config.accounts[0].credentials).toEqual({ username: 'u1', password: 'p1' });
    const removed = removeEntry(edited.config, 'accounts:visaCal-hagar');
    expect(removed.source).toBe('visaCal-hagar');
    expect(removed.config.accounts.map(sourceIdOf)).toEqual(['visaCal', 'visaCal-2']);
  });
});
