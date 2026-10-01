import type { DB } from '../db/connection.js';
import { addDays, loadTransactions, mad, median, NON_SPEND_KINDS, round, today, type Tx } from './common.js';
import { CARD_PAYMENT_PATTERN } from '../ingest/classify.js';

export interface RecurringSeries {
  merchantKey: string;
  accountId: string;
  kind: 'subscription' | 'bill' | 'salary' | 'income' | 'loan';
  typicalAmount: number;
  lastAmount: number;
  typicalDay: number;
  lastDate: string;
  nextExpectedDate: string;
  occurrences: number;
  categoryId: number | null;
  description: string;
}

const LOAN_WORDS = /הלוואה|הלוואות|משכנת|פרעון|loan|mortgage/i;
const SALARY_WORDS = /משכורת|שכר|salary|payroll/i;

/**
 * A merchant (per account) is recurring when it appears in at least 3 of the last 4 calendar
 * months. Stable amounts (≤5% spread) are subscriptions, others bills; inflows are salary/income.
 */
export function detectRecurring(txs: Tx[], asOf = today()): RecurringSeries[] {
  const since = addDays(asOf, -130);
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    if (NON_SPEND_KINDS.has(t.kind) || t.txnType === 'installments' || t.effectiveDate < since) continue;
    // generic debit-card descriptors ("ויזה") mix many different purchases — not one payee
    if (t.accountKind === 'bank' && CARD_PAYMENT_PATTERN.test(t.description.trim())) continue;
    const key = `${t.merchant}|${t.accountId}|${t.amount > 0 ? 'in' : 'out'}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const lastFourMonths = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const d = new Date(`${asOf}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i, 1);
    lastFourMonths.add(d.toISOString().slice(0, 7));
  }

  const series: RecurringSeries[] = [];
  for (const rows of groups.values()) {
    const months = new Set(rows.map(r => r.effectiveDate.slice(0, 7)).filter(m => lastFourMonths.has(m)));
    if (months.size < 3) continue;

    // one amount per month (sum), so a split payment in one month doesn't look like variance
    const perMonth = new Map<string, number>();
    for (const r of rows) perMonth.set(r.effectiveDate.slice(0, 7), (perMonth.get(r.effectiveDate.slice(0, 7)) ?? 0) + Math.abs(r.amount));
    const amounts = [...perMonth.values()];
    const typical = median(amounts);
    if (typical < 1) continue;
    const spread = mad(amounts) / typical;
    if (spread > 0.35) continue; // too irregular to plan around

    const sorted = [...rows].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    const last = sorted[sorted.length - 1];
    const dateOf = (t: Tx) => (t.accountKind === 'bank' ? t.processedDate : t.date);
    const typicalDay = Math.round(median(sorted.map(r => Number(dateOf(r).slice(8, 10)))));
    const inflow = last.amount > 0;
    const text = `${last.description} ${last.categoryName ?? ''}`;

    const kind: RecurringSeries['kind'] = inflow
      ? (SALARY_WORDS.test(text) ? 'salary' : 'income')
      : LOAN_WORDS.test(text) ? 'loan' : spread <= 0.05 ? 'subscription' : 'bill';

    series.push({
      merchantKey: last.merchant,
      accountId: last.accountId,
      kind,
      typicalAmount: round(typical),
      lastAmount: round(Math.abs(last.amount)),
      typicalDay,
      lastDate: dateOf(last),
      nextExpectedDate: nextMonthlyDate(dateOf(last), typicalDay),
      occurrences: rows.length,
      categoryId: last.categoryId,
      description: last.description,
    });
  }
  return series;
}

/** The first date after `lastDate` that falls on `day` (clamped to month length). */
export function nextMonthlyDate(lastDate: string, day: number): string {
  const d = new Date(`${lastDate}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  const len = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, len));
  return d.toISOString().slice(0, 10);
}

/** Recompute the recurring_series table from all transactions. */
export function refreshRecurring(db: DB, asOf = today()): RecurringSeries[] {
  const found = detectRecurring(loadTransactions(db), asOf);
  const upsert = db.prepare(`
    INSERT INTO recurring_series (merchant_key, account_id, kind, typical_amount, last_amount,
      typical_day, last_date, next_expected_date, occurrences, category_id, active)
    VALUES (@merchantKey, @accountId, @kind, @typicalAmount, @lastAmount, @typicalDay, @lastDate,
      @nextExpectedDate, @occurrences, @categoryId, 1)
    ON CONFLICT(merchant_key, account_id) DO UPDATE SET
      kind = excluded.kind, typical_amount = excluded.typical_amount, last_amount = excluded.last_amount,
      typical_day = excluded.typical_day, last_date = excluded.last_date,
      next_expected_date = excluded.next_expected_date, occurrences = excluded.occurrences,
      category_id = excluded.category_id, active = 1
  `);
  db.transaction(() => {
    db.prepare(`UPDATE recurring_series SET active = 0`).run();
    for (const s of found) upsert.run(s);
  })();
  return found;
}
