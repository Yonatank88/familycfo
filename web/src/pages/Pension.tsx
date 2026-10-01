import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Banknote, CalendarClock, ChartPie, Globe, GraduationCap, HandCoins, Info, Landmark, PiggyBank, ShieldCheck, Sparkles, Umbrella, Vault,
} from 'lucide-react';
import { api, type PensionOverview, type PensionProduct } from '../api';
import { day, fullDate, monthName, todayIso } from '../format';
import { Empty, ErrorBox, Loading, MemberBadge, Modal, Money, PageHeader, Progress, SectionTitle, Stat } from '../components/ui';
import { DonutChart, StackedColumns } from '../components/charts';
import { askAgent } from '../components/AgentChat';
import { cn } from '@/lib/utils';

const TYPE_LABELS: Record<PensionProduct['type'], string> = { pension: 'פנסיה וביטוח מנהלים', keren_hishtalmut: 'קרנות השתלמות', kupat_gemel: 'קופות גמל' };
const SHORT_LABELS: Record<PensionProduct['type'], string> = { pension: 'פנסיה', keren_hishtalmut: 'השתלמות', kupat_gemel: 'גמל' };
const TYPE_ICONS = { pension: Umbrella, keren_hishtalmut: GraduationCap, kupat_gemel: Vault };
const RETURN_LABELS = ['חודש אחרון', 'מתחילת השנה', '12 חודשים', '3 שנים', '5 שנים', 'ממוצע 3 שנים', 'ממוצע 5 שנים'];
const pct = (n: number | null | undefined, digits = 2) => (n == null ? '—' : `${n.toFixed(digits)}%`);
const shortMonthFmt = new Intl.DateTimeFormat('he-IL', { month: 'short', year: '2-digit' });
const shortMonth = (key: string) => shortMonthFmt.format(new Date(`${key}-01T12:00:00`));

/** A product's return over a period, weighted by how much sits in each track. */
function weightedReturn(p: PensionProduct, index: number): number | null {
  const tracks = (p.details?.tracks ?? []).filter(t => t.returns[index] != null && t.balance > 0);
  const total = tracks.reduce((s, t) => s + t.balance, 0);
  return total ? tracks.reduce((s, t) => s + t.balance * (t.returns[index] as number), 0) / total : null;
}
/** Management fees a year, in ₪: from the balance, plus from a year of the regular deposit. */
const yearlyFees = (p: PensionProduct) =>
  (p.value ?? 0) * (p.feeBalancePct ?? 0) / 100 + (p.monthlyDeposit ?? 0) * 12 * (p.feeDepositPct ?? 0) / 100;

export default function Pension() {
  const { data, isLoading, error } = useQuery({ queryKey: ['pension'], queryFn: () => api.get<PensionOverview>('/pension') });
  const [open, setOpen] = useState<PensionProduct | null>(null);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const { products, report, totals } = data;
  const s = report?.summary;

  if (!products.length) {
    return (
      <>
        <PageHeader title="פנסיה וגמל" icon={Umbrella} />
        <Empty>עוד אין נתוני פנסיה. אפשר לייבא דוח תקופתי מהסוכן או מהמסלקה הפנסיונית (npm run import:pension).</Empty>
      </>
    );
  }

  const fees = products.reduce((sum, p) => sum + yearlyFees(p), 0);
  const inactiveFees = products.filter(p => p.status === 'inactive').reduce((sum, p) => sum + yearlyFees(p), 0);
  const groups = (['pension', 'keren_hishtalmut', 'kupat_gemel'] as const)
    .map(type => ({ type, products: products.filter(p => p.type === type) })).filter(g => g.products.length);
  const nextLiquid = products.filter(p => p.type === 'keren_hishtalmut' && !p.liquidNow && p.liquidityDate)
    .sort((a, b) => a.liquidityDate!.localeCompare(b.liquidityDate!));

  return (
    <>
      <PageHeader title="פנסיה וגמל" icon={Umbrella}
        subtitle={report ? <>נכון ל-{fullDate(report.asOf)} · {report.source}{s?.agent && <> · הסוכן: {s.agent.name} {s.agent.phone}</>}</> : undefined}
        actions={<button type="button" className="btn" onClick={() => askAgent('תן לי סקירה של הפנסיה, קרנות ההשתלמות וקופות הגמל שלי', true)}><Sparkles />סקירה עם העוזר</button>} />

      <div className="grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 md:gap-4 lg:grid-cols-4">
        <Stat index={0} icon={PiggyBank} label="סך החיסכון" value={totals.value}
          hint={s ? <>תשואה מתחילת השנה <span className="font-semibold text-positive">{s.ytdReturnPct}%</span></> : undefined} />
        <Stat index={1} icon={HandCoins} color="var(--chart-5)" label="הפקדות חודשיות" value={totals.monthlyDeposits}
          hint={`${totals.active} מוצרים פעילים מתוך ${products.length}`} />
        <Stat index={2} icon={Umbrella} color="var(--chart-6)" label="קצבה חודשית צפויה בפרישה" value={s?.expectedAnnuity.totalWithoutDeposits ?? totals.expectedAnnuity}
          hint={s ? <>בלי הפקדות נוספות · אם ההפקדות ימשיכו: <Money value={s.expectedAnnuity.pensionWithDeposits + s.expectedAnnuity.managers} /></> : undefined} />
        <Stat index={3} icon={Banknote} color="var(--chart-2)" label="קרנות השתלמות נזילות היום" value={totals.liquidStudyFunds.value}
          hint={`${totals.liquidStudyFunds.count} קרנות, שעברו 6 שנים מההצטרפות (פטור ממס)`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card min-w-0">
          <SectionTitle icon={ChartPie}>לפי סוג מוצר</SectionTitle>
          <DonutChart height={190} centerLabel="סה״כ" data={groups.map(g => {
            const Icon = TYPE_ICONS[g.type];
            return { key: g.type, name: SHORT_LABELS[g.type], value: totals.byType[g.type] ?? 0, icon: <Icon /> };
          })} />
          {s && (
            <div className="mt-3 space-y-1.5 border-t border-line-soft pt-3 text-sm">
              <div className="text-xs font-medium text-fg-subtle">לפי גוף מנהל</div>
              {s.byProvider.map(p => (
                <div key={p.name} className="flex items-center justify-between gap-2">
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 text-fg-subtle"><Money value={p.amount} /> · {p.pct}%</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {s && (
          <div className="card min-w-0">
            <SectionTitle icon={Globe} color="var(--chart-5)">חשיפה ותמהיל השקעה</SectionTitle>
            <div className="space-y-3">
              {[['מניות', s.exposurePct.stocks], ['חו״ל', s.exposurePct.abroad], ['מט״ח', s.exposurePct.foreignCurrency], ['נכסים סחירים', s.tradedPct.traded]].map(([label, v]) => (
                <div key={label as string}>
                  <div className="mb-1 flex justify-between text-sm"><span>{label}</span><span className="num font-semibold">{v}%</span></div>
                  <Progress value={v as number} max={100} />
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-1 border-t border-line-soft pt-3 text-sm">
              {s.assetMixPct.filter(a => a.pct > 0).map(a => (
                <div key={a.name} className="flex justify-between gap-2"><span className="truncate text-fg-muted">{a.name}</span><span className="num">{a.pct}%</span></div>
              ))}
            </div>
          </div>
        )}

        <div className="card min-w-0">
          <SectionTitle icon={Info} color="var(--chart-3)">שווה לבדוק</SectionTitle>
          <ul className="space-y-3 text-sm leading-relaxed">
            <li>
              <b>{totals.inactive.count} מוצרים לא פעילים</b> (בלי הפקדות) עם <Money value={totals.inactive.value} /> — ממשיכים לשלם עליהם דמי ניהול,
              כ-<Money value={inactiveFees} /> בשנה.
            </li>
            <li>דמי ניהול בכל המוצרים: כ-<Money value={fees} /> בשנה (מהצבירה ומההפקדות הקבועות).</li>
            {totals.liquidStudyFunds.count > 0 && (
              <li><b>{totals.liquidStudyFunds.count} קרנות השתלמות כבר נזילות</b> (<Money value={totals.liquidStudyFunds.value} />).
                {nextLiquid[0] && <> הבאה תהיה נזילה ב-{fullDate(nextLiquid[0].liquidityDate)}.</>}</li>
            )}
            {s && s.coverage.noInfo.length > 0 && (
              <li>בדוח אין מידע על: {s.coverage.noInfo.join(', ')}. אם יש לכם ביטוחים כאלה (למשל בקופת חולים או דרך הבנק), אפשר להוסיף אותם ב<Link to="/insurance" className="underline">ביטוחים</Link>.</li>
            )}
          </ul>
          <p className="mt-3 text-xs text-fg-subtle">עובדות מהדוח בלבד, לא המלצה. לשינוי מסלול, איחוד קופות או ניוד — כדאי לדבר עם יועץ פנסיוני{s?.agent ? ` (${s.agent.name})` : ''}.</p>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {groups.map(g => {
          const Icon = TYPE_ICONS[g.type];
          return (
            <section key={g.type} className="card p-0">
              <SectionTitle icon={Icon} as="h2" action={<span className="text-sm font-normal text-fg-subtle"><Money value={totals.byType[g.type]} /></span>}>{TYPE_LABELS[g.type]}</SectionTitle>
              <div className="scroll-x">
                <table className="table">
                  <thead><tr>
                    <th>מוצר</th><th>גוף מנהל</th><th>סטטוס</th><th className="text-end">צבירה</th><th className="text-end">דמי ניהול</th>
                    <th className="text-end">מתחילת השנה</th><th className="text-end">12 חודשים</th><th>{g.type === 'keren_hishtalmut' ? 'נזילה' : 'הפקדה'}</th>
                  </tr></thead>
                  <tbody>
                    {g.products.map(p => (
                      <tr key={p.id} className="cursor-pointer hover:bg-accent/40" onClick={() => setOpen(p)}>
                        <td className="min-w-48">
                          <div className="font-medium">{p.details?.product ?? p.name}</div>
                          <div className="text-xs text-fg-subtle">{p.employer} · {p.policyNumber}</div>
                        </td>
                        <td className="min-w-36 text-sm">{p.provider}</td>
                        <td><span className={cn('chip text-[11px]', p.status === 'active' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : 'text-fg-subtle')}>
                          {p.status === 'active' ? 'פעיל' : 'לא פעיל'}</span></td>
                        <td className="text-end"><Money value={p.value} /></td>
                        <td className="whitespace-nowrap text-end text-xs">{p.managementFee ?? '—'}</td>
                        <td className="num text-end text-positive">{pct(weightedReturn(p, 1))}</td>
                        <td className="num text-end text-positive">{pct(weightedReturn(p, 2))}</td>
                        <td className="whitespace-nowrap text-xs">
                          {g.type === 'keren_hishtalmut'
                            ? (p.liquidNow ? <span className="font-semibold text-positive">נזילה</span> : day(p.liquidityDate))
                            : p.monthlyDeposit ? <><Money value={p.monthlyDeposit} /> בחודש</> : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>

      {open && <ProductDetails product={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ProductDetails({ product: p, onClose }: { product: PensionProduct; onClose: () => void }) {
  const d = p.details;
  const deposits = p.deposits.filter(x => x.salaryMonth);
  const chart = deposits.map(x => ({
    label: shortMonth(x.salaryMonth!),
    employee: x.employee ?? 0, employer: x.employer ?? 0, severance: x.severance ?? 0,
  }));
  return (
    <Modal wide title={`${d?.product ?? p.name} — ${p.provider ?? ''}`} onClose={onClose}>
      <div className="grid gap-3 text-sm sm:grid-cols-4">
        <Fact label="צבירה" value={<Money value={p.value} />} sub={p.valueDate ? `נכון ל-${day(p.valueDate)}` : undefined} />
        <Fact label="סטטוס" value={p.status === 'active' ? 'פעיל' : 'לא פעיל'} sub={p.employer ?? undefined} />
        <Fact label="דמי ניהול" value={p.managementFee ?? '—'} sub={`כ-₪${Math.round(yearlyFees(p)).toLocaleString('he-IL')} בשנה`} />
        <Fact label={p.type === 'keren_hishtalmut' ? 'נזילה' : 'הצטרפות'} value={p.type === 'keren_hishtalmut' ? (p.liquidNow ? 'כבר נזילה' : fullDate(p.liquidityDate)) : fullDate(p.joinDate)}
          sub={p.type === 'keren_hishtalmut' ? `הצטרפות ${day(p.joinDate)}` : `פוליסה ${p.policyNumber}`} />
        {p.expectedAnnuity != null && <Fact label="קצבה צפויה" value={<Money value={p.expectedAnnuity} />}
          sub={d?.expectedAnnuityWithDeposits ? `עם הפקדות: ₪${d.expectedAnnuityWithDeposits.toLocaleString('he-IL')}` : 'בלי הפקדות נוספות'} />}
        {p.monthlyDeposit != null && <Fact label="הפקדה חודשית" value={<Money value={p.monthlyDeposit} />} sub={d?.insuredSalary ? `שכר מבוטח ₪${d.insuredSalary.toLocaleString('he-IL')}` : undefined} />}
        {d?.components && <Fact label="תגמולים / פיצויים" value={<><Money value={d.components.tagmulim} /> / <Money value={d.components.pitzuyim} /></>} />}
        <Fact label="של מי" value={<MemberBadge id={p.ownerMemberId} />} />
      </div>

      {d?.tracks.length ? (
        <div>
          <SectionTitle icon={ChartPie} as="h3">מסלולי השקעה ותשואות</SectionTitle>
          <div className="scroll-x">
            <table className="table text-sm">
              <thead><tr><th>מסלול</th><th className="text-end">חלק</th><th className="text-end">צבירה</th>{RETURN_LABELS.map(l => <th key={l} className="whitespace-nowrap text-end">{l}</th>)}</tr></thead>
              <tbody>
                {d.tracks.map(t => (
                  <tr key={t.name}>
                    <td className="min-w-44">{t.name}</td><td className="num text-end">{t.share}%</td><td className="text-end"><Money value={t.balance} /></td>
                    {t.returns.map((r, i) => <td key={i} className={cn('num text-end', r != null && r >= 0 && 'text-positive', r != null && r < 0 && 'text-negative')}>{pct(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-fg-subtle">תשואות לפי דיווח משרד האוצר למסלול, לא לחשבון הספציפי.</p>
        </div>
      ) : null}

      {d?.coverages.length ? (
        <div>
          <SectionTitle icon={ShieldCheck} as="h3">כיסוי ביטוחי בקרן</SectionTitle>
          <div className="grid gap-2 sm:grid-cols-4">
            {d.coverages.map(c => <Fact key={c.name} label={`${c.name} (${c.pct}%)`} value={<><Money value={c.monthly} /> לחודש</>} />)}
          </div>
          {d.coverageCost && <p className="mt-1 text-xs text-fg-subtle">עלות: נכות <Money value={d.coverageCost.disability} /> + שארים <Money value={d.coverageCost.survivors} /> בחודש, מתוך ההפקדות.</p>}
        </div>
      ) : null}

      {deposits.length > 0 && (
        <div>
          <SectionTitle icon={Landmark} as="h3">הפקדות לפי חודש שכר</SectionTitle>
          {deposits.length > 1 && <StackedColumns height={200} data={chart} series={[
            { key: 'employee', name: 'עובד', color: 'var(--chart-1)' },
            { key: 'employer', name: 'מעסיק', color: 'var(--chart-5)' },
            { key: 'severance', name: 'פיצויים', color: 'var(--chart-3)' },
          ].filter(sr => chart.some(c => (c as Record<string, number | string>)[sr.key] as number > 0))} />}
          <div className="scroll-x mt-2">
            <table className="table text-sm">
              <thead><tr><th>חודש שכר</th><th>תאריך ערך</th><th className="text-end">שכר</th><th className="text-end">עובד</th><th className="text-end">מעסיק</th><th className="text-end">פיצויים</th><th className="text-end">סה״כ</th></tr></thead>
              <tbody>
                {[...deposits].reverse().map(x => (
                  <tr key={`${x.valueDate}-${x.salaryMonth}`}>
                    <td>{monthName(x.salaryMonth!)}</td><td className="text-xs">{day(x.valueDate)}</td>
                    <td className="text-end"><Money value={x.salary} /></td><td className="text-end"><Money value={x.employee} /></td>
                    <td className="text-end"><Money value={x.employer} /></td><td className="text-end"><Money value={x.severance} /></td>
                    <td className="text-end font-semibold"><Money value={x.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.status === 'active' && deposits.at(-1)!.salaryMonth! < todayIso().slice(0, 7) && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle"><CalendarClock className="h-3.5 w-3.5" />ההפקדה האחרונה בדוח היא על {monthName(deposits.at(-1)!.salaryMonth!)}.</p>
          )}
        </div>
      )}

      <button type="button" className="btn" onClick={() => { onClose(); askAgent(`לגבי ${d?.product ?? p.name} ב${p.provider} (${p.policyNumber}): `); }}>
        <Sparkles />שאל את העוזר על המוצר הזה
      </button>
    </Modal>
  );
}

function Fact({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5">
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className="mt-0.5 font-semibold">{value}</div>
      {sub && <div className="text-xs text-fg-subtle">{sub}</div>}
    </div>
  );
}
