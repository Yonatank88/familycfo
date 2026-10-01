import type { DB } from '../db/connection.js';
import {
  addDays, cycleFor, cycleStartDay, dayInMonth, daysBetween, getSetting, loadTransactions,
  merchantKey, round, today, trimmedMean, type Tx,
} from './common.js';
import { upcomingCardCharges, type CardCharge } from './cards.js';
import { listScheduled, type ScheduledItem } from './scheduled.js';
import { listPlanned, plannedPayments } from './planned.js';

export interface ForecastEvent {
  date: string;
  accountId: string;
  name: string;
  kind: ScheduledItem['kind'] | 'dynamic' | 'planned';
  /** signed ILS */
  amount: number;
  memberId: number | null;
  estimated: boolean;
  source: 'scheduled' | 'card' | 'dynamic';
  /** card_charge events: the card whose purchases make up the charge */
  cardAccountId?: string | null;
}

export interface AccountForecast {
  accountId: string;
  displayName: string;
  ownerMemberId: number | null;
  startBalance: number;
  balanceDate: string | null;
  stale: boolean;
  points: { date: string; expected: number; low: number; high: number }[];
  lowest: { date: string; amount: number };
  /** expected balance at the end of the planning period (the cycle, or the next one near its end) */
  endOfCycle: number;
  /** estimated everyday spending per day that isn't a scheduled item (Bit, cash, debit purchases) */
  dailyRate: number;
  /** money to add so the balance stays above the buffer until the end of the period, and the day it's needed by (first overdraft, else first dip below the buffer) */
  shortfall: { amount: number; by: string | null };
}

export interface Forecast {
  asOf: string;
  cycle: { key: string; start: string; end: string };
  /** the month being planned: the current cycle, or the next one when fewer than 5 days are left */
  period: { key: string; start: string; end: string };
  horizonEnd: string;
  buffer: number;
  accounts: AccountForecast[];
  total: AccountForecast;
  events: ForecastEvent[];
  /** remaining (future) amounts until the end of the planning period */
  remaining: { income: number; scheduledOut: number; cardCharges: number; dynamic: number };
  warnings: string[];
}

interface BankAccount { id: string; display_name: string | null; owner_member_id: number | null; last_scraped_at: string | null }

export interface ForecastInput {
  asOf: string;
  horizonEnd: string;
  cycleEnd: string;
  accounts: (BankAccount & { balance: number; balanceDate: string | null })[];
  scheduled: ScheduledItem[];
  cardCharges: CardCharge[];
  txs: Tx[];
  buffer: number;
  /** planned one-off payments from a bank account (card ones are inside cardCharges) */
  planned?: { date: string; accountId: string; name: string; amount: number; memberId: number | null }[];
}

/** Has this scheduled item already posted in the month of `date`? (so it isn't counted twice) */
export function alreadyPosted(item: ScheduledItem, date: string, txs: Tx[]): boolean {
  const month = date.slice(0, 7);
  if (item.kind === 'card_charge') return false; // card charges come from real card rows instead
  const pattern = item.match_pattern ?? merchantKey(item.name);
  return txs.some(t => t.accountId === item.bank_account_id
    && (t.accountKind === 'bank' ? t.processedDate : t.date).slice(0, 7) === month
    && Math.sign(t.amount) === Math.sign(item.amount)
    && (t.merchant === pattern || t.merchant.includes(pattern)));
}

/**
 * Daily spend that hits bank accounts directly (not via a card and not a scheduled item),
 * e.g. Bit transfers, cash withdrawals, one-off standing orders. Trimmed mean of the last
 * 3 months, per account.
 */
export function dynamicDailyRate(txs: Tx[], accountId: string, scheduled: ScheduledItem[], asOf: string): number {
  const patterns = scheduled.filter(s => s.bank_account_id === accountId).map(s => s.match_pattern ?? merchantKey(s.name));
  const accountOf = new Map(txs.map(t => [t.id, t.accountId]));
  // card purchases charged straight to this account (debit cards, or single immediate charges such
  // as foreign-currency purchases) — their bank rows are card_payment, so count the purchase itself
  const paidHere = (t: Tx) => (t.accountIsDebit && t.billingBankAccountId === accountId)
    || (t.settledByTxnId != null && accountOf.get(t.settledByTxnId) === accountId);
  const monthly: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const start = addDays(asOf, -30 * i);
    const end = addDays(asOf, -30 * (i - 1));
    const direct = txs
      .filter(t => t.accountId === accountId && t.kind === 'expense' && t.processedDate >= start && t.processedDate < end
        && !t.fixed && !patterns.some(p => t.merchant === p || t.merchant.includes(p)))
      .reduce((acc, t) => acc - t.amount, 0);
    const viaDebitCard = txs
      .filter(t => paidHere(t) && t.kind === 'expense' && t.date >= start && t.date < end)
      .reduce((acc, t) => acc - t.amount, 0);
    const sum = direct + viaDebitCard;
    monthly.push(sum);
  }
  return trimmedMean(monthly) / 30;
}

/** Pure projection — see buildForecast for the data loading. */
export function projectForecast(input: ForecastInput): Omit<Forecast, 'cycle' | 'period' | 'remaining'> & { remaining: Forecast['remaining'] } {
  const { asOf, horizonEnd, cycleEnd, txs, buffer } = input;
  const events: ForecastEvent[] = [];
  const warnings: string[] = [];

  // 1. scheduled items for every month in the horizon
  for (const item of input.scheduled) {
    if (!item.bank_account_id || item.kind === 'card_charge') continue;
    for (let d = new Date(`${asOf.slice(0, 7)}-01T12:00:00Z`); d.toISOString().slice(0, 10) <= horizonEnd; d.setUTCMonth(d.getUTCMonth() + 1)) {
      const date = dayInMonth(d.getUTCFullYear(), d.getUTCMonth(), item.day_of_month);
      if (date <= asOf || date > horizonEnd) continue;
      if (item.start_date && date < item.start_date) continue;
      if (item.end_date && date > item.end_date) continue;
      if (alreadyPosted(item, date, txs)) continue;
      events.push({ date, accountId: item.bank_account_id, name: item.name, kind: item.kind, amount: item.amount,
        memberId: item.member_id, estimated: item.amount_mode === 'estimated', source: 'scheduled' });
    }
  }

  // 1b. planned one-off payments from a bank account (a date that passed without the row is still expected: tomorrow)
  for (const p of input.planned ?? []) {
    const date = p.date <= asOf ? addDays(asOf, 1) : p.date;
    if (date > horizonEnd) continue;
    events.push({ date, accountId: p.accountId, name: p.name, kind: 'planned', amount: -Math.abs(p.amount),
      memberId: p.memberId, estimated: false, source: 'scheduled' });
  }

  // 2. card charges: known future statements, then the scheduled estimate for later months
  const cardMonths = new Set<string>();
  for (const c of input.cardCharges) {
    if (c.chargeDate <= asOf || c.chargeDate > horizonEnd) continue;
    if (!c.billingBankAccountId) {
      warnings.push(`לא ידוע מאיזה חשבון בנק משולם ${c.displayName} — הגדר בהגדרות`);
      continue;
    }
    cardMonths.add(`${c.cardAccountId}|${c.chargeDate.slice(0, 7)}`);
    events.push({ date: c.chargeDate, accountId: c.billingBankAccountId, name: `חיוב ${c.displayName}`, kind: 'card_charge',
      amount: -c.expectedAmount, memberId: null, estimated: c.expectedAmount !== c.knownAmount, source: 'card', cardAccountId: c.cardAccountId });
  }
  const debitCards = new Set(txs.filter(t => t.accountIsDebit).map(t => t.accountId));
  for (const item of input.scheduled.filter(s => s.kind === 'card_charge' && s.bank_account_id)) {
    if (item.card_account_id && debitCards.has(item.card_account_id)) {
      warnings.push(`"${item.name}" הוא כרטיס דביט — כל עסקה יורדת מהבנק מיד, אז החיוב החודשי לא נספר. אפשר להסיר אותו בהגדרות`);
      continue;
    }
    for (let d = new Date(`${asOf.slice(0, 7)}-01T12:00:00Z`); d.toISOString().slice(0, 10) <= horizonEnd; d.setUTCMonth(d.getUTCMonth() + 1)) {
      const date = dayInMonth(d.getUTCFullYear(), d.getUTCMonth(), item.day_of_month);
      if (date <= asOf || date > horizonEnd || cardMonths.has(`${item.card_account_id}|${date.slice(0, 7)}`)) continue;
      // a statement for this card already charged this month
      if (txs.some(t => t.accountId === item.card_account_id && t.processedDate.slice(0, 7) === date.slice(0, 7) && t.processedDate <= asOf)) continue;
      events.push({ date, accountId: item.bank_account_id!, name: item.name, kind: 'card_charge', amount: item.amount,
        memberId: item.member_id, estimated: true, source: 'card', cardAccountId: item.card_account_id });
    }
  }

  // 3. daily projection per account
  const accounts: AccountForecast[] = input.accounts.map(acc => {
    const rate = dynamicDailyRate(txs, acc.id, input.scheduled, asOf);
    const byDate = new Map<string, ForecastEvent[]>();
    for (const e of events.filter(e => e.accountId === acc.id)) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);

    let expected = acc.balance, low = acc.balance, high = acc.balance;
    const points = [{ date: asOf, expected, low, high }];
    for (let date = addDays(asOf, 1); date <= horizonEnd; date = addDays(date, 1)) {
      for (const e of byDate.get(date) ?? []) {
        expected += e.amount;
        // estimated outflows may be 10% worse, estimated inflows 10% lower
        low += e.estimated ? (e.amount < 0 ? e.amount * 1.1 : e.amount * 0.9) : e.amount;
        high += e.estimated ? (e.amount < 0 ? e.amount * 0.9 : e.amount * 1.05) : e.amount;
      }
      expected -= rate;
      low -= rate * 1.3;
      high -= rate * 0.7;
      points.push({ date, expected: round(expected), low: round(low), high: round(high) });
    }
    if (rate > 0) {
      events.push({ date: horizonEnd, accountId: acc.id, name: 'הוצאות שוטפות (הערכה)', kind: 'dynamic',
        amount: -round(rate * daysBetween(asOf, horizonEnd)), memberId: acc.owner_member_id, estimated: true, source: 'dynamic' });
    }
    const lowestPoint = points.reduce((m, p) => (p.expected < m.expected ? p : m), points[0]);
    const inPeriod = points.filter(p => p.date <= cycleEnd);
    const lowestInPeriod = Math.min(...inPeriod.map(p => p.expected));
    const stale = !acc.balanceDate || daysBetween(acc.balanceDate.slice(0, 10), asOf) > 3;
    if (stale) warnings.push(`היתרה של ${acc.display_name ?? acc.id} לא עודכנה מאז ${acc.balanceDate?.slice(0, 10) ?? 'אף פעם'}`);
    return {
      accountId: acc.id,
      displayName: acc.display_name ?? acc.id,
      ownerMemberId: acc.owner_member_id,
      startBalance: round(acc.balance),
      balanceDate: acc.balanceDate,
      stale,
      points,
      lowest: { date: lowestPoint.date, amount: lowestPoint.expected },
      endOfCycle: points.find(p => p.date === cycleEnd)?.expected ?? points[points.length - 1].expected,
      dailyRate: round(rate),
      shortfall: { amount: round(Math.max(0, buffer - lowestInPeriod)), by: inPeriod.find(p => p.expected < 0)?.date ?? inPeriod.find(p => p.expected < buffer)?.date ?? null },
    };
  });

  for (const a of accounts) {
    if (a.lowest.amount < buffer) {
      warnings.push(`${a.displayName} צפוי לרדת ל-₪${Math.round(a.lowest.amount).toLocaleString('he-IL')} ב-${a.lowest.date}`);
    }
  }

  const total = sumAccounts(accounts, cycleEnd);
  const inCycle = events.filter(e => e.date > asOf && e.date <= cycleEnd && e.source !== 'dynamic');
  const dynamicInCycle = accounts.reduce((sum, a) => sum + dynamicDailyRate(txs, a.accountId, input.scheduled, asOf) * Math.max(0, daysBetween(asOf, cycleEnd)), 0);

  return {
    asOf,
    horizonEnd,
    buffer,
    accounts,
    total,
    events: events.sort((a, b) => a.date.localeCompare(b.date)),
    remaining: {
      income: round(inCycle.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0)),
      scheduledOut: round(-inCycle.filter(e => e.amount < 0 && e.kind !== 'card_charge').reduce((s, e) => s + e.amount, 0)),
      cardCharges: round(-inCycle.filter(e => e.kind === 'card_charge').reduce((s, e) => s + e.amount, 0)),
      dynamic: round(dynamicInCycle),
    },
    warnings,
  };
}

function sumAccounts(accounts: AccountForecast[], cycleEnd: string): AccountForecast {
  const points = accounts[0]?.points.map((p, i) => ({
    date: p.date,
    expected: round(accounts.reduce((s, a) => s + a.points[i].expected, 0)),
    low: round(accounts.reduce((s, a) => s + a.points[i].low, 0)),
    high: round(accounts.reduce((s, a) => s + a.points[i].high, 0)),
  })) ?? [];
  const lowest = points.reduce((m, p) => (p.expected < m.expected ? p : m), points[0] ?? { date: '', expected: 0 });
  return {
    accountId: 'total', displayName: 'כל החשבונות', ownerMemberId: null,
    startBalance: round(accounts.reduce((s, a) => s + a.startBalance, 0)), balanceDate: null,
    stale: accounts.some(a => a.stale), points,
    lowest: { date: lowest.date, amount: lowest.expected },
    endOfCycle: points.find(p => p.date === cycleEnd)?.expected ?? points[points.length - 1]?.expected ?? 0,
    dailyRate: round(accounts.reduce((s, a) => s + a.dailyRate, 0)),
    shortfall: { amount: round(accounts.reduce((s, a) => s + a.shortfall.amount, 0)), by: accounts.map(a => a.shortfall.by).filter(Boolean).sort()[0] ?? null },
  };
}

export type BankBalance = BankAccount & { balance: number; balanceDate: string | null; currency: string; is_savings: number };

/**
 * Latest scraped balance per bank account. By default only ILS current accounts — the ones
 * money flows through day to day. Savings deposits and foreign-currency accounts belong to
 * net worth, not the cash-flow forecast (pass all = true to include them).
 */
export function bankBalances(db: DB, all = false): BankBalance[] {
  return db.prepare(`
    SELECT a.id, a.display_name, a.owner_member_id, a.last_scraped_at, a.currency, a.is_savings,
      COALESCE(b.balance, 0) AS balance, b.timestamp AS balanceDate
    FROM accounts a
    LEFT JOIN balances b ON b.id = (SELECT MAX(id) FROM balances WHERE account_id = a.id)
    WHERE a.kind = 'bank' AND a.active = 1 ${all ? '' : `AND a.is_savings = 0 AND COALESCE(a.currency, 'ILS') = 'ILS'`}
    ORDER BY a.id
  `).all() as BankBalance[];
}

export function buildForecast(db: DB, opts: { asOf?: string; horizonDays?: number; memberId?: number } = {}): Forecast {
  const asOf = opts.asOf ?? today();
  const startDay = cycleStartDay(db);
  const cycle = cycleFor(asOf, startDay);
  const period = planningPeriod(asOf, startDay);
  const horizonEnd = [period.end, addDays(asOf, opts.horizonDays ?? 60)].sort().pop()!;
  const txs = loadTransactions(db);
  let accounts = bankBalances(db);
  if (opts.memberId != null) accounts = accounts.filter(a => a.owner_member_id === opts.memberId);

  const result = projectForecast({
    asOf, horizonEnd, cycleEnd: period.end, accounts,
    scheduled: listScheduled(db),
    cardCharges: upcomingCardCharges(db, txs, asOf),
    txs,
    planned: listPlanned(db).filter(i => i.accountKind === 'bank').flatMap(i => plannedPayments(i, txs)
      .map(p => ({ date: p.date, accountId: p.accountId, amount: p.amount, memberId: i.memberId,
        name: i.installments > 1 ? `${i.description} (${p.n}/${i.installments})` : i.description }))),
    buffer: Number(getSetting(db, 'balance_buffer', '2000')),
  });
  return { ...result, cycle, period };
}

/** The month to plan: the current cycle — or, in its last days, the next one (nothing is left to plan in 0–4 days). */
export function planningPeriod(asOf: string, startDay: number) {
  const cycle = cycleFor(asOf, startDay);
  return daysBetween(asOf, cycle.end) >= 5 ? cycle : cycleFor(addDays(cycle.end, 1), startDay);
}
