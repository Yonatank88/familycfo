import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';

// the patched scraper (patches/israeli-bank-scrapers+*.patch) is CommonJS and calls fetchGraphql through the
// helper module's exports, so replacing that export mocks the GraphQL API
const require = createRequire(import.meta.url);
const fetchHelpers = require('israeli-bank-scrapers/lib/helpers/fetch.js');
const OneZeroScraper = require('israeli-bank-scrapers/lib/scrapers/one-zero.js').default;
const realFetchGraphql = fetchHelpers.fetchGraphql;

const movement = (id: string, currency: string, amount: string, runningBalance: string, at: string, creditDebit = 'CREDIT') => ({
  movementId: id, movementCurrency: currency, movementAmount: amount, runningBalance, creditDebit,
  movementTimestamp: at, valueDate: at, description: `txn ${id}`, transaction: null,
});

const customer = {
  customer: [{
    portfolios: [{
      portfolioId: 'p1', portfolioNum: '111', baseCurrency: 'ILS',
      accounts: [
        { accountId: 'a-ils', currency: 'ILS', accountType: 'CASH_ACCOUNT', status: 'ACTIVE' },
        { accountId: 'a-usd', currency: 'USD', accountType: 'FX_ACCOUNT', status: 'ACTIVE' },
        { accountId: 'a-eur', currency: 'EUR', accountType: 'FX_ACCOUNT', status: 'ACTIVE' },
        { accountId: 'a-gbp', currency: 'GBP', accountType: 'FX_ACCOUNT', status: 'CLOSED', closingDate: '2025-01-01' },
      ],
    }],
  }],
};

const movementsByAccount: Record<string, unknown[]> = {
  'a-ils': [movement('m1', 'ILS', '100', '1100', '2026-09-01T10:00:00Z'), movement('m2', 'ILS', '40', '1060', '2026-09-05T10:00:00Z', 'DEBIT')],
  'a-usd': [movement('m3', 'USD', '250', '250', '2026-09-03T10:00:00Z')],
  'a-eur': [],
};

function mockGraphql(calls: { query: string; variables: Record<string, unknown> }[]) {
  fetchHelpers.fetchGraphql = async (_url: string, query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes('GetCustomer')) return customer;
    if (query.includes('GetMovements')) {
      return { movements: { movements: movementsByAccount[variables.accountId as string] ?? [], pagination: { cursor: null, hasMore: false } } };
    }
    if (query.includes('GetBalance')) return { balance: { currency: 'EUR', currentAccountBalance: 75 } };
    throw new Error(`unexpected query: ${query.slice(0, 40)}`);
  };
}

async function scrape() {
  const scraper = new OneZeroScraper({ companyId: 'oneZero', startDate: new Date('2026-08-01') });
  scraper.accessToken = 'token';
  return scraper.fetchData();
}

afterEach(() => { fetchHelpers.fetchGraphql = realFetchGraphql; });

describe('One Zero multi-currency accounts', () => {
  it('returns one account per open account: ILS keeps the portfolio number, FX gets -CURRENCY', async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    mockGraphql(calls);
    const result = await scrape();

    expect(result.success).toBe(true);
    expect(result.accounts.map((a: { accountNumber: string; currency: string }) => [a.accountNumber, a.currency]))
      .toEqual([['111', 'ILS'], ['111-USD', 'USD'], ['111-EUR', 'EUR']]);
    // the closed account is never fetched
    expect(calls.some(c => c.variables.accountId === 'a-gbp')).toBe(false);
  });

  it('balance is the latest runningBalance; a movement-less account reads the balance query', async () => {
    mockGraphql([]);
    const [ils, usd, eur] = (await scrape()).accounts;
    expect(ils.balance).toBe(1060);
    expect(usd.balance).toBe(250);
    expect(eur.balance).toBe(75);
    expect(eur.txns).toEqual([]);
  });

  it("transactions carry their account's currency and sign", async () => {
    mockGraphql([]);
    const [ils, usd] = (await scrape()).accounts;
    expect(ils.txns.map((t: { chargedAmount: number }) => t.chargedAmount)).toEqual([100, -40]);
    expect(usd.txns[0]).toMatchObject({ identifier: 'm3', chargedAmount: 250, chargedCurrency: 'USD', originalCurrency: 'USD' });
  });

  it('a failing foreign-currency account does not break the ILS account', async () => {
    mockGraphql([]);
    const mocked = fetchHelpers.fetchGraphql;
    fetchHelpers.fetchGraphql = async (url: string, query: string, variables: Record<string, unknown>) => {
      if (variables.accountId === 'a-usd') throw new Error('boom');
      return mocked(url, query, variables);
    };
    const result = await scrape();
    expect(result.accounts.map((a: { accountNumber: string }) => a.accountNumber)).toEqual(['111', '111-EUR']);
  });
});
