import { getDb, type DB } from './db/connection.js';
import { categorizeTransactions, deriveKinds } from './ingest/classify.js';
import { matchImmediateCardDebits, matchInternalTransfers, reconcileCardBills } from './ingest/transfers.js';
import { refreshRecurring } from './analytics/recurring.js';
import { suggestScheduledItems } from './analytics/scheduled.js';
import { suggestPaybacks } from './analytics/paybacks.js';
import { refreshAlerts } from './analytics/alerts.js';
import { refreshBoiRates } from './analytics/fx.js';
import { refreshHistory, refreshQuotes } from './analytics/quotes.js';
import { matchPlanned } from './analytics/planned.js';

export interface PipelineOptions {
  /** rows to categorize; defaults to every uncategorized row */
  txIds?: number[];
  categoryApiUrl?: string;
  fetchRates?: boolean;
}

/** Everything that runs after a scrape: classify → kinds/transfers → recurring → suggestions → alerts. */
export async function runPipeline(db: DB = getDb(), opts: PipelineOptions = {}): Promise<Record<string, number>> {
  const ids = opts.txIds
    ?? (db.prepare(`SELECT id FROM transactions WHERE category_id IS NULL`).pluck().all() as number[]);

  if (opts.fetchRates !== false) {
    try { await refreshBoiRates(db); } catch (err) { console.warn('  FX rates not refreshed:', (err as Error).message); }
    try { await refreshQuotes(db, 0); await refreshHistory(db); } catch (err) { console.warn('  stock prices not refreshed:', (err as Error).message); }
  }
  await categorizeTransactions(db, ids, opts.categoryApiUrl);
  deriveKinds(db, 'all');
  const cardBills = reconcileCardBills(db);
  const debits = matchImmediateCardDebits(db);
  const transfers = matchInternalTransfers(db);
  // planned expenses whose real row arrived: link them (they stop counting, the real row counts)
  const planned = matchPlanned(db);
  const recurring = refreshRecurring(db).length;
  const scheduled = suggestScheduledItems(db);
  const paybacks = suggestPaybacks(db);
  const alerts = refreshAlerts(db);
  return { categorized: ids.length, cardBillsKept: cardBills.kept, cardBillsDemoted: cardBills.demoted, immediateDebits: debits.matched, debitCards: debits.debitCards.length, transfers, plannedMatched: planned.matched, plannedAmbiguous: planned.ambiguous, recurring, scheduled, paybacks, alerts };
}

// `npm run pipeline` — reprocess the database without scraping (set CATEGORY_API_URL to categorize via the API)
if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runPipeline(getDb(), { categoryApiUrl: process.env.CATEGORY_API_URL });
  console.log('Pipeline:', summary);
}
