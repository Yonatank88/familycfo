import type { DB } from '../db/connection.js';

/** Remove what a source brought (on "Remove" without keeping its data): its accounts, rows, holdings, snapshots, runs. */
export function deleteSourceData(db: DB, source: string, section: 'accounts' | 'investments'): void {
  db.transaction(() => {
    if (section === 'accounts') {
      const accounts = `SELECT id FROM accounts WHERE company = ?`;
      db.prepare(`UPDATE transactions SET matched_txn_id = NULL WHERE matched_txn_id IN
        (SELECT id FROM transactions WHERE account_id IN (${accounts}))`).run(source);
      db.prepare(`DELETE FROM transactions WHERE account_id IN (${accounts})`).run(source);
      db.prepare(`DELETE FROM balances WHERE account_id IN (${accounts})`).run(source);
      db.prepare(`DELETE FROM accounts WHERE company = ?`).run(source);
    } else {
      db.prepare(`DELETE FROM holdings WHERE substr(source, 1, length(?) + 1) = ? || ':'`).run(source, source);
    }
    db.prepare(`DELETE FROM daily_snapshots WHERE source = ?`).run(source);
    db.prepare(`DELETE FROM source_runs WHERE source = ?`).run(source);
  })();
}
