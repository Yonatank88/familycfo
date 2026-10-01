import { describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { portfolio, portfolioHistory } from '../src/analytics/investments.js';
import { majorUnits } from '../src/analytics/quotes.js';
import { netWorth } from '../src/analytics/networth.js';
import { setRate } from '../src/analytics/fx.js';
import { today } from '../src/analytics/common.js';
import type { DB } from '../src/db/connection.js';

function quote(db: DB, symbol: string, currency: string, price: number, previousClose: number, marketTime = new Date().toISOString()) {
  db.prepare(`INSERT INTO quotes (symbol, currency, price, previous_close, market_time, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(symbol, currency, price, previousClose, marketTime, new Date().toISOString());
}
function holding(db: DB, h: Record<string, unknown>) {
  const keys = Object.keys(h);
  db.prepare(`INSERT INTO holdings (${keys.join(', ')}) VALUES (${keys.map(k => `@${k}`).join(', ')})`).run(h);
}

describe('investments', () => {
  it('converts minor currency units (TASE agorot, London pence)', () => {
    expect(majorUnits('ILA')).toEqual({ currency: 'ILS', factor: 0.01 });
    expect(majorUnits('GBp')).toEqual({ currency: 'GBP', factor: 0.01 });
    expect(majorUnits('USD')).toEqual({ currency: 'USD', factor: 1 });
  });

  it('values holdings in ILS with the gain from the buy price, or from the baseline', () => {
    const db = testDb();
    setRate(db, '2026-01-01', 'USD', 3.5);
    setRate(db, today(), 'USD', 3);
    quote(db, 'NVDA', 'USD', 200, 190);
    quote(db, 'LUMI.TA', 'ILS', 75, 75);
    holding(db, { symbol: 'NVDA', quantity: 10, currency: 'USD', buy_price: 100, buy_date: '2026-01-01', owner_member_id: 1, broker: 'X' });
    holding(db, { symbol: 'LUMI.TA', quantity: 100, currency: 'ILS', baseline_price: 70, baseline_date: today(), owner_member_id: 1, broker: 'X' });

    const p = portfolio(db);
    const nvda = p.holdings.find(h => h.symbol === 'NVDA')!;
    expect(nvda.valueIls).toBe(6000);           // 10 × $200 × 3
    expect(nvda.costIls).toBe(3500);            // 10 × $100 × 3.5 (the rate on the buy date)
    expect(nvda.gainPct).toBe(100);             // in dollars
    expect(nvda.gainIls).toBe(2500);            // in shekels, after the dollar fell
    expect(nvda.dayChangeIls).toBe(300);        // 10 × $10 × 3
    const lumi = p.holdings.find(h => h.symbol === 'LUMI.TA')!;
    expect(lumi.basis).toBe('baseline');
    expect(lumi.gainIls).toBe(500);
    expect(p.totals.valueIls).toBe(13500);
    expect(p.totals.gainIls).toBe(3000);
  });

  it('has no daily change when the market has not traded today', () => {
    const db = testDb();
    quote(db, 'AAPL', 'USD', 110, 100, '2020-01-01T20:00:00Z');
    holding(db, { symbol: 'AAPL', quantity: 1, currency: 'USD', buy_price: 100 });
    expect(portfolio(db).holdings[0].dayChangePct).toBeNull();
    expect(portfolio(db).totals.dayChangeIls).toBe(0);
  });

  it('uses a manual price for something with no quote', () => {
    const db = testDb();
    holding(db, { symbol: 'FUND', quantity: 1000, currency: 'ILS', manual_price: 1.5, buy_price: 1 });
    const h = portfolio(db).holdings[0];
    expect(h.priceSource).toBe('manual');
    expect(h.valueIls).toBe(1500);
    expect(h.gainIls).toBe(500);
  });

  it('builds the value history from daily closes since each holding started', () => {
    const db = testDb();
    quote(db, 'VOO', 'ILS', 12, 11);
    holding(db, { symbol: 'VOO', quantity: 10, currency: 'ILS', buy_price: 9, buy_date: '2026-01-02' });
    for (const [date, close] of [['2026-01-01', 8], ['2026-01-02', 9], ['2026-01-05', 10]] as const) {
      db.prepare(`INSERT INTO quote_history (symbol, date, close) VALUES ('VOO', ?, ?)`).run(date, close);
    }
    expect(portfolioHistory(db)).toEqual([{ date: '2026-01-02', value: 90 }, { date: '2026-01-05', value: 100 }]);
  });

  it('counts holdings in net worth, one item per broker and owner', () => {
    const db = testDb();
    quote(db, 'LUMI.TA', 'ILS', 75, 75);
    holding(db, { symbol: 'LUMI.TA', quantity: 100, currency: 'ILS', buy_price: 60, broker: 'IBKR', owner_member_id: 1 });
    holding(db, { symbol: 'LUMI.TA', quantity: 10, currency: 'ILS', buy_price: 60, broker: 'IBKR', owner_member_id: 1 });
    const nw = netWorth(db);
    const item = nw.items.find(i => i.id.startsWith('portfolio:'))!;
    expect(item.valueIls).toBe(8250);
    expect(item.type).toBe('brokerage');
    expect(nw.totals.liquid).toBe(8250);
  });
});
