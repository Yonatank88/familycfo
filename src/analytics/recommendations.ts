import type { DB } from '../db/connection.js';
import { addDays, cycleFor, cycleStartDay, loadTransactions, median, recentCycles, round, today } from './common.js';
import { summarizeCycle } from './cashflow.js';
import { savingsCapacity } from './planning.js';
import { bankBalances } from './forecast.js';

export interface Recommendation {
  key: string;
  type: string;
  title: string;
  detail: string;
  monthlySaving: number;
  annualSaving: number;
  examples: { description: string; amount: number }[];
}

/** Services that often overlap — paying for several in a group is a candidate to cancel. */
const SERVICE_GROUPS: { name: string; pattern: RegExp }[] = [
  { name: 'סטרימינג', pattern: /netflix|disney|spotify|apple\s*(tv|music)|youtube|hbo|yes\s*plus|sting|partner\s*tv|hot\s*(vod|plus)|cellcom\s*tv|deezer/i },
  { name: 'אחסון ענן', pattern: /google\s*one|icloud|dropbox|onedrive|box\.com|apple\s*com\s*bill/i },
  { name: 'כלי AI', pattern: /openai|chatgpt|anthropic|claude|cursor|elevenlabs|midjourney|runpod|perplexity|copilot|gemini/i },
  { name: 'חדרי כושר ואפליקציות ספורט', pattern: /holmes|הולמס|גו אקטיב|go active|strava|fitbit|כושר/i },
];

export function buildRecommendations(db: DB, asOf = today()): Recommendation[] {
  const txs = loadTransactions(db);
  const recs: Recommendation[] = [];
  const subs = db.prepare(`SELECT * FROM recurring_series WHERE active = 1 AND kind IN ('subscription','bill')`).all() as
    { merchant_key: string; account_id: string; kind: string; typical_amount: number; last_amount: number }[];
  const describe = (merchant: string) => txs.find(t => t.merchant === merchant)?.description ?? merchant;

  // 1. subscriptions ranked by yearly cost
  const subscriptions = subs.filter(s => s.kind === 'subscription').sort((a, b) => b.typical_amount - a.typical_amount);
  if (subscriptions.length) {
    const monthly = subscriptions.reduce((s, x) => s + x.typical_amount, 0);
    recs.push({
      key: 'subscriptions:review', type: 'subscriptions',
      title: `${subscriptions.length} מנויים קבועים — ₪${Math.round(monthly * 12).toLocaleString('he-IL')} בשנה`,
      detail: 'כדאי לעבור על הרשימה ולבטל את מה שלא בשימוש. ביטול של רבע מהמנויים חוסך בערך את הסכום המוצג.',
      monthlySaving: round(monthly * 0.25), annualSaving: round(monthly * 12 * 0.25),
      examples: subscriptions.slice(0, 8).map(s => ({ description: describe(s.merchant_key), amount: s.typical_amount })),
    });
  }

  // 2. overlapping services
  for (const group of SERVICE_GROUPS) {
    const inGroup = subs.filter(s => group.pattern.test(describe(s.merchant_key)) || group.pattern.test(s.merchant_key));
    if (inGroup.length < 2) continue;
    const cheapest = Math.min(...inGroup.map(s => s.typical_amount));
    const total = inGroup.reduce((s, x) => s + x.typical_amount, 0);
    recs.push({
      key: `overlap:${group.name}`, type: 'overlap',
      title: `${inGroup.length} שירותי ${group.name} במקביל`,
      detail: `משלמים ₪${Math.round(total)} בחודש על ${group.name}. אם שירות אחד מספיק, אפשר לחסוך את השאר.`,
      monthlySaving: round(total - cheapest), annualSaving: round((total - cheapest) * 12),
      examples: inGroup.map(s => ({ description: describe(s.merchant_key), amount: s.typical_amount })),
    });
  }

  // 3. price increases
  for (const s of subs.filter(s => s.last_amount > s.typical_amount * 1.05 && s.last_amount - s.typical_amount >= 2)) {
    const diff = s.last_amount - s.typical_amount;
    recs.push({
      key: `price:${s.merchant_key}:${s.account_id}`, type: 'price_increase',
      title: `המחיר של ${describe(s.merchant_key)} עלה`,
      detail: `מ-₪${Math.round(s.typical_amount)} ל-₪${Math.round(s.last_amount)}. כדאי לבדוק מבצע שהסתיים או לנהל משא ומתן.`,
      monthlySaving: round(diff), annualSaving: round(diff * 12), examples: [],
    });
  }

  // 4. fees: bank fees, card fees, credit allocation, foreign-currency conversion
  const since = addDays(asOf, -90);
  const fees = txs.filter(t => t.date >= since && t.kind === 'expense'
    && (/עמלה|עמלת|עמ'|דמי כרטיס|דמי ניהול|ריבית/.test(t.description) || t.categoryName === 'עמלות בנקאיות'));
  if (fees.length) {
    const total = fees.reduce((s, t) => s - t.amount, 0);
    recs.push({
      key: 'fees:bank', type: 'fees',
      title: `עמלות בנק וכרטיסים: ₪${Math.round(total / 3)} בחודש`,
      detail: 'אפשר לבקש מהבנק לבטל עמלות (דמי כרטיס, הקצאת אשראי) או לעבור למסלול עמלות דיגיטלי.',
      monthlySaving: round(total / 3), annualSaving: round((total / 3) * 12),
      examples: fees.slice(0, 6).map(t => ({ description: t.description, amount: round(-t.amount) })),
    });
  }
  const foreign = txs.filter(t => t.date >= since && t.kind === 'expense' && isForeign(db, t.id));
  if (foreign.length >= 5) {
    const volume = foreign.reduce((s, t) => s - t.amount, 0) / 3;
    recs.push({
      key: 'fees:fx', type: 'fees',
      title: `${foreign.length} עסקאות במט"ח ב-3 חודשים`,
      detail: 'על עסקאות במט"ח נגבית בדרך כלל עמלת המרה של כ-2.5%-3%. כרטיס או חשבון מט"ח ללא עמלה יחסכו אותה.',
      monthlySaving: round(volume * 0.025), annualSaving: round(volume * 0.025 * 12), examples: [],
    });
  }

  // 5. insurance: several policies — check Har HaBituach for duplicate coverage
  const insurers = new Set(txs.filter(t => t.date >= since && t.categoryName === 'ביטוחים').map(t => t.merchant));
  if (insurers.size >= 2) {
    const monthly = txs.filter(t => t.date >= since && t.categoryName === 'ביטוחים').reduce((s, t) => s - t.amount, 0) / 3;
    recs.push({
      key: 'insurance:duplicates', type: 'insurance',
      title: `${insurers.size} גופי ביטוח שונים — ₪${Math.round(monthly)} בחודש`,
      detail: 'כפל ביטוחי בריאות וחיים נפוץ מאוד. כדאי להוציא דוח מ"הר הביטוח" ולבדוק כפילויות (במיוחד ביטוח בריאות פרטי מול שב"ן).',
      monthlySaving: round(monthly * 0.2), annualSaving: round(monthly * 12 * 0.2),
      examples: [...insurers].slice(0, 6).map(m => ({ description: describe(m), amount: 0 })),
    });
  }

  // 6. categories trending up vs the last 3 cycles
  const startDay = cycleStartDay(db);
  const cycles = recentCycles(asOf, 4, startDay).slice(0, -1).map(c => summarizeCycle(txs, c));
  const last = cycles.at(-1);
  if (last) {
    for (const c of last.byCategory) {
      const typical = median(cycles.slice(0, -1).map(p => p.byCategory.find(x => x.categoryId === c.categoryId)?.spend ?? 0));
      if (typical > 0 && c.dynamic > typical * 1.25 && c.dynamic - typical > 300) {
        recs.push({
          key: `trend:${c.categoryId}:${last.cycle.key}`, type: 'trend',
          title: `עלייה בהוצאות ${c.name}`,
          detail: `₪${Math.round(c.spend)} בחודש שעבר לעומת ₪${Math.round(typical)} בדרך כלל.`,
          monthlySaving: round(c.dynamic - typical), annualSaving: round((c.dynamic - typical) * 12), examples: [],
        });
      }
    }
  }

  // 7. idle cash on current accounts
  const capacity = savingsCapacity(db, {}, asOf);
  const cash = bankBalances(db).reduce((s, b) => s + Math.max(0, b.balance), 0);
  const monthlyOut = capacity.averageFixed + capacity.averageDynamic;
  if (monthlyOut > 0 && cash > monthlyOut * 2) {
    const idle = cash - monthlyOut * 1.5;
    recs.push({
      key: 'cash:idle', type: 'savings',
      title: `₪${Math.round(idle).toLocaleString('he-IL')} יושבים בעו"ש`,
      detail: 'כסף מעבר לחודש וחצי של הוצאות לא מרוויח ריבית בעו"ש. קרן כספית או פיקדון נזיל ישאירו אותו זמין.',
      monthlySaving: round((idle * 0.04) / 12), annualSaving: round(idle * 0.04), examples: [],
    });
  }

  // 8. savings capacity not assigned to funds
  const targets = db.prepare(`SELECT COALESCE(SUM(monthly_target), 0) FROM sinking_funds`).pluck().get() as number;
  if (capacity.monthlyCapacity > targets + 200) {
    recs.push({
      key: `capacity:${cycleFor(asOf, startDay).key}`, type: 'savings',
      title: `אפשר לחסוך בערך ₪${Math.round(capacity.monthlyCapacity).toLocaleString('he-IL')} בחודש`,
      detail: `היעדים החודשיים בקופות מסתכמים ב-₪${Math.round(targets)}. כדאי להגדיר הוראת קבע לחיסכון כבר בתחילת החודש.`,
      monthlySaving: 0, annualSaving: 0, examples: capacity.allocation.map(a => ({ description: a.name, amount: a.amount })),
    });
  }

  const states = new Map((db.prepare(`SELECT key, state, until FROM recommendation_states`).all() as { key: string; state: string; until: string | null }[])
    .map(s => [s.key, s]));
  return recs
    .filter(r => {
      const s = states.get(r.key);
      return !s || (s.state === 'snoozed' && s.until != null && s.until < asOf);
    })
    .sort((a, b) => b.annualSaving - a.annualSaving);
}

function isForeign(db: DB, id: number): boolean {
  const row = db.prepare(`SELECT original_currency FROM transactions WHERE id = ?`).pluck().get(id) as string | null;
  return !!row && !['ILS', '₪', 'NIS', 'ש"ח'].includes(row.toUpperCase());
}

