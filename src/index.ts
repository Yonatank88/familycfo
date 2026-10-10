import { lookup } from 'node:dns/promises';
import cron from 'node-cron';
import { scrapeAll, type Config } from './scraper.js';
import { runPipeline } from './pipeline.js';
import { getDb } from './db/connection.js';
import { loadConfig } from './config.js';
import { syncInvestments } from './sync/index.js';

const config = loadConfig();

// a run that fires right after the Mac wakes starts before the network is back, and every source then fails
async function waitForNetwork(maxMs = 5 * 60_000): Promise<void> {
  const until = Date.now() + maxMs;
  for (;;) {
    try {
      await lookup('api.binance.com');
      return;
    } catch {
      if (Date.now() > until) return console.log('Network still down after 5 minutes, scraping anyway');
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

async function run(cfg: Config): Promise<void> {
  await waitForNetwork();
  const db = getDb();
  const results = [...await scrapeAll(cfg, db), ...await syncInvestments(cfg.investments, db)];
  console.log(`\nScrape done: ${results.map(r => `${r.company} ${r.success ? '✓' : `✗ ${r.errorType}`}`).join(', ')}`);
  const summary = await runPipeline(db, { sources: results.map(r => ({ source: r.company, kind: r.kind, success: r.success })) });
  console.log('Pipeline:', summary);
}

// SCHEDULE="0 7 * * *" keeps the process running and scrapes on that cron schedule
const schedule = process.env.SCHEDULE;
if (schedule) {
  console.log(`Bank scraper scheduled: ${schedule}`);
  cron.schedule(schedule, () => {
    console.log(`\n[${new Date().toISOString()}] Running scrape...`);
    run(config).catch(console.error);
  });
} else {
  // exit when done: a failed bank can leave its browser (or an exchange client) holding the event loop open,
  // and a scheduled run that never ends would block the next one
  run(config).then(() => process.exit(0), err => { console.error(err); process.exit(1); });
}
