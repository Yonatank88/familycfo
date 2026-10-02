/**
 * A demo household with made-up data, to try the app without any bank login:
 *   npm run demo        → creates demo.db (replacing an older one)
 *   npm run dev:demo    → runs the app on it
 * Nothing here is real: names, accounts, merchants and amounts are invented.
 */
import { existsSync, rmSync } from 'fs';
import { openDb, type DB } from './db/connection.js';
import { addDays, today } from './analytics/common.js';
import { runPipeline } from './pipeline.js';

const PATH = process.env.BANK_DB || 'demo.db';

let seq = 0;
/** A scraped-like row. Dates are local YYYY-MM-DD, stored as Israel midnight in UTC like the scrapers do. */
function tx(db: DB, t: { account: string; date: string; processed?: string; description: string; amount: number; sourceCategory?: string;
  installment?: [number, number] }) {
  const iso = (d: string) => new Date(`${d}T00:00:00+03:00`).toISOString();
  db.prepare(`
    INSERT INTO transactions (identifier, account_id, date, processed_date, description, original_amount, original_currency,
      charged_amount, charged_currency, source_category, txn_type, installment_number, installment_total, status)
    VALUES (?, ?, ?, ?, ?, ?, 'ILS', ?, 'ILS', ?, ?, ?, ?, 'completed')
  `).run(`demo-${++seq}`, t.account, iso(t.date), iso(t.processed ?? t.date), t.description, t.amount, t.amount,
    t.sourceCategory ?? null, t.installment ? 'installments' : 'normal', t.installment?.[0] ?? null, t.installment?.[1] ?? null);
}

/** Deterministic "random" so every demo looks the same. */
let seed = 42;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const between = (min: number, max: number) => Math.round((min + rand() * (max - min)) * 100) / 100;

const ym = (d: string) => d.slice(0, 7);
const dayOf = (month: string, day: number) => `${month}-${String(day).padStart(2, '0')}`;
const nextMonth = (month: string) => { const d = new Date(`${month}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); };

function seedDemo(db: DB): void {
  const now = today();
  db.prepare(`UPDATE members SET name = 'דנה' WHERE id = 1`).run();
  db.prepare(`UPDATE members SET name = 'יואב' WHERE id = 2`).run();

  const account = db.prepare(`INSERT INTO accounts (id, company, kind, display_name, owner_member_id, billing_bank_account_id) VALUES (?, ?, ?, ?, ?, ?)`);
  const BANK_A = 'hapoalim:12-345-000001', BANK_B = 'leumi:10-800-000002', CARD_A = 'isracard:0001', CARD_B = 'max:0002';
  account.run(BANK_A, 'hapoalim', 'bank', 'עו"ש דנה', 1, null);
  account.run(BANK_B, 'leumi', 'bank', 'עו"ש יואב', 2, null);
  account.run(CARD_A, 'isracard', 'card', 'ישראכרט דנה', 1, BANK_A);
  account.run(CARD_B, 'max', 'card', 'מקס יואב', 2, BANK_B);

  // five months back, plus the current one so far
  const months: string[] = [];
  for (let m = ym(addDays(now, -150)); m <= ym(now); m = nextMonth(m)) months.push(m);
  const past = (d: string) => d <= now;

  const shops = [
    ['שופרסל דיל', 'מזון וצריכה', 180, 520], ['רמי לוי', 'מזון וצריכה', 250, 700], ['סופר פארם', 'רפואה ובתי מרקחת', 40, 180],
    ['קפה לנדוור', 'מסעדות, קפה וברים', 35, 120], ['מקדונלדס', 'מזון מהיר', 45, 110], ['פז דלק', 'דלק, חשמל וגז', 200, 380],
    ['זארה', 'אופנה', 120, 450], ['איקאה', 'ריהוט ובית', 90, 600], ['נטפליקס', 'פנאי, בידור וספורט', 54.9, 54.9],
    ['ספוטיפיי', 'פנאי, בידור וספורט', 23.9, 23.9], ['פרטנר תקשורת', 'שירותי תקשורת', 99, 99], ['הולמס פלייס', 'פנאי, בידור וספורט', 289, 289],
  ] as const;

  for (const month of months) {
    const cards: Record<string, number> = { [CARD_A]: 0, [CARD_B]: 0 };
    const charge = nextMonth(month);
    // card purchases, charged on the 10th of the next month
    for (const [card, count] of [[CARD_A, 22], [CARD_B, 16]] as const) {
      for (let i = 0; i < count; i++) {
        const [name, category, min, max] = shops[Math.floor(rand() * 8)];
        const date = dayOf(month, 1 + Math.floor(rand() * 27));
        if (!past(date)) continue;
        const amount = -between(min, max);
        tx(db, { account: card, date, processed: dayOf(charge, 10), description: name, amount, sourceCategory: category });
        cards[card] += amount;
      }
    }
    // subscriptions on card A, gym on card B
    for (const [name, category, price] of [shops[8], shops[9], shops[10]]) {
      tx(db, { account: CARD_A, date: dayOf(month, 3), processed: dayOf(charge, 10), description: name, amount: -price, sourceCategory: category });
      cards[CARD_A] -= price;
    }
    tx(db, { account: CARD_B, date: dayOf(month, 5), processed: dayOf(charge, 10), description: shops[11][0], amount: -shops[11][2], sourceCategory: shops[11][1] });
    cards[CARD_B] -= shops[11][2];

    // the bank side: salaries, mortgage, utilities, the card bills of the previous month
    const bank = (account: string, day: number, description: string, amount: number, sourceCategory?: string) => {
      const date = dayOf(month, day);
      if (past(date)) tx(db, { account, date, description, amount, sourceCategory });
    };
    bank(BANK_A, 1, 'משכורת - חברת אלפא בע"מ', 16500, 'משכורת');
    bank(BANK_B, 9, 'משכורת - בטא טכנולוגיות', 13800, 'משכורת');
    bank(BANK_B, 2, 'משכנתא - בנק לאומי', -5200);
    bank(BANK_A, 15, 'עיריית תל אביב - ארנונה', -680);
    bank(BANK_A, 20, 'חברת החשמל', -between(380, 620));
    bank(BANK_B, 12, 'הוראת קבע לחסכון', -1000);
    bank(BANK_A, 4, 'העברה לחשבון יואב', -4000);
    bank(BANK_B, 4, 'העברה מחשבון דנה', 4000);
  }
  // card bills: what each card charged on the 10th, debited from its bank account
  const bills = db.prepare(`
    SELECT account_id, substr(processed_date, 1, 10) AS day, SUM(charged_amount) AS total FROM transactions
    WHERE account_id IN (?, ?) GROUP BY 1, 2
  `).all(CARD_A, CARD_B) as { account_id: string; day: string; total: number }[];
  for (const b of bills) {
    const day = new Date(b.day).toISOString().slice(0, 8) + '10';
    if (!past(day)) continue;
    tx(db, { account: b.account_id === CARD_A ? BANK_A : BANK_B, date: day, description: b.account_id === CARD_A ? 'ישראכרט' : 'מקס איט פיננסים', amount: Math.round(b.total * 100) / 100 });
  }

  // classification rules, as "apply to similar" would create them
  const rule = db.prepare(`INSERT INTO category_rules (match_type, pattern, set_category_id, priority)
    SELECT 'contains', ?, id, 0 FROM categories WHERE name = ?`);
  for (const [pattern, category] of [['משכנתא', 'הלוואות ומשכנתא'], ['ארנונה', 'ארנונה'], ['חברת החשמל', 'חשמל'],
    ['לחסכון', 'חסכון חודשי'], ['העברה', 'העברות כספים']]) rule.run(pattern, category);

  const balance = db.prepare(`INSERT INTO balances (account_id, balance, timestamp) VALUES (?, ?, ?)`);
  balance.run(BANK_A, 18450, `${now} 08:00:00`);
  balance.run(BANK_B, 6230, `${now} 08:00:00`);

  // a savings account, a study fund, a small portfolio (live prices from Yahoo Finance when online)
  const asset = db.prepare(`INSERT INTO assets (name, type, provider, owner_member_id, currency, liquidity_date) VALUES (?, ?, ?, ?, 'ILS', ?)`);
  const savings = Number(asset.run('חיסכון לחופשה', 'bank_savings', 'leumi', 2, null).lastInsertRowid);
  const study = Number(asset.run('קרן השתלמות', 'keren_hishtalmut', 'אלטשולר שחם', 1, addDays(now, 900)).lastInsertRowid);
  const snap = db.prepare(`INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, 'ILS')`);
  snap.run(savings, now, 24000);
  snap.run(study, now, 86500);

  const holding = db.prepare(`INSERT INTO holdings (symbol, name, quantity, currency, buy_price, buy_date, broker, owner_member_id, manual_price, manual_price_date)
    VALUES (?, ?, ?, ?, ?, ?, 'IBKR', 1, ?, ?)`);
  holding.run('VOO', 'Vanguard S&P 500 ETF', 12, 'USD', 480, addDays(now, -300), null, null);
  holding.run('AAPL', 'Apple', 15, 'USD', 190, addDays(now, -200), null, null);
  holding.run('TEVA.TA', 'טבע', 120, 'ILS', 62, addDays(now, -120), null, null);
  holding.run('CASH', 'מזומן בתיק', 3500, 'ILS', 1, null, 1, now);
}

async function main() {
  for (const suffix of ['', '-shm', '-wal']) if (existsSync(PATH + suffix)) rmSync(PATH + suffix);
  const db = openDb(PATH);
  seedDemo(db);
  const summary = await runPipeline(db, {
    txIds: db.prepare(`SELECT id FROM transactions`).pluck().all() as number[],
  });
  console.log(`Demo household created in ${PATH}:`, summary);
  console.log('Run it with: npm run dev:demo');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
