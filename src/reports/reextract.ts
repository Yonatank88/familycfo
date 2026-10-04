/**
 * Re-extract one stored report: npm run reports:reextract -- <report id>
 * Reads its file with Claude again and applies the new reading through the same checks — its identity unchanged, its
 * values (and stated returns) updated. When a check asks something, nothing changes and the questions are printed.
 */
import { getDb } from '../db/connection.js';
import { reextractReport } from './index.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id < 1) {
  console.error('usage: npm run reports:reextract -- <report id>');
  process.exit(1);
}
try {
  const { report, questions } = await reextractReport(getDb(), id);
  if (questions.length) {
    console.log(`report ${id}: not changed — the checks ask:`);
    for (const q of questions) console.log(`  · ${q.text}`);
    process.exit(1);
  }
  const n = getDb().prepare(`SELECT COUNT(*) FROM report_values WHERE report_id = ?`).pluck().get(id);
  console.log(`report ${id}: re-extracted — ${[report.issuer, report.as_of].filter(Boolean).join(', ')}, ${n} product(s)`);
} catch (err) {
  console.error(`report ${id}: ${(err as Error).message}`);
  process.exit(1);
}
