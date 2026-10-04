export type Currency = 'ILS' | 'USD';

const formatters = new Map<string, Intl.NumberFormat>();
const fmt = (currency: string, compact: boolean) => {
  const key = `${currency}|${compact}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat('en-US', compact
      ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
      : { style: 'currency', currency, maximumFractionDigits: 0 }));
  }
  return formatters.get(key)!;
};

export const money = (n: number | null | undefined, currency: string = 'ILS') => {
  if (n == null) return '—';
  try { return fmt(currency, false).format(n); } catch { return `${Math.round(n).toLocaleString('en-US')} ${currency}`; }
};
export const compact = (n: number, currency: Currency) => fmt(currency, true).format(n);

export const signedMoney = (n: number | null | undefined, currency: Currency) =>
  n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n), currency)}`;
export const signedPct = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`;
/** A quantity: whole above 1,000, else up to 4 decimals (6 below 1). */
export const quantity = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 4 : 6 });
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)}%`);

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'short' });
const monthYearFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const shortMonthYearFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' });
const tinyMonthYearFmt = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const atNoon = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`);
export const day = (d: string) => dayFmt.format(atNoon(d));
export const shortDay = (d: string) => shortDayFmt.format(atNoon(d));
export const monthShort = (m: string) => monthFmt.format(atNoon(`${m}-01`));
export const monthLong = (m: string) => monthYearFmt.format(atNoon(`${m}-01`));
export const monthYear = (m: string) => shortMonthYearFmt.format(atNoon(`${m}-01`));
export const monthYearTiny = (m: string) => tinyMonthYearFmt.format(atNoon(`${m}-01`));
/** A data time: date-only values as a date, timestamps with the time. */
export const asOf = (iso: string | null) => (!iso ? '—' : iso.length <= 10 ? day(iso) : timeFmt.format(new Date(iso)));

/** "5 min ago", "3 h ago", "2 d ago" — the exact time goes in a tooltip (asOf). */
export const ago = (iso: string | null, now = Date.now()) => {
  if (!iso) return '—';
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
};
