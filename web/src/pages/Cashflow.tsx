import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs, type CycleSummary, type Forecast, type IncomeExpectation, type InstallmentPlan, type MonthIncome, type SavingsCapacity, type TightMonthPlan } from '../api';
import { useFilters, useLookups } from '../state';
import { day, monthName, SCHEDULED_KIND_LABELS } from '../format';
import { BarChart3, Banknote, CalendarRange, Layers, Settings2, TrendingUp, TriangleAlert, Users } from 'lucide-react';
import { ErrorBox, Loading, MemberBadge, Money, PageHeader, SectionTitle, Segmented } from '../components/ui';
import { CashflowBars, Columns, ForecastChart } from '../components/charts';
import { accountIcon, MemberAvatar } from '@/lib/visuals';
import { DayDetails } from '../components/DayDetails';

const shortMonth = (key: string) => new Intl.DateTimeFormat('he-IL', { month: 'short' }).format(new Date(`${key}-01T12:00:00`));

export default function Cashflow() {
  const { params, filters } = useFilters();
  const { accountName, meta } = useLookups();
  const [accountTab, setAccountTab] = useState('total');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [memberTab, setMemberTab] = useState<'all' | number>('all');
  const SHARED_MEMBER = 3;
  // whose item is it: the scheduled item's member, else the owner of the account it hits
  const memberOf = (e: { memberId: number | null; accountId: string }) =>
    e.memberId ?? meta?.accounts.find(a => a.id === e.accountId)?.ownerMemberId ?? SHARED_MEMBER;
  const forecastQ = useQuery({ queryKey: ['forecast', filters.memberId], queryFn: () => api.get<Forecast>(`/forecast${qs({ member: filters.memberId })}`) });
  const historyQ = useQuery({ queryKey: ['cashflow', params], queryFn: () => api.get<CycleSummary[]>(`/cashflow${qs({ ...params, cycles: 7 })}`) });
  const planningQ = useQuery({ queryKey: ['planning', params], queryFn: () =>
    api.get<{ capacity: SavingsCapacity; tight: TightMonthPlan; income: IncomeExpectation; monthIncome: MonthIncome }>(`/planning${qs(params)}`) });
  const installmentsQ = useQuery({ queryKey: ['installments', params], queryFn: () => api.get<InstallmentPlan[]>(`/installments${qs(params)}`) });

  const f = forecastQ.data;
  const selected = f ? (accountTab === 'total' ? f.total : f.accounts.find(a => a.accountId === accountTab) ?? f.total) : undefined;

  // calendar: each event with its account's balance right after it — the previous day's projected
  // balance (which already includes daily running spend) plus that day's events up to and including it
  const calendar = useMemo(() => {
    if (!f) return [];
    const dayTotals = new Map<string, number>();
    return f.events
      .filter(e => e.source !== 'dynamic')
      .map(e => {
        const points = f.accounts.find(a => a.accountId === e.accountId)?.points ?? [];
        const idx = points.findIndex(p => p.date === e.date);
        const before = idx > 0 ? points[idx - 1].expected : f.accounts.find(a => a.accountId === e.accountId)?.startBalance ?? 0;
        const key = `${e.accountId}|${e.date}`;
        const sameDay = (dayTotals.get(key) ?? 0) + e.amount;
        dayTotals.set(key, sameDay);
        return { ...e, balanceAfter: before + sameDay };
      })
      .filter(e => accountTab === 'total' || e.accountId === accountTab);
  }, [f, accountTab]);

  // per-member ledger: what enters and leaves that member's own accounts, with a running total —
  // a shared payment (e.g. the mortgage) debited from one partner's account is part of that partner's month
  const ownerOf = (accountId: string) => meta?.accounts.find(a => a.id === accountId)?.ownerMemberId ?? SHARED_MEMBER;
  const ledger = useMemo(() => {
    let cumulative = 0;
    return calendar
      .map(e => ({ ...e, member: memberOf(e) }))
      .filter(e => memberTab === 'all' || ownerOf(e.accountId) === memberTab)
      .map(e => { cumulative += e.amount; return { ...e, cumulative }; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendar, memberTab, meta]);

  const installmentMonths = useMemo(() => {
    const months = new Map<string, number>();
    for (const p of installmentsQ.data ?? []) for (const [m, v] of Object.entries(p.schedule)) months.set(m, (months.get(m) ?? 0) + v);
    return [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 12);
  }, [installmentsQ.data]);

  if (forecastQ.isLoading) return <Loading />;
  if (forecastQ.error || !f) return <ErrorBox error={forecastQ.error} />;
  const tight = planningQ.data?.tight;

  return (
    <>
      <PageHeader title="תזרים ותחזית" icon={TrendingUp} subtitle={`מתכננים את ${monthName(f.period.key)} · תחזית עד ${day(f.horizonEnd)}`}
        actions={<Link to="/fixed#scheduled" className="btn"><Settings2 className="h-4 w-4" />ניהול הכנסות והוצאות קבועות</Link>} />

      {tight?.isTight && (
        <div role="status" className="card animate-rise-in mb-4 border-rose-200 bg-gradient-to-l from-rose-50/80 to-orange-50/40 dark:border-rose-900/60 dark:from-rose-950/30 dark:to-orange-950/10">
          <div className="mb-2 flex items-center gap-2 font-semibold text-rose-800 dark:text-rose-300">
            <span className="icon-tile h-7 w-7 rounded-lg [&_svg]:h-4 [&_svg]:w-4" style={{ ['--tile' as string]: 'var(--negative)' }}><TriangleAlert /></span>
            חודש לחוץ — כדאי לצמצם
          </div>
          <ul className="mb-3 list-disc space-y-0.5 ps-5 text-sm leading-relaxed text-rose-900 dark:text-rose-200">{tight.reasons.map(r => <li key={r}>{r}</li>)}</ul>
          {tight.cuts.length > 0 && (
            <div className="overflow-x-auto"><table className="table">
              <thead><tr><th>קטגוריה</th><th className="text-end">עד עכשיו</th><th className="text-end">בדרך כלל</th><th className="text-end">בקצב הנוכחי</th><th className="text-end">לצמצם ב-</th></tr></thead>
              <tbody>
                {tight.cuts.map(c => (
                  <tr key={c.categoryId ?? c.name}>
                    <td>{c.name}</td><td className="text-end"><Money value={c.spentSoFar} /></td><td className="text-end"><Money value={c.typical} /></td>
                    <td className="text-end"><Money value={c.projected} /></td><td className="text-end font-semibold text-rose-700"><Money value={c.suggestedCut} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      )}

      <div className="card">
        <Segmented className="mb-4" value={accountTab} onChange={setAccountTab}
          options={[f.total, ...f.accounts].map(a => ({ value: a.accountId, label: a.displayName, icon: accountIcon(a.accountId === 'total' ? undefined : 'bank') }))} />
        {selected && (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div className="rounded-lg bg-muted/60 px-3 py-2"><div className="label">יתרה היום</div><Money value={selected.startBalance} animated className="text-lg font-semibold" colored /></div>
              <div className="rounded-lg bg-muted/60 px-3 py-2"><div className="label">נקודה נמוכה</div><Money value={selected.lowest.amount} animated className="text-lg font-semibold" colored /> <span className="text-xs text-muted-foreground">{day(selected.lowest.date)}</span></div>
              <div className="rounded-lg bg-muted/60 px-3 py-2"><div className="label">סוף {monthName(f.period.key)}</div><Money value={selected.endOfCycle} animated className="text-lg font-semibold" colored /></div>
              <div className="rounded-lg bg-muted/60 px-3 py-2"><div className="label">כרית ביטחון</div><Money value={f.buffer} className="text-lg" /></div>
            </div>
            <ForecastChart points={selected.points ?? []} buffer={f.buffer} height={300} lowest={selected.lowest}
              events={f.events.filter(e => accountTab === 'total' || e.accountId === accountTab)}
              dailyRate={selected.dailyRate} selectedDate={selectedDate} onSelectDate={setSelectedDate} />
            {selectedDate && (
              <DayDetails date={selectedDate} points={selected.points ?? []} dailyRate={selected.dailyRate}
                events={f.events.filter(e => accountTab === 'total' || e.accountId === accountTab)} onClose={() => setSelectedDate(null)} />
            )}
          </>
        )}
        {f.warnings.length > 0 && <div className="mt-2 space-y-0.5 text-xs text-amber-700 dark:text-amber-300">{f.warnings.map(w => <div key={w} className="flex items-start gap-1.5"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w.replace(/^⚠\s*/, '')}</div>)}</div>}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="card min-w-0 p-0 lg:col-span-3">
          <div className="px-4 pt-4 md:px-5"><SectionTitle icon={CalendarRange}>לוח תזרים — מה יורד ונכנס ומתי</SectionTitle></div>
          <div className="px-4 pb-3 md:px-5">
            <Segmented<'all' | number> value={memberTab} onChange={setMemberTab}
              options={[{ value: 'all' as const, label: 'מאוחד', icon: Users }, ...(meta?.members ?? []).map(m => ({
                value: m.id, label: <><MemberAvatar name={m.name} color={m.color} size={16} />{m.name}</>,
              }))]} itemClassName="gap-1.5" />
          </div>
          {memberTab !== 'all' && (
            <div className="animate-fade-in grid grid-cols-3 gap-2 px-4 pb-3 text-sm md:px-5">
              <div><div className="label">נכנס</div><Money value={ledger.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0)} className="font-semibold text-emerald-600" /></div>
              <div><div className="label">יוצא</div><Money value={ledger.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0)} className="font-semibold" /></div>
              <div><div className="label">נטו בתקופה</div><Money value={ledger.reduce((s, e) => s + e.amount, 0)} className="font-semibold" colored /></div>
            </div>
          )}
          <div className="scroll-x border-t border-line"><table className="table">
            <thead><tr><th>תאריך</th><th>מה</th><th>חשבון</th><th>של מי</th><th className="text-end">סכום</th>
              <th className="text-end" title={memberTab === 'all' ? 'יתרת החשבון אחרי הפריט' : 'סכום מצטבר של הכנסות והוצאות של בן המשפחה'}>
                {memberTab === 'all' ? 'יתרה אחרי' : 'מצטבר'}
              </th>
              {memberTab !== 'all' && <th className="text-end">יתרת החשבון</th>}
            </tr></thead>
            <tbody>
              {ledger.map((e, i) => (
                <tr key={i} className={e.balanceAfter < 0 ? 'bg-rose-50/60 dark:bg-rose-950/20' : ''}>
                  <td className="whitespace-nowrap">{day(e.date)}</td>
                  <td className="min-w-40">
                    {e.kind === 'card_charge' && e.cardAccountId
                      ? <Link className="font-medium text-brand-700 hover:underline dark:text-brand-300" title="הצג את העסקאות שבחיוב הזה"
                          to={`/transactions?account=${encodeURIComponent(e.cardAccountId)}&charge=${e.date}`}>{e.name} ←</Link>
                      : <div className="font-medium">{e.name}</div>}
                    <div className="text-[11px] text-muted-foreground">{SCHEDULED_KIND_LABELS[e.kind] ?? e.kind}{e.estimated ? ' · הערכה' : ''}</div>
                  </td>
                  <td className="whitespace-nowrap text-xs text-muted-foreground">{accountName(e.accountId)}</td>
                  <td><MemberBadge id={e.member} /></td>
                  <td className="whitespace-nowrap text-end"><Money value={e.amount} colored /></td>
                  {memberTab === 'all'
                    ? <td className="text-end"><Money value={e.balanceAfter} colored={e.balanceAfter < 0} /></td>
                    : <>
                      <td className="text-end font-medium"><Money value={e.cumulative} colored /></td>
                      <td className="text-end text-xs text-muted-foreground"><Money value={e.balanceAfter} /></td>
                    </>}
                </tr>
              ))}
              {ledger.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-sm text-muted-foreground">אין אירועים מתוכננים — הוסף הכנסות והוצאות קבועות בהגדרות</td></tr>}
            </tbody>
          </table></div>
          <p className="border-t border-line-soft px-4 py-3 text-xs leading-relaxed text-muted-foreground md:px-5">
            {memberTab !== 'all' && <>מוצג כל מה שנכנס ויוצא מהחשבונות של {meta?.members.find(m => m.id === memberTab)?.name}, כולל תשלומים משותפים שיורדים מהם. </>}
            בנוסף מחושבות הוצאות שוטפות ישירות מהבנק (ביט, מזומן) של כ-<Money value={f.remaining.dynamic} /> עד סוף {monthName(f.period.key)}.
          </p>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-2">
          <div className="card">
            {planningQ.data && (() => {
              const mi = planningQ.data.monthIncome;
              return (
                <>
                  <SectionTitle icon={Banknote} color="var(--positive)">הכנסה ב{monthName(mi.cycle.key)}</SectionTitle>
                  <Money value={mi.total} animated className="text-2xl font-semibold tracking-tight text-emerald-600 dark:text-emerald-400" />
                  <div className="mt-1 text-xs text-muted-foreground">נכנס <Money value={mi.received} /> · עוד צפוי <Money value={mi.pending} /></div>
                  <div className="mt-4 space-y-2.5 text-sm">
                    {mi.recurring.map(r => (
                      <div key={r.name + r.accountId} className="flex justify-between gap-2">
                        <span className="truncate">{r.name} <span className="text-xs text-muted-foreground">· {r.received ? `נכנס ${day(r.date)} ✓` : `צפוי ${day(r.date)}`}</span> <MemberBadge id={r.memberId} /></span>
                        <Money value={r.amount} className={r.received ? '' : 'text-muted-foreground'} />
                      </div>
                    ))}
                    {mi.other > 0 && <div className="flex justify-between gap-2"><span>הכנסות נוספות שנכנסו</span><Money value={mi.other} /></div>}
                    <div className="flex justify-between gap-2 border-t border-line-soft pt-2.5 text-xs text-muted-foreground">
                      <span title="משמש רק לחישוב העודף החודשי הממוצע לחיסכון">חודש טיפוסי (ממוצע, כולל הכנסות מזדמנות)</span>
                      <Money value={planningQ.data.income.expectedMonthly} />
                    </div>
                  </div>
                </>
              );
            })()}
          </div>

          <div className="card">
            <SectionTitle icon={Layers} color="var(--chart-6)">תשלומים עתידיים שכבר התחייבתם אליהם</SectionTitle>
            {installmentMonths.length === 0 ? <div className="text-sm text-muted-foreground">אין עסקאות בתשלומים פתוחות</div> : (
              <>
              <Columns data={installmentMonths.map(([m, v]) => ({ label: shortMonth(m), value: v }))} color="var(--chart-6)" height={160} />
              <div className="mt-3 space-y-1.5 text-sm">
                {installmentMonths.map(([m, v]) => <div key={m} className="flex justify-between"><span>{monthName(m)}</span><Money value={v} /></div>)}
              </div>
              </>
            )}
            {(installmentsQ.data ?? []).slice(0, 6).map(p => (
              <div key={p.description + p.purchaseDate} className="mt-2 border-t border-line-soft pt-2 text-xs leading-relaxed text-muted-foreground">
                {p.description} · {p.paid}/{p.total} · נשארו {p.remaining} · <Money value={p.remainingAmount} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card mt-4">
        <SectionTitle icon={BarChart3} color="var(--chart-2)">הכנסות מול הוצאות — 7 מחזורים</SectionTitle>
        {historyQ.data && (
          <CashflowBars data={historyQ.data.map(h => ({ label: monthName(h.cycle.key), income: h.income, fixed: h.fixed, dynamic: h.dynamic }))} />
        )}
        {historyQ.data && (
          <div className="scroll-x card-bleed mt-4">
            <table className="table">
              <thead><tr><th>מחזור</th><th className="text-end">הכנסות</th><th className="text-end">קבועות</th><th className="text-end">משתנות</th><th className="text-end">נטו</th><th className="text-end">הופקד לחיסכון</th></tr></thead>
              <tbody>
                {[...historyQ.data].reverse().map(h => (
                  <tr key={h.cycle.key}>
                    <td>{monthName(h.cycle.key)}</td><td className="text-end"><Money value={h.income} /></td><td className="text-end"><Money value={h.fixed} /></td>
                    <td className="text-end"><Money value={h.dynamic} /></td><td className="text-end"><Money value={h.net} colored /></td>
                    <td className="text-end"><Money value={h.savingsDeposits} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
