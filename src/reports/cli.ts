/**
 * Import a report from the command line: npm run import -- <file> [<file>…]
 * Reads it with Claude, corroborates it with what's stored and applies it — or leaves it for review in the dashboard.
 */
import { getDb } from '../db/connection.js';
import { importReport } from './index.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run import -- <report file> [<report file>…]');
  process.exit(1);
}
const db = getDb();
let failed = false;
for (const file of files) {
  console.log(`${file}: reading…`);
  try {
    const { report, duplicate } = await importReport(db, file);
    const what = [report.issuer, report.as_of].filter(Boolean).join(', ');
    if (duplicate) console.log(`  already imported (report ${report.id}, ${report.status})`);
    else if (report.status === 'applied') {
      const n = db.prepare(`SELECT COUNT(*) FROM report_values WHERE report_id = ?`).pluck().get(report.id);
      console.log(`  applied — ${what}, ${n} product(s)`);
    } else if (report.status === 'needs_review') {
      const questions = JSON.parse(report.questions ?? '[]') as { text: string }[];
      console.log(`  needs review — ${what}. Open the dashboard to answer:`);
      for (const q of questions) console.log(`  · ${q.text}`);
    } else {
      failed = true;
      console.log(`  ${report.status}: ${report.error}`);
    }
  } catch (err) {
    failed = true;
    console.error(`  ${(err as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
