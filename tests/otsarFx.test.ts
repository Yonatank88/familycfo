import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

// the patched Beinleumi-group base (Otsar Hahayal, Beinleumi, Massad, Pagi) — patches/israeli-bank-scrapers+*.patch
const require = createRequire(import.meta.url);
const { parseForeignPortfolio, parseForeignMovements, fetchForeignCurrencyAccounts } =
  require('israeli-bank-scrapers/lib/scrapers/base-beinleumi-group.js');

const PORTFOLIO_HEADERS = ['פעולה', 'סוג חשבון', 'שער', 'יתרה עדכנית', 'שווי בש"ח', 'יתרת מזומן', 'שווי בש"ח'];
const row = (balance: string) => ['ק מ', '105 פמח עוש יחידים', '3.0500', ` ${balance}`, '1.00', balance, '1.00'];

describe('Beinleumi group foreign-currency portfolio (תיק מט"ח)', () => {
  it('reads one balance per currency section from the "יתרה עדכנית" column', () => {
    expect(parseForeignPortfolio([
      { title: 'פרוט למטבע דולר ארה"ב', headers: PORTFOLIO_HEADERS, rows: [row('1,234.50')] },
      { title: 'פרוט למטבע אירו', headers: PORTFOLIO_HEADERS, rows: [row('10.00'), row('5.25')] },
    ])).toEqual([{ currency: 'USD', balance: 1234.5 }, { currency: 'EUR', balance: 15.25 }]);
  });

  it('skips sections with an unknown currency or no balance column', () => {
    expect(parseForeignPortfolio([
      { title: 'פרוט למטבע מטבע לא ידוע', headers: PORTFOLIO_HEADERS, rows: [row('1.00')] },
      { title: 'פרוט למטבע לירה שטרלינג', headers: ['פעולה'], rows: [['x']] },
    ])).toEqual([]);
  });
});

describe('Beinleumi group foreign-currency movements (dataTable040)', () => {
  const headers = ['יתרה', 'ערך', 'זכות', 'חובה', 'תאור פעולה', '.ס.פ', 'אסמכתא', 'תאריך'];
  it('maps rows to transactions in the account currency, without the opening balance row', () => {
    const txns = parseForeignMovements(headers, [
      ['0.00', '', '', '', 'יתרת פתיחה', '', '', ''],
      ['1,000.00', '02/09/2026', '1,000.00', '', 'רכישת מט"ח שער מוסכם', '105', ' 7', '01/09/2026'],
      ['990.00', '03/09/2026', '', '10.00', 'עמלה', '105', '8', '03/09/2026'],
    ], 'USD');
    expect(txns.map((t: Record<string, unknown>) => [t.identifier, t.originalAmount, t.chargedCurrency, t.originalCurrency, t.description]))
      .toEqual([[7, 1000, 'USD', 'USD', 'רכישת מט"ח שער מוסכם'], [8, -10, 'USD', 'USD', 'עמלה']]);
    expect(new Date(txns[0].date).getDate()).toBe(1);
    expect(new Date(txns[0].processedDate).getDate()).toBe(2);
  });
});

describe('Beinleumi group foreign-currency accounts guard', () => {
  it('returns no accounts (and does not throw) when the foreign-currency pages fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scraper = { BASE_URL: 'https://example.invalid', page: {}, navigateTo: async () => { throw new Error('boom'); } };
    await expect(fetchForeignCurrencyAccounts(scraper, null)).resolves.toEqual([]);
    warn.mockRestore();
  });
});
