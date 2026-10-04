import { describe, expect, it } from 'vitest';
import {
  cardAccount, cardTransactions, convertApproval, convertVoucher, fetchCardData, loginOutcome, monthsToFetch,
  parseIsraeliDate, type ApiApproval, type ApiCard, type ApiVoucher, type LoginResponse,
} from '../src/scrapers/isracardGroup.js';

const local = (date: string, time?: string) => parseIsraeliDate(date, time);

describe('loginOutcome', () => {
  const validated = (returnCode: string, extra: Record<string, unknown> = {}): LoginResponse => ({
    call: 'ValidateIdDataNoReg', body: { Header: { Status: '1' }, ValidateIdDataNoRegBean: { returnCode, ...extra } },
  });
  const logon = (body: Record<string, unknown>): LoginResponse => ({ call: 'performLogonI', body });

  it('waits until the site answers', () => {
    expect(loginOutcome([])).toEqual({ state: 'pending' });
    // the bot block answers with a text page — that's not a wrong password
    expect(loginOutcome([{ call: 'ValidateIdDataNoReg', body: { status: 'unparsable', message: 'HTTP 200: Block Automation' } }]))
      .toMatchObject({ state: 'failed', errorType: 'BLOCKED' });
    expect(loginOutcome([validated('1'), { call: 'IsRegisterNoReg', body: { IsRegisterNoRegBean: { returnCode: '1' } } }]))
      .toEqual({ state: 'pending' });
  });

  it('performLogonI status 1 is success', () => {
    expect(loginOutcome([validated('1'), logon({ status: '1' })])).toEqual({ state: 'success' });
  });

  it('status 3 or returnCode 4 asks for a new password', () => {
    expect(loginOutcome([validated('1'), logon({ status: '3' })])).toMatchObject({ state: 'failed', errorType: 'CHANGE_PASSWORD' });
    expect(loginOutcome([validated('1'), logon({ status: '0', returnCode: '4' })])).toMatchObject({ errorType: 'CHANGE_PASSWORD' });
    expect(loginOutcome([validated('4')])).toMatchObject({ errorType: 'CHANGE_PASSWORD' });
  });

  it('reports a CAPTCHA, else an invalid password, with the site message', () => {
    expect(loginOutcome([validated('1'), logon({ status: '0', isCaptcha: 'true', message: 'm' })]))
      .toEqual({ state: 'failed', errorType: 'CAPTCHA', errorMessage: 'm' });
    expect(loginOutcome([validated('1'), logon({ status: '0', message: 'פרטים שגויים' })]))
      .toEqual({ state: 'failed', errorType: 'INVALID_PASSWORD', errorMessage: 'פרטים שגויים' });
  });

  it('stops at ValidateIdDataNoReg: wrong details, locked, not registered, fraud monitor', () => {
    expect(loginOutcome([validated('2', { message: 'שגוי' })])).toMatchObject({ errorType: 'INVALID_PASSWORD', errorMessage: 'שגוי' });
    expect(loginOutcome([validated('2', { isCaptcha: 'true' })])).toMatchObject({ errorType: 'CAPTCHA' });
    expect(loginOutcome([validated('5')])).toMatchObject({ errorType: 'ACCOUNT_BLOCKED' });
    expect(loginOutcome([validated('7')])).toMatchObject({ errorType: 'GENERIC' });
    expect(loginOutcome([validated('1'), { call: 'IsRegisterNoReg', body: { IsRegisterNoRegBean: { returnCode: '7' } } }]))
      .toMatchObject({ errorType: 'GENERIC' });
    expect(loginOutcome([{ call: 'ValidateIdDataNoReg', body: { Header: { Status: '0' } } }])).toMatchObject({ errorType: 'GENERIC' });
    expect(loginOutcome([validated('1'), logon({ status: '2', returnCode: '665' })])).toMatchObject({ errorType: 'ACCOUNT_BLOCKED' });
  });
});

const voucher = (over: Partial<ApiVoucher> = {}): ApiVoucher => ({
  purchaseDate: '10/08/2026', purchaseTime: null, businessName: ' שופרסל ', originalAmount: 120, originalCurrencyIso: 'ILS',
  billingAmount: 120, moreInfo: null, seqVoucherNumber: 'V1', currentInstallmentNum: null, numberOfInstallment: null,
  transactionDescription: ' מזון ', ...over,
});
const approval = (over: Partial<ApiApproval> = {}): ApiApproval => ({
  purchaseDate: '10/08/2026', israelTransactionTime: '14:30', businessName: 'שופרסל ', originalAmount: 120, currencyIso: 'ILS',
  ilsBillingAmount: 120, extraDetails: null, seqConfirmationNumber: 'A1', branchCodeDescription: 'מזון', ...over,
});

describe('transaction mapping', () => {
  it('a voucher is a completed charge on its billing date, negative, with category and installments', () => {
    const t = convertVoucher(voucher({ currentInstallmentNum: 2, numberOfInstallment: 6, originalCurrencyIso: 'USD', originalAmount: 30 }),
      local('02/09/2026'));
    expect(t).toMatchObject({
      type: 'installments', identifier: 'V1', date: local('10/08/2026'), processedDate: local('02/09/2026'),
      originalAmount: -30, originalCurrency: 'USD', chargedAmount: -120, chargedCurrency: 'ILS',
      description: 'שופרסל', category: 'מזון', status: 'completed', installments: { number: 2, total: 6 },
    });
    expect(convertVoucher(voucher({ billingAmount: -50, originalAmount: -50 }), local('02/09/2026')).chargedAmount).toBe(50); // refund
  });

  it('an approval is pending, dated with its time', () => {
    const t = convertApproval(approval(), local('02/09/2026'));
    expect(t).toMatchObject({ type: 'normal', status: 'pending', date: local('10/08/2026', '14:30'),
      processedDate: local('02/09/2026'), chargedAmount: -120, description: 'שופרסל', category: 'מזון' });
  });

  it('merges months: drops approvals that settled, de-duplicates repeats, keeps immediate-debit vouchers on their own date', () => {
    const months = [
      { processedDate: local('02/08/2026'), data: {
        approvals: { approvedTransactions: [approval(), approval({ seqConfirmationNumber: 'A2', businessName: 'פז', originalAmount: 80, ilsBillingAmount: 80 })] },
        israelAbroadVouchers: { vouchers: { israelAbroadVouchersList: [] }, outOfStatementChargeDateVouchers: [
          { totalVouchersCurrencyDate: { dateImmediateVouchers: '12/08/2026' }, immediateVouchersCurrencyDate: [voucher({ seqVoucherNumber: 'D1', businessName: 'כספומט' })] },
        ] },
      } },
      { processedDate: local('02/09/2026'), data: {
        // the same approvals again, and the first one has now settled
        approvals: { approvedTransactions: [approval(), approval({ seqConfirmationNumber: 'A2', businessName: 'פז', originalAmount: 80, ilsBillingAmount: 80 })] },
        israelAbroadVouchers: { vouchers: { israelAbroadVouchersList: [voucher()] }, outOfStatementChargeDateVouchers: null },
      } },
    ];
    const txns = cardTransactions(months, local('02/10/2026'));
    expect(txns.map(t => [t.identifier, t.status, t.processedDate])).toEqual([
      ['A2', 'pending', local('02/10/2026')],
      ['D1', 'completed', local('12/08/2026')],
      ['V1', 'completed', local('02/09/2026')],
    ]);
  });
});

describe('cardAccount', () => {
  const card: ApiCard = { companyCode: '11', cardStatus: '0', cardSuffix: '1234', serviceType: '1', isActive: true, isBlock: false,
    isPartner: false, limitData: { creditLimitAmount: '15500', limitUsed: '9564.99' }, cardChargeNext: { billingDate: '02/10/2026' } };

  it('balance, frame and charge date from the card list; installments re-dated; old rows dropped', () => {
    const txns = [
      convertVoucher(voucher({ seqVoucherNumber: 'I3', purchaseDate: '15/06/2026', currentInstallmentNum: 3, numberOfInstallment: 4 }), local('02/09/2026')),
      convertVoucher(voucher({ seqVoucherNumber: 'OLD', purchaseDate: '15/06/2026' }), local('02/07/2026')),
    ];
    const acc = cardAccount(card, txns, new Date(2026, 6, 1));
    expect(acc).toMatchObject({ accountNumber: '1234', balance: -9564.99, cardFrame: 15500, balanceDate: local('02/10/2026') });
    expect(acc.txns.map(t => [t.identifier, t.date])).toEqual([['I3', local('15/08/2026')]]);
  });
});

describe('fetchCardData (mocked DigitalV3 API)', () => {
  it('fetches every active card of this company, month by month', async () => {
    const calls: { endpoint: string; body: Record<string, unknown> }[] = [];
    const postJson = async (url: string, body: unknown) => {
      const endpoint = url.split('/').pop()!;
      calls.push({ endpoint, body: body as Record<string, unknown> });
      if (endpoint === 'GetCardList') {
        return { isSuccess: true, data: { cardsList: [
          { companyCode: '11', cardStatus: '0', cardSuffix: '1111', serviceType: '1', isActive: true, isBlock: false, isPartner: false,
            limitData: { creditLimitAmount: '10000', limitUsed: '500' }, cardChargeNext: { billingDate: '02/11/2026' } },
          { companyCode: '77', cardStatus: '0', cardSuffix: '7777', serviceType: '1', isActive: true, isBlock: false, isPartner: false },
          { companyCode: '11', cardStatus: '9', cardSuffix: '2222', serviceType: '1', isActive: false, isBlock: false, isPartner: false },
        ] } };
      }
      if (endpoint === 'GetMonthlyBilling') {
        const [mm, yyyy] = String((body as { billingDate: string }).billingDate).split('/');
        return { isSuccess: true, data: { cards: { 1111: { billingDate: `02/${mm}/${yyyy}` } } } };
      }
      const month = String((body as { billingMonth: string }).billingMonth).slice(3);
      return { isSuccess: true, data: {
        approvals: null,
        israelAbroadVouchers: { vouchers: { israelAbroadVouchersList: month === '10/2026'
          ? [voucher({ seqVoucherNumber: 'S1', purchaseDate: '20/09/2026' })] : [] }, outOfStatementChargeDateVouchers: [] },
      } };
    };

    const accounts = await fetchCardData(postJson, 'isracard', {
      startDate: new Date(2026, 8, 1), futureMonths: 1, now: new Date(2026, 9, 4), pause: async () => {},
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ accountNumber: '1111', balance: -500, cardFrame: 10000 });
    expect(accounts[0].txns.map(t => [t.identifier, t.processedDate])).toEqual([['S1', local('02/10/2026')]]);
    expect(calls[0]).toEqual({ endpoint: 'GetCardList', body: { companyCode: '99', cardSuffixLength: 4 } });
    const lists = calls.filter(c => c.endpoint === 'GetTransactionsList').map(c => [c.body.billingMonth, c.body.isNextBillingDate, c.body.companyCode]);
    expect(lists).toEqual([['01/09/2026', false, 11], ['01/10/2026', false, 11], ['01/11/2026', true, 11]]);
  });

  it('fails loudly when the API refuses', async () => {
    await expect(fetchCardData(async () => ({ isSuccess: false, errorDescription: 'nope' }), 'amex',
      { startDate: new Date(), futureMonths: 0, pause: async () => {} })).rejects.toThrow('GetCardList failed: nope');
  });
});

describe('monthsToFetch', () => {
  it('runs from the start month through the future months', () => {
    expect(monthsToFetch(new Date(2026, 6, 15), 2, new Date(2026, 9, 4)).map(d => d.getMonth() + 1)).toEqual([7, 8, 9, 10, 11, 12]);
  });
});

describe('ingest', () => {
  it('a mapped card saves like a library result: card account, balance, pending + completed rows', async () => {
    const { testDb } = await import('./helpers.js');
    const { saveScrapedAccount } = await import('../src/db/ingestRepo.js');
    const db = testDb();
    const card: ApiCard = { companyCode: '11', cardStatus: '0', cardSuffix: '1234', serviceType: '1', isActive: true, isBlock: false,
      isPartner: false, limitData: { creditLimitAmount: '15500', limitUsed: '200' }, cardChargeNext: { billingDate: '02/10/2026' } };
    const txns = cardTransactions([{ processedDate: local('02/09/2026'), data: {
      approvals: { approvedTransactions: [approval({ seqConfirmationNumber: 'A9', businessName: 'פז', purchaseDate: '01/09/2026' })] },
      israelAbroadVouchers: { vouchers: { israelAbroadVouchersList: [voucher({ currentInstallmentNum: 1, numberOfInstallment: 3 })] } },
    } }], local('02/10/2026'));
    const saved = saveScrapedAccount(db, 'isracard', cardAccount(card, txns, new Date(2026, 6, 1)) as never);
    expect(saved.accountId).toBe('isracard:1234');
    expect(saved.insertedIds).toHaveLength(2);
    expect(db.prepare(`SELECT kind, card_frame FROM accounts`).get()).toEqual({ kind: 'card', card_frame: 15500 });
    expect(db.prepare(`SELECT status, txn_type, installment_number, installment_total, source_category FROM transactions ORDER BY id`).all())
      .toEqual([
        { status: 'pending', txn_type: 'normal', installment_number: null, installment_total: null, source_category: 'מזון' },
        { status: 'completed', txn_type: 'installments', installment_number: 1, installment_total: 3, source_category: 'מזון' },
      ]);
  });
});
