import { getDb, type DB } from './db/connection.js';
import { categorizeTransactions, deriveKinds } from './ingest/classify.js';
import { matchImmediateCardDebits, matchInternalTransfers, reconcileCardBills } from './ingest/transfers.js';
import { refreshBoiRates } from './analytics/fx.js';
import { refreshQuotes } from './analytics/quotes.js';

export interface PipelineOptions {
  fetchRates?: boolean;
}

/** Everything that runs after a scrape: FX → quotes → categorize → kinds → card bills → transfers. */
export async function runPipeline(db: DB = getDb(), opts: PipelineOptions = {}): Promise<Record<string, number>> {
  if (opts.fetchRates !== false) {
    try { await refreshBoiRates(db); } catch (err) { console.warn('  FX rates not refreshed:', (err as Error).message); }
    try { await refreshQuotes(db, 0); } catch (err) { console.warn('  prices not refreshed:', (err as Error).message); }
  }
  const categorized = categorizeTransactions(db);
  deriveKinds(db, 'all');
  const cardBills = reconcileCardBills(db);
  const debits = matchImmediateCardDebits(db);
  const transfers = matchInternalTransfers(db);
  return { categorized, cardBillsKept: cardBills.kept, cardBillsDemoted: cardBills.demoted, immediateDebits: debits.matched, transfers };
}

// `npm run pipeline` — reprocess the database without scraping
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Pipeline:', await runPipeline(getDb()));
}
