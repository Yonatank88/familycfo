import type { DB } from '../db/connection.js';
import type { Config } from '../scraper.js';
import { investmentSourceId } from '../sync/index.js';
import { sourceIdOf } from '../config.js';

/** Owner names are display only: the first name, read at request time — no column, nothing stored per row. */

export const firstName = (full: string | null | undefined): string | null => full?.trim().split(/\s+/)[0] || null;

/**
 * Each integration's owner from accounts.json (its `owner`), by source id — what its accounts and holdings inherit.
 * Banks / cards by their entry's source id (`id`, else companyId) — an account inherits the entry that scraped it —
 * brokers / exchanges / wallets by theirs.
 */
export function configOwners(config: Config | null): Map<string, string> {
  const owners = new Map<string, string>();
  if (!config) return owners;
  for (const a of config.accounts ?? []) { const o = firstName(a.owner); if (o) owners.set(sourceIdOf(a), o); }
  for (const s of config.investments ?? []) { const o = firstName(s.owner); if (o) owners.set(investmentSourceId(s), o); }
  return owners;
}

/** Each report product's owner, as printed on its latest applied report (corrected in the review panel). */
export function reportOwners(db: DB): Map<string, string> {
  const rows = db.prepare(`
    SELECT v.holding_source, v.owner FROM report_values v JOIN reports r ON r.id = v.report_id
    WHERE r.status = 'applied' AND v.owner IS NOT NULL AND trim(v.owner) <> ''
    ORDER BY v.as_of, v.report_id
  `).all() as { holding_source: string; owner: string }[];
  const owners = new Map<string, string>();
  for (const r of rows) owners.set(r.holding_source, firstName(r.owner)!);
  return owners;
}
