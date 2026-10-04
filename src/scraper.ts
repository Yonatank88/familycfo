import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { getDb, type DB } from './db/connection.js';
import { saveScrapedAccount, recordSourceRun, beginSourceRun, NEEDS_CODE, NEEDS_ATTENTION, NOT_CONFIGURED } from './db/ingestRepo.js';
import { credentialsFilled, entryLabels, matchesOnly, sourceIdOf } from './config.js';
import { archiveRaw } from './ingest/archive.js';
import type { InvestmentSource } from './sync/index.js';
import * as readline from 'readline';
import type { Page } from 'puppeteer';
import type { ScrapedAccount } from './ingest/normalize.js';
import puppeteer from 'puppeteer';
import { BROWSER_ARGS, describePage, findChromePath, maskAutomation, profileDir } from './scrapers/browser.js';
import { scrapeIsracardGroup, type IsracardGroupCredentials } from './scrapers/isracardGroup.js';
import { scrapeCal, type CalCredentials } from './scrapers/cal.js';
import { markSubmit, startHapoalimWatcher } from './scrapers/hapoalim.js';

interface AccountConfig {
  /** the source id, when it isn't the companyId — a second login of one company (e.g. visaCal-hagar). Default: companyId */
  id?: string;
  companyId: keyof typeof CompanyTypes;
  credentials: Record<string, string>;
  /** kept in the file, skipped by every run */
  disabled?: boolean;
  /** whose it is (display only — not a secret); its accounts inherit it */
  owner?: string;
}

export interface Config {
  accounts: AccountConfig[];
  /** brokers, wallets and exchanges synced into holdings (src/sync/) */
  investments?: InvestmentSource[];
}

/** Lets a caller (the API's scrape job) run the scrape: answer the OTP and follow progress. */
export interface ScrapeHooks {
  /** asked when the bank shows its OTP screen (the source id, and its name — "Cal · Hagar"); defaults to the terminal. '' gives up */
  requestOtp?: (company: string, label: string) => Promise<string>;
  onProgress?: (event: ScrapeProgress) => void;
  /** no one can answer an OTP (scheduled / no TTY): a source that asks for one stops at once as NEEDS_CODE, and a card
   * company whose last login was refused is skipped as NEEDS_ATTENTION. Default: `isUnattended` */
  unattended?: boolean;
  /** replaces the per-company scrape (tests) */
  runCompany?: (account: AccountConfig, startDate: Date, otp: OtpControl) => Promise<CompanyResult>;
}

/** What a scrape of one company returns: the library's result shape. */
type CompanyResult = { success: true; accounts?: ScrapedAccount[] } | { success: false; errorType?: string; errorMessage?: string };

/** A source's OTP channel: `request` asks for the code; `onAbort` registers how to stop the source at once. */
export interface OtpControl {
  request: () => Promise<string>;
  onAbort: (abort: () => Promise<unknown>) => void;
}

export { NEEDS_CODE, NEEDS_ATTENTION, NOT_CONFIGURED };

/** Unattended = no OTP hook, and stdin isn't a terminal (launchd, cron) or UNATTENDED=1 (the launchd plist sets it). */
export function isUnattended(hasOtpHook: boolean, stdinIsTTY = !!process.stdin.isTTY, env: NodeJS.ProcessEnv = process.env): boolean {
  return !hasOtpHook && (!stdinIsTTY || env.UNATTENDED === '1');
}

/** Login refusals after which another try may count toward a card company's lockout. */
const LOCKOUT_ERRORS = ['BLOCKED', 'INVALID_PASSWORD', 'ACCOUNT_BLOCKED'];

/**
 * The refusal that keeps a card company out of unattended runs: a BLOCKED / INVALID_PASSWORD / ACCOUNT_BLOCKED run since
 * its last success. Only a successful run (interactive — unattended ones skip it) clears it.
 */
export function lockoutGuard(db: DB, source: string): string | null {
  const row = db.prepare(`SELECT error FROM source_runs WHERE source = ? AND ok = 0
      AND id > COALESCE((SELECT MAX(id) FROM source_runs WHERE source = ? AND ok = 1), 0)
      AND (${LOCKOUT_ERRORS.map(() => `error LIKE ? || '%'`).join(' OR ')})
    ORDER BY id DESC LIMIT 1`).get(source, source, ...LOCKOUT_ERRORS) as { error: string } | undefined;
  return row?.error ?? null;
}

/**
 * The OTP channel of one source. Unattended, a request for a code marks the source as needing one, stops it (closing
 * its browser) and answers '' — so it fails in seconds instead of waiting out the bank's timeout.
 */
export function otpControl(ask: (() => Promise<string>) | null): OtpControl & { needsCode: () => boolean } {
  let needed = false;
  let abort: (() => Promise<unknown>) | null = null;
  return {
    request: ask ?? (async () => {
      needed = true;
      await abort?.().catch(() => {});
      return '';
    }),
    onAbort: fn => { abort = fn; },
    needsCode: () => needed,
  };
}
/** `company` = the source id (an entry's `id`, else its companyId) */
export type ScrapeProgress =
  | { type: 'start'; company: string }
  | { type: 'done'; company: string; success: boolean; newTransactions: number; errorType?: string; errorMessage?: string };

async function promptOtp(label: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`\n🔐 ${label}: enter OTP code (5 digits): `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const ISRACARD_GROUP = new Set(['isracard', 'amex']);
/** card companies on our own login-page scrapers (src/scrapers/): visible browser, lockout guard */
const OWN_LOGIN = new Set([...ISRACARD_GROUP, 'visaCal']);
/** always in a visible browser, even with SHOW_BROWSER=0: Isracard blocks headless Chrome at performLogonI, after the
 * password was already checked — so a headless try can count toward the lockout; Cal's login is treated the same */
const ALWAYS_HEADFUL = OWN_LOGIN;
const showBrowserFor = (company: string) => ALWAYS_HEADFUL.has(company) || process.env.SHOW_BROWSER !== '0';
/** run in their own Chrome profile under data/browser-profile/<source id> */
const PERSISTENT_PROFILE = new Set(['hapoalim']);
/** upcoming card charges and future installments */
const FUTURE_MONTHS = 2;

/** One company through israeli-bank-scrapers. */
async function libraryScrape(account: AccountConfig, startDate: Date, otp: OtpControl, unattended: boolean,
  onPageClose: (description: string) => void) {
  const requestOtp = otp.request;
  const showBrowser = showBrowserFor(account.companyId);
  // banks that ask for an SMS code on an unknown device get a persistent profile, so the bank may remember this one
  const browser = PERSISTENT_PROFILE.has(account.companyId)
    ? await puppeteer.launch({ headless: !showBrowser, executablePath: findChromePath(), args: BROWSER_ARGS, userDataDir: profileDir(sourceIdOf(account)) })
    : undefined;
  if (browser) otp.onAbort(() => browser.close());
  const scraper = createScraper({
    ...(browser ? { browser } : {}),
    // desktop layout headless too (the library's default is 1024x768)
    viewportSize: { width: 1920, height: 1080 },
    // patched hapoalim.js: how long to wait for the redirect after the login (the SMS step); unattended the watcher
    // stops it within ~20 s, this is the backstop
    ...({ loginRedirectTimeout: unattended ? 45_000 : 180_000 } as object),
    companyId: CompanyTypes[account.companyId],
    startDate,
    futureMonthsToScrape: FUTURE_MONTHS,
    // per-transaction detail requests (e.g. Isracard PirteyIska_204) get rate-limited (HTTP 429) as automation
    additionalTransactionInformation: false,
    includeRawTransaction: true,
    verbose: true,
    combineInstallments: false,
    showBrowser,
    timeout: 120000, // 2 minutes for OTP
    defaultTimeout: 120000, // 2 minutes for navigation
    navigationRetryCount: 1,
    executablePath: findChromePath(),
    args: BROWSER_ARGS,
    preparePage: async (page: Page) => {
      // The library closes the page before returning a failed result, so snapshot it on close
      const closePage = page.close.bind(page);
      page.close = async (...args: Parameters<Page['close']>) => {
        onPageClose(await describePage(page));
        return closePage(...args);
      };

      await maskAutomation(page);

      // Hapoalim's SMS step shares the login's URL: watch the page for it (src/scrapers/hapoalim.ts)
      if (account.companyId === 'hapoalim') {
        await markSubmit(page);
        startHapoalimWatcher(page, requestOtp, unattended).catch(() => {}); // fire and forget
      }
    },
  });

  // One Zero without a long-term token (npm run link -- onezero) asks for the SMS code on every scrape
  const credentials = account.companyId === 'oneZero' && !account.credentials.idToken && !account.credentials.otpLongTermToken
    ? { ...account.credentials, otpCodeRetriever: requestOtp }
    : account.credentials;
  return scraper.scrape(credentials as never);
}

export interface ScrapeSummary {
  /** the source id */
  company: string;
  /** a bank / card company, or an investment source (src/sync/) */
  kind: 'bank' | 'investment';
  success: boolean;
  newTransactionIds: number[];
  errorType?: string;
}

export async function scrapeAll(config: Config, db: DB = getDb(), hooks: ScrapeHooks = {}): Promise<ScrapeSummary[]> {
  // SCRAPE_FROM=2026-01-01 fetches from that date (backfill); otherwise the last 3 months
  const startDate = process.env.SCRAPE_FROM ? new Date(`${process.env.SCRAPE_FROM}T00:00:00`) : new Date();
  if (Number.isNaN(startDate.getTime())) throw new Error(`SCRAPE_FROM is not a date: ${process.env.SCRAPE_FROM}`);
  if (!process.env.SCRAPE_FROM) startDate.setMonth(startDate.getMonth() - 3);

  // SCRAPE_ONLY=visaCal,leumi limits the run to those companies (every login of each) or source ids (visaCal-hagar)
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  const summaries: ScrapeSummary[] = [];
  const labels = entryLabels(config.accounts);
  const everSucceeded = db.prepare(`SELECT 1 FROM source_runs WHERE source = ? AND ok = 1 LIMIT 1`).pluck();

  for (const account of config.accounts ?? []) {
    if (account.disabled || !matchesOnly(only, account)) continue;
    const source = sourceIdOf(account);
    const label = labels.get(source) ?? source;

    // a placeholder (a credential empty) is never tried; a bank logged into by hand with empty credentials (Hapoalim)
    // runs once it has succeeded — the same rule as the Integrations "Not configured" status
    if (!credentialsFilled(account.credentials) && !everSucceeded.get(source)) {
      console.log(`Skipping ${source}: not configured (a credential is empty)`);
      summaries.push({ company: source, kind: 'bank', success: false, newTransactionIds: [], errorType: NOT_CONFIGURED });
      hooks.onProgress?.({ type: 'done', company: source, success: false, newTransactions: 0, errorType: NOT_CONFIGURED, errorMessage: 'Not configured' });
      continue;
    }

    console.log(`Scraping ${source}...`);
    hooks.onProgress?.({ type: 'start', company: source });
    const startedAt = new Date().toISOString();
    const unattended = hooks.unattended ?? isUnattended(!!hooks.requestOtp);

    // Isracard / Amex / Cal: after a refused login, only a person (dashboard Refresh, CLI in a terminal) tries again
    const refusal = unattended && OWN_LOGIN.has(account.companyId) ? lockoutGuard(db, source) : null;
    if (refusal) {
      const errorMessage = `skipped unattended after "${refusal.slice(0, 120)}" — run it once from the dashboard Refresh`;
      console.error(`Skipping ${source}: ${NEEDS_ATTENTION} ${errorMessage}`);
      recordSourceRun(db, { source, startedAt, ok: false, error: `${NEEDS_ATTENTION}: ${errorMessage}` });
      summaries.push({ company: source, kind: 'bank', success: false, newTransactionIds: [], errorType: NEEDS_ATTENTION });
      hooks.onProgress?.({ type: 'done', company: source, success: false, newTransactions: 0, errorType: NEEDS_ATTENTION, errorMessage });
      continue;
    }

    beginSourceRun(db, source, startedAt);
    let pageStateAtClose: string | undefined;

    const otp = otpControl(hooks.requestOtp ? () => hooks.requestOtp!(source, label) : unattended ? null : () => promptOtp(label));
    try {
      const requestOtp = otp.request;
      const raw: CompanyResult = hooks.runCompany ? await hooks.runCompany(account, startDate, otp) : ISRACARD_GROUP.has(account.companyId)
        // our own scraper (src/scrapers/isracardGroup.ts): the library's login no longer works there
        ? await scrapeIsracardGroup({
          company: account.companyId as 'isracard' | 'amex',
          profile: source,
          credentials: account.credentials as unknown as IsracardGroupCredentials,
          startDate,
          futureMonths: FUTURE_MONTHS,
          showBrowser: showBrowserFor(account.companyId),
          requestOtp,
          // the login is submitted once; unattended, nobody finishes it by hand
          finishByHand: !unattended,
          onFailurePage: description => { pageStateAtClose = description; },
        }).then(r => (r.success ? { ...r, accounts: r.accounts as unknown as ScrapedAccount[] } : r))
        : account.companyId === 'visaCal'
        // our own scraper (src/scrapers/cal.ts): drives Cal's login popup, one Chrome profile per login
        ? await scrapeCal({
          profile: source,
          credentials: account.credentials as unknown as CalCredentials,
          startDate,
          futureMonths: FUTURE_MONTHS,
          showBrowser: showBrowserFor(account.companyId),
          requestOtp,
          finishByHand: !unattended,
          onFailurePage: description => { pageStateAtClose = description; },
        }).then(r => (r.success ? { ...r, accounts: r.accounts as unknown as ScrapedAccount[] } : r))
        : await libraryScrape(account, startDate, otp, unattended, description => { pageStateAtClose = description; });
      // unattended and the bank wanted a code: whatever the scrape then returned, that is why it stopped
      const result: CompanyResult = otp.needsCode() ? { success: false, errorType: NEEDS_CODE, errorMessage: 'the bank asked for an SMS code' } : raw;

      if (!result.success) {
        console.error(`Failed to scrape ${source}:`, result.errorType, result.errorMessage);
        if (pageStateAtClose) console.error(pageStateAtClose);
        recordSourceRun(db, { source, startedAt, ok: false,
          error: [result.errorType, result.errorMessage].filter(Boolean).join(': ') });
        summaries.push({ company: source, kind: 'bank', success: false, newTransactionIds: [], errorType: result.errorType });
        hooks.onProgress?.({ type: 'done', company: source, success: false, newTransactions: 0,
          errorType: result.errorType, errorMessage: result.errorMessage });
        continue;
      }

      // the untouched result, before it's normalized (data/raw/<source id>/)
      archiveRaw(source, result);
      const newIds: number[] = [];
      for (const acc of result.accounts ?? []) {
        const saved = saveScrapedAccount(db, account.companyId, acc, source);
        newIds.push(...saved.insertedIds);
        const label = acc.savingsAccount ? ' (savings deposit)' : '';
        console.log(`  ${saved.accountId}${label}: balance ${acc.balance ?? '-'} ${acc.currency ?? 'ILS'}, ${saved.insertedIds.length} new, ${saved.updated} updated`);
      }
      recordSourceRun(db, { source, startedAt, ok: true, asOf: new Date().toISOString() });
      summaries.push({ company: source, kind: 'bank', success: true, newTransactionIds: newIds });
      hooks.onProgress?.({ type: 'done', company: source, success: true, newTransactions: newIds.length });
    } catch (err) {
      const errorType = otp.needsCode() ? NEEDS_CODE : 'EXCEPTION';
      const message = otp.needsCode() ? 'the bank asked for an SMS code' : err instanceof Error ? err.message : String(err);
      console.error(`Error scraping ${source}:`, otp.needsCode() ? NEEDS_CODE : err);
      recordSourceRun(db, { source, startedAt, ok: false, error: otp.needsCode() ? `${NEEDS_CODE}: ${message}` : String(err) });
      summaries.push({ company: source, kind: 'bank', success: false, newTransactionIds: [], errorType });
      hooks.onProgress?.({ type: 'done', company: source, success: false, newTransactions: 0, errorType, errorMessage: message });
    }
  }
  return summaries;
}
