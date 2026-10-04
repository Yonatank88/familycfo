/**
 * Cal (Visa Cal), replacing israeli-bank-scrapers' visa-cal scraper.
 *
 * Login drives the real login popup on www.cal-online.co.il: "#ccLoginDesktopBtn" opens an iframe from
 * connect.cal-online.co.il (an Angular app that routes itself: /send-otp → /regular-login → /verify-otp, /error, …).
 * The iframe is looked up by URL before every step and never held across a navigation, so a re-attached or swapped
 * frame can't leave a stale handle. Its own script posts col-rest/calconnect/authentication/login; we only read that
 * response ({ token } on success, 412 = change password, else the site's message). The form is submitted at most once.
 *
 * Data comes from the same api.cal-online.co.il endpoints the library uses (GetFrameStatus, getClearanceRequests,
 * getCardTransactionsDetails), called from inside the logged-in digital-web page with `CALAuthScheme <token>`, so the
 * requests carry the real browser's fingerprint. The result has the library's shape (accounts → txns).
 */
import puppeteer, { type Browser, type Frame, type HTTPResponse, type Page } from 'puppeteer';
import { BROWSER_ARGS, describePage, findChromePath, maskAutomation, profileDir } from './browser.js';
import { monthsToFetch, type ScrapedCardAccount, type ScrapedTxn } from './isracardGroup.js';
import { normalizeCurrency } from '../analytics/fx.js';

export const HOME_URL = 'https://www.cal-online.co.il/';
const API = 'https://api.cal-online.co.il';
export const ENDPOINTS = {
  login: /\/col-rest\/calconnect\/authentication\/login(\?|$)/i,
  frames: `${API}/Frames/api/Frames/GetFrameStatus`,
  pending: `${API}/Transactions/api/approvals/getClearanceRequests`,
  transactions: `${API}/Transactions/api/transactionsDetails/getCardTransactionsDetails`,
};
/** the login app's constant site id (the library's getXSiteId) */
export const X_SITE_ID = '09031987-273E-2311-906C-8AF85B17C8D9';
/** the login iframe: connect.cal-online.co.il, or the same app served under digital-web's /calconnect/ */
export const LOGIN_FRAME_URL = /^https:\/\/(connect\.cal-online\.co\.il\/|digital-web\.cal-online\.co\.il\/calconnect\/)/i;
/** where the main page lands once logged in */
export const DIGITAL_WEB_URL = /^https:\/\/digital-web\.cal-online\.co\.il\/(?!calconnect\/)/i;

export const SELECTORS = {
  loginButton: '#ccLoginDesktopBtn',
  passwordTab: '#regular-login',
  passwordForm: 'regular-login form',
  userName: 'regular-login [formcontrolname="userName"]',
  password: 'regular-login [formcontrolname="password"]',
  submit: 'regular-login button[type="submit"]',
  otpInput: 'verify-otp input[maxlength="6"], verify-otp input[autocomplete="one-time-code"]',
  otpSubmit: 'verify-otp button[type="submit"]',
};

export interface CalCredentials {
  username: string;
  password: string;
}

export type CalResult =
  | { success: true; accounts: ScrapedCardAccount[] }
  | { success: false; errorType: string; errorMessage?: string };

// ---------- login ----------

export const INVALID_PASSWORD_MESSAGE = 'שם המשתמש או הסיסמה שהוזנו שגויים';
/** "הכניסה למנוי נחסמה…" — the login app reports this one to its fraud log */
export const BLOCKED_MESSAGE = 'הכניסה למנוי נחסמה';

export interface LoginResponse { status: number; body: unknown }

export type LoginOutcome =
  | { state: 'pending' }
  | { state: 'success'; token?: string }
  | { state: 'failed'; errorType: string; errorMessage: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? v as Json : {});
const str = (v: unknown): string => (v == null ? '' : String(v));

/** The site's message in an error body: a JSON string, or one of the usual fields. */
function messageOf(body: unknown): string {
  if (typeof body === 'string') return body;
  const b = obj(body);
  return str(b.message ?? b.statusDescription ?? b.title ?? b.error ?? b.statusTitle);
}

/** A rejection the site words — the same branches as the login app's callServer (412 → change-password, else /error). */
export function messageOutcome(message: string): LoginOutcome & { state: 'failed' } | null {
  if (message.includes(INVALID_PASSWORD_MESSAGE)) return { state: 'failed', errorType: 'INVALID_PASSWORD', errorMessage: message };
  if (message.includes(BLOCKED_MESSAGE)) return { state: 'failed', errorType: 'ACCOUNT_BLOCKED', errorMessage: message };
  return null;
}

/** What the authentication/login response means. */
export function loginOutcome(response: LoginResponse | null): LoginOutcome {
  if (!response) return { state: 'pending' };
  const { status, body } = response;
  const root = obj(body);
  // a WAF / bot-protection page instead of the API's JSON
  if (str(root.status) === 'unparsable' || status === 403 || status === 429) {
    return { state: 'failed', errorType: 'BLOCKED', errorMessage: `authentication/login answered HTTP ${status}${root.message ? ` (${str(root.message)})` : ''}` };
  }
  if (status >= 200 && status < 300) {
    const token = str(root.token).trim();
    return token ? { state: 'success', token } : { state: 'failed', errorType: 'GENERIC', errorMessage: 'authentication/login returned no token' };
  }
  if (status === 412) return { state: 'failed', errorType: 'CHANGE_PASSWORD', errorMessage: messageOf(body) || 'Cal asks for a new password' };
  const message = messageOf(body);
  const known = messageOutcome(message);
  if (known) return known;
  // any other refusal of the password counts toward the lockout like a wrong password
  if (status >= 400 && status < 500) return { state: 'failed', errorType: 'INVALID_PASSWORD', errorMessage: message || `authentication/login HTTP ${status}` };
  return { state: 'failed', errorType: 'GENERIC', errorMessage: message || `authentication/login HTTP ${status}` };
}

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export type FrameRoute = 'send-otp' | 'regular-login' | 'verify-otp' | 'change-password' | 'banking-approval'
  | 'passwordless-register' | 'error' | 'other';

/** Which step the login iframe shows, from its URL (Angular routes, matrix params after ";"). */
export function frameRoute(url: string): FrameRoute {
  const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })().replace(/^\/calconnect/i, '');
  const first = path.split('/').filter(Boolean)[0]?.split(';')[0] ?? '';
  const routes: FrameRoute[] = ['send-otp', 'regular-login', 'verify-otp', 'change-password', 'banking-approval', 'passwordless-register', 'error'];
  return routes.find(r => r === first) ?? 'other';
}

/**
 * What the iframe's route says when the response wasn't read: the error route carries the message as a matrix param
 * (…/error;…;status=400;…;error=<message>, eshaham/israeli-bank-scrapers#1184), change-password is its own route.
 */
export function routeOutcome(url: string): LoginOutcome {
  const route = frameRoute(url);
  if (route === 'change-password') return { state: 'failed', errorType: 'CHANGE_PASSWORD', errorMessage: 'Cal asks for a new password' };
  if (route !== 'error') return { state: 'pending' };
  const decoded = safeDecode(url);
  const message = decoded.match(/;error=([^;]*)/)?.[1] ?? '';
  return messageOutcome(message)
    ?? { state: 'failed', errorType: 'GENERIC', errorMessage: `the login shows an error${message ? `: ${message}` : ''}` };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jitter = (min: number, max: number) => sleep(min + Math.random() * (max - min));

/** The login iframe, looked up fresh (never a handle kept from before a navigation). */
export function findLoginFrame(page: Page): Frame | undefined {
  return page.frames().find(f => f !== page.mainFrame() && !f.detached && LOGIN_FRAME_URL.test(f.url()));
}

async function waitForLoginFrame(page: Page, timeoutMs = 20_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = findLoginFrame(page);
    if (frame) return frame;
    if (Date.now() > deadline) throw new Error('the Cal login frame did not appear');
    await sleep(250);
  }
}

const DETACHED = /detached|Execution context was destroyed|Cannot find context|Target closed|frame was removed/i;

/** Run `fn` on the current login frame; a frame that detaches or navigates mid-step is looked up again and retried. */
async function inLoginFrame<T>(page: Page, fn: (frame: Frame) => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    const frame = await waitForLoginFrame(page);
    try {
      return await fn(frame);
    } catch (err) {
      if (i >= attempts || !DETACHED.test(String(err))) throw err;
      await sleep(750);
    }
  }
}

/** Empty a field the Angular way (value + input event), so a retried step never types after a partial value. */
async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  await inLoginFrame(page, async frame => {
    await frame.waitForSelector(selector, { visible: true, timeout: 15_000 });
    await frame.$eval(selector, el => {
      (el as HTMLInputElement).value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await frame.click(selector);
    await frame.type(selector, value, { delay: 70 + Math.random() * 60 });
  });
}

export interface LoginOptions {
  requestOtp?: () => Promise<string>;
  /** how long to wait for the site's verdict after submitting */
  timeoutMs?: number;
  /** fill the form and stop before submitting (rehearsal) */
  dryRun?: boolean;
}

/** The username the form accepts (maxlength 8) and the password its validator wants (^[0-9a-zA-z]{8,64}$ with an 8-character username). */
export function credentialsProblem(credentials: CalCredentials): string | null {
  if (!credentials.username || credentials.username.length > 8) return `username must be 1–8 characters (has ${credentials.username?.length ?? 0})`;
  // the form adds this validator once the username has 8 characters
  if (credentials.username.length === 8 && !/^[0-9a-zA-z]{8,64}$/.test(credentials.password ?? '')) {
    return 'password must be 8–64 letters and digits (the Cal form accepts nothing else)';
  }
  if (!credentials.password || credentials.password.length > 64) return 'password must be 1–64 characters';
  return null;
}

/**
 * Log in through the popup. Submits the password at most once, and only after checking the form holds exactly what
 * was typed (a mistyped password counts toward the lockout).
 */
export async function loginViaPage(page: Page, credentials: CalCredentials, options: LoginOptions = {}): Promise<LoginOutcome> {
  const problem = credentialsProblem(credentials);
  if (problem) return { state: 'failed', errorType: 'GENERIC', errorMessage: `${problem} — password not submitted` };

  let response: LoginResponse | null = null;
  const onResponse = async (res: HTTPResponse) => {
    if (res.request().method() !== 'POST' || !ENDPOINTS.login.test(res.url())) return;
    const text = await res.text().catch(() => '');
    try {
      response = { status: res.status(), body: JSON.parse(text) };
    } catch {
      // a plain-text message is the site's own; an HTML page is bot protection
      response = /<html|<!doctype/i.test(text)
        ? { status: res.status(), body: { status: 'unparsable', message: text.replace(/\s+/g, ' ').slice(0, 80) } }
        : { status: res.status(), body: text };
    }
  };
  page.on('response', onResponse);
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector(SELECTORS.loginButton, { visible: true, timeout: 30_000 });
    await jitter(1000, 2000);
    await page.click(SELECTORS.loginButton);

    // the popup opens on the SMS tab; the username + password tab is its sibling
    await inLoginFrame(page, async frame => {
      await frame.waitForSelector(SELECTORS.passwordTab, { visible: true, timeout: 20_000 });
    });
    await jitter(600, 1200);
    await inLoginFrame(page, frame => frame.click(SELECTORS.passwordTab));
    await inLoginFrame(page, async frame => {
      await frame.waitForSelector(SELECTORS.password, { visible: true, timeout: 15_000 });
    });
    await jitter(500, 1000);

    await typeInto(page, SELECTORS.userName, credentials.username);
    await jitter(300, 700);
    await typeInto(page, SELECTORS.password, credentials.password);
    await jitter(400, 800);

    // lengths only — values never leave the page
    const typed = await inLoginFrame(page, frame => frame.evaluate((s: typeof SELECTORS) => ({
      route: location.pathname,
      userName: (document.querySelector(s.userName) as HTMLInputElement | null)?.value.length ?? -1,
      password: (document.querySelector(s.password) as HTMLInputElement | null)?.value.length ?? -1,
      formValid: document.querySelector(s.passwordForm)?.classList.contains('ng-valid') ?? false,
      submit: !!document.querySelector(s.submit),
    }), SELECTORS));
    if (typed.userName !== credentials.username.length || typed.password !== credentials.password.length
      || !typed.formValid || !typed.submit || !/regular-login/.test(typed.route)) {
      return { state: 'failed', errorType: 'GENERIC',
        errorMessage: `login form not filled as expected (lengths user ${typed.userName}, password ${typed.password === credentials.password.length ? 'ok' : typed.password}, form ${typed.formValid ? 'valid' : 'invalid'}, route ${typed.route}) — password not submitted` };
    }

    if (options.dryRun) return { state: 'pending' };

    // the one and only submit: never retried, even if the frame swaps under the click
    let clickError: unknown;
    try {
      await inLoginFrame(page, frame => frame.click(SELECTORS.submit), 1);
    } catch (err) {
      clickError = err;
    }

    const deadline = Date.now() + (options.timeoutMs ?? 90_000);
    const clickDeadline = Date.now() + 20_000;
    let otpHandled = false;
    while (Date.now() < deadline) {
      const outcome = loginOutcome(response);
      if (outcome.state !== 'pending') return outcome;
      // the main page already moved to the personal area (a login the app finished without our reading it)
      if (DIGITAL_WEB_URL.test(page.url())) return { state: 'success' };
      const frame = findLoginFrame(page);
      if (frame) {
        const byRoute = routeOutcome(frame.url());
        if (byRoute.state === 'failed') return byRoute;
        if (frameRoute(frame.url()) === 'verify-otp' && !otpHandled) {
          otpHandled = true;
          console.log('\n📱 Cal asks for a one-time code');
          const code = options.requestOtp ? await options.requestOtp() : '';
          if (!code) return { state: 'failed', errorType: 'TWO_FACTOR_RETRIEVER_MISSING', errorMessage: 'no OTP code given' };
          await typeInto(page, SELECTORS.otpInput, code);
          await inLoginFrame(page, f => f.click(SELECTORS.otpSubmit), 1);
        }
      }
      if (clickError && !response && Date.now() > clickDeadline) {
        return { state: 'failed', errorType: 'GENERIC', errorMessage: `the submit click failed (${String(clickError).slice(0, 120)}) and no login request followed` };
      }
      await sleep(500);
    }
    return { state: 'failed', errorType: 'TIMEOUT', errorMessage: 'no answer from the login popup' };
  } finally {
    page.off('response', onResponse);
  }
}

/** The calConnect token and the card list the digital-web app keeps in its session storage once logged in. */
export async function readSession(page: Page): Promise<{ token?: string; cards?: { cardUniqueId: string; last4Digits: string }[] }> {
  if (!DIGITAL_WEB_URL.test(page.url())) return {};
  // no named helper functions inside: tsx's keepNames would wrap them in a __name() the page doesn't have
  return page.evaluate(() => {
    const [auth, init] = ['auth-module', 'init'].map(key => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { return null; } });
    const token = auth?.auth?.calConnectToken;
    const cards = init?.result?.cards;
    return {
      token: typeof token === 'string' && token.trim() ? token.trim() : undefined,
      cards: Array.isArray(cards) ? cards.map((c: { cardUniqueId: string; last4Digits: string }) => ({ cardUniqueId: c.cardUniqueId, last4Digits: c.last4Digits })) : undefined,
    };
  }).catch(() => ({}));
}

/** Wait for the main page to land on digital-web with its session (token + cards). */
async function waitForSession(page: Page, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let session: Awaited<ReturnType<typeof readSession>> = {};
  while (Date.now() < deadline) {
    session = await readSession(page);
    if (session.token && session.cards) return session;
    await sleep(1000);
  }
  return session;
}

// ---------- data ----------

export const TRN_TYPE = { regular: '5', credit: '6', installments: '8', standingOrder: '9' } as const;

export interface ApiCompletedTxn {
  trnIntId: string;
  trnPurchaseDate: string;
  debCrdDate: string;
  merchantName: string;
  trnAmt: number;
  trnCurrencySymbol: string;
  amtBeforeConvAndIndex: number;
  debCrdCurrencySymbol: string;
  trnTypeCode: string;
  numOfPayments?: number | null;
  curPaymentNum?: number | null;
  branchCodeDesc?: string | null;
  transTypeCommentDetails?: unknown[] | null;
}

export interface ApiPendingTxn {
  merchantName: string;
  trnPurchaseDate: string;
  trnAmt: number;
  trnCurrencySymbol: string;
  trnTypeCode: string;
  numberOfPayments?: number | null;
  branchCodeDesc?: string | null;
  transTypeCommentDetails?: unknown[] | null;
}

export interface ApiMonth {
  statusCode: number;
  title?: string;
  result?: {
    bankAccounts?: {
      debitDates?: { date?: string; transactions?: ApiCompletedTxn[] | null }[] | null;
      immidiateDebits?: { debitDays?: { transactions?: ApiCompletedTxn[] | null }[] | null } | null;
    }[] | null;
  } | null;
}

export interface ApiPending {
  statusCode: number;
  title?: string;
  result?: { cardsList?: { cardUniqueID?: string; authDetalisList?: ApiPendingTxn[] | null }[] | null } | null;
}

interface CardLevelFrame { cardUniqueId: string; nextTotalDebit?: number | null; nextDebitDate?: string | null }
interface IssuedCards {
  nextTotalDebitForAccount?: number | null;
  nextTotalDebitDateForAccount?: string | null;
  frameLimitForCardAmount?: number | null;
  fictiveMaxAccAmt?: number | null;
  cardLevelFrames?: CardLevelFrame[] | null;
}
export interface ApiFrames { result?: { calIssuedCards?: IssuedCards | null; bankIssuedCards?: IssuedCards | null } | null }

export interface CalCard { cardUniqueId: string; last4Digits: string }

const memoOf = (details: unknown[] | null | undefined) =>
  (details ?? []).map(d => (typeof d === 'string' ? d : str(obj(d).text ?? obj(d).comment ?? ''))).map(s => s.trim()).filter(Boolean).join(', ');

/** Credits are positive, everything else negative; `amount`'s own sign is ignored. */
const signed = (amount: number, credit: boolean) => (credit ? 1 : -1) * Math.abs(amount);

/** Like the library with combineInstallments: false — installment n is dated n-1 months after the purchase. */
function installmentDate(purchase: string, number: number): string {
  const d = new Date(purchase);
  if (number > 1) d.setMonth(d.getMonth() + number - 1);
  return d.toISOString();
}

export function convertCompleted(t: ApiCompletedTxn): ScrapedTxn {
  const credit = t.trnTypeCode === TRN_TYPE.credit;
  const total = t.numOfPayments ?? 0;
  const installments = total > 0 ? { number: t.curPaymentNum || 1, total } : undefined;
  const isInstallments = t.trnTypeCode === TRN_TYPE.installments || total > 1;
  return {
    type: isInstallments ? 'installments' : 'normal',
    identifier: t.trnIntId ? String(t.trnIntId) : undefined,
    date: installments ? installmentDate(t.trnPurchaseDate, installments.number) : new Date(t.trnPurchaseDate).toISOString(),
    processedDate: new Date(t.debCrdDate).toISOString(),
    originalAmount: signed(t.trnAmt, credit),
    originalCurrency: normalizeCurrency(t.trnCurrencySymbol),
    chargedAmount: signed(t.amtBeforeConvAndIndex, credit),
    chargedCurrency: normalizeCurrency(t.debCrdCurrencySymbol),
    description: (t.merchantName ?? '').trim(),
    memo: memoOf(t.transTypeCommentDetails),
    category: t.branchCodeDesc?.trim() || undefined,
    installments,
    status: 'completed',
    rawTransaction: t,
  };
}

/** A pending authorization, charged (in shekels) on the card's next debit date when known. */
export function convertPending(t: ApiPendingTxn, nextDebitDate?: string): ScrapedTxn {
  const credit = t.trnTypeCode === TRN_TYPE.credit;
  const total = t.numberOfPayments ?? 0;
  const installments = total > 0 ? { number: 1, total } : undefined;
  const date = new Date(t.trnPurchaseDate).toISOString();
  const currency = normalizeCurrency(t.trnCurrencySymbol);
  return {
    type: t.trnTypeCode === TRN_TYPE.installments || total > 1 ? 'installments' : 'normal',
    date,
    processedDate: nextDebitDate ?? date,
    originalAmount: signed(t.trnAmt, credit),
    originalCurrency: currency,
    // the library's rule: a pending charge's amount is the purchase amount until Cal converts it
    chargedAmount: signed(t.trnAmt, credit),
    chargedCurrency: currency,
    description: (t.merchantName ?? '').trim(),
    memo: memoOf(t.transTypeCommentDetails),
    category: t.branchCodeDesc?.trim() || undefined,
    installments,
    status: 'pending',
    rawTransaction: t,
  };
}

const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));

/**
 * Drop a pending authorization that already shows as completed (eshaham/israeli-bank-scrapers#1171): same merchant,
 * same day, closest time, matched one-to-one; the amount may differ (a fuel hold, a settlement adjustment).
 */
export function dedupePending(txns: ScrapedTxn[]): ScrapedTxn[] {
  // an installment's date moved n-1 months; its purchase time is the raw row's
  const purchaseTime = (t: ScrapedTxn) => Date.parse((t.rawTransaction as { trnPurchaseDate?: string } | undefined)?.trnPurchaseDate ?? t.date);
  const completed = txns.filter(t => t.status === 'completed');
  const used = new Set<ScrapedTxn>();
  const drop = new Set<ScrapedTxn>();
  for (const p of txns.filter(t => t.status === 'pending')) {
    const at = purchaseTime(p);
    const day = localDay(new Date(at).toISOString());
    const best = completed
      .filter(c => !used.has(c) && c.description === p.description && localDay(new Date(purchaseTime(c)).toISOString()) === day)
      .sort((a, b) => Math.abs(purchaseTime(a) - at) - Math.abs(purchaseTime(b) - at))[0];
    if (best) {
      used.add(best);
      drop.add(p);
    }
  }
  return txns.filter(t => !drop.has(t));
}

/** The card's frame (credit line) data: its own card-level frame, else its issuer group's. */
export function cardFrame(frames: ApiFrames, cardUniqueId: string): { frame?: CardLevelFrame; group?: IssuedCards } {
  const groups = [frames.result?.bankIssuedCards, frames.result?.calIssuedCards].filter(Boolean) as IssuedCards[];
  for (const group of groups) {
    const frame = group.cardLevelFrames?.find(f => f.cardUniqueId === cardUniqueId);
    if (frame) return { frame, group };
  }
  return { group: groups[0] };
}

/** The upcoming debit (the library's getBalanceAmount), as a negative balance. */
export function balanceOf(frames: ApiFrames, cardUniqueId: string): { balance?: number; balanceDate?: string; cardFrame?: number } {
  const { frame, group } = cardFrame(frames, cardUniqueId);
  const amount = frame?.nextTotalDebit ?? group?.nextTotalDebitForAccount
    ?? (group?.frameLimitForCardAmount != null && group.fictiveMaxAccAmt != null ? group.frameLimitForCardAmount - group.fictiveMaxAccAmt : undefined);
  const date = frame?.nextDebitDate ?? group?.nextTotalDebitDateForAccount;
  return {
    balance: amount == null ? undefined : -amount,
    balanceDate: date ? new Date(date).toISOString() : undefined,
    cardFrame: group?.frameLimitForCardAmount ?? undefined,
  };
}

/** One card's account from its frames, monthly statements and pending authorizations. */
export function cardAccount(card: CalCard, frames: ApiFrames, months: ApiMonth[], pending: ApiPending | null, startDate: Date): ScrapedCardAccount {
  const { balance, balanceDate, cardFrame: frameLimit } = balanceOf(frames, card.cardUniqueId);
  const completed = months.flatMap(m => (m.result?.bankAccounts ?? []).flatMap(a => [
    ...(a.debitDates ?? []).flatMap(d => d.transactions ?? []),
    ...(a.immidiateDebits?.debitDays ?? []).flatMap(d => d.transactions ?? []),
  ])).map(convertCompleted);
  const pendingTxns = (pending?.result?.cardsList ?? [])
    .filter(c => !c.cardUniqueID || c.cardUniqueID === card.cardUniqueId)
    .flatMap(c => c.authDetalisList ?? [])
    .map(t => convertPending(t, balanceDate));
  const txns = dedupePending([...pendingTxns, ...completed]).filter(t => Date.parse(t.date) >= startDate.getTime());
  return { accountNumber: card.last4Digits, balance, balanceDate, cardFrame: frameLimit, txns };
}

export type PostJson = (url: string, body: unknown) => Promise<unknown>;

export interface FetchOptions {
  startDate: Date;
  futureMonths: number;
  now?: Date;
  /** pause between API calls; tests pass a no-op */
  pause?: () => Promise<void>;
}

/** Every card's account, through any `postJson` (the logged-in page in production). */
export async function fetchCalData(postJson: PostJson, cards: CalCard[], options: FetchOptions): Promise<ScrapedCardAccount[]> {
  const pause = options.pause ?? (() => jitter(1000, 2000));
  const months = monthsToFetch(options.startDate, options.futureMonths, options.now);
  const accounts: ScrapedCardAccount[] = [];
  for (const card of cards) {
    await pause();
    const frames = obj(await postJson(ENDPOINTS.frames, { cardsForFrameData: [{ cardUniqueId: card.cardUniqueId }] })) as ApiFrames;

    await pause();
    let pending = obj(await postJson(ENDPOINTS.pending, { cardUniqueIDArray: [card.cardUniqueId] })) as unknown as ApiPending;
    // 96 = no pending authorizations; anything else isn't fatal, the statements still count
    if (pending.statusCode !== 1 && pending.statusCode !== 96) {
      console.warn(`  Cal card ${card.last4Digits}: pending authorizations unavailable (${pending.title ?? pending.statusCode})`);
      pending = { statusCode: 96 };
    }

    const statements: ApiMonth[] = [];
    for (const month of months) {
      await pause();
      const data = obj(await postJson(ENDPOINTS.transactions, {
        cardUniqueId: card.cardUniqueId, month: String(month.getMonth() + 1), year: String(month.getFullYear()),
      })) as unknown as ApiMonth;
      if (data.statusCode === 96) continue; // no statement that month
      if (data.statusCode !== 1 || !data.result) {
        throw new Error(`getCardTransactionsDetails failed for card ${card.last4Digits} (${month.getMonth() + 1}/${month.getFullYear()}): ${data.title || data.statusCode}`);
      }
      statements.push(data);
    }
    accounts.push(cardAccount(card, frames, statements, pending, options.startDate));
  }
  return accounts;
}

/** POST JSON from inside the digital-web page (its origin, cookies and real browser fingerprint). */
export function pagePostJson(page: Page, token: string): PostJson {
  return async (url, body) => {
    const { status, text } = await page.evaluate(async (u: string, b: string, auth: string, siteId: string) => {
      const res = await fetch(u, { method: 'POST', body: b,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', Authorization: auth, 'X-Site-Id': siteId } });
      return { status: res.status, text: await res.text() };
    }, url, JSON.stringify(body), `CALAuthScheme ${token}`, X_SITE_ID);
    const endpoint = url.split('/').pop();
    if (status === 429 || /block automation|bot detection|you have been blocked|cloudflare/i.test(text)) {
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

export interface ScrapeCalOptions {
  /** the Chrome profile under data/browser-profile/ — the source id (visaCal, visaCal-hagar) */
  profile: string;
  credentials: CalCredentials;
  startDate: Date;
  futureMonths: number;
  showBrowser: boolean;
  requestOtp?: () => Promise<string>;
  /** with the browser visible, wait for a login finished by hand (never in an unattended run) */
  finishByHand?: boolean;
  /** where the browser was when it failed (visible text only) */
  onFailurePage?: (description: string) => void;
}

export async function scrapeCal(options: ScrapeCalOptions): Promise<CalResult> {
  const { credentials } = options;
  if (!credentials.username || !credentials.password) {
    return { success: false, errorType: 'GENERIC', errorMessage: 'credentials need username and password' };
  }
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    // a persistent profile per login keeps Cal's device cookies; desktop layout (the login button is desktop-only)
    browser = await puppeteer.launch({
      headless: !options.showBrowser, executablePath: findChromePath(), args: BROWSER_ARGS, defaultViewport: null,
      ignoreDefaultArgs: ['--enable-automation'], userDataDir: profileDir(options.profile),
    });
    page = (await browser.pages())[0] ?? await browser.newPage();
    page.setDefaultTimeout(120_000);
    await maskAutomation(page);

    let login = await loginViaPage(page, credentials, { requestOtp: options.requestOtp });
    // the token alone isn't enough: the main page must reach digital-web (cards are in its session)
    let session = login.state === 'success' ? await waitForSession(page, 60_000) : {};
    const landed = () => !!(session.token || (login.state === 'success' && login.token)) && !!session.cards;
    if (!landed() && options.finishByHand && !(login.state === 'failed' && ['ACCOUNT_BLOCKED', 'CHANGE_PASSWORD'].includes(login.errorType))) {
      const why = login.state === 'failed' ? login.errorMessage
        : login.state === 'success' ? `logged in, but the site stopped at "${frameRoute(findLoginFrame(page)?.url() ?? '')}"` : 'login did not finish';
      console.log(`\n⚠️  ${options.profile}: ${why}`);
      console.log('   Finish the login by hand in the Chrome window (3 minutes) — the scrape continues once you are in.');
      session = await waitForSession(page, 180_000);
      if (session.token && session.cards) login = { state: 'success', token: session.token };
    }
    const token = session.token ?? (login.state === 'success' ? login.token : undefined);
    if (login.state !== 'success' || !token || !session.cards) {
      const failure = login.state === 'failed' ? login
        : { errorType: 'GENERIC', errorMessage: login.state === 'success'
          ? `logged in, but the personal area did not load (${session.cards ? 'no token' : 'no card list'}; login frame at "${frameRoute(findLoginFrame(page)?.url() ?? '')}")`
          : 'login did not finish' };
      options.onFailurePage?.(await describePage(page));
      return { success: false, errorType: failure.errorType, errorMessage: failure.errorMessage };
    }
    console.log(`  ${options.profile}: logged in, ${session.cards.length} card(s)`);

    await jitter(1500, 2500);
    const accounts = await fetchCalData(pagePostJson(page, token), session.cards, { startDate: options.startDate, futureMonths: options.futureMonths });
    return { success: true, accounts };
  } catch (err) {
    if (page) options.onFailurePage?.(await describePage(page).catch(() => ''));
    return { success: false, errorType: 'GENERIC', errorMessage: err instanceof Error ? err.message : String(err) };
  } finally {
    await browser?.close().catch(() => {});
  }
}
