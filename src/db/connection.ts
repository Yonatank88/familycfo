import Database from 'better-sqlite3';
import { ensureSchema } from './schema.js';

export type DB = Database.Database;

let instance: DB | undefined;

/** The database file: finance.db unless BANK_DB says otherwise. */
export const DB_FILE = process.env.BANK_DB || 'finance.db';

/** Open a database (created with the baseline schema when new; any other schema is refused). Tests pass ':memory:'. */
export function openDb(path = DB_FILE): DB {
  const db = new Database(path);
  try {
    ensureSchema(db);
  } catch (err) {
    db.close();
    throw err;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Shared process-wide connection. */
export function getDb(): DB {
  instance ??= openDb();
  return instance;
}
