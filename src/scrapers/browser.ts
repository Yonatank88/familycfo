import type { Page } from 'puppeteer';
import { existsSync } from 'fs';
import { platform } from 'os';
import { join } from 'path';

/** Chrome profiles that keep a site's device cookies between runs (git-ignored, under data/); `BROWSER_PROFILE_DIR` overrides. */
export const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR ?? join('data', 'browser-profile');
export const profileDir = (company: string) => join(PROFILE_DIR, company);

export function findChromePath(): string | undefined {
  const paths: Record<string, string[]> = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  };
  return (paths[platform()] || []).find(p => existsSync(p));
}

export const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--safebrowsing-disable-auto-update',
  '--window-size=1920,1080',
];

/** The sec-ch-ua platform name Chrome reports on this OS. */
function clientHintsPlatform(): string {
  return ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' } as Record<string, string>)[platform()] ?? 'Linux';
}

/**
 * Hide the usual automation tells before any page script runs: the real browser's user agent minus "Headless"
 * (and matching sec-ch-ua client hints — a hardcoded or mismatched version trips bot detection), no
 * `navigator.webdriver`, plugins, languages, notification permission.
 */
export async function maskAutomation(page: Page): Promise<void> {
  const realUserAgent = await page.browser().userAgent();
  const userAgent = realUserAgent.replace('HeadlessChrome', 'Chrome');
  if (userAgent === realUserAgent) {
    await page.setUserAgent(userAgent);
  } else {
    // headless: also replace the client hints, which would otherwise still say "HeadlessChrome"
    const major = userAgent.match(/Chrome\/(\d+)/)?.[1] ?? '140';
    await page.setUserAgent({
      userAgent,
      userAgentMetadata: {
        brands: [
          { brand: 'Google Chrome', version: major },
          { brand: 'Chromium', version: major },
          { brand: 'Not)A;Brand', version: '99' },
        ],
        fullVersion: userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? `${major}.0.0.0`,
        platform: clientHintsPlatform(),
        platformVersion: '',
        architecture: process.arch === 'arm64' ? 'arm' : 'x86',
        model: '',
        mobile: false,
      },
    });
  }

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['he-IL', 'he', 'en-US', 'en'] });
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: 'denied' } as PermissionStatus)
        : originalQuery(parameters);
  });

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7' });
}

// Describe where the browser ended up, for diagnosing failed logins. Uses visible
// text only (innerText never includes typed input values), so credentials are not logged.
export async function describePage(page: Page): Promise<string> {
  const lines = [`  URL: ${page.url()}`];
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => document.body?.innerText ?? '');
      const compact = text.replace(/\s+/g, ' ').trim().slice(0, 800);
      if (compact) lines.push(`  Visible text [${frame.url().slice(0, 80)}]: ${compact}`);
    } catch {
      // frame detached mid-navigation; skip it
    }
  }
  return lines.join('\n');
}
