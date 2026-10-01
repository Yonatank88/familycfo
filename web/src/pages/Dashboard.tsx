import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Gauge as GaugeIcon, Landmark, LayoutDashboard, PiggyBank, Receipt, Sparkles, TriangleAlert, Users, Wallet } from 'lucide-react';
import { api, qs, type CycleSummary, type InstallmentPlan, type Summary } from '../api';
import { useFilters, useLookups } from '../state';
import { day, monthName } from '../format';
import { ErrorBox, Loading, MemberBadge, Money, MoreLink, PageHeader, Progress, SectionTitle, SeverityDot, Stat } from '../components/ui';
import { BarList, CashflowBars, DonutChart, ForecastChart, Gauge } from '../components/charts';
import { DayDetails } from '../components/DayDetails';
import { ScrapeButton } from '../components/ScrapeButton';
import { categoryIcon, hueFor, MemberAvatar } from '@/lib/visuals';

const shortMonth = (key: string) => new Intl.DateTimeFormat('he-IL', { month: 'short' }).format(new Date(`${key}-01T12:00:00`));

export default function Dashboard() {
  const { params } = useFilters();
  const { accountName, member, meta } = useLookups();
  const { data, isLoading, error } = useQuery({ queryKey: ['summary', params], queryFn: () => api.get<Summary>(`/summary${qs(params)}`) });
  const installments = useQuery({ queryKey: ['installments', params], queryFn: () => api.get<InstallmentPlan[]>(`/installments${qs(params)}`) });
  const history = useQuery({ queryKey: ['cashflow', params], queryFn: () => api.get<CycleSummary[]>(`/cashflow${qs({ ...params, cycles: 7 })}`) });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;

  const { cycle, forecast, capacity } = data;
  const periodName = monthName(forecast.period.key);
  const cardOwner = (id: string) => meta?.accounts.find(a => a.id === id)?.ownerMemberId ?? null;
  const bankTotal = forecast.total.startBalance;
  // roll sub-categories up into their parent for the overview
  const grouped = new Map<string, { key: string; name: string; spend: number; categoryId: number | null }>();
  for (const c of cycle.byCategory) {
    const key = String(c.parentId ?? c.categoryId ?? 'none');
    const g = grouped.get(key) ?? { key, name: c.parentName ?? c.name, spend: 0, categoryId: c.parentId ?? c.categoryId };
    g.spend += c.spend;
    grouped.set(key, g);
  }
  const categories = [...grouped.values()].sort((a, b) => b.spend - a.spend);
  const catHref = (c: { categoryId: number | null }) => `/transactions${c.categoryId != null ? `?category=${c.categoryId}&cycle=${cycle.cycle.key}` : `?review=1`}`;

  // trends: completed cycles (oldest → newest), the current one last
  const hist = history.data ?? [];
  const past = hist.filter(h => h.cycle.key !== cycle.cycle.key);
  const avgSpend = past.length ? past.reduce((s, h) => s + h.spend, 0) / past.length : 0;
  const spendDelta = avgSpend > 0 ? { value: cycle.spend / avgSpend - 1, label: 'מול הממוצע', positiveIsGood: false } : undefined;
  const balanceSpark = (forecast.total.points ?? []).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 20)) === 0).map(p => p.expected);

  const members = Object.entries(cycle.byMember).map(([id, v]) => ({ id: Number(id), ...v })).filter(m => m.spend > 0 || m.income > 0);
  const budgetTotal = data.budgets.reduce((s, b) => s + (b.budget ?? 0), 0);
  const budgetSpent = data.budgets.reduce((s, b) => s + b.spent, 0);

  return (
    <>
      <PageHeader title="סקירה" icon={LayoutDashboard} subtitle={`מחזור ${monthName(cycle.cycle.key)} · ${day(cycle.cycle.start)} – ${day(cycle.cycle.end)}`} actions={<ScrapeButton />} />

      <div className="grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 md:gap-4 lg:grid-cols-4">
        <Stat index={0} icon={Landmark} color="var(--chart-5)" label="יתרה בבנקים עכשיו" value={bankTotal} tone={bankTotal < 0 ? 'bad' : undefined}
          spark={balanceSpark} hint={forecast.total.stale ? 'חלק מהיתרות לא עודכנו לאחרונה' : undefined} />
        <Stat index={1} icon={GaugeIcon} label={`יתרה צפויה בסוף ${periodName}`} value={forecast.total.endOfCycle}
          tone={forecast.total.endOfCycle < forecast.buffer ? 'bad' : 'good'} spark={balanceSpark}
          hint={<>נקודה נמוכה: <Money value={forecast.total.lowest.amount} /> ב-{day(forecast.total.lowest.date)}</>} />
        <Stat index={2} icon={Receipt} color="var(--chart-3)" label="הוצאות המחזור" value={cycle.spend} delta={spendDelta}
          spark={hist.length > 1 ? hist.map(h => h.spend) : undefined}
          hint={<Link to="/fixed" className="hover:underline">קבועות <Money value={cycle.fixed} /> · משתנות <Money value={cycle.dynamic} /> ←</Link>} />
        {capacity.monthlyCapacity >= 0 ? (
          <Stat index={3} icon={PiggyBank} label="עודף חודשי ממוצע (לחיסכון)" value={capacity.monthlyCapacity} tone="good"
            spark={hist.length > 1 ? hist.map(h => h.net) : undefined}
            hint={<>ממוצע {capacity.monthsUsed.length} חודשים: הכנסה <Money value={capacity.expectedIncome} /> פחות הוצאות <Money value={capacity.expectedIncome - capacity.monthlyCapacity} /></>} />
        ) : (
          <Stat index={3} icon={PiggyBank} label="גירעון חודשי ממוצע" value={capacity.monthlyCapacity} tone="bad"
            spark={hist.length > 1 ? hist.map(h => h.net) : undefined} hint={`בממוצע ${capacity.monthsUsed.length} החודשים האחרונים ההוצאות גבוהות מההכנסה`} />
        )}
      </div>


      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card min-w-0 lg:col-span-2">
          <SectionTitle icon={Sparkles} action={<MoreLink to="/cashflow">ללוח התזרים</MoreLink>}>תחזית יתרה — עד {day(forecast.period.end)}</SectionTitle>
          <ForecastChart points={forecast.total.points ?? []} buffer={forecast.buffer} lowest={forecast.total.lowest} height={280}
            events={forecast.events} dailyRate={forecast.total.dailyRate} selectedDate={selectedDate} onSelectDate={setSelectedDate} />
          {selectedDate && (
            <DayDetails date={selectedDate} events={forecast.events} points={forecast.total.points ?? []}
              dailyRate={forecast.total.dailyRate} onClose={() => setSelectedDate(null)} />
          )}
          <div className="mt-4 border-t border-line-soft pt-3 text-xs text-muted-foreground">מהיום עד סוף {periodName}:</div>
          <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              { label: 'הכנסות צפויות', value: forecast.remaining.income, color: 'var(--positive)' },
              { label: 'הלוואות וקבועות מהבנק', value: -forecast.remaining.scheduledOut, color: 'var(--chart-1)' },
              { label: 'חיובי כרטיסים', value: -forecast.remaining.cardCharges, color: 'var(--chart-6)' },
              { label: 'שוטף מהבנק (הערכה)', value: -forecast.remaining.dynamic, color: 'var(--chart-3)' },
            ].map(x => (
              <div key={x.label} className="rounded-lg bg-muted/60 px-3 py-2">
                <div className="label mb-1 flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: x.color }} />{x.label}</div>
                <Money value={x.value} animated className={`font-semibold ${x.value > 0 ? 'text-positive' : ''}`} />
              </div>
            ))}
          </div>
        </div>

        <div className="card min-w-0">
          <SectionTitle icon={Landmark} color="var(--chart-5)">חשבונות בנק</SectionTitle>
          <div className="space-y-2">
            {forecast.accounts.map(a => (
              <div key={a.accountId} className="flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-muted/40 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate font-medium">{a.displayName}</div>
                  <div className="text-xs text-zinc-500">
                    {a.stale ? <span className="text-amber-600">עודכן {day(a.balanceDate)}</span> : `עודכן ${day(a.balanceDate)}`}
                    {' · '}סוף {periodName} <Money value={a.endOfCycle} />
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Money value={a.startBalance} animated className="font-bold" colored />
                  <MemberBadge id={a.ownerMemberId} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 border-t border-line-soft pt-5">
            <SectionTitle icon={CreditCard} color="var(--chart-6)">חיובי כרטיסים קרובים</SectionTitle>
          </div>
          <div className="space-y-1 text-sm">
            {data.cardCharges.length === 0 && <div className="text-zinc-500">אין חיובים עתידיים ידועים</div>}
            {data.cardCharges.map(c => (
              <Link key={`${c.cardAccountId}${c.chargeDate}`} to={`/transactions?account=${encodeURIComponent(c.cardAccountId)}&charge=${c.chargeDate}`}
                title="הצג את העסקאות שבחיוב הזה"
                className="group -mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition-colors duration-(--duration-fast) hover:bg-accent/60">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 flex-col items-center justify-center rounded-lg bg-muted text-[10px] font-semibold leading-tight text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <span className="num text-sm font-bold leading-none">{Number(c.chargeDate.slice(8, 10))}</span>
                    {shortMonth(c.chargeDate.slice(0, 7))}
                  </span>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{c.displayName}</span>
                      {cardOwner(c.cardAccountId) != null ? <MemberBadge id={cardOwner(c.cardAccountId)} />
                        : <span className="chip text-[11px] text-muted-foreground" title="אפשר לשייך בהגדרות › חשבונות וכרטיסים">לא משויך</span>}
                    </div>
                    <div className="text-xs text-zinc-500">מ{accountName(c.billingBankAccountId)}</div>
                  </div>
                </div>
                <div className="text-end">
                  {c.transactions > 0 || c.projectedInstallments > 0 || c.projectedFixed > 0 || c.projectedPlanned > 0 ? (
                    <>
                      <Money value={c.knownAmount + c.projectedInstallments + c.projectedFixed + c.projectedPlanned} className="font-semibold" />
                      {c.projectedInstallments > 0 && <div className="text-xs text-zinc-500" title="תשלומים של עסקאות בתשלומים שהכרטיס עוד לא דיווח עליהם">כולל תשלומים <Money value={c.projectedInstallments} /></div>}
                      {c.projectedPlanned > 0 && <div className="text-xs text-zinc-500" title={`הוצאות צפויות שהזנת מראש: ${c.plannedItems.map(p => p.of > 1 ? `${p.name} (${p.n}/${p.of})` : p.name).join(', ')}`}>כולל צפויות <Money value={c.projectedPlanned} /></div>}
                      {c.projectedFixed > 0 && <div className="text-xs text-zinc-500" title={`קבועות בכרטיס שעוד לא דווחו: ${c.fixedItems.map(f => f.name).join(', ')}`}>כולל קבועות <Money value={c.projectedFixed} /></div>}
                      {c.expectedAmount > c.knownAmount + c.projectedInstallments + c.projectedFixed + c.projectedPlanned && <div className="text-xs text-zinc-500" title={`החיוב עוד פתוח. קניות שוטפות בחיוב רגיל: כ-₪${Math.round(c.typicalVariable).toLocaleString('he-IL')} (חציון 3 החיובים האחרונים, בלי תשלומים וקבועות). התחזית מניחה את הסכום הזה`}>עד כה · צפוי כ-<Money value={c.expectedAmount} /></div>}
                    </>
                  ) : (
                    <>
                      <Money value={c.expectedAmount} className="font-semibold text-zinc-500" />
                      <div className="text-xs text-zinc-500" title="תשלומים וקבועות ידועים + קניות שוטפות כמו בחיוב רגיל (חציון 3 החיובים האחרונים)">הערכה — אין עדיין פירוט</div>
                    </>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* BI row: the trend and where it went */}
      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <div className="card min-w-0 lg:col-span-3">
          <SectionTitle icon={Receipt} color="var(--chart-2)" action={<MoreLink to="/cashflow">פירוט</MoreLink>}>הכנסות מול הוצאות — 7 מחזורים</SectionTitle>
          {hist.length ? <CashflowBars height={240} data={hist.map(h => ({ label: shortMonth(h.cycle.key), income: h.income, fixed: h.fixed, dynamic: h.dynamic }))} />
            : <div className="skeleton h-60 w-full" />}
        </div>
        <div className="card min-w-0 lg:col-span-2">
          <SectionTitle icon={Wallet} color="var(--chart-6)" action={<MoreLink to="/transactions">תנועות</MoreLink>}>לאן הלך הכסף</SectionTitle>
          <DonutChart centerLabel="הוצאות המחזור"
            data={categories.map(c => {
              const Icon = categoryIcon(c.name);
              return { key: c.key, name: c.name, value: c.spend, href: catHref(c), icon: <Icon /> };
            })} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="card min-w-0">
          <SectionTitle icon={GaugeIcon} action={<MoreLink to="/budgets">הכל</MoreLink>}>תקציב</SectionTitle>
          {data.budgets.length === 0 && <div className="text-sm text-zinc-500">עוד לא הוגדרו תקציבים. <Link className="text-primary" to="/budgets">להגדרה</Link></div>}
          {data.budgets.length > 0 && (
            <div className="mb-4 flex items-center gap-4 rounded-xl bg-muted/50 p-3">
              <Gauge value={budgetSpent} max={budgetTotal} size={96} label="נוצל"
                status={budgetSpent > budgetTotal ? 'over' : budgetSpent > budgetTotal * 0.8 ? 'warning' : 'ok'} />
              <div className="min-w-0 text-sm">
                <div className="text-xs text-muted-foreground">הוצא מתוך התקציבים שבסקירה</div>
                <div className="mt-1 text-lg font-bold"><Money value={budgetSpent} animated /></div>
                <div className="text-xs text-muted-foreground">מתוך <Money value={budgetTotal} /></div>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {data.budgets.map(b => {
              const Icon = categoryIcon(b.categoryName);
              return (
                <div key={b.categoryId}>
                  <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2"><Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{b.categoryName}</span></span>
                    <span className="shrink-0 text-xs text-zinc-500"><Money value={b.spent} /> / <Money value={b.budget} /></span>
                  </div>
                  <Progress value={b.spent} max={b.budget ?? 0} status={b.status} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="card min-w-0">
          <SectionTitle icon={Users} color="var(--chart-5)">הוצאות לפי בן משפחה</SectionTitle>
          {members.length === 0 ? <div className="text-sm text-zinc-500">אין עדיין הוצאות במחזור</div> : (
            <BarList items={members.sort((a, b) => b.spend - a.spend).map(m => {
              const mm = member(m.id);
              return {
                key: String(m.id), value: m.spend, color: mm?.color ?? hueFor(m.id),
                label: <span className="inline-flex items-center gap-2">{mm && <MemberAvatar name={mm.name} color={mm.color} size={20} />}{mm?.name ?? 'משותף'}</span>,
                sub: m.income > 0 ? <>הכנסות <Money value={m.income} /></> : undefined,
              };
            })} />
          )}
          <div className="mt-5 border-t border-line-soft pt-4">
            <div className="label">הקטגוריות הגדולות</div>
            <BarList color="var(--chart-6)" items={categories.slice(0, 5).map(c => {
              const Icon = categoryIcon(c.name);
              return { key: c.key, label: c.name, value: c.spend, icon: <Icon />, href: catHref(c) };
            })} />
          </div>
        </div>

        <div className="card min-w-0">
          <SectionTitle icon={TriangleAlert} color="var(--negative)" action={<MoreLink to="/insights">הכל</MoreLink>}>התראות</SectionTitle>
          {data.alerts.length === 0 && <div className="text-sm text-zinc-500">אין התראות פתוחות 🎉</div>}
          <div className="stagger space-y-1">
            {data.alerts.map((a, i) => (
              <div key={a.id} style={{ ['--i' as string]: i }} className="flex gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-accent/50">
                <SeverityDot severity={a.severity} />
                <div className="min-w-0">
                  <div className="font-medium">{a.title}</div>
                  <div className="text-xs leading-relaxed text-zinc-500">{a.message}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <InstallmentsCard plans={installments.data ?? []} />

      <div className="card mt-4 overflow-hidden">
        <SectionTitle icon={PiggyBank} color="var(--positive)">{capacity.monthlyCapacity >= 0 ? 'חיסכון מומלץ החודש' : 'אין כרגע עודף לחיסכון'}</SectionTitle>
        <div className="stagger grid gap-3 sm:grid-cols-3">
          {capacity.allocation.map((a, i) => (
            <div key={a.fundId} style={{ ['--i' as string]: i }}
              className="card-hover relative overflow-hidden rounded-xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-teal-50/40 px-4 py-3.5 dark:border-emerald-900/50 dark:from-emerald-950/40 dark:to-teal-950/20">
              <PiggyBank aria-hidden className="absolute -bottom-2 -end-2 h-14 w-14 text-emerald-500/10" />
              <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">{a.name}</div>
              <Money value={a.amount} animated className="mt-1 block text-xl font-bold tracking-tight text-emerald-700 dark:text-emerald-300" />
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          הכנסה צפויה <Money value={capacity.expectedIncome} /> − קבועות <Money value={capacity.averageFixed} /> − משתנות <Money value={capacity.averageDynamic} />
          {' '}− רזרבה להוצאות חריגות <Money value={capacity.irregularReserve} /> = <Money value={capacity.monthlyCapacity} colored />
        </p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          הממוצעים מחושבים מהחודשים: {capacity.monthsUsed.join(', ')} (חודשים בלי נתונים מלאים לא נכללים). הרזרבה = הוצאות חד-פעמיות מעל ₪1,500 בשנה האחרונה, מחולקות לחודשים.
        </p>
      </div>
    </>
  );
}

/** Open installment purchases: how many payments are left on each and when the next one is charged. */
function InstallmentsCard({ plans }: { plans: InstallmentPlan[] }) {
  const { accountName } = useLookups();
  if (plans.length === 0) return null;
  const sorted = [...plans].sort((a, b) => (a.nextChargeDate ?? '').localeCompare(b.nextChargeDate ?? '') || b.remainingAmount - a.remainingAmount);
  const totalLeft = plans.reduce((s, p) => s + p.remainingAmount, 0);
  const thisMonth = sorted[0].nextChargeDate?.slice(0, 7);
  const nextMonthTotal = plans.reduce((s, p) => s + (thisMonth ? p.schedule[thisMonth] ?? 0 : 0), 0);
  return (
    <div className="card mt-4">
      <SectionTitle icon={CreditCard} color="var(--chart-6)" action={<MoreLink to="/cashflow">לפי חודש</MoreLink>}>עסקאות בתשלומים</SectionTitle>
      <div className="mb-4 flex flex-wrap gap-2 text-sm">
        <span className="rounded-lg bg-muted/70 px-3 py-1.5 text-zinc-500"><b className="num text-foreground">{plans.length}</b> עסקאות פתוחות</span>
        <span className="rounded-lg bg-muted/70 px-3 py-1.5 text-zinc-500">נשאר לשלם <Money value={totalLeft} animated className="font-semibold text-foreground" /></span>
        {thisMonth && <span className="rounded-lg bg-muted/70 px-3 py-1.5 text-zinc-500">ב{monthName(thisMonth)} <Money value={nextMonthTotal} animated className="font-semibold text-foreground" /></span>}
      </div>
      <div className="scroll-x card-bleed">
        <table className="table">
          <thead>
            <tr><th>עסקה</th><th>כרטיס</th><th>של מי</th><th className="min-w-36">תשלומים</th><th>נשארו</th><th>החיוב הבא</th><th className="text-end">לתשלום</th><th className="text-end">נשאר</th></tr>
          </thead>
          <tbody>
            {sorted.map(p => (
              <tr key={`${p.cardAccountId}|${p.description}|${p.purchaseDate}`}>
                <td>
                  <div className="font-medium">{p.description}</div>
                  <div className="text-xs text-zinc-500">נרכש {day(p.purchaseDate)} · מסתיים ב{monthName(p.lastChargeMonth)}</div>
                </td>
                <td className="text-xs text-zinc-500">{accountName(p.cardAccountId)}</td>
                <td><MemberBadge id={p.memberId} /></td>
                <td>
                  <div className="mb-1 text-xs text-zinc-500">{p.paid} מתוך {p.total} שולמו</div>
                  <Progress value={p.paid} max={p.total} />
                </td>
                <td className="whitespace-nowrap font-semibold">{p.remaining === 1 ? 'תשלום אחרון' : `${p.remaining} תשלומים`}</td>
                <td className="whitespace-nowrap text-sm">{day(p.nextChargeDate)}</td>
                <td className="text-end"><Money value={p.installmentAmount} /></td>
                <td className="text-end font-semibold"><Money value={p.remainingAmount} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
