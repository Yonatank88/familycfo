import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { getDb, type DB } from './db/connection.js';
import { saveScrapedAccount, recordSourceRun, beginSourceRun, NEEDS_CODE } from './db/ingestRepo.js';
import { archiveRaw } from './ingest/archive.js';
import type { InvestmentSource } from './sync/index.js';
import * as readline from 'readline';
import type { Page } from 'puppeteer';
import type { ScrapedAccount } from './ingest/normalize.js';
import puppeteer from 'puppeteer';
import { BROWSER_ARGS, describePage, findChromePath, maskAutomation, profileDir } from './scrapers/browser.js';
import { scrapeIsracardGroup, type IsracardGroupCredentials } from './scrapers/isracardGroup.js';

interface AccountConfig {
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
  /** asked when the bank shows its OTP screen; defaults to the terminal. '' gives up */
  requestOtp?: (company: string) => Promise<string>;
  onProgress?: (event: ScrapeProgress) => void;
  /** no one can answer an OTP (scheduled / no TTY): a source that asks for one stops at once as NEEDS_CODE. Default:
   * no requestOtp hook and stdin isn't a terminal */
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

export { NEEDS_CODE };

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
export type ScrapeProgress =
  | { type: 'start'; company: string }
  | { type: 'done'; company: string; success: boolean; newTransactions: number; errorType?: string; errorMessage?: string };

async function promptOtp(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n🔐 Enter OTP code (5 digits): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function startOtpWatcher(page: Page, requestOtp: () => Promise<string>): Promise<void> {
  const maxWait = 90000;
  const interval = 1000;
  let waited = 0;
  let otpHandled = false;

  while (waited < maxWait && !otpHandled) {
    try {
      // Check if OTP modal is visible
      const otpModal = await page.$('poalim-separated-characters-input');
      if (otpModal) {
        console.log('\n📱 OTP popup detected!');
        const otp = await requestOtp();
        if (!otp) return;

        // Fill each digit into separate inputs
        const inputs = await page.$$('poalim-separated-characters-input input');
        for (let i = 0; i < Math.min(otp.length, inputs.length); i++) {
          await inputs[i].type(otp[i], { delay: 50 });
        }

        // Click submit button
        const submitBtn = await page.$('button.btn-red_1');
        if (submitBtn) {
          await submitBtn.click();
          console.log('✅ OTP submitted');
        }
        
        otpHandled = true;
        return;
      }

      // Check if we've moved past login (success)
      const url = page.url();
      if (!url.includes('login') && !url.includes('auth')) {
        return; // Login completed without OTP
      }
    } catch {
      // Frame detached or other error - page might have navigated, just continue
    }

    await new Promise(r => setTimeout(r, interval));
    waited += interval;
  }
}

const ISRACARD_GROUP = new Set(['isracard', 'amex']);
/** run in their own Chrome profile under data/browser-profile/<company> */
const PERSISTENT_PROFILE = new Set(['hapoalim']);
/** upcoming card charges and future installments */
const FUTURE_MONTHS = 2;

/** One company through israeli-bank-scrapers. */
async function libraryScrape(account: AccountConfig, startDate: Date, otp: OtpControl,
  onPageClose: (description: string) => void) {
  const requestOtp = otp.request;
  const showBrowser = process.env.SHOW_BROWSER !== '0';
  // banks that ask for an SMS code on an unknown device get a persistent profile, so the bank may remember this one
  const browser = PERSISTENT_PROFILE.has(account.companyId)
    ? await puppeteer.launch({ headless: !showBrowser, executablePath: findChromePath(), args: BROWSER_ARGS, userDataDir: profileDir(account.companyId) })
    : undefined;
  if (browser) otp.onAbort(() => browser.close());
  const scraper = createScraper({
    ...(browser ? { browser } : {}),
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

      // Start OTP watcher in background for Hapoalim
      if (account.companyId === 'hapoalim') {
        startOtpWatcher(page, requestOtp).catch(() => {}); // Fire and forget
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

  // SCRAPE_ONLY=visaCal,leumi limits the run to those companies
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  const summaries: ScrapeSummary[] = [];

  for (const account of config.accounts ?? []) {
    if (account.disabled || (only && !only.includes(account.companyId))) continue;
    console.log(`Scraping ${account.companyId}...`);
    hooks.onProgress?.({ type: 'start', company: account.companyId });
    const startedAt = new Date().toISOString();
    beginSourceRun(db, account.companyId, startedAt);
    let pageStateAtClose: string | undefined;

    const unattended = hooks.unattended ?? (!hooks.requestOtp && !process.stdin.isTTY);
    const otp = otpControl(hooks.requestOtp ? () => hooks.requestOtp!(account.companyId) : unattended ? null : promptOtp);
    try {
      const requestOtp = otp.request;
      const raw: CompanyResult = hooks.runCompany ? await hooks.runCompany(account, startDate, otp) : ISRACARD_GROUP.has(account.companyId)
        // our own scraper (src/scrapers/isracardGroup.ts): the library's login no longer works there
        ? await scrapeIsracardGroup({
          company: account.companyId as 'isracard' | 'amex',
          credentials: account.credentials as unknown as IsracardGroupCredentials,
          startDate,
          futureMonths: FUTURE_MONTHS,
          showBrowser: process.env.SHOW_BROWSER !== '0',
          requestOtp,
          finishByHand: !unattended && process.env.SHOW_BROWSER !== '0',
          onFailurePage: description => { pageStateAtClose = description; },
        }).then(r => (r.success ? { ...r, accounts: r.accounts as unknown as ScrapedAccount[] } : r))
        : await libraryScrape(account, startDate, otp, description => { pageStateAtClose = description; });
      // unattended and the bank wanted a code: whatever the scrape then returned, that is why it stopped
      const result: CompanyResult = otp.needsCode() ? { success: false, errorType: NEEDS_CODE, errorMessage: 'the bank asked for an SMS code' } : raw;

      if (!result.success) {
        console.error(`Failed to scrape ${account.companyId}:`, result.errorType, result.errorMessage);
        if (pageStateAtClose) console.error(pageStateAtClose);
        recordSourceRun(db, { source: account.companyId, startedAt, ok: false,
          error: [result.errorType, result.errorMessage].filter(Boolean).join(': ') });
        summaries.push({ company: account.companyId, kind: 'bank', success: false, newTransactionIds: [], errorType: result.errorType });
        hooks.onProgress?.({ type: 'done', company: account.companyId, success: false, newTransactions: 0,
          errorType: result.errorType, errorMessage: result.errorMessage });
        continue;
      }

      // the untouched result, before it's normalized (data/raw/<company>/)
      archiveRaw(account.companyId, result);
      const newIds: number[] = [];
      for (const acc of result.accounts ?? []) {
        const saved = saveScrapedAccount(db, account.companyId, acc);
        newIds.push(...saved.insertedIds);
        const label = acc.savingsAccount ? ' (savings deposit)' : '';
        console.log(`  ${saved.accountId}${label}: balance ${acc.balance ?? '-'} ${acc.currency ?? 'ILS'}, ${saved.insertedIds.length} new, ${saved.updated} updated`);
      }
      recordSourceRun(db, { source: account.companyId, startedAt, ok: true, asOf: new Date().toISOString() });
      summaries.push({ company: account.companyId, kind: 'bank', success: true, newTransactionIds: newIds });
      hooks.onProgress?.({ type: 'done', company: account.companyId, success: true, newTransactions: newIds.length });
    } catch (err) {
      const errorType = otp.needsCode() ? NEEDS_CODE : 'EXCEPTION';
      const message = otp.needsCode() ? 'the bank asked for an SMS code' : err instanceof Error ? err.message : String(err);
      console.error(`Error scraping ${account.companyId}:`, otp.needsCode() ? NEEDS_CODE : err);
      recordSourceRun(db, { source: account.companyId, startedAt, ok: false, error: otp.needsCode() ? `${NEEDS_CODE}: ${message}` : String(err) });
      summaries.push({ company: account.companyId, kind: 'bank', success: false, newTransactionIds: [], errorType });
      hooks.onProgress?.({ type: 'done', company: account.companyId, success: false, newTransactions: 0, errorType, errorMessage: message });
    }
  }
  return summaries;
}
