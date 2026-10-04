import { getDb, type DB } from './db/connection.js';
import { categorizeTransactions, deriveKinds } from './ingest/classify.js';
import { categorizeMerchants, type MerchantCategorizer } from './categorize/index.js';
import { applyCategoryRules } from './categorize/rules.js';
import { localDate } from './ingest/normalize.js';
import { matchCurrencyExchanges, matchImmediateCardDebits, matchInternalTransfers, reconcileCardBills } from './ingest/transfers.js';
import { backfillRates, refreshBoiRates } from './analytics/fx.js';
import { refreshQuotes } from './analytics/quotes.js';
import { seedAccountBalances, writeSnapshots, type SourceOutcome } from './analytics/snapshots.js';
import { addDays, today } from './util.js';

export interface PipelineOptions {
  /** the sources of this run: a snapshot is written only for the ones that succeeded */
  sources?: SourceOutcome[];
  fetchRates?: boolean;
  /** the AI merchant categorizer (default: the user's `claude -p`); false skips it */
  categorizer?: MerchantCategorizer | false;
}

/** The first day anything needs a rate for: the oldest transaction or snapshot. */
function ratesFrom(db: DB): string {
  const tx = db.prepare(`SELECT MIN(date) FROM transactions`).pluck().get() as string | null;
  const snap = db.prepare(`SELECT MIN(date) FROM daily_snapshots`).pluck().get() as string | null;
  return [tx ? localDate(tx) : null, snap, addDays(today(), -7)].filter((d): d is string => !!d).sort()[0];
}

/**
 * Everything that runs after a scrape, in order: FX → quotes → categorize → kinds → card bills → immediate card
 * debits → own-account transfers → currency exchanges between own accounts → merchant categories (AI; once kinds are final, it only reads spend rows) → snapshots.
 */
export async function runPipeline(db: DB = getDb(), opts: PipelineOptions = {}): Promise<Record<string, number>> {
  if (opts.fetchRates !== false) {
    try { await refreshBoiRates(db); } catch (err) { console.warn('  FX rates not refreshed:', (err as Error).message); }
    try {
      const fx = await backfillRates(db, ratesFrom(db));
      if (fx.missing.length) console.warn(`  no exchange rate for: ${fx.missing.join(', ')}`);
    } catch (err) { console.warn('  FX history not backfilled:', (err as Error).message); }
    try { await refreshQuotes(db, 0); } catch (err) { console.warn('  prices not refreshed:', (err as Error).message); }
  }
  const categorized = categorizeTransactions(db);
  deriveKinds(db, 'all');
  const cardBills = reconcileCardBills(db);
  const debits = matchImmediateCardDebits(db);
  const transfers = matchInternalTransfers(db);
  const fxExchanges = matchCurrencyExchanges(db);
  let merchantRows = 0;
  if (opts.categorizer === false) merchantRows = applyCategoryRules(db).rows;
  else {
    // never fails the pipeline: without the claude CLI the rows just stay uncategorised until the next run
    try {
      const ai = await categorizeMerchants(db, opts.categorizer ? { categorizer: opts.categorizer } : {});
      merchantRows = ai.rows + ai.ruleRows;
    } catch (err) { console.warn('  merchants not categorised:', (err as Error).message); }
  }
  const snapshots = writeSnapshots(db, opts.sources ?? []);
  const accountDays = seedAccountBalances(db);
  return {
    categorized, merchantRows, cardBillsKept: cardBills.kept, cardBillsDemoted: cardBills.demoted, cardRowsCovered: cardBills.covered, immediateDebits: debits.matched, transfers, fxExchanges,
    snapshots: snapshots.written, bankDaysBackfilled: snapshots.backfilled, accountDaysSeeded: accountDays, fxFlagged: snapshots.flagged.length,
  };
}

// `npm run pipeline` — reprocess the database without scraping (no source ran, so no snapshot is written)
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Pipeline:', await runPipeline(getDb()));
}
