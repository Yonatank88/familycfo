import { getDb } from '../db/connection.js';
import { categorizeTransactions } from '../ingest/classify.js';
import { categorizeMerchants } from './index.js';

// `npm run categorize [-- --all]` — scraper categories, then the AI for every merchant still without one
// (--all re-asks every merchant not categorised by a person or the scraper)
const db = getDb();
const scraper = categorizeTransactions(db);
const ai = await categorizeMerchants(db, { all: process.argv.includes('--all') });
console.log('Categorize:', { scraper, ...ai });
