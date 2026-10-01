import { Link, useNavigate } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, CalendarDays, X } from 'lucide-react';
import type { ForecastEvent, ForecastPoint } from '../api';
import { fullDate, SCHEDULED_KIND_LABELS } from '../format';
import { useLookups } from '../state';
import { MemberBadge, Money } from './ui';

/** What happens on one day of the forecast: every scheduled item, and the balance before and after. */
export function DayDetails({ date, events, points, dailyRate, onClose }: {
  date: string; events: ForecastEvent[]; points: ForecastPoint[]; dailyRate: number; onClose: () => void;
}) {
  const { accountName, meta } = useLookups();
  const navigate = useNavigate();
  const statementUrl = (e: ForecastEvent) => e.kind === 'card_charge' && e.cardAccountId
    ? `/transactions?account=${encodeURIComponent(e.cardAccountId)}&charge=${e.date}` : null;
  const dayEvents = events.filter(e => e.date === date && e.source !== 'dynamic');
  const idx = points.findIndex(p => p.date === date);
  const before = idx > 0 ? points[idx - 1].expected : undefined;
  const after = idx >= 0 ? points[idx].expected : undefined;
  const ownerOf = (e: ForecastEvent) => e.memberId ?? meta?.accounts.find(a => a.id === e.accountId)?.ownerMemberId ?? null;
  const inflow = dayEvents.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const outflow = dayEvents.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0);

  return (
    <div className="animate-rise-in mt-4 rounded-xl border border-primary/20 bg-gradient-to-l from-primary/[0.06] to-transparent p-3 md:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 font-semibold">
          <span className="icon-tile h-8 w-8 rounded-lg [&_svg]:h-4 [&_svg]:w-4"><CalendarDays /></span>
          {fullDate(date)}
        </div>
        <button className="btn-ghost btn-icon -me-1.5" onClick={onClose} aria-label="סגור"><X /></button>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-lg bg-card/70 px-3 py-2"><div className="label">יתרה בתחילת היום</div><Money value={before} colored={before != null && before < 0} /></div>
        <div className="rounded-lg bg-card/70 px-3 py-2"><div className="label flex items-center gap-1"><ArrowDownLeft className="h-3 w-3 text-positive" />נכנס</div><Money value={inflow} className="text-positive" /></div>
        <div className="rounded-lg bg-card/70 px-3 py-2"><div className="label flex items-center gap-1"><ArrowUpRight className="h-3 w-3 text-negative" />יוצא</div><Money value={outflow} /></div>
        <div className="rounded-lg bg-card/70 px-3 py-2"><div className="label">יתרה בסוף היום</div><Money value={after} className="font-semibold" colored={after != null && after < 0} /></div>
      </div>
      {dayEvents.length === 0 ? (
        <div className="text-sm text-muted-foreground">אין חיובים או הכנסות מתוכננים ביום הזה.</div>
      ) : (
        <div className="-mx-3 overflow-x-auto px-3 md:-mx-4 md:px-4"><table className="table">
          <thead><tr><th>מה</th><th>סוג</th><th>חשבון</th><th>של מי</th><th className="text-end">סכום</th></tr></thead>
          <tbody>
            {dayEvents.map((e, i) => {
              const url = statementUrl(e);
              return (
              <tr key={i} className={url ? 'cursor-pointer' : ''}
                title={url ? 'הצג את העסקאות שבחיוב הזה' : undefined} onClick={url ? () => navigate(url) : undefined}>
                <td className="min-w-36 font-medium">{e.name}{url && <span className="ms-1 text-xs text-brand-600">←</span>}</td>
                <td className="whitespace-nowrap text-xs text-muted-foreground">{SCHEDULED_KIND_LABELS[e.kind] ?? e.kind}{e.estimated ? ' · הערכה' : ''}</td>
                <td className="whitespace-nowrap text-xs text-muted-foreground">{accountName(e.accountId)}</td>
                <td><MemberBadge id={ownerOf(e)} /></td>
                <td className="text-end"><Money value={e.amount} colored /></td>
              </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      <div className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-2 text-xs leading-relaxed text-muted-foreground">
        {dailyRate > 0 && <span>בנוסף מחושבות הוצאות שוטפות משוערות של כ-<Money value={dailyRate} /> ליום (ביט, מזומן, כרטיס דביט).</span>}
        <Link className="font-medium text-brand-600 hover:underline dark:text-brand-400" to="/fixed#scheduled">עריכת הכנסות והוצאות קבועות ←</Link>
      </div>
    </div>
  );
}
