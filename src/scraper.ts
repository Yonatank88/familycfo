import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { getDb, type DB } from './db/connection.js';
import { saveScrapedAccount, recordSourceRun, beginSourceRun } from './db/ingestRepo.js';
import { archiveRaw } from './ingest/archive.js';
import type { InvestmentSource } from './sync/index.js';
import * as readline from 'readline';
import type { Page } from 'puppeteer';
import type { ScrapedAccount } from './ingest/normalize.js';
import { BROWSER_ARGS, describePage, findChromePath, maskAutomation } from './scrapers/browser.js';
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
/** upcoming card charges and future installments */
const FUTURE_MONTHS = 2;

/** One company through israeli-bank-scrapers. */
async function libraryScrape(account: AccountConfig, startDate: Date, requestOtp: () => Promise<string>,
  onPageClose: (description: string) => void) {
  const scraper = createScraper({
    companyId: CompanyTypes[account.companyId],
    startDate,
    futureMonthsToScrape: FUTURE_MONTHS,
    // per-transaction detail requests (e.g. Isracard PirteyIska_204) get rate-limited (HTTP 429) as automation
    additionalTransactionInformation: false,
    includeRawTransaction: true,
    verbose: true,
    combineInstallments: false,
    showBrowser: process.env.SHOW_BROWSER !== '0',
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

    try {
      const requestOtp = hooks.requestOtp ? () => hooks.requestOtp!(account.companyId) : promptOtp;
      const result = ISRACARD_GROUP.has(account.companyId)
        // our own scraper (src/scrapers/isracardGroup.ts): the library's login no longer works there
        ? await scrapeIsracardGroup({
          company: account.companyId as 'isracard' | 'amex',
          credentials: account.credentials as unknown as IsracardGroupCredentials,
          startDate,
          futureMonths: FUTURE_MONTHS,
          showBrowser: process.env.SHOW_BROWSER !== '0',
          requestOtp,
          onFailurePage: description => { pageStateAtClose = description; },
        }).then(r => (r.success ? { ...r, accounts: r.accounts as unknown as ScrapedAccount[] } : r))
        : await libraryScrape(account, startDate, requestOtp, description => { pageStateAtClose = description; });

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
      console.error(`Error scraping ${account.companyId}:`, err);
      recordSourceRun(db, { source: account.companyId, startedAt, ok: false, error: String(err) });
      summaries.push({ company: account.companyId, kind: 'bank', success: false, newTransactionIds: [], errorType: 'EXCEPTION' });
      hooks.onProgress?.({ type: 'done', company: account.companyId, success: false, newTransactions: 0,
        errorType: 'EXCEPTION', errorMessage: err instanceof Error ? err.message : String(err) });
    }
  }
  return summaries;
}
