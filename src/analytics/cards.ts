import type { DB } from '../db/connection.js';
import { CARD_PAYMENT_PATTERN } from '../ingest/classify.js';
import { BILL_COMPANY_PATTERNS } from '../ingest/transfers.js';
import { listPlanned, plannedPayments, type PlannedPayment } from './planned.js';
import { addDays, commitmentMatchers, dayInMonth, daysBetween, median, round, today, type Tx } from './common.js';

export interface CardCharge {
  cardAccountId: string;
  company: string;
  displayName: string;
  chargeDate: string;
  /** positive ILS amount known so far (card rows with this charge date) */
  knownAmount: number;
  /** installment payments due this month that the card hasn't reported yet (beyond the scraped months) */
  projectedInstallments: number;
  /** confirmed fixed payments on this card (kindergarten, insurance, classes…) the card hasn't reported yet */
  projectedFixed: number;
  fixedItems: { scheduledId: number; name: string; amount: number; purchaseDate: string }[];
  /** planned one-off purchases (entered in advance) the card hasn't reported yet */
  projectedPlanned: number;
  plannedItems: { plannedId: number; name: string; amount: number; n: number; of: number }[];
  /** typical recent charge, used while the statement is still open */
  typicalAmount: number;
  /** the reported rows that aren't installments or listed fixed payments (everyday purchases) */
  knownVariable: number;
  /** typical everyday purchases of a statement — recent statements without their installments and fixed payments */
  typicalVariable: number;
  /**
   * amount to plan with: what's certain (reported installments and fixed payments, plus the ones not
   * reported yet) + everyday purchases — as reported if the date is close, else at least the typical ones
   */
  expectedAmount: number;
  transactions: number;
  billingBankAccountId: string | null;
  typicalChargeDay: number | null;
}

export interface InstallmentPlan {
  description: string;
  cardAccountId: string;
  memberId: number;
  /** date of the first installment (the purchase) */
  purchaseDate: string;
  installmentAmount: number;
  /** installments already charged as of today */
  paid: number;
  total: number;
  /** installments still to be charged */
  remaining: number;
  nextChargeDate: string | null;
  lastChargeMonth: string;
  remainingAmount: number;
  /** YYYY-MM → amount still to be charged that month */
  schedule: Record<string, number>;
  /** payments the card hasn't reported yet (charge date projected from the last known one) */
  projected: { date: string; amount: number }[];
}

interface CardAccount { id: string; company: string; display_name: string | null; billing_bank_account_id: string | null }

/**
 * Per-card charge totals by charge date (positive ILS). `variable` is the part that isn't an
 * installment or a listed fixed payment — the everyday purchases that change month to month.
 */
function chargesByDate(txs: Tx[], cardId: string, isFixed: (t: Tx) => boolean = () => false): Map<string, { amount: number; variable: number; count: number }> {
  const byDate = new Map<string, { amount: number; variable: number; count: number }>();
  for (const t of txs) {
    // purchases already charged straight to the bank aren't part of the monthly statement
    if (t.accountId !== cardId || t.settledByTxnId != null) continue;
    const cur = byDate.get(t.processedDate) ?? { amount: 0, variable: 0, count: 0 };
    cur.amount += -t.amount;
    if (t.txnType !== 'installments' && !isFixed(t)) cur.variable += -t.amount;
    cur.count++;
    byDate.set(t.processedDate, cur);
  }
  return byDate;
}

/**
 * Suggest which bank account pays each card: the bank account whose card-bill rows best
 * match the card's charge totals (same month, within 3%). Explicit settings win.
 */
export function inferBillingAccounts(db: DB, txs: Tx[]): Map<string, string | null> {
  const cards = db.prepare(`SELECT id, company, display_name, billing_bank_account_id, owner_member_id FROM accounts WHERE kind = 'card'`).all() as (CardAccount & { owner_member_id: number | null })[];
  // a new card with no bill yet: its owner's everyday account, when they have exactly one
  const everyday = db.prepare(`SELECT id, owner_member_id FROM accounts WHERE kind = 'bank' AND active = 1 AND is_savings = 0
    AND COALESCE(currency, 'ILS') = 'ILS'`).all() as { id: string; owner_member_id: number | null }[];
  const ownerAccount = (member: number | null) => {
    const own = everyday.filter(a => member != null && a.owner_member_id === member);
    return own.length === 1 ? own[0].id : null;
  };
  const bills = txs.filter(t => t.accountKind === 'bank' && t.amount < 0 && CARD_PAYMENT_PATTERN.test(t.description.trim()));
  const result = new Map<string, string | null>();

  for (const card of cards) {
    if (card.billing_bank_account_id) { result.set(card.id, card.billing_bank_account_id); continue; }
    const pattern = BILL_COMPANY_PATTERNS[card.company];
    const charges = chargesByDate(txs, card.id);
    const votes = new Map<string, number>();
    for (const [date, c] of charges) {
      const bill = bills.find(b => (!pattern || pattern.test(b.description.trim()))
        && b.processedDate.slice(0, 7) === date.slice(0, 7)
        && Math.abs(-b.amount - c.amount) <= Math.max(5, c.amount * 0.03));
      if (bill) votes.set(bill.accountId, (votes.get(bill.accountId) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    result.set(card.id, best?.[0] ?? ownerAccount(card.owner_member_id));
  }
  return result;
}

/** Upcoming charges per card from today on (the scraper fetches 2 future months). */
export function upcomingCardCharges(db: DB, txs: Tx[], asOf = today()): CardCharge[] {
  // debit cards charge each purchase to the bank immediately — there is no monthly statement
  const cards = db.prepare(`SELECT id, company, display_name, billing_bank_account_id FROM accounts WHERE kind = 'card' AND active = 1 AND is_debit = 0`).all() as CardAccount[];
  const billing = inferBillingAccounts(db, txs);
  const matchers = commitmentMatchers(db);
  const out: CardCharge[] = [];
  // charges within this many days are nearly closed: plan with what's reported
  const close = (date: string) => daysBetween(asOf, date) <= 20;

  for (const card of cards) {
    const listedFixed = (t: Tx) => t.amount < 0 && matchers.some(m => m.matches(t.accountId, t.description));
    const charges = chargesByDate(txs, card.id, listedFixed);
    const past = [...charges.entries()].filter(([d]) => d < asOf).sort(([a], [b]) => a.localeCompare(b));
    // statement totals: the largest multi-row charge of each month (smaller same-month dates are
    // batches debited straight to the bank, not the monthly statement)
    const statements = new Map<string, [string, { amount: number; variable: number; count: number }]>();
    for (const e of past.filter(([, c]) => c.count >= 2)) {
      const m = e[0].slice(0, 7);
      if (!statements.has(m) || statements.get(m)![1].amount < e[1].amount) statements.set(m, e);
    }
    const recent = [...statements.values()].slice(-3);
    const typical = round(median(recent.map(([, c]) => c.amount)));
    const typicalVariable = round(median(recent.map(([, c]) => c.variable)));
    const typicalDay = recent.length ? Math.round(median(recent.map(([d]) => Number(d.slice(8, 10))))) || null : null;

    // (rows that net to nothing — e.g. a reversed charge — aren't a statement)
    for (const [date, c] of [...charges.entries()].filter(([d, c]) => d >= asOf && c.amount > 0).sort(([a], [b]) => a.localeCompare(b))) {
      out.push({
        cardAccountId: card.id,
        company: card.company,
        displayName: card.display_name ?? card.id,
        chargeDate: date,
        knownAmount: round(c.amount),
        projectedInstallments: 0,
        projectedFixed: 0,
        fixedItems: [],
        projectedPlanned: 0,
        plannedItems: [],
        typicalAmount: typical,
        knownVariable: round(c.variable),
        typicalVariable,
        expectedAmount: 0,
        transactions: c.count,
        billingBankAccountId: billing.get(card.id) ?? null,
        typicalChargeDay: typicalDay,
      });
    }

    // no charge dates known yet (e.g. the card hasn't been scraped since charge dates were stored):
    // show the scheduled estimate so the card doesn't silently disappear
    if (!out.some(c => c.cardAccountId === card.id)) {
      const item = db.prepare(`SELECT amount, day_of_month, bank_account_id FROM scheduled_items
        WHERE kind = 'card_charge' AND card_account_id = ? AND status != 'dismissed'`).get(card.id) as
        { amount: number; day_of_month: number; bank_account_id: string | null } | undefined;
      if (item) {
        const [y, m] = asOf.split('-').map(Number);
        let date = dayInMonth(y, m - 1, item.day_of_month);
        if (date <= asOf) date = dayInMonth(m === 12 ? y + 1 : y, m % 12, item.day_of_month);
        out.push({
          cardAccountId: card.id,
          company: card.company,
          displayName: card.display_name ?? card.id,
          chargeDate: date,
          knownAmount: 0,
          projectedInstallments: 0,
          projectedFixed: 0,
          fixedItems: [],
          projectedPlanned: 0,
          plannedItems: [],
          typicalAmount: round(-item.amount),
          knownVariable: 0,
          typicalVariable: round(-item.amount),
          expectedAmount: 0,
          transactions: 0,
          billingBankAccountId: item.bank_account_id ?? billing.get(card.id) ?? null,
          typicalChargeDay: item.day_of_month,
        });
      }
    }
  }

  // the card's charge in `month` — the reported one, or one on `date` (default: the card's usual day)
  const findCharge = (cardId: string, month: string) => out.find(c => c.cardAccountId === cardId && c.chargeDate.slice(0, 7) === month);
  const usualDate = (cardId: string, month: string) => {
    const [y, m] = month.split('-').map(Number);
    return dayInMonth(y, m - 1, out.find(c => c.cardAccountId === cardId)?.typicalChargeDay ?? 2);
  };
  const chargeIn = (cardId: string, month: string, date = usualDate(cardId, month)): CardCharge => {
    const existing = findCharge(cardId, month);
    if (existing) return existing;
    const card = cards.find(c => c.id === cardId)!;
    const sameCard = out.find(c => c.cardAccountId === cardId);
    const charge: CardCharge = {
      cardAccountId: card.id,
      company: card.company,
      displayName: card.display_name ?? card.id,
      chargeDate: date,
      knownAmount: 0,
      projectedInstallments: 0,
      projectedFixed: 0,
      fixedItems: [],
      projectedPlanned: 0,
      plannedItems: [],
      typicalAmount: sameCard?.typicalAmount ?? 0,
      // nothing reported for that month yet: the usual everyday purchases on top of what's certain
      knownVariable: 0,
      typicalVariable: sameCard?.typicalVariable ?? 0,
      expectedAmount: 0,
      transactions: 0,
      billingBankAccountId: sameCard?.billingBankAccountId ?? billing.get(card.id) ?? null,
      typicalChargeDay: sameCard?.typicalChargeDay ?? null,
    };
    out.push(charge);
    return charge;
  };

  // installment payments beyond the months the card has reported yet are still certain charges
  const horizon = addMonths(asOf.slice(0, 7), 3);
  const cardIds = new Set(cards.map(c => c.id));
  for (const plan of installmentPlans(txs, asOf)) {
    if (!cardIds.has(plan.cardAccountId)) continue;
    for (const p of plan.projected) {
      if (p.date <= asOf || p.date.slice(0, 7) > horizon) continue;
      const charge = chargeIn(plan.cardAccountId, p.date.slice(0, 7), p.date);
      charge.projectedInstallments = round(charge.projectedInstallments + p.amount);
    }
  }

  // confirmed fixed payments on a card (kindergarten, insurance, classes, donations…) are certain too:
  // until the card reports one, add it to the statement it will land in
  for (const f of cardCommitments(db, txs)) {
    if (!cardIds.has(f.cardAccountId)) continue; // debit / inactive cards have no monthly statement
    for (let i = -1; i <= 3; i++) {
      const purchaseMonth = addMonths(asOf.slice(0, 7), i);
      const [y, m] = purchaseMonth.split('-').map(Number);
      const purchaseDate = dayInMonth(y, m - 1, f.day);
      if ((f.startDate && purchaseDate < f.startDate) || (f.endDate && purchaseDate > f.endDate)) continue;
      const chargeMonth = addMonths(purchaseMonth, f.lag);
      if (chargeMonth < asOf.slice(0, 7) || chargeMonth > horizon) continue;
      // already reported by the card — it's part of knownAmount
      if (f.rows.some(t => t.date.slice(0, 7) === purchaseMonth || t.processedDate.slice(0, 7) === chargeMonth)) continue;
      // that statement was already charged
      if ((findCharge(f.cardAccountId, chargeMonth)?.chargeDate ?? usualDate(f.cardAccountId, chargeMonth)) <= asOf) continue;
      const charge = chargeIn(f.cardAccountId, chargeMonth);
      charge.projectedFixed = round(charge.projectedFixed + f.amount);
      charge.fixedItems.push({ scheduledId: f.id, name: f.name, amount: f.amount, purchaseDate });
    }
  }

  // planned one-off purchases entered in advance, until the card reports them (then they're matched and drop out)
  for (const item of listPlanned(db).filter(i => cardIds.has(i.accountId))) {
    const payments = plannedPayments(item, txs);
    if (!payments.length) continue;
    // the statement it should have been in was already charged without it: it'll be in the next one
    let shift = 0;
    const month = (p: PlannedPayment) => addMonths(p.chargeMonth!, shift);
    while ((findCharge(item.accountId, month(payments[0]))?.chargeDate ?? usualDate(item.accountId, month(payments[0]))) <= asOf) shift++;
    for (const p of payments) {
      if (month(p) > horizon) continue;
      const charge = chargeIn(item.accountId, month(p));
      charge.projectedPlanned = round(charge.projectedPlanned + p.amount);
      charge.plannedItems.push({ plannedId: item.id, name: item.description, amount: p.amount, n: p.n, of: item.installments });
    }
  }

  // what's certain (reported installments/fixed + the ones not reported yet) + the everyday purchases:
  // as reported when the statement is about to close, else at least the typical amount
  for (const c of out) {
    const certain = c.knownAmount - c.knownVariable + c.projectedInstallments + c.projectedFixed + c.projectedPlanned;
    c.expectedAmount = round(certain + (close(c.chargeDate) && c.transactions > 0 ? c.knownVariable : Math.max(c.knownVariable, c.typicalVariable)));
  }
  return out.sort((a, b) => a.chargeDate.localeCompare(b.chargeDate));
}

interface CardCommitment {
  id: number; name: string; cardAccountId: string; amount: number; day: number;
  startDate: string | null; endDate: string | null;
  /** the card rows that paid it so far */
  rows: Tx[];
  /** months between the purchase and the statement it's charged in (learned from past rows; usually 1) */
  lag: number;
}

/** Confirmed fixed payments made with a card, with the rows that paid them and their billing lag. */
export function cardCommitments(db: DB, txs: Tx[]): CardCommitment[] {
  const items = db.prepare(`SELECT id, name, amount, day_of_month, card_account_id, start_date, end_date FROM scheduled_items
    WHERE card_account_id IS NOT NULL AND kind IN ('fixed_expense','loan','mortgage') AND status = 'confirmed'`).all() as
    { id: number; name: string; amount: number; day_of_month: number; card_account_id: string; start_date: string | null; end_date: string | null }[];
  const matchers = new Map(commitmentMatchers(db).map(m => [m.id, m]));
  return items.map(item => {
    const m = matchers.get(item.id);
    const rows = m ? txs.filter(t => t.amount < 0 && m.matches(t.accountId, t.description)) : [];
    const lags = rows.map(t => monthsBetween(t.date.slice(0, 7), t.processedDate.slice(0, 7)));
    return {
      id: item.id, name: item.name, cardAccountId: item.card_account_id, amount: round(Math.abs(item.amount)), day: item.day_of_month,
      startDate: item.start_date, endDate: item.end_date, rows,
      lag: lags.length ? Math.max(0, Math.round(median(lags))) : 1,
    };
  });
}

const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));

const addMonths = (month: string, n: number) => {
  const d = new Date(`${month}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};

/**
 * Open installment plans. Each installment is its own row (Cal and Max also move its date every
 * month), so rows are grouped by the month the first installment was charged. Rows scraped ahead
 * are known future charges; installments beyond the last known row are projected monthly.
 */
export function installmentPlans(txs: Tx[], asOf = today()): InstallmentPlan[] {
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    if (t.txnType !== 'installments' || !t.installmentTotal || !t.installmentNumber) continue;
    const firstMonth = addMonths(t.processedDate.slice(0, 7), 1 - t.installmentNumber);
    const key = `${t.accountId}|${t.description}|${t.installmentTotal}|${firstMonth}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const plans: InstallmentPlan[] = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.installmentNumber! - b.installmentNumber!);
    const last = rows[rows.length - 1];
    const total = last.installmentTotal!;
    const amount = round(-last.amount);
    const charged = rows.filter(r => r.processedDate <= asOf);
    const paid = charged.length ? charged[charged.length - 1].installmentNumber! : Math.max(0, rows[0].installmentNumber! - 1);
    const remaining = total - paid;
    if (remaining <= 0) continue;

    const schedule: Record<string, number> = {};
    const projected: { date: string; amount: number }[] = [];
    let nextChargeDate: string | null = null;
    for (let n = paid + 1; n <= total; n++) {
      const known = rows.find(r => r.installmentNumber === n);
      const date = known?.processedDate ?? `${addMonths(last.processedDate.slice(0, 7), n - last.installmentNumber!)}${last.processedDate.slice(7)}`;
      nextChargeDate ??= date;
      const m = date.slice(0, 7);
      schedule[m] = round((schedule[m] ?? 0) + (known ? -known.amount : amount));
      if (!known) projected.push({ date, amount });
    }
    const first = rows[0];
    plans.push({
      description: last.description,
      cardAccountId: last.accountId,
      memberId: last.memberId,
      purchaseDate: first.installmentNumber === 1 ? first.date : addMonths(first.date.slice(0, 7), 1 - first.installmentNumber!) + first.date.slice(7),
      installmentAmount: amount,
      paid,
      total,
      remaining,
      nextChargeDate,
      lastChargeMonth: Object.keys(schedule).sort().at(-1)!,
      remainingAmount: round(Object.values(schedule).reduce((s, v) => s + v, 0)),
      schedule,
      projected,
    });
  }
  return plans.sort((a, b) => b.remainingAmount - a.remainingAmount);
}

/** Card-bill rows on bank accounts that no scraped card explains (spend may be missing). */
export function unmatchedCardBills(txs: Tx[], asOf = today()): Tx[] {
  // month → card → charged total that month
  const perMonth = new Map<string, Map<string, number>>();
  for (const t of txs) {
    if (t.accountKind !== 'card') continue;
    const month = t.processedDate.slice(0, 7);
    const cards = perMonth.get(month) ?? new Map<string, number>();
    cards.set(t.accountId, (cards.get(t.accountId) ?? 0) - t.amount);
    perMonth.set(month, cards);
  }
  return txs
    .filter(t => t.kind === 'card_payment' && -t.amount >= 1000 && t.processedDate >= addDays(asOf, -60) && t.processedDate <= asOf)
    .filter(bill => ![...(perMonth.get(bill.processedDate.slice(0, 7))?.values() ?? [])]
      .some(sum => Math.abs(sum + bill.amount) <= Math.max(5, sum * 0.03)));
}
