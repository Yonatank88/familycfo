import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import type { Config } from '../scraper.js';
import { readConfigFile, writeConfigFile } from './manage.js';

/**
 * One Zero's one-time SMS enrollment (sergienko4/israeli-bank-scrapers#576): the texted code buys a ~1-hour otpToken,
 * traded right away for the ~10-year idToken, saved as `credentials.idToken`. Used by `npm run link` and the dashboard.
 */
export const LINKABLE: Record<string, keyof typeof CompanyTypes> = { onezero: 'oneZero' };

export interface LinkSession {
  companyId: keyof typeof CompanyTypes;
  /** trade the texted code for the idToken and save it into the file (backed up first) */
  finish(code: string): Promise<void>;
}

export async function startLink(companyId: keyof typeof CompanyTypes, accountsFile: string): Promise<LinkSession> {
  const account = (readConfigFile(accountsFile).accounts ?? []).find(a => a.companyId === companyId);
  if (!account) throw new Error(`no "${companyId}" account in ${accountsFile} — add it first`);
  const phoneNumber = account.credentials.phoneNumber?.trim();
  if (!phoneNumber?.startsWith('+')) throw new Error(`the phone number is required, in international format (+9725…)`);

  const scraper = createScraper({ companyId: CompanyTypes[companyId], startDate: new Date() });
  const triggered = await scraper.triggerTwoFactorAuth(phoneNumber);
  if (!triggered.success) throw new Error(`${triggered.errorType}: ${triggered.errorMessage ?? 'could not send the code'}`);

  return {
    companyId,
    async finish(code: string) {
      const result = await scraper.getLongTermTwoFactorToken(code.trim());
      if (!result.success) throw new Error(`${result.errorType}: ${result.errorMessage ?? 'the code was not accepted'}`);
      // trade the short-lived otpToken for the long-lived idToken (the patched scraper keeps it on `idToken`)
      const loginScraper = scraper as unknown as { login(c: Record<string, unknown>): Promise<{ success: boolean; errorMessage?: string }>; idToken?: string };
      const login = await loginScraper.login({ ...account.credentials, idToken: undefined, otpLongTermToken: result.longTermTwoFactorAuthToken });
      if (!login.success || !loginScraper.idToken) throw new Error(`login after the code failed: ${login.errorMessage ?? 'no idToken returned'}`);
      saveIdToken(accountsFile, companyId, loginScraper.idToken);
    },
  };
}

/** Edit the file as it is on disk: only this account's credentials change. */
export function saveIdToken(accountsFile: string, companyId: string, idToken: string): void {
  const file = readConfigFile(accountsFile) as Config;
  const target = file.accounts.find(a => a.companyId === companyId);
  if (!target) throw new Error(`no "${companyId}" account in ${accountsFile}`);
  const { otpLongTermToken: _expired, ...credentials } = target.credentials;
  target.credentials = { ...credentials, idToken };
  writeConfigFile(accountsFile, file);
}
