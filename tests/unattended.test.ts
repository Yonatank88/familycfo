import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { integrations } from '../src/analytics/integrations.js';
import { hapoalimLoginState, watchHapoalimOtp, type HapoalimSnapshot } from '../src/scrapers/hapoalim.js';
import { recordSourceRun } from '../src/db/ingestRepo.js';
import { testDb } from './helpers.js';

const raw = mkdtempSync(join(tmpdir(), 'familycfo-raw-'));
process.env.RAW_DIR = raw;
const { scrapeAll, isUnattended, lockoutGuard, NEEDS_CODE, NEEDS_ATTENTION } = await import('../src/scraper.js');

describe('unattended detection', () => {
  it('no OTP hook and no TTY, or UNATTENDED=1; an OTP hook is always attended', () => {
    expect(isUnattended(false, false, {})).toBe(true); // launchd: stdin is /dev/null
    expect(isUnattended(false, true, {})).toBe(false); // CLI in a terminal
    expect(isUnattended(false, true, { UNATTENDED: '1' })).toBe(true);
    expect(isUnattended(true, false, { UNATTENDED: '1' })).toBe(false); // dashboard Refresh
  });
});

describe('Isracard lockout guard', () => {
  const isracard = { accounts: [{ companyId: 'isracard', credentials: { id: 'i', card6Digits: 'c', password: 'p' } }] } as never;
  const at = (n: number) => `2026-10-0${n}T07:00:00.000Z`;

  it('after a BLOCKED / INVALID_PASSWORD run an unattended run skips it as NEEDS_ATTENTION until a success', async () => {
    const db = testDb();
    recordSourceRun(db, { source: 'isracard', startedAt: at(1), ok: true });
    expect(lockoutGuard(db, 'isracard')).toBeNull();
    recordSourceRun(db, { source: 'isracard', startedAt: at(2), ok: false, error: 'BLOCKED: performLogonI answered with a non-JSON page' });
    expect(lockoutGuard(db, 'isracard')).toMatch(/^BLOCKED/);

    let calls = 0;
    const runCompany = async () => { calls++; return { success: true as const, accounts: [] }; };
    const skipped = await scrapeAll(isracard, db, { unattended: true, runCompany });
    expect(calls).toBe(0);
    expect(skipped.map(r => [r.success, r.errorType])).toEqual([[false, NEEDS_ATTENTION]]);
    // still guarded: the skip itself, an interruption or another failure don't clear it
    recordSourceRun(db, { source: 'isracard', startedAt: at(4), ok: false, error: 'interrupted (SIGTERM)' });
    await scrapeAll(isracard, db, { unattended: true, runCompany });
    expect(calls).toBe(0);
    const list = integrations(db, [{ id: 'isracard', kind: 'card', configured: true }]);
    expect(list.sources[0].status).toBe('needs_attention');

    // an interactive run tries it once; its success clears the guard
    await scrapeAll(isracard, db, { unattended: false, runCompany });
    expect(calls).toBe(1);
    expect(lockoutGuard(db, 'isracard')).toBeNull();
    await scrapeAll(isracard, db, { unattended: true, runCompany });
    expect(calls).toBe(2);
  });

  it('guards each Cal login by its own source id', async () => {
    const db = testDb();
    const cal = { accounts: [
      { id: 'visaCal', companyId: 'visaCal', credentials: { username: 'u', password: 'p' } },
      { id: 'visaCal-hagar', companyId: 'visaCal', credentials: { username: 'u', password: 'p' } },
    ] } as never;
    recordSourceRun(db, { source: 'visaCal-hagar', startedAt: at(1), ok: false, error: 'INVALID_PASSWORD: שם המשתמש או הסיסמה שהוזנו שגויים' });
    const ran: string[] = [];
    const runCompany = async (account: { id?: string }) => { ran.push(account.id!); return { success: true as const, accounts: [] }; };
    const results = await scrapeAll(cal, db, { unattended: true, runCompany: runCompany as never });
    expect(ran).toEqual(['visaCal']);
    expect(results.map(r => [r.company, r.errorType ?? 'ok'])).toEqual([['visaCal', 'ok'], ['visaCal-hagar', NEEDS_ATTENTION]]);
  });

  it('INVALID_PASSWORD guards too; other failures and other sources do not', async () => {
    const db = testDb();
    recordSourceRun(db, { source: 'isracard', startedAt: at(1), ok: false, error: 'GENERIC: timeout' });
    expect(lockoutGuard(db, 'isracard')).toBeNull();
    recordSourceRun(db, { source: 'amex', startedAt: at(1), ok: false, error: 'INVALID_PASSWORD: performLogonI status 2' });
    expect(lockoutGuard(db, 'amex')).toMatch(/^INVALID_PASSWORD/);
    recordSourceRun(db, { source: 'hapoalim', startedAt: at(1), ok: false, error: 'BLOCKED: x' });
    let calls = 0;
    await scrapeAll({ accounts: [{ companyId: 'hapoalim', credentials: { userCode: 'u', password: 'p' } }] } as never, db,
      { unattended: true, runCompany: async () => { calls++; return { success: true, accounts: [] }; } });
    expect(calls).toBe(1);
  });
});

const page = (s: Partial<HapoalimSnapshot>): HapoalimSnapshot =>
  ({ url: 'https://login.bankhapoalim.co.il/ng-portals/auth/he/', otpElement: false, submitted: false, text: 'כניסה לחשבונך קוד משתמש סיסמה', ...s });

describe('Hapoalim SMS step', () => {
  it('reads the page state', () => {
    expect(hapoalimLoginState(page({}))).toBe('login'); // "קוד משתמש" is the user code, not an OTP
    expect(hapoalimLoginState(page({ submitted: true }))).toBe('waiting');
    expect(hapoalimLoginState(page({ submitted: true, otpElement: true }))).toBe('otp');
    expect(hapoalimLoginState(page({ submitted: true, text: 'הזן את הקוד שנשלח אליך ב-SMS' }))).toBe('otp');
    expect(hapoalimLoginState(page({ submitted: true, text: 'קוד משתמש או סיסמה שגויים' }))).toBe('error');
    expect(hapoalimLoginState(page({ url: 'https://login.bankhapoalim.co.il/ng-portals/rb/he/homepage' }))).toBe('done');
  });

  const run = (pages: HapoalimSnapshot[], unattended: boolean) => {
    let i = 0;
    let t = 0;
    const asked: string[] = [];
    const result = watchHapoalimOtp(async () => pages[Math.min(i++, pages.length - 1)], async () => { asked.push('otp'); return ''; },
      async () => {}, { unattended, graceMs: 15_000, intervalMs: 0, maxMs: 200_000, now: () => (t += 1000) });
    return result.then(r => ({ result: r, asked: asked.length, seconds: t / 1000 }));
  };

  it('unattended: a code box stops it at once', async () => {
    expect(await run([page({}), page({ submitted: true }), page({ submitted: true, otpElement: true })], true))
      .toMatchObject({ result: 'otp', asked: 1 });
  });

  it('unattended: no code box found, still on the auth page 15 s after the submit → taken as the SMS step', async () => {
    const r = await run([page({}), page({ submitted: true })], true);
    expect(r).toMatchObject({ result: 'assumed-otp', asked: 1 });
    expect(r.seconds).toBeLessThan(25);
  });

  it('attended: keeps waiting for the code step itself; a refusal or a login without a code asks nothing', async () => {
    expect(await run([page({ submitted: true }), page({ submitted: true }), page({ submitted: true, otpElement: true })], false))
      .toMatchObject({ result: 'otp', asked: 1 });
    expect(await run([page({ submitted: true, text: 'סיסמה שגויה' })], true)).toMatchObject({ result: 'error', asked: 0 });
    expect(await run([page({ submitted: true }), page({ url: 'https://login.bankhapoalim.co.il/ng-portals/rb/he/homepage' })], true))
      .toMatchObject({ result: 'done', asked: 0 });
  });

  it('unattended scrape: the watcher maps to NEEDS_CODE and the source stops', async () => {
    const db = testDb();
    let aborted = false;
    const results = await scrapeAll({ accounts: [{ companyId: 'hapoalim', credentials: { userCode: 'u', password: 'p' } }] } as never, db, {
      unattended: true,
      runCompany: async (_account, _start, otp) => {
        otp.onAbort(async () => { aborted = true; });
        let t = 0;
        await watchHapoalimOtp(async () => page({ submitted: true }), otp.request, async () => {},
          { unattended: true, intervalMs: 0, now: () => (t += 1000) });
        // the library then fails on its closed browser
        return { success: false, errorType: 'TIMEOUT', errorMessage: 'waiting for redirect' };
      },
    });
    expect(aborted).toBe(true);
    expect(results[0]).toMatchObject({ success: false, errorType: NEEDS_CODE });
  });
});

process.on('exit', () => rmSync(raw, { recursive: true, force: true }));
