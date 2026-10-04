import type { DB } from '../db/connection.js';
import { beginSourceRun, recordSourceRun } from '../db/ingestRepo.js';
import { archiveRaw } from '../ingest/archive.js';
import type { ScrapeHooks, ScrapeSummary } from '../scraper.js';
import { syncHoldings, type SyncedAccount } from './holdings.js';
import { fetchIbkr, type IbkrSource } from './ibkr.js';
import { fetchWallets, type WalletsSource } from './wallets.js';
import { fetchExchange, type ExchangeSource } from './exchange.js';

/** `investments[]` in accounts.json: brokers, wallets and exchanges whose positions become holdings. */
export type InvestmentSource = (IbkrSource | WalletsSource | ExchangeSource) & {
  /** kept in the file, skipped by every run */ disabled?: boolean;
  /** whose it is (display only — not a secret); its holdings inherit it */ owner?: string;
};

/** The id a source is known by: SCRAPE_ONLY, sync status, `data/raw/<id>/`, and the prefix of its holdings' source. */
export const investmentSourceId = (s: InvestmentSource) => s.id ?? (s.type === 'exchange' ? s.exchange : s.type);

interface Fetched { raw: unknown; accounts: SyncedAccount[]; asOf?: string | null; history?: unknown; warnings?: string[] }

function fetchSource(s: InvestmentSource, db: DB): Promise<Fetched> {
  switch (s.type) {
    case 'ibkr': return fetchIbkr(s);
    case 'wallets': {
      const stored = db.prepare(`SELECT opened_at FROM holdings WHERE source = ? AND symbol = ?`).pluck();
      return fetchWallets(s, { known: (source, symbol) => (stored.get(source, symbol) as string | null | undefined) ?? null });
    }
    case 'exchange': return fetchExchange(s);
    default: throw new Error(`unknown investment source type "${(s as { type?: string }).type}"`);
  }
}

/**
 * Sync every configured investment source into holdings, one after the other; a failing source is recorded in
 * source_runs like a failed bank and leaves its holdings as they were. Runs with the bank scrape (before the pipeline,
 * which refreshes the quotes). Reports progress with the same events as the banks.
 */
export async function syncInvestments(sources: InvestmentSource[] = [], db: DB, hooks: Pick<ScrapeHooks, 'onProgress'> = {}): Promise<ScrapeSummary[]> {
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  const summaries: ScrapeSummary[] = [];
  for (const source of sources) {
    const id = investmentSourceId(source);
    if (source.disabled || (only && !only.includes(id))) continue;
    console.log(`Syncing ${id}...`);
    hooks.onProgress?.({ type: 'start', company: id });
    const startedAt = new Date().toISOString();
    beginSourceRun(db, id, startedAt);
    try {
      const { raw, accounts, asOf, history, warnings = [] } = await fetchSource(source, db);
      archiveRaw(id, raw);
      // trade / transfer history behind opening dates and costs, archived next to the positions
      if (history && Object.keys(history as object).length) archiveRaw(`${id}-history`, history);
      const r = await syncHoldings(db, id, accounts);
      console.log(`  ${accounts.length} account(s): ${r.added} new, ${r.updated} updated, ${r.removed} gone${r.manual ? `, ${r.manual} at the source's price (no quote)` : ''}`);
      if (warnings.length) console.warn(`  ${warnings.join('; ')}`);
      // a history endpoint that was refused doesn't fail the run: it is recorded on the successful run
      recordSourceRun(db, { source: id, startedAt, ok: true, error: warnings.length ? warnings.join('; ') : null, asOf: asOf ?? new Date().toISOString() });
      summaries.push({ company: id, kind: 'investment', success: true, newTransactionIds: [] });
      hooks.onProgress?.({ type: 'done', company: id, success: true, newTransactions: r.added });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to sync ${id}:`, message);
      recordSourceRun(db, { source: id, startedAt, ok: false, error: message });
      summaries.push({ company: id, kind: 'investment', success: false, newTransactionIds: [], errorType: 'SYNC_FAILED' });
      hooks.onProgress?.({ type: 'done', company: id, success: false, newTransactions: 0, errorType: 'SYNC_FAILED', errorMessage: message });
    }
  }
  return summaries;
}
