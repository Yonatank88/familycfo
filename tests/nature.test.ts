import { describe, expect, it } from 'vitest';
import { ONE_OFF_MIN_AMOUNT, classifyNatures, computeNatures, isStandingOrder, type NatureInput } from '../src/analytics/nature.js';
import { addAccount, addTx, testDb } from './helpers.js';

let seq = 0;
const row = (merchant: string, month: string, amount: number, extra: Partial<NatureInput> = {}): NatureInput => ({
  id: ++seq, merchant, month, amount, category: null, installment: false, standingOrder: false, ...extra,
});
/** a background of small everyday rows so the household median is ~50 */
const background = () => ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
  .flatMap(m => Array.from({ length: 10 }, (_, i) => row('שופרסל', m, 40 + i * 2)));
const natureOf = (rows: NatureInput[], r: NatureInput) => classifyNatures(rows).get(r.id);

describe('nature: monthly', () => {
  it('the same merchant in ≥ 3 of 6 months at a stable amount (±25%) is monthly, from its first charge', () => {
    const subs = ['2026-02', '2026-03', '2026-04', '2026-05'].map((m, i) => row('netflix', m, 50 + i * 3));
    const rows = [...background(), ...subs];
    for (const s of subs) expect(natureOf(rows, s)).toBe('monthly');
  });

  it('two months is not yet recurring; a third makes both earlier ones monthly too', () => {
    const a = row('gym club', '2026-04', 200), b = row('gym club', '2026-05', 200);
    expect(natureOf([...background(), a, b], a)).toBe('everyday');
    const c = row('gym club', '2026-06', 210);
    expect(natureOf([...background(), a, b, c], a)).toBe('monthly');
  });

  it('a new merchant is everyday (or one-off when rare and large), never monthly', () => {
    const coffee = row('new cafe', '2026-06', 30);
    const sofa = row('sofa shop', '2026-06', 4000);
    const rows = [...background(), coffee, sofa];
    expect(natureOf(rows, coffee)).toBe('everyday');
    expect(natureOf(rows, sofa)).toBe('one_off');
  });

  it('unstable amounts are not recurring', () => {
    const rows = [...background(), ...[30, 120, 400, 60].map((a, i) => row('random shop', `2026-0${i + 2}`, a))];
    expect(rows.slice(-4).map(r => natureOf(rows, r))).not.toContain('monthly');
  });

  it('a merchant charged many times a month (a supermarket) is not a subscription even at a stable monthly total', () => {
    const rows = background();
    expect(new Set(rows.map(r => natureOf(rows, r)))).toEqual(new Set(['everyday']));
  });

  it('a price change: the next charge after a recurring run stays monthly within ×2', () => {
    const run = ['2026-01', '2026-02', '2026-03'].map(m => row('spotify', m, 20));
    const raised = row('spotify', '2026-04', 32);   // +60%: outside ±25% of the run
    const rows = [...background(), ...run, raised];
    expect(natureOf(rows, raised)).toBe('monthly');
    const tripled = row('spotify', '2026-05', 100);
    expect(natureOf([...rows, tripled], tripled)).not.toBe('monthly');
  });

  it('installments, standing orders and Bills are monthly by definition', () => {
    const plan = row('ikea', '2026-06', 900, { installment: true });
    const order = row('ועד בית', '2026-06', 300, { standingOrder: true });
    const bill = row('חברת החשמל', '2026-06', 700, { category: 'Bills' });
    const rows = [...background(), plan, order, bill];
    expect([plan, order, bill].map(r => natureOf(rows, r))).toEqual(['monthly', 'monthly', 'monthly']);
  });
});

describe('nature: one-off', () => {
  it('rare (≤ 2 in 12 months) and large (≥ 3× the household median and ≥ ₪500)', () => {
    const tv = row('ksp', '2026-03', 3000);
    const second = row('ksp', '2026-05', 2500);
    expect(natureOf([...background(), tv, second], tv)).toBe('one_off');
    const third = row('ksp', '2026-06', 900);
    expect(natureOf([...background(), tv, second, third], tv)).toBe('everyday');
  });

  it('below the floor or below 3× the median it is everyday', () => {
    const small = row('ksp', '2026-03', ONE_OFF_MIN_AMOUNT - 1);
    expect(natureOf([...background(), small], small)).toBe('everyday');
    // a household whose rows are all big: 600 is not 3× its median
    const big = ['2026-01', '2026-02', '2026-03'].flatMap(m => Array.from({ length: 5 }, (_, i) => row(`shop ${i}${m}`, m, 400 + i)));
    const r = row('ksp', '2026-03', 600);
    expect(natureOf([...big, r], r)).toBe('everyday');
  });

  it('Travel & abroad is one-off, small rows too; installments for a flight stay monthly while they run', () => {
    const cafe = row('cafe paris', '2026-05', 30, { category: 'Travel & abroad' });
    const flight = row('el al', '2026-05', 800, { category: 'Travel & abroad', installment: true });
    const rows = [...background(), cafe, flight];
    expect(natureOf(rows, cafe)).toBe('one_off');
    expect(natureOf(rows, flight)).toBe('monthly');
  });

  it('a refund takes the nature of the merchant\'s nearest charge', () => {
    const tv = row('ksp', '2026-03', 3000), back = row('ksp', '2026-04', -3000);
    expect(natureOf([...background(), tv, back], back)).toBe('one_off');
    const lone = row('nobody', '2026-04', -50);
    expect(natureOf([...background(), lone], lone)).toBe('everyday');
  });
});

describe('standing orders and the stored nature', () => {
  it('reads the card / bank markers; an online shop on a stored card is not one', () => {
    expect(isStandingOrder('בזק הוראת קבע', null)).toBe(true);
    expect(isStandingOrder('אדם תבור הו"ק', null)).toBe(true);
    expect(isStandingOrder('PAYPAL *SPOTIFY', { isdirectDebit: 1 })).toBe(true);
    expect(isStandingOrder('חברת החשמל', { trnType: 'הוראת קבע' })).toBe(true);
    expect(isStandingOrder('WWW.ALIEXPRESS.COM', { isdirectDebit: 1 })).toBe(false);
    expect(isStandingOrder('ארומה', { isdirectDebit: 0 })).toBe(false);
  });

  it('computeNatures writes every spend row and clears rows that stopped being spend', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    const ids = ['2026-03-05', '2026-04-05', '2026-05-05'].map(d => addTx(db, { account: 'max:1', date: d, description: 'NETFLIX', amount: -50, kind: 'expense' }));
    const order = addTx(db, { account: 'max:1', date: '2026-05-10', description: 'ועד בית', amount: -300, kind: 'expense', raw: { trnType: 'הוראת קבע' } });
    const moved = addTx(db, { account: 'max:1', date: '2026-05-10', description: 'x', amount: -10, kind: 'transfer' });
    db.prepare(`UPDATE transactions SET nature = 'everyday' WHERE id = ?`).run(moved);
    const counts = computeNatures(db, '2026-05-31');
    const of = (id: number) => db.prepare(`SELECT nature FROM transactions WHERE id = ?`).pluck().get(id);
    expect(ids.map(of)).toEqual(['monthly', 'monthly', 'monthly']);
    expect(of(order)).toBe('monthly');
    expect(of(moved)).toBeNull();
    expect(counts.monthly).toBe(4);
  });
});
