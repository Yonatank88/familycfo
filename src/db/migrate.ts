import type Database from 'better-sqlite3';
import { migrations } from './migrations.js';

/** Apply pending migrations in order, each in its own transaction. */
export function runMigrations(db: Database.Database): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(db.prepare(`SELECT version FROM schema_version`).pluck().all() as number[]);
  const ran: number[] = [];

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    // foreign_keys must be off while tables are renamed/rebuilt
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      m.up(db);
      db.prepare(`INSERT INTO schema_version (version, name) VALUES (?, ?)`).run(m.version, m.name);
    })();
    db.pragma('foreign_keys = ON');
    ran.push(m.version);
  }
  return ran;
}

// `npm run migrate` — apply migrations to bank.db (or $BANK_DB) and report
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(process.env.BANK_DB || 'bank.db');
  const ran = runMigrations(db);
  console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date.');
}
