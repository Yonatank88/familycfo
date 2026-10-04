import { existsSync, readFileSync } from 'fs';
import type { Config } from './scraper.js';
import { SOURCE_NAMES } from './db/ingestRepo.js';

/** The bank logins file (git-ignored) — read on demand by whoever scrapes. `ACCOUNTS_FILE` overrides the path. */
export const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';

export function loadConfig(): Config {
  if (!existsSync(ACCOUNTS_FILE)) {
    throw new Error(`${ACCOUNTS_FILE} not found — copy accounts.example.json to ${ACCOUNTS_FILE} and fill in your bank logins`);
  }
  return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
}

/** An accounts.json bank / card entry, as far as identifying it goes. */
interface EntryRef { id?: string; companyId: string; owner?: string; credentials?: Record<string, string> }

/**
 * The source id of a bank / card entry: its `id`, else its companyId — so an entry without an id keeps the keys its
 * history was recorded under. Two logins of one company tell apart by `id` (source_runs, integrations keys, lockout
 * guard, browser profile, raw archive, owners).
 */
export const sourceIdOf = (a: EntryRef): string => a.id?.trim() || String(a.companyId);

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/^YOUR_/.test(v.trim());
/** Every credential filled (none empty, none a YOUR_… placeholder, at least one). */
export const credentialsFilled = (credentials: Record<string, unknown> | undefined): boolean => {
  const values = Object.values(credentials ?? {});
  return values.length > 0 && values.every(filled);
};

/** SCRAPE_ONLY: an entry matches its source id or its companyId (every login of that company). */
export const matchesOnly = (only: string[] | undefined, a: EntryRef): boolean =>
  !only || only.includes(sourceIdOf(a)) || only.includes(String(a.companyId));

/**
 * Each entry's display name by source id: the company's name, plus " · <owner's first name>" (else its id) when the
 * company has more than one entry — "Cal · Yonatan", "Cal · Hagar".
 */
export function entryLabels(entries: EntryRef[] = []): Map<string, string> {
  const count = new Map<string, number>();
  for (const a of entries) count.set(String(a.companyId), (count.get(String(a.companyId)) ?? 0) + 1);
  return new Map(entries.map(a => {
    const company = String(a.companyId);
    const name = SOURCE_NAMES[company] ?? company;
    const who = a.owner?.trim().split(/\s+/)[0] || sourceIdOf(a);
    return [sourceIdOf(a), (count.get(company) ?? 0) > 1 ? `${name} · ${who}` : name];
  }));
}
