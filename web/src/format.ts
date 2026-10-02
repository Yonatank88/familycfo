const ils = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const ils2 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (n: number | null | undefined, cents = false) => (n == null ? '—' : (cents ? ils2 : ils).format(n));

export function moneyIn(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n).toLocaleString('he-IL')} ${currency}`;
  }
}

export const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);

const dayFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short' });
const fullFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
export const day = (d: string | null | undefined) => (d ? dayFmt.format(new Date(`${d.slice(0, 10)}T12:00:00`)) : '—');
export const fullDate = (d: string | null | undefined) => (d ? fullFmt.format(new Date(`${d.slice(0, 10)}T12:00:00`)) : '—');

const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });
export const monthName = (key: string) => monthFmt.format(new Date(`${key}-01T12:00:00`));

export const KIND_LABELS: Record<string, string> = {
  expense: 'הוצאה', income: 'הכנסה', refund: 'זיכוי', transfer: 'העברה פנימית', card_payment: 'תשלום כרטיס', savings: 'הפקדה לחיסכון',
};
export const SCHEDULED_KIND_LABELS: Record<string, string> = {
  income: 'הכנסה', fixed_expense: 'הוצאה קבועה', loan: 'הלוואה', mortgage: 'משכנתא', card_charge: 'חיוב כרטיס', planned: 'הוצאה צפויה',
};
export const ASSET_TYPE_LABELS: Record<string, string> = {
  bank_savings: 'חיסכון בבנק', deposit: 'פיקדון', pension: 'פנסיה', keren_hishtalmut: 'קרן השתלמות', kupat_gemel: 'קופת גמל',
  brokerage: 'תיק השקעות', crypto: 'קריפטו', real_estate: 'נדל"ן', other: 'אחר',
  bank: 'עו"ש', card: 'חיובי כרטיס פתוחים',
};

export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
