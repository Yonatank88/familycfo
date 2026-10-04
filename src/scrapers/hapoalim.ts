/**
 * Hapoalim's second login step (the SMS code), watched beside the library's own login.
 *
 * The login form and the code step live on the same SPA URL (/ng-portals/auth/he/), so the URL can't tell them apart
 * and the library just waits for a redirect. The watcher reads the page: a code box or the code step's text means
 * the bank is asking for a code. Unattended, once the form has been submitted and the page stays on the auth portal
 * without an error for `graceMs`, the bank is taken to be waiting for a code too — no one could answer it anyway.
 */
import type { Page } from 'puppeteer';

export interface HapoalimSnapshot {
  url: string;
  /** a visible code box (the old `poalim-separated-characters-input`, an `autocomplete=one-time-code` input, an otp/sms component) */
  otpElement: boolean;
  /** the login button was clicked (or the form submitted) */
  submitted: boolean;
  /** visible text (innerText: never typed input values) */
  text: string;
}

export type HapoalimLoginState = 'done' | 'otp' | 'error' | 'login' | 'waiting';

/** The code step's own words — not "קוד משתמש" (user code) on the login form. */
export const OTP_TEXT = /קוד\s*(?:ה)?(?:אימות|חד[-\s]?פעמי|זמני)|(?:ה)?קוד\s*(?:ש)?(?:נשלח|קיבלת)|סיסמה\s*חד[-\s]?פעמית|הודעת\s*SMS|במסרון|(?:^|[^A-Za-z])SMS(?![A-Za-z])|one[-\s]?time\s*(?:code|password)/i;
/** a login refusal the library reports on its own */
export const ERROR_TEXT = /שגוי|אינם\s*תואמים|אינו\s*תקין|נחסם|חסום|נעול/;

const AUTH_URL = /\/ng-portals\/auth\/|reqName=getLogonPage|^about:blank$/;

export function hapoalimLoginState(s: HapoalimSnapshot): HapoalimLoginState {
  if (!AUTH_URL.test(s.url)) return 'done';
  if (s.otpElement || (s.submitted && OTP_TEXT.test(s.text))) return 'otp';
  if (!s.submitted) return 'login';
  if (ERROR_TEXT.test(s.text)) return 'error';
  return 'waiting';
}

/** Where the login is now, read from the page (null while it navigates). */
export async function snapshotHapoalim(page: Page): Promise<HapoalimSnapshot | null> {
  try {
    return await page.evaluate(() => {
      const visible = (el: Element | null) => !!el && (el as HTMLElement).getClientRects().length > 0;
      const codeBox = [...document.querySelectorAll('poalim-separated-characters-input, input[autocomplete="one-time-code"]')]
        .concat([...document.querySelectorAll('*')].filter(e => e.tagName.includes('-') && /otp|sms|one-time|separated-characters/i.test(e.tagName)));
      return {
        url: location.href,
        otpElement: codeBox.some(visible),
        submitted: !!(window as unknown as { __familycfoSubmitted?: boolean }).__familycfoSubmitted,
        text: (document.body?.innerText ?? '').slice(0, 5000),
      };
    });
  } catch {
    return null;
  }
}

/** Before any page script: note when the login is submitted (the library clicks `.login-btn`). */
export async function markSubmit(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const mark = () => { (window as unknown as { __familycfoSubmitted?: boolean }).__familycfoSubmitted = true; };
    document.addEventListener('click', e => { if ((e.target as Element | null)?.closest?.('.login-btn, button[type="submit"]')) mark(); }, true);
    document.addEventListener('submit', mark, true);
  });
}

/** Type the code into the code step and submit it. */
async function fillOtp(page: Page, code: string): Promise<void> {
  const boxes = await page.$$('poalim-separated-characters-input input, input[autocomplete="one-time-code"]');
  const inputs = boxes.length ? boxes : await page.$$('input:not(#userCode):not(#password):not([type="hidden"])');
  if (inputs.length > 1 && inputs.length >= code.length) {
    for (let i = 0; i < code.length; i++) await inputs[i].type(code[i], { delay: 50 });
  } else if (inputs[0]) {
    await inputs[0].type(code, { delay: 50 });
  }
  const submit = await page.$('button.btn-red_1') ?? await page.$('button[type="submit"]');
  await submit?.click();
  console.log('✅ OTP submitted');
}

export interface WatchOptions {
  /** no one can answer: after a submit with no verdict for `graceMs`, take the page as asking for a code */
  unattended: boolean;
  graceMs?: number;
  intervalMs?: number;
  maxMs?: number;
  now?: () => number;
}

export type WatchResult = 'otp' | 'assumed-otp' | 'done' | 'error' | 'closed' | 'gave-up';

/**
 * Polls `probe` until the login ends or asks for a code; then asks `requestOtp` (which, unattended, stops the source)
 * and passes a code on to `fill`.
 */
export async function watchHapoalimOtp(probe: () => Promise<HapoalimSnapshot | null | 'closed'>, requestOtp: () => Promise<string>,
  fill: (code: string) => Promise<void>, options: WatchOptions): Promise<WatchResult> {
  const { unattended, graceMs = 15_000, intervalMs = 1000, maxMs = 200_000, now = Date.now } = options;
  const started = now();
  let submittedAt: number | null = null;
  while (now() - started < maxMs) {
    const s = await probe();
    if (s === 'closed') return 'closed';
    if (s) {
      const state = hapoalimLoginState(s);
      if (state === 'done') return 'done';
      if (state === 'error') return 'error';
      if (s.submitted) submittedAt ??= now();
      const assumed = state === 'waiting' && unattended && submittedAt !== null && now() - submittedAt >= graceMs;
      if (state === 'otp' || assumed) {
        console.log(state === 'otp' ? '\n📱 OTP popup detected!' : '\n📱 No answer after the login — taking it as the SMS step');
        const code = await requestOtp();
        if (code) await fill(code);
        return state === 'otp' ? 'otp' : 'assumed-otp';
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return 'gave-up';
}

/** Watch a live Hapoalim page (fire and forget from preparePage). */
export function startHapoalimWatcher(page: Page, requestOtp: () => Promise<string>, unattended: boolean): Promise<WatchResult> {
  return watchHapoalimOtp(async () => (page.isClosed() ? 'closed' : snapshotHapoalim(page)), requestOtp, code => fillOtp(page, code), { unattended });
}
