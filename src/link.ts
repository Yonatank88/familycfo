/**
 * One-time two-factor enrollment, so a bank that texts a code on every login scrapes unattended:
 *   npm run link -- onezero
 * One Zero sends an SMS to `credentials.phoneNumber`; the code buys a ~1-hour otpToken, which is traded right away for
 * the ~10-year idToken (sergienko4/israeli-bank-scrapers#576), saved as `credentials.idToken` in accounts.json (never
 * printed). Every later scrape logs in with it and no SMS. Run this again only when One Zero rejects the idToken.
 */
import { readFileSync, writeFileSync } from 'fs';
import * as readline from 'readline/promises';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { ACCOUNTS_FILE, loadConfig } from './config.js';

const COMPANIES: Record<string, keyof typeof CompanyTypes> = { onezero: 'oneZero' };

async function main() {
  const arg = (process.argv[2] ?? '').toLowerCase();
  const companyId = COMPANIES[arg];
  if (!companyId) throw new Error(`usage: npm run link -- onezero   (linkable: ${Object.keys(COMPANIES).join(', ')})`);

  const config = loadConfig();
  const account = (config.accounts ?? []).find(a => a.companyId === companyId);
  if (!account) throw new Error(`no "${companyId}" account in ${ACCOUNTS_FILE} — add it first (see accounts.example.json)`);
  const phoneNumber = account.credentials.phoneNumber?.trim();
  if (!phoneNumber?.startsWith('+')) throw new Error(`credentials.phoneNumber is required, in international format (+9725…)`);

  const scraper = createScraper({ companyId: CompanyTypes[companyId], startDate: new Date() });
  const triggered = await scraper.triggerTwoFactorAuth(phoneNumber);
  if (!triggered.success) throw new Error(`${triggered.errorType}: ${triggered.errorMessage ?? 'could not send the code'}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question(`\n🔐 Code texted to ${phoneNumber}: `)).trim();
  rl.close();
  const result = await scraper.getLongTermTwoFactorToken(code);
  if (!result.success) throw new Error(`${result.errorType}: ${result.errorMessage ?? 'the code was not accepted'}`);

  // trade the short-lived otpToken for the long-lived idToken (the patched scraper keeps it on `idToken`)
  const loginScraper = scraper as unknown as { login(c: Record<string, unknown>): Promise<{ success: boolean; errorMessage?: string }>; idToken?: string };
  const login = await loginScraper.login({ ...account.credentials, idToken: undefined, otpLongTermToken: result.longTermTwoFactorAuthToken });
  if (!login.success || !loginScraper.idToken) throw new Error(`login after the code failed: ${login.errorMessage ?? 'no idToken returned'}`);

  // edit the file as it is on disk (only this account's credentials change)
  const file = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')) as typeof config;
  const target = file.accounts.find(a => a.companyId === companyId)!;
  const { otpLongTermToken: _expired, ...credentials } = target.credentials;
  target.credentials = { ...credentials, idToken: loginScraper.idToken };
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(file, null, 2) + '\n');
  console.log(`✅ Linked. The 10-year idToken is saved in ${ACCOUNTS_FILE}; ${companyId} now scrapes without a code.`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
