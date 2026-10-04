import type { DB } from '../db/connection.js';
import { NOT_CONFIGURED, scrapeAll, type Config, type ScrapeProgress } from '../scraper.js';
import { runPipeline } from '../pipeline.js';
import { investmentSourceId, syncInvestments } from '../sync/index.js';
// reads the bank credentials file; the credentials go only to the scraper and are never returned by the API
import { entryLabels, loadConfig, matchesOnly, sourceIdOf } from '../config.js';
import { sourceLabel } from '../analytics/summary.js';

/**
 * One scrape at a time, started from the UI: all banks, then the pipeline. The bank's OTP screen
 * becomes a pending request that the UI answers (POST /api/scrape/otp). State lives in memory —
 * a server restart (tsx watch) ends a running scrape.
 */
export interface ScrapeCompanyState {
  /** the source id */
  company: string;
  /** its name ("Cal · Hagar") */
  label: string;
  /** skipped: not configured (a credential empty, never succeeded) — no login was tried */
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  newTransactions: number;
  error: string | null;
}
export interface ScrapeJobState {
  status: 'idle' | 'running' | 'pipeline' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  companies: ScrapeCompanyState[];
  /** the bank is waiting for an OTP code */
  otp: { company: string; label: string; requestedAt: string } | null;
  newTransactions: number;
  error: string | null;
  /** a "Test connection" run of one integration: saved = whether its settings were written (only when it succeeded) */
  test: { key: string; saved: boolean | null } | null;
}

const idle = (): ScrapeJobState => ({ status: 'idle', startedAt: null, finishedAt: null, companies: [], otp: null, newTransactions: 0, error: null, test: null });
let state: ScrapeJobState = idle();
let answerOtp: ((code: string) => void) | null = null;

export const scrapeState = (): ScrapeJobState => state;
export const scrapeRunning = () => state.status === 'running' || state.status === 'pipeline';

const clearOtp = () => {
  answerOtp?.('');
  answerOtp = null;
  state.otp = null;
};

const setCompany = (company: string, patch: Partial<ScrapeCompanyState>) => {
  state.companies = state.companies.map(c => (c.company === company ? { ...c, ...patch } : c));
};

/**
 * `test`: run only that config (one integration, from the Integrations page) and call `onSuccess` when it succeeded —
 * which saves its settings; a failed test saves nothing.
 */
export function startScrape(db: DB, test?: { key: string; config: Config; onSuccess: () => void }): ScrapeJobState {
  if (scrapeRunning()) throw Object.assign(new Error('a scrape is already running'), { statusCode: 409 });
  let config: Config;
  try {
    config = test?.config ?? loadConfig();
  } catch {
    throw Object.assign(new Error('the scraper configuration is missing or invalid (see accounts.example.json)'), { statusCode: 400 });
  }
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  const labels = entryLabels(config.accounts);
  state = {
    ...idle(), status: 'running', startedAt: new Date().toISOString(), test: test ? { key: test.key, saved: null } : null,
    companies: [
      ...(config.accounts ?? []).filter(a => !a.disabled && matchesOnly(only, a)).map(sourceIdOf),
      ...(config.investments ?? []).filter(s => !s.disabled).map(investmentSourceId).filter(id => !only || only.includes(id)),
    ].map(company => ({ company, label: labels.get(company) ?? sourceLabel(company), status: 'pending', newTransactions: 0, error: null })),
  };

  const onProgress = (event: ScrapeProgress) => {
    if (event.type === 'start') setCompany(event.company, { status: 'running' });
    else {
      // a bank that ended (e.g. timed out) no longer needs its code
      if (state.otp?.company === event.company) clearOtp();
      setCompany(event.company, event.success
        ? { status: 'done', newTransactions: event.newTransactions }
        : { status: event.errorType === NOT_CONFIGURED ? 'skipped' : 'failed', error: event.errorMessage || event.errorType || 'error' });
    }
  };

  (async () => {
    const results = await scrapeAll(config, db, {
      requestOtp: (company, label) => new Promise<string>(resolve => {
        answerOtp = resolve;
        state.otp = { company, label, requestedAt: new Date().toISOString() };
      }),
      onProgress,
    });
    // brokers, wallets and exchanges → holdings (before the pipeline refreshes their quotes)
    results.push(...await syncInvestments(config.investments, db, { onProgress }));
    state.status = 'pipeline';
    const newIds = results.flatMap(r => r.newTransactionIds);
    state.newTransactions = newIds.length;
    await runPipeline(db, { sources: results.map(r => ({ source: r.company, kind: r.kind, success: r.success })) });
    state.status = results.some(r => r.success) ? 'done' : 'failed';
    if (state.status === 'failed') state.error = test ? state.companies[0]?.error ?? 'the connection failed' : 'no bank was scraped';
    if (test && state.test) {
      const ok = results.length > 0 && results.every(r => r.success);
      if (ok) test.onSuccess();
      state.test.saved = ok;
    }
  })().catch(err => {
    console.error('Scrape job failed:', err);
    state.status = 'failed';
    state.error = err instanceof Error ? err.message : String(err);
  }).finally(() => {
    clearOtp();
    state.finishedAt = new Date().toISOString();
  });

  return state;
}

/** The code the user typed for the bank's OTP screen. */
export function submitOtp(code: string): void {
  if (!answerOtp) throw Object.assign(new Error('no bank is waiting for a code'), { statusCode: 409 });
  if (!/^\d{4,8}$/.test(code)) throw Object.assign(new Error('the code must be 4–8 digits'), { statusCode: 400 });
  const resolve = answerOtp;
  answerOtp = null;
  state.otp = null;
  resolve(code);
}
