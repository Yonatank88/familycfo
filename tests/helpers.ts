import { openDb, type DB } from '../src/db/connection.js';

/** An empty database with the baseline schema, without the default categories (each test adds what it needs). */
export function testDb(): DB {
  const db = openDb(':memory:');
  db.exec(`DELETE FROM category_aliases; DELETE FROM categories`);
  return db;
}

export function addAccount(db: DB, id: string, kind: 'bank' | 'card', currency = 'ILS'): void {
  db.prepare(`INSERT INTO accounts (id, company, kind, display_name, currency) VALUES (?, ?, ?, ?, ?)`)
    .run(id, id.split(':')[0], kind, id, currency);
}

let seq = 0;
/** Insert a transaction. Dates are local YYYY-MM-DD; stored like scrapers do (Israel midnight in UTC). */
export function addTx(db: DB, t: {
  account: string; date: string; description: string; amount: number;
  processedDate?: string; kind?: string; categoryId?: number; txnType?: string;
  installmentNumber?: number; installmentTotal?: number; status?: string; raw?: unknown; memo?: string;
}): number {
  const iso = (d: string) => new Date(`${d}T00:00:00+03:00`).toISOString();
  return Number(db.prepare(`
    INSERT INTO transactions (identifier, account_id, date, processed_date, description, memo, original_amount,
      original_currency, charged_amount, charged_currency, kind, kind_source, category_id, txn_type,
      installment_number, installment_total, status, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ILS', ?, 'ILS', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`t${++seq}`, t.account, iso(t.date), t.processedDate ? iso(t.processedDate) : null, t.description, t.memo ?? null,
    t.amount, t.amount, t.kind ?? null, t.kind ? 'auto' : null, t.categoryId ?? null,
    t.txnType ?? null, t.installmentNumber ?? null, t.installmentTotal ?? null, t.status ?? 'completed',
    t.raw ? JSON.stringify(t.raw) : null).lastInsertRowid);
}

/** `when` is an ISO time; stored like SQLite's CURRENT_TIMESTAMP. */
export function addBalance(db: DB, account: string, balance: number, when = new Date().toISOString()): void {
  db.prepare(`INSERT INTO balances (account_id, balance, timestamp) VALUES (?, ?, ?)`).run(account, balance, when.replace('T', ' ').slice(0, 19));
}

export function addHolding(db: DB, h: { source: string; symbol: string; quantity: number; currency: string; assetClass: string; price: number }): void {
  db.prepare(`INSERT INTO holdings (source, symbol, quantity, currency, asset_class, manual_price) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(h.source, h.symbol, h.quantity, h.currency, h.assetClass, h.price);
}

export const rate = (db: DB, date: string, currency: string, value: number) =>
  db.prepare(`INSERT INTO fx_rates (date, currency, rate_to_ils, source) VALUES (?, ?, ?, 'boi')`).run(date, currency, value);

export const kindOf = (db: DB, id: number) => db.prepare(`SELECT kind FROM transactions WHERE id = ?`).pluck().get(id);
