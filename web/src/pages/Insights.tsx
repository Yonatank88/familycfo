import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Alert, type Recommendation } from '../api';
import { day, todayIso } from '../format';
import {
  Activity, Bell, CalendarDays, CloudOff, Copy, CreditCard, Lightbulb, type LucideIcon, PieChart, Receipt, Repeat, RotateCcw,
  Sparkles, TrendingUp, TriangleAlert, X,
} from 'lucide-react';
import { Empty, ErrorBox, Loading, Money, PageHeader, SectionTitle, SeverityDot } from '../components/ui';
import { BarList, DonutChart } from '../components/charts';
import { categoryIcon } from '@/lib/visuals';

interface RecurringRow { merchantKey: string; accountId: string; kind: string; typicalAmount: number; lastAmount: number; typicalDay: number; lastDate: string; categoryName: string | null }

const ALERT_TYPES: Record<string, string> = {
  budget: 'תקציב', duplicate: 'חיוב כפול', anomaly: 'חריגה', new_subscription: 'מנוי חדש', price_increase: 'עליית מחיר',
  low_balance: 'יתרה נמוכה', card_vs_balance: 'חיוב כרטיס', fee: 'עמלה', unmatched_card_bill: 'כרטיס לא נסרק',
  scrape_failed: 'סריקה', big_day: 'יום חריג',
};

const ALERT_ICONS: Record<string, LucideIcon> = {
  budget: PieChart, duplicate: Copy, anomaly: Activity, new_subscription: Repeat, price_increase: TrendingUp,
  low_balance: TriangleAlert, card_vs_balance: CreditCard, fee: Receipt, unmatched_card_bill: CreditCard,
  scrape_failed: CloudOff, big_day: CalendarDays,
};
const SEVERITY_TILE: Record<string, string> = { critical: 'var(--negative)', warning: 'var(--chart-3)' };

export default function Insights() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const recs = useQuery({ queryKey: ['recommendations'], queryFn: () => api.get<Recommendation[]>('/recommendations') });
  const alerts = useQuery({ queryKey: ['alerts', showAll ? 'all' : 'open'], queryFn: () => api.get<Alert[]>(`/alerts${showAll ? '?all=1' : ''}`) });
  const recurring = useQuery({ queryKey: ['recurring'], queryFn: () => api.get<RecurringRow[]>('/recurring') });

  const recState = useMutation({
    mutationFn: (b: { key: string; state: string; until?: string }) => api.post('/recommendations/state', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recommendations'] }),
  });
  const alertAction = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, boolean> }) => api.patch(`/alerts/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  // opening the page marks the visible alerts as seen
  useEffect(() => {
    for (const a of alerts.data ?? []) if (!a.seenAt) alertAction.mutate({ id: a.id, body: { seen: true } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts.data]);

  const totalSaving = recs.data?.reduce((s, r) => s + r.annualSaving, 0) ?? 0;
  const snoozeUntil = () => { const d = new Date(`${todayIso()}T12:00:00`); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10); };
  const subs = recurring.data?.filter(r => r.kind === 'subscription') ?? [];

  return (
    <>
      <PageHeader icon={Lightbulb} title="תובנות והתראות" subtitle={recs.data ? <>פוטנציאל חיסכון מוערך: <Money value={totalSaving} animated className="font-semibold text-positive" /> בשנה</> : undefined} />

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 space-y-3 lg:col-span-3">
          <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight"><Sparkles className="h-4 w-4 text-primary" />איפה אפשר לחסוך</h2>
          {recs.data && recs.data.some(r => r.annualSaving > 0) && (
            <div className="card animate-rise-in">
              <BarList color="var(--positive)" items={[...recs.data].filter(r => r.annualSaving > 0).sort((a, b) => b.annualSaving - a.annualSaving)
                .map(r => ({ key: r.key, label: r.title, value: r.annualSaving, icon: <Lightbulb /> }))} />
            </div>
          )}
          {recs.isLoading ? <Loading /> : recs.error ? <ErrorBox error={recs.error} /> : recs.data!.length === 0 ? <Empty>אין המלצות כרגע</Empty> : <div className="stagger space-y-3">{recs.data!.map((r, i) => (
            <div key={r.key} style={{ ['--i' as string]: i }} className="card card-hover">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-3">
                  <span className="icon-tile h-9 w-9" style={{ ['--tile' as string]: r.annualSaving > 0 ? 'var(--positive)' : 'var(--chart-3)' }}>{r.annualSaving > 0 ? <Sparkles /> : <Lightbulb />}</span>
                  <div className="min-w-0">
                    <div className="font-semibold">{r.title}</div>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{r.detail}</p>
                  </div>
                </div>
                {r.annualSaving > 0 && (
                  <div className="shrink-0 rounded-xl bg-positive/10 px-3 py-1.5 text-end">
                    <Money value={r.annualSaving} animated className="text-xl font-bold tracking-tight text-positive" />
                    <div className="text-xs text-positive/80">בשנה</div>
                  </div>
                )}
              </div>
              {r.examples.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {r.examples.map((e, i) => <span key={i} className="chip">{e.description}{e.amount ? <> · <Money value={e.amount} /></> : null}</span>)}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line-soft pt-3">
                <button className="btn" onClick={() => recState.mutate({ key: r.key, state: 'done' })}>✓ טיפלתי</button>
                <button className="btn-ghost" onClick={() => recState.mutate({ key: r.key, state: 'snoozed', until: snoozeUntil() })}>הזכר בעוד חודש</button>
                <button className="btn-ghost" onClick={() => recState.mutate({ key: r.key, state: 'dismissed' })}>לא רלוונטי</button>
              </div>
            </div>
          ))}</div>}

          <div className="card">
            <SectionTitle icon={Repeat} color="var(--chart-6)"><span>מנויים שזוהו ({subs.length}) — <Money value={subs.reduce((s, r) => s + r.typicalAmount, 0) * 12} /> בשנה</span></SectionTitle>
            {subs.length > 0 && (
              <div className="mb-4">
                <DonutChart centerLabel="שנתי" data={subs.map(s => {
                  const Icon = categoryIcon(s.categoryName ?? s.merchantKey);
                  return { key: s.merchantKey + s.accountId, name: s.merchantKey, value: s.typicalAmount * 12, icon: <Icon /> };
                })} />
              </div>
            )}
            <div className="scroll-x card-bleed"><table className="table">
              <thead><tr><th>שירות</th><th>קטגוריה</th><th className="text-end">חודשי</th><th className="text-end">שנתי</th><th>חיוב אחרון</th></tr></thead>
              <tbody>
                {subs.map(s => (
                  <tr key={s.merchantKey + s.accountId}>
                    <td className="min-w-32 font-medium">{s.merchantKey}</td><td className="text-xs text-zinc-500">{s.categoryName}</td>
                    <td className="text-end"><Money value={s.typicalAmount} cents /></td><td className="text-end"><Money value={s.typicalAmount * 12} /></td>
                    <td className="whitespace-nowrap text-xs text-zinc-500">{day(s.lastDate)}{s.lastAmount > s.typicalAmount * 1.05 && <span className="ms-1 text-rose-600">↑ <Money value={s.lastAmount} /></span>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </div>

        <div className="min-w-0 lg:col-span-2">
          <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight"><Bell className="h-4 w-4 text-primary" />התראות</h2>
            <label className="flex min-h-8 items-center gap-2 text-sm text-fg-muted"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> כולל שנסגרו</label>
          </div>
          {alerts.isLoading ? <Loading /> : (alerts.data ?? []).length === 0 ? <Empty>אין התראות</Empty> : (
            <div className="stagger space-y-2">
              {alerts.data!.map((a, i) => {
                const TypeIcon = ALERT_ICONS[a.type] ?? Bell;
                return (
                <div key={a.id} style={{ ['--i' as string]: i }} className={`card card-hover flex gap-3 p-3.5 transition-opacity duration-(--duration-base) md:p-4 ${a.dismissedAt ? 'opacity-50' : ''}`}>
                  <SeverityDot severity={a.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="chip gap-1" style={{ color: SEVERITY_TILE[a.severity], backgroundColor: SEVERITY_TILE[a.severity] ? `color-mix(in oklab, ${SEVERITY_TILE[a.severity]} 12%, transparent)` : undefined }}>
                        <TypeIcon className="h-3 w-3" />{ALERT_TYPES[a.type] ?? a.type}
                      </span>
                      <span className="text-xs text-zinc-500">{day(a.createdAt)}</span>
                    </div>
                    <div className="mt-1.5 text-sm font-medium">{a.title}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">{a.message}</div>
                  </div>
                  <button className="btn-ghost btn-icon -me-1.5 -mt-1 self-start" title={a.dismissedAt ? 'החזר' : 'סגור'} aria-label={a.dismissedAt ? 'החזר' : 'סגור'}
                    onClick={() => alertAction.mutate({ id: a.id, body: { dismissed: !a.dismissedAt } })}>{a.dismissedAt ? <RotateCcw /> : <X />}</button>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
