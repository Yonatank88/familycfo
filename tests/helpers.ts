import { openDb, type DB } from '../src/db/connection.js';

/** An empty household: migrated, without the default categories (each test adds what it needs). */
export function testDb(): DB {
  const db = openDb(':memory:');
  db.exec(`DELETE FROM category_aliases; DELETE FROM categories`);
  return db;
}

export function addAccount(db: DB, id: string, kind: 'bank' | 'card', owner: number | null = 1, billing: string | null = null): void {
  db.prepare(`INSERT INTO accounts (id, company, kind, display_name, owner_member_id, billing_bank_account_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, id.split(':')[0], kind, id, owner, billing);
}

let seq = 0;
/** Insert a transaction. Dates are local YYYY-MM-DD; stored like scrapers do (Israel midnight in UTC). */
export function addTx(db: DB, t: {
  account: string; date: string; description: string; amount: number;
  processedDate?: string; kind?: string; categoryId?: number; txnType?: string;
  installmentNumber?: number; installmentTotal?: number; status?: string; currency?: string;
}): number {
  const iso = (d: string) => new Date(`${d}T00:00:00+03:00`).toISOString();
  return Number(db.prepare(`
    INSERT INTO transactions (identifier, account_id, date, processed_date, description, original_amount,
      original_currency, charged_amount, charged_currency, kind, kind_source, category_id, txn_type,
      installment_number, installment_total, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ILS', ?, ?, ?, ?, ?, ?, ?)
  `).run(`t${++seq}`, t.account, iso(t.date), t.processedDate ? iso(t.processedDate) : null, t.description,
    t.amount, t.currency ?? 'ILS', t.amount, t.kind ?? null, t.kind ? 'auto' : null, t.categoryId ?? null,
    t.txnType ?? null, t.installmentNumber ?? null, t.installmentTotal ?? null, t.status ?? 'completed').lastInsertRowid);
}

export function addBalance(db: DB, account: string, balance: number, when = new Date().toISOString()): void {
  db.prepare(`INSERT INTO balances (account_id, balance, timestamp) VALUES (?, ?, ?)`).run(account, balance, when.replace('T', ' ').slice(0, 19));
}
