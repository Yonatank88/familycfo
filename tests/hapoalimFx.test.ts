import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// the patched Hapoalim scraper (patches/israeli-bank-scrapers+*.patch), driven through a fake logged-in page
const require = createRequire(import.meta.url);
const HapoalimScraper = require('israeli-bank-scrapers/lib/scrapers/hapoalim.js').default;

function fakePage(routes: (url: string) => [unknown, number]) {
  return {
    cookies: async () => [],
    evaluate: async (fn: () => unknown, url?: string) => {
      if (url === undefined) return String(fn).includes('restContext') ? '/ServerServices' : true;
      const [body, status] = routes(url);
      return [body == null ? null : JSON.stringify(body), status];
    },
  };
}

async function scrape(fx: (url: string) => [unknown, number]) {
  const scraper = new HapoalimScraper({ companyId: 'hapoalim', startDate: new Date() });
  scraper.page = fakePage(url => {
    if (url.endsWith('/general/accounts')) return [[{ bankNumber: 12, branchNumber: 3, accountNumber: 4, accountClosingReasonCode: 0 }], 200];
    if (url.includes('balanceAndCreditLimit')) return [{ currentBalance: 10 }, 200];
    if (url.includes('current-account/transactions')) return [{ transactions: [] }, 200];
    if (url.includes('foreign-currency/transactions')) return fx(url);
    throw new Error(`unexpected ${url}`);
  });
  return scraper.fetchData();
}

const entry = (currencySwiftCode: string, currentBalance: number, transactions: unknown[] = []) =>
  ({ currencyCode: 19, currencySwiftCode, currentBalance, detailedAccountTypeCode: 142, transactions });

describe('Hapoalim foreign-currency accounts', () => {
  it('adds one account per currency next to the ILS account', async () => {
    const txn = { executingDate: 20260901, valueDate: 20260902, eventAmount: 50, eventActivityTypeCode: 2, activityDescription: 'fee', referenceNumber: 7 };
    const result = await scrape(url => url.includes('view=details')
      ? [{ balancesAndLimitsDataList: [entry('USD', 100, [txn]), entry('EUR', 5)] }, 200]
      : [{ balancesAndLimitsDataList: [entry('USD', 100), entry('EUR', 5)] }, 200]);
    expect(result.accounts.map((a: { accountNumber: string; currency?: string; balance: number }) => [a.accountNumber, a.currency, a.balance]))
      .toEqual([['12-3-4', undefined, 10], ['12-3-4-USD', 'USD', 100], ['12-3-4-EUR', 'EUR', 5]]);
    expect(result.accounts[1].txns[0]).toMatchObject({ chargedAmount: -50, chargedCurrency: 'USD', identifier: 7, date: expect.stringMatching(/^2026-0[89]/) });
  });

  it('no foreign-currency data or a failing endpoint leaves the ILS scrape intact', async () => {
    for (const fx of [() => [null, 204], () => ['<html>', 500], () => { throw new Error('boom'); }] as ((u: string) => [unknown, number])[]) {
      const result = await scrape(fx);
      expect(result.accounts.map((a: { accountNumber: string }) => a.accountNumber)).toEqual(['12-3-4']);
    }
  });
});
