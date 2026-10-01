import { existsSync, readFileSync } from 'fs';
import type { Config } from './scraper.js';

/** The bank logins file (git-ignored) — read on demand by whoever scrapes. `ACCOUNTS_FILE` overrides the path. */
export const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || 'accounts.json';

export function loadConfig(): Config {
  if (!existsSync(ACCOUNTS_FILE)) {
    throw new Error(`${ACCOUNTS_FILE} not found — copy accounts.example.json to ${ACCOUNTS_FILE} and fill in your bank logins`);
  }
  return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
}
