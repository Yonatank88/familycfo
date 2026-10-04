/**
 * Isracard and Amex (one backend, "Isracard Group"), replacing israeli-bank-scrapers' own scraper.
 *
 * Login drives the real login page, so the site's own script runs the current flow: ValidateIdDataNoReg →
 * IsRegisterNoReg → performLogonI, each wrapped in reCAPTCHA v3, plus the fraud-monitor calls. The library posted
 * the old ValidateIdData + performLogonI directly and gets an empty userName back, which failed as INVALID_PASSWORD.
 * We only read the responses of those calls to learn the outcome.
 *
 * Data comes from the DigitalV3 JSON API on web.isracard.co.il / web.americanexpress.co.il (eshaham/israeli-bank-scrapers#1159):
 * GetCardList (every card on the login) → per card and month GetMonthlyBilling (the real charge date) and
 * GetTransactionsList (pending approvals + settled vouchers + immediate-debit vouchers).
 *
 * The result has the library's shape (accounts → txns), so ingest, card-bill reconciliation and raw archiving
 * don't know the difference.
 */
import puppeteer, { type Browser, type HTTPResponse, type Page } from 'puppeteer';
import { BROWSER_ARGS, describePage, findChromePath, maskAutomation, profileDir } from './browser.js';


export type IsracardGroupCompany = 'isracard' | 'amex';

export const COMPANIES: Record<IsracardGroupCompany, { loginBaseUrl: string; webBaseUrl: string; companyCode: string }> = {
  isracard: { loginBaseUrl: 'https://digital.isracard.co.il', webBaseUrl: 'https://web.isracard.co.il', companyCode: '11' },
  amex: { loginBaseUrl: 'https://he.americanexpress.co.il', webBaseUrl: 'https://web.americanexpress.co.il', companyCode: '77' },
};

export interface IsracardGroupCredentials {
  id: string;
  /** the card's last 6 digits */
  card6Digits: string;
  password: string;
}

export interface ScrapedTxn {
  type: 'normal' | 'installments';
  identifier?: string;
  date: string;
  processedDate: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency: string;
  description: string;
  memo: string;
  status: 'pending' | 'completed';
  installments?: { number: number; total: number };
  category?: string;
  rawTransaction?: unknown;
}

export interface ScrapedCardAccount {
  accountNumber: string;
  balance?: number;
  balanceDate?: string;
  cardFrame?: number;
  txns: ScrapedTxn[];
}

export type IsracardGroupResult =
  | { success: true; accounts: ScrapedCardAccount[] }
  | { success: false; errorType: string; errorMessage?: string };

// ---------- login ----------

/** The login calls whose responses decide the outcome (ProxyRequestHandler.ashx?reqName=…). */
export const LOGIN_CALLS = ['ValidateIdDataNoReg', 'IsRegisterNoReg', 'performLogonI'] as const;
export type LoginCall = typeof LOGIN_CALLS[number];
export interface LoginResponse { call: LoginCall; body: unknown }

export type LoginOutcome =
  | { state: 'pending' }
  | { state: 'success' }
  | { state: 'failed'; errorType: string; errorMessage: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? v as Json : {});
const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * What the login page's responses so far mean — the same branches as the page's own LoginController
 * (handlePasswordValidateIdDataNoReg, IsRegisterNoReg, handlePerformLogon). Messages are the site's own text.
 */
export function loginOutcome(responses: LoginResponse[]): LoginOutcome {
  const captcha = (b: Json) => str(b.isCaptcha) === 'true';
  for (const { call, body } of responses) {
    const root = obj(body);
    // Isracard's bot protection answers with a text/HTML page ("Block Automation") instead of JSON
    if (str(root.status) === 'unparsable') return { state: 'failed', errorType: 'BLOCKED', errorMessage: `${call} answered with a non-JSON page (${str(root.message)})` };
    if (call === 'ValidateIdDataNoReg') {
      if (str(obj(root.Header).Status) !== '1') return { state: 'failed', errorType: 'GENERIC', errorMessage: 'ValidateIdDataNoReg failed' };
      const bean = obj(root.ValidateIdDataNoRegBean);
      const code = str(bean.returnCode);
      const message = str(bean.message);
      if (code === '1') continue;
      if (code === '4' || code === '49') return { state: 'failed', errorType: 'CHANGE_PASSWORD', errorMessage: message || 'password expired' };
      if (code === '7') return { state: 'failed', errorType: 'GENERIC', errorMessage: message || 'not registered for password login' };
      if (code === '5') return { state: 'failed', errorType: 'ACCOUNT_BLOCKED', errorMessage: message || 'account locked' };
      if (captcha(bean)) return { state: 'failed', errorType: 'CAPTCHA', errorMessage: message || 'the site asks for a CAPTCHA' };
      return { state: 'failed', errorType: 'INVALID_PASSWORD', errorMessage: message || `ValidateIdDataNoReg returnCode ${code}` };
    }
    if (call === 'IsRegisterNoReg') {
      if (str(obj(root.IsRegisterNoRegBean).returnCode) === '7') {
        return { state: 'failed', errorType: 'GENERIC', errorMessage: 'not registered for password login (IsRegisterNoReg 7)' };
      }
      continue;
    }
    // performLogonI
    const status = str(root.status);
    const message = str(root.message);
    if (status === '1') return { state: 'success' };
    if (status === '3' || str(root.returnCode) === '4') return { state: 'failed', errorType: 'CHANGE_PASSWORD', errorMessage: message || 'password expired' };
    if (captcha(root)) return { state: 'failed', errorType: 'CAPTCHA', errorMessage: message || 'the site asks for a CAPTCHA' };
    if (status === '2' && str(root.returnCode) === '665') return { state: 'failed', errorType: 'ACCOUNT_BLOCKED', errorMessage: message || 'blocked by the fraud monitor' };
    return { state: 'failed', errorType: 'INVALID_PASSWORD', errorMessage: message || `performLogonI status ${status}` };
  }
  return { state: 'pending' };
}

export const SELECTORS = {
  passwordSideLink: '#flip', // "או כניסה עם סיסמה קבועה" → vm.rotateView(true)
  flippedCard: '#card.flipped',
  form: '#otpLobbyFormPassword',
  id: '#otpLoginId_ID',
  card6Digits: '#cardnum',
  password: '#otpLoginPwd',
  submit: '#otpLobbyFormPassword button[type="submit"]',
};

/** Inputs of the login lobby itself — never mistaken for an OTP code box. */
const LOBBY_INPUT = /^(otpLoginId_SMS|otpLoginId_ID|cardnum|otpLoginPwd|digit-\d|digit4-\d|radio.*)$/;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jitter = (min: number, max: number) => sleep(min + Math.random() * (max - min));

/** A visible one-time-code box that isn't part of the lobby, if the site shows one after the password. */
async function findOtpInput(page: Page): Promise<string | null> {
  return page.evaluate((lobbySource: string) => {
    const lobby = new RegExp(lobbySource);
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;
    const input = [...document.querySelectorAll('input')].find(i =>
      visible(i) && !lobby.test(i.id) && /^(tel|text|number|password)$/.test(i.type)
      && /otp|sms|code|קוד/i.test(`${i.id} ${i.name} ${i.className} ${i.getAttribute('placeholder') ?? ''} ${i.getAttribute('aria-label') ?? ''}`));
    if (!input) return null;
    if (!input.id) input.id = 'familycfo-otp';
    return `#${input.id}`;
  }, LOBBY_INPUT.source);
}

async function typeOtp(page: Page, selector: string, code: string): Promise<void> {
  const boxes = await page.$$(`${selector}, ${selector} ~ input`);
  if (boxes.length > 1 && boxes.length >= code.length) {
    for (let i = 0; i < code.length; i++) await boxes[i].type(code[i], { delay: 60 });
  } else {
    await page.type(selector, code, { delay: 60 });
  }
  // submit the form/popup that holds the code box
  await page.evaluate((sel: string) => {
    const input = document.querySelector(sel) as HTMLInputElement | null;
    const scope = input?.closest('form, [role="dialog"], .modal, .popup') ?? document;
    const button = [...scope.querySelectorAll('button, input[type="submit"]')]
      .find(b => (b as HTMLElement).offsetParent !== null && !(b as HTMLButtonElement).disabled) as HTMLElement | undefined;
    button?.click();
  }, selector);
}

export interface LoginOptions {
  requestOtp?: () => Promise<string>;
  /** how long to wait for the site's verdict after submitting */
  timeoutMs?: number;
  /** fill the form and stop before submitting (rehearsal) */
  dryRun?: boolean;
}

/**
 * Log in through the page. Submits the password at most once; refuses to submit when the typed fields don't hold
 * exactly what was meant to be typed (a mistyped password counts toward the lockout).
 */
export async function loginViaPage(page: Page, company: IsracardGroupCompany, credentials: IsracardGroupCredentials,
  options: LoginOptions = {}): Promise<LoginOutcome> {
  const { loginBaseUrl } = COMPANIES[company];
  const responses: LoginResponse[] = [];
  const onResponse = async (response: HTTPResponse) => {
    const call = LOGIN_CALLS.find(c => new RegExp(`[?&]reqName=${c}(&|$)`, 'i').test(response.url()));
    if (!call) return;
    try {
      responses.push({ call, body: JSON.parse(await response.text()) });
    } catch {
      const text = await response.text().catch(() => '');
      responses.push({ call, body: { status: 'unparsable', message: `HTTP ${response.status()}: ${text.replace(/\s+/g, ' ').slice(0, 80)}` } });
    }
  };
  page.on('response', onResponse);
  try {
    await page.goto(`${loginBaseUrl}/personalarea/Login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(SELECTORS.passwordSideLink, { visible: true, timeout: 30_000 });
    await jitter(800, 1600);
    await page.click(SELECTORS.passwordSideLink);
    await page.waitForSelector(SELECTORS.flippedCard, { timeout: 10_000 });
    await page.waitForSelector(SELECTORS.password, { visible: true, timeout: 10_000 });
    await jitter(500, 1000);

    // The password field drops every key outside [a-z0-9] (its `englishAndNumbers` keydown handler), so a stored
    // password with a symbol logs in on the site as its letters and digits only — send exactly that.
    const password = credentials.password.replace(/[^a-z0-9]/gi, '');
    for (const [selector, value] of [[SELECTORS.id, credentials.id], [SELECTORS.card6Digits, credentials.card6Digits],
      [SELECTORS.password, password]] as const) {
      await page.click(selector);
      await page.type(selector, value, { delay: 70 + Math.random() * 60 });
      await jitter(300, 700);
    }

    // lengths only — values never leave the page
    const typed = await page.evaluate((s: typeof SELECTORS) => ({
      id: (document.querySelector(s.id) as HTMLInputElement | null)?.value.length ?? -1,
      card: (document.querySelector(s.card6Digits) as HTMLInputElement | null)?.value.length ?? -1,
      password: (document.querySelector(s.password) as HTMLInputElement | null)?.value.length ?? -1,
      formValid: document.querySelector(s.form)?.classList.contains('ng-valid') ?? false,
    }), SELECTORS);
    if (typed.id !== credentials.id.length || typed.card !== credentials.card6Digits.length
      || typed.password !== password.length || !typed.formValid) {
      return { state: 'failed', errorType: 'GENERIC',
        errorMessage: `login form not filled as expected (lengths id ${typed.id}, card ${typed.card}, form ${typed.formValid ? 'valid' : 'invalid'}) — password not submitted` };
    }

    if (options.dryRun) return { state: 'pending' };
    await page.click(SELECTORS.submit);

    const deadline = Date.now() + (options.timeoutMs ?? 90_000);
    let otpHandled = false;
    while (Date.now() < deadline) {
      const outcome = loginOutcome(responses);
      if (outcome.state === 'success') {
        // the page redirects to the personal area once its own handler has set the login cookie
        await page.waitForFunction(() => !/\/personalarea\/login/i.test(location.pathname), { timeout: 30_000 }).catch(() => {});
        return outcome;
      }
      if (outcome.state === 'failed') {
        // A successful performLogonI navigates away at once, so its body can come back empty and read as a block.
        // If the page then leaves the login page for the logged-in site, the login worked.
        if (outcome.errorType === 'BLOCKED' && responses.some(r => r.call === 'performLogonI')) {
          const loggedIn = await page.waitForFunction(
            () => /isracard\.co\.il|americanexpress\.co\.il/i.test(location.hostname) && !/\/personalarea\/login/i.test(location.pathname),
            { timeout: 15_000, polling: 500 },
          ).then(() => true, () => false);
          if (loggedIn) return { state: 'success' };
        }
        return outcome;
      }
      // an OTP step can only come after the site accepted the ID, card and password
      const validated = responses.some(r => r.call === 'ValidateIdDataNoReg');
      if (validated && !otpHandled) {
        const otpInput = await findOtpInput(page).catch(() => null);
        if (otpInput) {
          otpHandled = true;
          console.log('\n📱 Isracard OTP popup detected!');
          const code = options.requestOtp ? await options.requestOtp() : '';
          if (!code) return { state: 'failed', errorType: 'TWO_FACTOR_RETRIEVER_MISSING', errorMessage: 'no OTP code given' };
          await typeOtp(page, otpInput, code);
          // an OTP login lands in the personal area without a performLogonI response
          const landed = await page.waitForFunction(() => !/\/personalarea\/login/i.test(location.pathname), { timeout: 60_000 })
            .then(() => true, () => false);
          if (landed) return { state: 'success' };
        }
      }
      await sleep(500);
    }
    return { state: 'failed', errorType: 'TIMEOUT', errorMessage: 'no answer from the login page' };
  } finally {
    page.off('response', onResponse);
  }
}

// ---------- data (DigitalV3 API) ----------

export interface ApiCard {
  companyCode: string | number;
  cardStatus: string | number;
  cardSuffix: string;
  serviceType: string | number;
  isActive: boolean;
  isBlock: boolean;
  isPartner: boolean;
  limitData?: { creditLimitAmount?: string | number; limitUsed?: string | number } | null;
  cardChargeNext?: { billingDate?: string } | null;
}

export interface ApiApproval {
  purchaseDate: string;
  israelTransactionTime?: string | null;
  businessName?: string | null;
  originalAmount: number;
  currencyIso?: string | null;
  ilsBillingAmount: number;
  extraDetails?: string | null;
  seqConfirmationNumber?: string | null;
  branchCodeDescription?: string | null;
}

export interface ApiVoucher {
  purchaseDate: string;
  purchaseTime?: string | null;
  businessName?: string | null;
  originalAmount: number;
  originalCurrencyIso?: string | null;
  billingAmount: number;
  moreInfo?: string | null;
  seqVoucherNumber?: string | null;
  currentInstallmentNum?: number | null;
  numberOfInstallment?: number | null;
  transactionDescription?: string | null;
}

export interface ApiTransactionsData {
  approvals?: { approvedTransactions?: ApiApproval[] | null } | null;
  israelAbroadVouchers?: {
    vouchers?: { israelAbroadVouchersList?: ApiVoucher[] | null } | null;
    outOfStatementChargeDateVouchers?: {
      immediateVouchersCurrencyDate?: ApiVoucher[] | null;
      totalVouchersCurrencyDate?: { dateImmediateVouchers?: string } | null;
    }[] | null;
  } | null;
}

/** "DD/MM/YYYY" (+ optional "HH:mm[:ss]") in Israel local time → ISO, like the library's moment parsing. */
export function parseIsraeliDate(date: string, time?: string | null): string {
  const [d, m, y] = date.split('/').map(Number);
  const [hh = 0, mm = 0, ss = 0] = (time ?? '').split(':').filter(Boolean).map(Number);
  const parsed = new Date(y, m - 1, d, hh, mm, ss);
  if (Number.isNaN(parsed.getTime()) || !y || !m || !d) throw new Error(`unexpected date "${date}"`);
  return parsed.toISOString();
}

const SHEKEL = 'ILS';
const currency = (iso: string | null | undefined) => (!iso || iso === '₪' || iso === 'ש"ח' || iso === 'NIS' ? SHEKEL : iso);
const num = (v: unknown): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export function convertApproval(txn: ApiApproval, processedDate?: string): ScrapedTxn {
  // old records can come without a purchase date — fall back to the charge date
  const date = txn.purchaseDate ? parseIsraeliDate(txn.purchaseDate, txn.israelTransactionTime) : (processedDate ?? new Date().toISOString());
  return {
    type: 'normal',
    identifier: txn.seqConfirmationNumber || undefined,
    date,
    processedDate: processedDate ?? date,
    originalAmount: -txn.originalAmount,
    originalCurrency: currency(txn.currencyIso),
    chargedAmount: -txn.ilsBillingAmount,
    chargedCurrency: SHEKEL,
    description: (txn.businessName ?? '').trim(),
    memo: (txn.extraDetails ?? '').trim(),
    category: txn.branchCodeDescription?.trim() || undefined,
    status: 'pending',
    rawTransaction: txn,
  };
}

export function convertVoucher(voucher: ApiVoucher, processedDate: string): ScrapedTxn {
  const installments = voucher.numberOfInstallment && voucher.currentInstallmentNum
    ? { number: voucher.currentInstallmentNum, total: voucher.numberOfInstallment } : undefined;
  return {
    type: installments ? 'installments' : 'normal',
    identifier: voucher.seqVoucherNumber || undefined,
    date: voucher.purchaseDate ? parseIsraeliDate(voucher.purchaseDate, voucher.purchaseTime) : processedDate,
    processedDate,
    originalAmount: -voucher.originalAmount,
    originalCurrency: currency(voucher.originalCurrencyIso),
    chargedAmount: -voucher.billingAmount,
    chargedCurrency: SHEKEL,
    description: (voucher.businessName ?? '').trim(),
    memo: (voucher.moreInfo ?? '').trim(),
    // settled vouchers carry no merchant category (transactionDescription is the deal type, e.g. "עסקאות רגילות")
    category: undefined,
    installments,
    status: 'completed',
    rawTransaction: voucher,
  };
}

/** Settled vouchers of one GetTransactionsList response, each with its charge date. */
export function monthVouchers(data: ApiTransactionsData, processedDate: string): ScrapedTxn[] {
  const groups = data.israelAbroadVouchers?.outOfStatementChargeDateVouchers ?? [];
  return [
    ...(data.israelAbroadVouchers?.vouchers?.israelAbroadVouchersList ?? []).map(v => convertVoucher(v, processedDate)),
    // immediate-debit vouchers are charged on their own date, outside the monthly statement
    ...groups.flatMap(g => {
      const groupDate = g.totalVouchersCurrencyDate?.dateImmediateVouchers;
      const charged = groupDate ? parseIsraeliDate(groupDate) : processedDate;
      return (g.immediateVouchersCurrencyDate ?? []).map(v => convertVoucher(v, charged));
    }),
  ];
}

const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * One card's transactions from all its monthly responses. The same approval comes back in every month's response and
 * stays there after it settles, so approvals are de-duplicated and dropped once a voucher (any month) shows the same
 * purchase (date + amount + currency + merchant). Pending charges are dated to the card's next charge date.
 */
export function cardTransactions(months: { data: ApiTransactionsData; processedDate: string }[], nextChargeDate?: string): ScrapedTxn[] {
  const vouchers = months.flatMap(m => monthVouchers(m.data, m.processedDate));
  const seen = new Set<string>();
  const settled = vouchers.filter(v => {
    const key = [v.identifier, v.installments?.number ?? '', v.date, v.processedDate, v.chargedAmount, v.description].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const approvals: ScrapedTxn[] = [];
  const seenApprovals = new Set<string>();
  for (const m of months) {
    for (const a of m.data.approvals?.approvedTransactions ?? []) {
      const txn = convertApproval(a, nextChargeDate);
      const key = [txn.identifier, txn.date, txn.originalAmount, txn.originalCurrency, txn.description].join('|');
      if (seenApprovals.has(key)) continue;
      seenApprovals.add(key);
      const isSettled = settled.some(v => sameDay(v.date, txn.date) && v.originalAmount === txn.originalAmount
        && v.originalCurrency === txn.originalCurrency && v.description === txn.description);
      if (!isSettled) approvals.push(txn);
    }
  }
  return [...approvals, ...settled];
}

/** Like the library with combineInstallments: false — installment n is dated n-1 months after the purchase. */
export function fixInstallments(txns: ScrapedTxn[]): ScrapedTxn[] {
  return txns.map(t => {
    if (t.type !== 'installments' || !t.installments || t.installments.number <= 1) return t;
    const d = new Date(t.date);
    d.setMonth(d.getMonth() + t.installments.number - 1);
    return { ...t, date: d.toISOString() };
  });
}

export function cardAccount(card: ApiCard, txns: ScrapedTxn[], startDate: Date): ScrapedCardAccount {
  const used = num(card.limitData?.limitUsed);
  const next = card.cardChargeNext?.billingDate;
  return {
    accountNumber: card.cardSuffix,
    balance: used === undefined ? undefined : -used,
    balanceDate: next ? parseIsraeliDate(next) : undefined,
    cardFrame: num(card.limitData?.creditLimitAmount),
    txns: fixInstallments(txns).filter(t => Date.parse(t.date) >= startDate.getTime()),
  };
}

/** First of each month from startDate's month through futureMonths after this one. */
export function monthsToFetch(startDate: Date, futureMonths: number, now = new Date()): Date[] {
  const months: Date[] = [];
  const last = new Date(now.getFullYear(), now.getMonth() + futureMonths, 1);
  for (let m = new Date(startDate.getFullYear(), startDate.getMonth(), 1); m <= last; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
    months.push(m);
  }
  return months;
}

const pad = (n: number) => String(n).padStart(2, '0');

interface ApiEnvelope<T> { isSuccess?: boolean; data?: T | null; errorCode?: string; errorDescription?: string | null }
export type PostJson = (url: string, body: unknown) => Promise<unknown>;

function unwrap<T>(what: string, response: unknown): T {
  const r = obj(response) as ApiEnvelope<T>;
  if (!r.isSuccess || !r.data) throw new Error(`${what} failed: ${r.errorDescription || r.errorCode || 'unknown error'}`);
  return r.data;
}

export interface FetchOptions {
  startDate: Date;
  futureMonths: number;
  now?: Date;
  /** pause between API calls (rate limiting); tests pass a no-op */
  pause?: () => Promise<void>;
}

/** Every active card on the login, with its transactions — through any `postJson` (the logged-in page in production). */
export async function fetchCardData(postJson: PostJson, company: IsracardGroupCompany, options: FetchOptions): Promise<ScrapedCardAccount[]> {
  const { webBaseUrl, companyCode } = COMPANIES[company];
  const api = `${webBaseUrl}/ocp/transactions/DigitalV3.Transactions`;
  const pause = options.pause ?? (() => jitter(2500, 3000));
  const companyNumber = Number(companyCode);

  const cardList = unwrap<{ cardsList?: ApiCard[] }>('GetCardList',
    await postJson(`${api}/GetCardList`, { companyCode: '99', cardSuffixLength: 4 }));
  const cards = (cardList.cardsList ?? []).filter(c => String(c.companyCode) === companyCode && c.isActive && !c.isBlock);

  const months = monthsToFetch(options.startDate, options.futureMonths, options.now);
  const currentMonth = new Date((options.now ?? new Date()).getFullYear(), (options.now ?? new Date()).getMonth(), 1);
  const accounts: ScrapedCardAccount[] = [];
  for (const card of cards) {
    const responses: { data: ApiTransactionsData; processedDate: string }[] = [];
    for (const month of months) {
      await pause();
      const billing = unwrap<{ cards?: Record<string, { billingDate?: string }> }>('GetMonthlyBilling',
        await postJson(`${api}/GetMonthlyBilling`, {
          cards: [{ cardStatus: Number(card.cardStatus), cardSuffix: card.cardSuffix, companyCode: companyNumber,
            serviceType: Number(card.serviceType), isPartner: card.isPartner }],
          billingDate: `${pad(month.getMonth() + 1)}/${month.getFullYear()}`,
        }));
      const billingDate = billing.cards?.[card.cardSuffix]?.billingDate;
      const processedDate = billingDate ? parseIsraeliDate(billingDate) : month.toISOString();

      await pause();
      const data = unwrap<ApiTransactionsData>('GetTransactionsList', await postJson(`${api}/GetTransactionsList`, {
        card4Number: card.cardSuffix,
        isNextBillingDate: month > currentMonth,
        cardStatus: Number(card.cardStatus),
        billingMonth: `01/${pad(month.getMonth() + 1)}/${month.getFullYear()}`,
        companyCode: companyNumber,
        isPartner: card.isPartner,
      }));
      responses.push({ data, processedDate });
    }
    const next = card.cardChargeNext?.billingDate ? parseIsraeliDate(card.cardChargeNext.billingDate) : undefined;
    accounts.push(cardAccount(card, cardTransactions(responses, next), options.startDate));
  }
  return accounts;
}

/** POST JSON from inside the page, so the request carries the session's cookies and the page's origin. */
export function pagePostJson(page: Page): PostJson {
  return async (url, body) => {
    const { status, text } = await page.evaluate(async (u: string, b: string) => {
      const res = await fetch(u, { method: 'POST', credentials: 'include', body: b,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
      return { status: res.status, text: await res.text() };
    }, url, JSON.stringify(body));
    const endpoint = url.split('/').pop();
    if (status === 429 || /block automation|bot detection|you have been blocked/i.test(text)) {
      throw new Error(`${endpoint}: blocked as automation (HTTP ${status})`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${endpoint}: HTTP ${status}, not JSON`);
    }
  };
}

// ---------- the whole scrape ----------

export interface ScrapeIsracardGroupOptions {
  company: IsracardGroupCompany;
  /** the Chrome profile under data/browser-profile/ — the source id (default: the company) */
  profile?: string;
  credentials: IsracardGroupCredentials;
  startDate: Date;
  futureMonths: number;
  showBrowser: boolean;
  requestOtp?: () => Promise<string>;
  /** with the browser visible, wait for a login finished by hand (default: showBrowser; never in an unattended run) */
  finishByHand?: boolean;
  /** where the browser was when it failed (visible text only) */
  onFailurePage?: (description: string) => void;
}

export async function scrapeIsracardGroup(options: ScrapeIsracardGroupOptions): Promise<IsracardGroupResult> {
  const { company, credentials } = options;
  if (!credentials.id || !credentials.card6Digits || !credentials.password) {
    return { success: false, errorType: 'GENERIC', errorMessage: 'credentials need id, card6Digits and password' };
  }
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    // A persistent profile keeps Isracard's device cookies between runs, like a person's browser; no
    // `--enable-automation` switch and no request interception (blocking its detector script is itself a tell).
    browser = await puppeteer.launch({
      headless: !options.showBrowser, executablePath: findChromePath(), args: BROWSER_ARGS,
      ignoreDefaultArgs: ['--enable-automation'], userDataDir: profileDir(options.profile ?? company),
    });
    page = (await browser.pages())[0] ?? await browser.newPage();
    page.setDefaultTimeout(120_000);
    await maskAutomation(page);

    let login = await loginViaPage(page, company, credentials, { requestOtp: options.requestOtp });
    // With the browser visible, a login the page won't finish (bot block, CAPTCHA, an unexpected step) can be
    // finished by hand in the same window; the scrape then continues on that session.
    if (login.state !== 'success' && (options.finishByHand ?? options.showBrowser) && !(login.state === 'failed' && ['ACCOUNT_BLOCKED', 'CHANGE_PASSWORD'].includes(login.errorType))) {
      console.log(`\n⚠️  ${company}: ${login.state === 'failed' ? login.errorMessage : 'login did not finish'}`);
      console.log('   Finish the login by hand in the Chrome window (3 minutes) — the scrape continues once you are in.');
      const landed = await page.waitForFunction(() => !/\/personalarea\/login/i.test(location.pathname), { timeout: 180_000, polling: 1000 })
        .then(() => true, () => false);
      if (landed) login = { state: 'success' };
    }
    if (login.state !== 'success') {
      const failure = login.state === 'failed' ? login : { errorType: 'GENERIC', errorMessage: 'login did not finish' };
      options.onFailurePage?.(await describePage(page));
      return { success: false, errorType: failure.errorType, errorMessage: failure.errorMessage };
    }
    console.log(`  ${company}: logged in`);

    // the DigitalV3 API is called from its own origin, as its web app does
    await page.goto(`${COMPANIES[company].webBaseUrl}/transactions`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await jitter(2000, 3000);
    const accounts = await fetchCardData(pagePostJson(page), company, { startDate: options.startDate, futureMonths: options.futureMonths });
    return { success: true, accounts };
  } catch (err) {
    if (page) options.onFailurePage?.(await describePage(page).catch(() => ''));
    return { success: false, errorType: 'GENERIC', errorMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser?.close().catch(() => {});
  }
}
