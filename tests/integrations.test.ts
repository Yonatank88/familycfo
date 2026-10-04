import { describe, expect, it } from 'vitest';
import { configuredSources, integrationStatus, integrations } from '../src/analytics/integrations.js';
import { beginSourceRun, recordInterruptedRuns, recordSourceRun } from '../src/db/ingestRepo.js';
import type { Config } from '../src/scraper.js';
import { addAccount, addHolding, testDb } from './helpers.js';

const NOW = Date.parse('2026-05-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe('integration status', () => {
  it('is Not configured when credentials are missing and it never succeeded', () => {
    expect(integrationStatus({ configured: false, lastRunOk: null, lastSuccessAt: null }, NOW)).toBe('not_configured');
    expect(integrationStatus({ configured: false, lastRunOk: false, lastSuccessAt: null }, NOW)).toBe('not_configured');
  });
  it('treats empty credentials with successful runs (a login typed in the browser) as configured', () => {
    expect(integrationStatus({ configured: false, lastRunOk: true, lastSuccessAt: hoursAgo(1) }, NOW)).toBe('ok');
    expect(integrationStatus({ configured: false, lastRunOk: false, lastSuccessAt: hoursAgo(5) }, NOW)).toBe('failed');
  });
  it('is Failed when the latest run failed', () => {
    expect(integrationStatus({ configured: true, lastRunOk: false, lastSuccessAt: hoursAgo(2) }, NOW)).toBe('failed');
  });
  it('is Stale with no success in 36 h, or none ever', () => {
    expect(integrationStatus({ configured: true, lastRunOk: true, lastSuccessAt: hoursAgo(37) }, NOW)).toBe('stale');
    expect(integrationStatus({ configured: true, lastRunOk: null, lastSuccessAt: null }, NOW)).toBe('stale');
  });
  it('is OK after a recent success', () => {
    expect(integrationStatus({ configured: true, lastRunOk: true, lastSuccessAt: hoursAgo(35) }, NOW)).toBe('ok');
  });
});

describe('configured sources', () => {
  it('tells only whether credentials are filled (empty and placeholder values are not)', () => {
    const config = {
      accounts: [
        { companyId: 'oneZero', credentials: { email: 'a@b.c', password: 'secret-pw' } },
        { companyId: 'hapoalim', credentials: { userCode: '', password: '' } },
        { companyId: 'max', credentials: { username: 'YOUR_USERNAME', password: 'YOUR_PASSWORD' } },
      ],
      investments: [
        { type: 'ibkr', token: 'tok', queryId: '1' },
        { type: 'exchange', exchange: 'kraken', apiKey: 'k', secret: '' },
        { type: 'wallets', apiKey: 'k', wallets: [{ address: '0xabc' }] },
      ],
    } as unknown as Config;
    const sources = configuredSources(config);
    expect(sources).toEqual([
      { id: 'oneZero', kind: 'bank', configured: true },
      { id: 'hapoalim', kind: 'bank', configured: false },
      { id: 'max', kind: 'card', configured: false },
      { id: 'ibkr', kind: 'investment', configured: true },
      { id: 'kraken', kind: 'investment', configured: false },
      { id: 'wallets', kind: 'investment', configured: true },
    ]);
    expect(JSON.stringify(sources)).not.toContain('secret-pw');
    expect(configuredSources(null)).toEqual([]);
  });
});

describe('/api/integrations', () => {
  it('reports each source from source_runs: status, last success / attempt, error, recent runs and what it brings', () => {
    const db = testDb();
    addAccount(db, 'oneZero:1', 'bank');
    addHolding(db, { source: 'ibkr:U1', symbol: 'VOO', quantity: 1, currency: 'ILS', assetClass: 'stock', price: 100 });
    addHolding(db, { source: 'ibkr:U1', symbol: 'QQQ', quantity: 1, currency: 'ILS', assetClass: 'stock', price: 100 });
    recordSourceRun(db, { source: 'oneZero', startedAt: hoursAgo(3), ok: true });
    recordSourceRun(db, { source: 'ibkr', startedAt: hoursAgo(5), ok: true });
    recordSourceRun(db, { source: 'ibkr', startedAt: hoursAgo(2), ok: false, error: 'HTTP 500' });
    recordSourceRun(db, { source: 'kraken', startedAt: hoursAgo(40), ok: true });
    for (let i = 12; i > 0; i--) recordSourceRun(db, { source: 'hapoalim', startedAt: hoursAgo(i), ok: false, error: 'TIMEOUT' });

    const r = integrations(db, [
      { id: 'oneZero', kind: 'bank', configured: true },
      { id: 'hapoalim', kind: 'bank', configured: false },
      { id: 'ibkr', kind: 'investment', configured: true },
      { id: 'kraken', kind: 'investment', configured: true },
      { id: 'binance', kind: 'investment', configured: true },
    ], NOW);
    const by = Object.fromEntries(r.sources.map(s => [s.id, s]));
    expect(by.oneZero).toMatchObject({ status: 'ok', lastSuccessAt: hoursAgo(3), lastAttemptAt: hoursAgo(3), lastError: null, accounts: 1 });
    expect(by.hapoalim).toMatchObject({ status: 'not_configured', lastSuccessAt: null, lastError: 'TIMEOUT' });
    expect(by.hapoalim.runs).toHaveLength(10);
    expect(by.hapoalim.runs.at(-1)!.at).toBe(hoursAgo(1)); // oldest → newest
    expect(by.ibkr).toMatchObject({ status: 'failed', lastSuccessAt: hoursAgo(5), lastAttemptAt: hoursAgo(2), lastError: 'HTTP 500', accounts: 1, holdings: 2 });
    expect(by.ibkr.runs.map(x => x.ok)).toEqual([true, false]);
    expect(by.kraken.status).toBe('stale');
    expect(by.binance).toMatchObject({ status: 'stale', lastAttemptAt: null, runs: [] });
    expect(r.reports).toMatchObject({ imported: 0, needsReview: [], products: 0 });
  });

  it('records a run cut short as failed', () => {
    const db = testDb();
    beginSourceRun(db, 'oneZero', hoursAgo(1));
    beginSourceRun(db, 'ibkr', hoursAgo(1));
    recordSourceRun(db, { source: 'ibkr', startedAt: hoursAgo(1), ok: true });
    recordInterruptedRuns('interrupted (SIGTERM)');
    recordInterruptedRuns('again'); // nothing left in flight
    expect(db.prepare(`SELECT source, ok, error FROM source_runs ORDER BY id`).all()).toEqual([
      { source: 'ibkr', ok: 1, error: null },
      { source: 'oneZero', ok: 0, error: 'interrupted (SIGTERM)' },
    ]);
  });
});
