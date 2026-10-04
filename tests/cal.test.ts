import { describe, expect, it } from 'vitest';
import {
  BLOCKED_MESSAGE, INVALID_PASSWORD_MESSAGE, balanceOf, cardAccount, convertCompleted, convertPending, credentialsProblem,
  dedupePending, fetchCalData, frameRoute, loginOutcome, routeOutcome,
  type ApiCompletedTxn, type ApiFrames, type ApiMonth, type ApiPendingTxn,
} from '../src/scrapers/cal.js';

describe('loginOutcome (authentication/login response)', () => {
  it('waits until the site answers', () => {
    expect(loginOutcome(null)).toEqual({ state: 'pending' });
  });

  it('a token is success', () => {
    expect(loginOutcome({ status: 200, body: { token: 'abc', hash: null, innerLoginType: 0 } })).toEqual({ state: 'success', token: 'abc' });
    expect(loginOutcome({ status: 200, body: { token: '' } })).toMatchObject({ state: 'failed', errorType: 'GENERIC' });
  });

  it('412 asks for a new password', () => {
    expect(loginOutcome({ status: 412, body: 'x' })).toMatchObject({ state: 'failed', errorType: 'CHANGE_PASSWORD' });
  });

  it('maps the site message: wrong credentials, blocked subscription', () => {
    expect(loginOutcome({ status: 400, body: INVALID_PASSWORD_MESSAGE }))
      .toEqual({ state: 'failed', errorType: 'INVALID_PASSWORD', errorMessage: INVALID_PASSWORD_MESSAGE });
    expect(loginOutcome({ status: 400, body: { message: `${BLOCKED_MESSAGE}, נא לפנות למוקד` } }))
      .toMatchObject({ state: 'failed', errorType: 'ACCOUNT_BLOCKED' });
    // any other refusal counts toward the lockout guard
    expect(loginOutcome({ status: 400, body: 'משהו אחר' })).toMatchObject({ errorType: 'INVALID_PASSWORD', errorMessage: 'משהו אחר' });
    expect(loginOutcome({ status: 500, body: '' })).toMatchObject({ errorType: 'GENERIC' });
  });

  it('a bot-protection page is BLOCKED, not a wrong password', () => {
    expect(loginOutcome({ status: 200, body: { status: 'unparsable', message: '<html>' } })).toMatchObject({ errorType: 'BLOCKED' });
    expect(loginOutcome({ status: 403, body: INVALID_PASSWORD_MESSAGE })).toMatchObject({ errorType: 'BLOCKED' });
    expect(loginOutcome({ status: 429, body: {} })).toMatchObject({ errorType: 'BLOCKED' });
  });
});

describe('login iframe routes', () => {
  // the route the iframe shows after a rejected login (eshaham/israeli-bank-scrapers#1184)
  const errorUrl = (message: string) =>
    'https://digital-web.cal-online.co.il/calconnect/error;headers=%5Bobject%20Object%5D;status=400;statusText=OK;'
    + 'url=https:%2F%2Fconnect.cal-online.co.il%2Fcol-rest%2Fcalconnect%2Fauthentication%2Flogin;ok=false;'
    + `name=HttpErrorResponse;message=Http%20failure%20response;error=${encodeURIComponent(message)}`;

  it('names the step', () => {
    expect(frameRoute('https://connect.cal-online.co.il/send-otp')).toBe('send-otp');
    expect(frameRoute('https://connect.cal-online.co.il/regular-login')).toBe('regular-login');
    expect(frameRoute('https://connect.cal-online.co.il/verify-otp')).toBe('verify-otp');
    expect(frameRoute(errorUrl('x'))).toBe('error');
    expect(frameRoute('https://connect.cal-online.co.il/index.html')).toBe('other');
  });

  it('reads the outcome from the route when the response was not seen', () => {
    expect(routeOutcome(errorUrl(INVALID_PASSWORD_MESSAGE))).toMatchObject({ state: 'failed', errorType: 'INVALID_PASSWORD' });
    expect(routeOutcome(errorUrl('שגיאה כללית'))).toMatchObject({ state: 'failed', errorType: 'GENERIC' });
    expect(routeOutcome('https://connect.cal-online.co.il/change-password')).toMatchObject({ errorType: 'CHANGE_PASSWORD' });
    expect(routeOutcome('https://connect.cal-online.co.il/regular-login')).toEqual({ state: 'pending' });
  });
});

describe('credentialsProblem (checked before anything is typed)', () => {
  it('refuses what the form would refuse', () => {
    expect(credentialsProblem({ username: 'abcdefgh', password: 'abc12345' })).toBeNull();
    expect(credentialsProblem({ username: 'abcdefghi', password: 'abc12345' })).toMatch(/username/);
    expect(credentialsProblem({ username: 'abcdefgh', password: 'abc$1234' })).toMatch(/letters and digits/);
    expect(credentialsProblem({ username: 'abcdefgh', password: 'abc1234' })).toMatch(/letters and digits/);
  });
});

const completed = (o: Partial<ApiCompletedTxn> = {}): ApiCompletedTxn => ({
  trnIntId: '111', trnPurchaseDate: '2026-09-10T12:30:00', debCrdDate: '2026-10-02T00:00:00', merchantName: ' סופר ',
  trnAmt: 100, trnCurrencySymbol: '₪', amtBeforeConvAndIndex: 100, debCrdCurrencySymbol: '₪', trnTypeCode: '5',
  numOfPayments: 0, curPaymentNum: 0, branchCodeDesc: 'מזון', transTypeCommentDetails: [], ...o,
});
const pending = (o: Partial<ApiPendingTxn> = {}): ApiPendingTxn => ({
  merchantName: 'קפה', trnPurchaseDate: '2026-10-03T08:00:00', trnAmt: 18, trnCurrencySymbol: '₪', trnTypeCode: '5',
  numberOfPayments: 0, branchCodeDesc: 'מסעדות', transTypeCommentDetails: [], ...o,
});

describe('transaction mapping', () => {
  it('a completed charge: negative, processed on the debit date, category, currency codes', () => {
    const t = convertCompleted(completed());
    expect(t).toMatchObject({
      type: 'normal', identifier: '111', status: 'completed', description: 'סופר', category: 'מזון',
      originalAmount: -100, originalCurrency: 'ILS', chargedAmount: -100, chargedCurrency: 'ILS',
      date: new Date('2026-09-10T12:30:00').toISOString(), processedDate: new Date('2026-10-02T00:00:00').toISOString(),
    });
    expect(t.installments).toBeUndefined();
  });

  it('a foreign charge keeps the original currency and the shekel charge', () => {
    expect(convertCompleted(completed({ trnAmt: 20, trnCurrencySymbol: '$', amtBeforeConvAndIndex: 74.3 })))
      .toMatchObject({ originalAmount: -20, originalCurrency: 'USD', chargedAmount: -74.3, chargedCurrency: 'ILS' });
  });

  it('a credit is positive whatever sign Cal sends', () => {
    expect(convertCompleted(completed({ trnTypeCode: '6', trnAmt: 50, amtBeforeConvAndIndex: -50 })))
      .toMatchObject({ type: 'normal', originalAmount: 50, chargedAmount: 50 });
  });

  it('installment n is dated n-1 months after the purchase', () => {
    const t = convertCompleted(completed({ trnTypeCode: '8', numOfPayments: 3, curPaymentNum: 2, trnAmt: 300, amtBeforeConvAndIndex: 100 }));
    expect(t).toMatchObject({ type: 'installments', installments: { number: 2, total: 3 }, originalAmount: -300, chargedAmount: -100 });
    expect(t.date).toBe(new Date('2026-10-10T12:30:00').toISOString());
  });

  it('a pending authorization is charged on the next debit date', () => {
    const next = new Date('2026-11-02T00:00:00').toISOString();
    expect(convertPending(pending(), next)).toMatchObject({
      status: 'pending', processedDate: next, originalAmount: -18, chargedAmount: -18, chargedCurrency: 'ILS', category: 'מסעדות',
    });
    expect(convertPending(pending({ numberOfPayments: 4 })).installments).toEqual({ number: 1, total: 4 });
  });

  it('drops a pending authorization that already completed, one to one', () => {
    const done = convertCompleted(completed({ merchantName: 'דלק', trnPurchaseDate: '2026-10-03T08:05:00', amtBeforeConvAndIndex: 84 }));
    const hold = convertPending(pending({ merchantName: 'דלק', trnAmt: 200 }));
    const second = convertPending(pending({ merchantName: 'דלק', trnPurchaseDate: '2026-10-03T19:00:00', trnAmt: 50 }));
    const otherDay = convertPending(pending({ merchantName: 'דלק', trnPurchaseDate: '2026-10-04T08:00:00' }));
    const result = dedupePending([hold, second, otherDay, done]);
    expect(result).toEqual([second, otherDay, done]);
  });
});

describe('card accounts', () => {
  const frames: ApiFrames = { result: {
    calIssuedCards: { frameLimitForCardAmount: 20000, cardLevelFrames: [{ cardUniqueId: 'u1', nextTotalDebit: 1234.5, nextDebitDate: '2026-10-02T00:00:00' }] },
  } };

  it('balance = the next debit, negative; frame limit from the issuer group', () => {
    expect(balanceOf(frames, 'u1')).toEqual({ balance: -1234.5, balanceDate: new Date('2026-10-02T00:00:00').toISOString(), cardFrame: 20000 });
    // no card-level frame: the group's figures
    expect(balanceOf({ result: { bankIssuedCards: { frameLimitForCardAmount: 10000, fictiveMaxAccAmt: 7000 } } }, 'u9'))
      .toEqual({ balance: -3000, balanceDate: undefined, cardFrame: 10000 });
  });

  it('builds one account per card, last 4 as the number, from statements + immediate debits + pending, filtered by start', () => {
    const month: ApiMonth = { statusCode: 1, result: { bankAccounts: [{
      debitDates: [{ transactions: [completed(), completed({ trnIntId: '0', trnPurchaseDate: '2026-01-01T00:00:00' })] }],
      immidiateDebits: { debitDays: [{ transactions: [completed({ trnIntId: '222', merchantName: 'מיידי' })] }] },
    }] } };
    const account = cardAccount({ cardUniqueId: 'u1', last4Digits: '4321' }, frames, [month],
      { statusCode: 1, result: { cardsList: [{ cardUniqueID: 'u1', authDetalisList: [pending()] }] } }, new Date('2026-07-01'));
    expect(account.accountNumber).toBe('4321');
    expect(account.balance).toBe(-1234.5);
    expect(account.txns.map(t => t.identifier ?? t.status)).toEqual(['pending', '111', '222']);
    expect(account.txns[0].processedDate).toBe(new Date('2026-10-02T00:00:00').toISOString());
  });
});

describe('fetchCalData', () => {
  it('calls frames, pending and every month per card; 96 = nothing that month', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const postJson = async (url: string, body: unknown) => {
      calls.push({ url, body: body as Record<string, unknown> });
      if (url.endsWith('GetFrameStatus')) return { result: { calIssuedCards: { cardLevelFrames: [] } } };
      if (url.endsWith('getClearanceRequests')) return { statusCode: 96 };
      const b = body as { month: string };
      return b.month === '10' ? { statusCode: 96, title: 'no data' }
        : { statusCode: 1, result: { bankAccounts: [{ debitDates: [{ transactions: [completed({ trnIntId: `m${b.month}`, trnPurchaseDate: `2026-0${b.month}-05T10:00:00` })] }] }] } };
    };
    const accounts = await fetchCalData(postJson, [{ cardUniqueId: 'u1', last4Digits: '1111' }],
      { startDate: new Date(2026, 7, 1), futureMonths: 1, now: new Date(2026, 8, 15), pause: async () => {} });
    expect(calls.filter(c => c.url.endsWith('getCardTransactionsDetails')).map(c => `${c.body.month}/${c.body.year}`)).toEqual(['8/2026', '9/2026', '10/2026']);
    expect(calls[0].body).toEqual({ cardsForFrameData: [{ cardUniqueId: 'u1' }] });
    expect(accounts[0].txns.map(t => t.identifier)).toEqual(['m8', 'm9']);
  });

  it('a failed statement fails the scrape', async () => {
    const postJson = async (url: string) => (url.endsWith('getCardTransactionsDetails') ? { statusCode: 2, title: 'שגיאה' } : { statusCode: 1, result: {} });
    await expect(fetchCalData(postJson, [{ cardUniqueId: 'u1', last4Digits: '1111' }],
      { startDate: new Date(2026, 8, 1), futureMonths: 0, now: new Date(2026, 8, 15), pause: async () => {} })).rejects.toThrow(/card 1111/);
  });
});
