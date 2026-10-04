import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { integrationStatus, integrations } from '../src/analytics/integrations.js';
import { testDb } from './helpers.js';

// archived payloads of the fake runs go to a temp dir, never data/raw
const raw = mkdtempSync(join(tmpdir(), 'familycfo-raw-'));
process.env.RAW_DIR = raw;
const { scrapeAll, otpControl, NEEDS_CODE } = await import('../src/scraper.js');

describe('NEEDS_CODE', () => {
  it('unattended, a source that asks for an SMS code stops at once; the others keep running', async () => {
    const db = testDb();
    let aborted = false;
    const started = Date.now();
    const results = await scrapeAll({ accounts: [
      { companyId: 'hapoalim', credentials: {} },
      { companyId: 'oneZero', credentials: {} },
    ] } as never, db, {
      unattended: true,
      runCompany: async (account, _start, otp) => {
        if (account.companyId !== 'hapoalim') return { success: true, accounts: [] };
        otp.onAbort(async () => { aborted = true; });
        const code = await otp.request();
        // the library would now fail on its own (browser closed / bad code)
        return { success: false, errorType: 'GENERIC', errorMessage: code ? 'unexpected' : 'browser closed' };
      },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(results.map(r => [r.company, r.success, r.errorType ?? null])).toEqual([['hapoalim', false, NEEDS_CODE], ['oneZero', true, null]]);
    const runs = db.prepare(`SELECT source, ok, error FROM source_runs ORDER BY id`).all() as { source: string; ok: number; error: string | null }[];
    expect(runs.map(r => [r.source, r.ok])).toEqual([['hapoalim', 0], ['oneZero', 1]]);
    expect(runs[0].error).toMatch(/^NEEDS_CODE/);
    // the Integrations page shows it as Needs code
    const list = integrations(db, [{ id: 'hapoalim', kind: 'bank', configured: true }, { id: 'oneZero', kind: 'bank', configured: true }]);
    expect(list.sources.map(s => [s.id, s.status])).toEqual([['hapoalim', 'needs_code'], ['oneZero', 'ok']]);
  });

  it('with an OTP hook (the dashboard Refresh) the code is asked for and passed on', async () => {
    const otp = otpControl(async () => '12345');
    expect(await otp.request()).toBe('12345');
    expect(otp.needsCode()).toBe(false);
  });

  it('a failed run that is not about the code stays Failed', () => {
    const now = Date.parse('2026-05-02T12:00:00Z');
    expect(integrationStatus({ configured: true, lastRunOk: false, lastSuccessAt: null, lastError: 'NEEDS_CODE: the bank asked for an SMS code' }, now)).toBe('needs_code');
    expect(integrationStatus({ configured: true, lastRunOk: false, lastSuccessAt: null, lastError: 'GENERIC: timeout' }, now)).toBe('failed');
  });
});

process.on('exit', () => rmSync(raw, { recursive: true, force: true }));
