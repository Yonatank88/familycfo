import { getDb } from '../db/connection.js';
import { categorizeTransactions } from '../ingest/classify.js';
import { categorizeMerchants } from './index.js';
import { computeNatures } from '../analytics/nature.js';

// `npm run categorize [-- --all | --unknown]` — scraper categories, rules, then the AI for every merchant still without one
// (--all re-asks every merchant the AI categorised; --unknown only those it left in the unknown category)
const db = getDb();
const scraper = categorizeTransactions(db);
const ai = await categorizeMerchants(db, { all: process.argv.includes('--all'), unknown: process.argv.includes('--unknown') });
console.log('Categorize:', { scraper, ...ai, natures: computeNatures(db) });
