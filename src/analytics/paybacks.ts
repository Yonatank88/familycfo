import type { DB } from '../db/connection.js';
import { addDays, loadTransactions, type Tx } from './common.js';

const P2P = /ביט|bit|paybox|פייבוקס|פיי בוקס|העברה מ/i;
const MAX_SHARES = 6;

export interface PaybackSuggestion {
  inflowId: number;
  expenseId: number;
  type: 'refund' | 'payback';
  amount: number;
  reason: string;
}

/**
 * Suggest links between inflows and the expenses they pay back (#Bit/refund matching):
 * - refunds: a card credit from the same merchant, up to the expense amount, within 60 days
 * - paybacks: a Bit/PayBox inflow equal to the expense divided by 1..6 people, within 30 days
 */
export function findPaybackCandidates(txs: Tx[], existing: Set<string>): PaybackSuggestion[] {
  const expenses = txs.filter(t => t.kind === 'expense');
  const out: PaybackSuggestion[] = [];
  const usedInflows = new Set([...existing].map(k => Number(k.split('|')[0])));

  for (const inflow of txs.filter(t => t.amount > 0 && !usedInflows.has(t.id) && !['transfer', 'card_payment'].includes(t.kind))) {
    const isRefund = inflow.kind === 'refund' || inflow.accountKind === 'card';
    const isP2P = P2P.test(inflow.description);
    if (!isRefund && !isP2P) continue;

    const windowStart = addDays(inflow.date, isRefund ? -60 : -30);
    const candidates = expenses.filter(e => e.date >= windowStart && e.date <= inflow.date && !existing.has(`${inflow.id}|${e.id}`));

    let best: PaybackSuggestion | undefined;
    if (isRefund) {
      const e = candidates
        .filter(e => e.merchant === inflow.merchant && -e.amount >= inflow.amount - 0.01)
        .sort((a, b) => b.date.localeCompare(a.date))[0];
      if (e) best = { inflowId: inflow.id, expenseId: e.id, type: 'refund', amount: inflow.amount, reason: `זיכוי מ-${inflow.description}` };
    } else {
      for (const e of candidates.sort((a, b) => b.date.localeCompare(a.date))) {
        const total = -e.amount;
        for (let people = 1; people <= MAX_SHARES && !best; people++) {
          if (Math.abs(total / people - inflow.amount) <= Math.max(1, inflow.amount * 0.02)) {
            best = { inflowId: inflow.id, expenseId: e.id, type: 'payback', amount: inflow.amount,
              reason: people === 1 ? `החזר מלא על ${e.description}` : `החזר חלק 1/${people} על ${e.description}` };
          }
        }
        if (best) break;
      }
    }
    if (best) out.push(best);
  }
  return out;
}

export function suggestPaybacks(db: DB): number {
  const existing = new Set((db.prepare(`SELECT from_txn_id || '|' || to_txn_id FROM transaction_links`).pluck().all() as string[]));
  const suggestions = findPaybackCandidates(loadTransactions(db), existing);
  const insert = db.prepare(`INSERT OR IGNORE INTO transaction_links (from_txn_id, to_txn_id, type, amount, status)
    VALUES (?, ?, ?, ?, 'suggested')`);
  db.transaction(() => {
    for (const s of suggestions) insert.run(s.inflowId, s.expenseId, s.type, s.amount);
  })();
  return suggestions.length;
}
