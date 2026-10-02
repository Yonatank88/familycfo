import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Banknote, CalendarCheck, CalendarClock, CalendarDays, Clock, Layers, ListChecks, Pencil, PieChart, Plus, Sparkles, Wallet, X } from 'lucide-react';
import { api, qs, type Commitment, type MonthPlan, type MonthPlanned, type PlannedItem } from '../api';
import { ManualEntry } from '../components/ManualEntry';
import { ScheduledManager } from '../components/ScheduledManager';
import { useFilters, useLookups } from '../state';
import { day, monthName, pct, todayIso } from '../format';
import { StartOfMonth } from '../components/StartOfMonth';
import { AccountSelect, CategorySelect, Empty, ErrorBox, Field, Loading, MemberBadge, Modal, Money, PageHeader, Picker, SectionTitle, Segmented, Stat } from '../components/ui';
import { DonutChart } from '../components/charts';
import { categoryIcon } from '@/lib/visuals';

const COLORS = { fixed: 'var(--chart-1)', installments: 'var(--chart-6)', planned: 'var(--chart-5)', spent: 'var(--chart-3)', left: 'var(--positive)' };

const STATE: Record<Commitment['state'], { label: string; cls: string }> = {
  paid: { label: 'שולם ✓', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
  partial: { label: 'שולם חלקית', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  pending: { label: 'ממתין', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  missing: { label: 'עוד לא נראה', cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200' },
};

const groupOf = (c: Commitment) => c.parentName ?? (c.kind === 'loan' || c.kind === 'mortgage' ? 'הלוואות ומשכנתא' : 'ללא קטגוריה');

function nextCycleKey(key: string) {
  const d = new Date(`${key}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}

/** The month from its start: fixed commitments known in advance, installments, and what's left for variable spend. */
export default function Fixed() {
  const { params } = useFilters();
  const { accountName } = useLookups();
  const qc = useQueryClient();
  const [cycleKey, setCycleKey] = useState<string | null>(null);
  const [view, setView] = useState<'accounts' | 'categories'>('accounts');
  const [adding, setAdding] = useState<{ name: string; amount: number; day: number; accountId: string | null; categoryId: number | null; matchPattern: string } | null>(null);
  const query = { ...params, cycle: cycleKey ?? undefined };
  const { data, isLoading, error } = useQuery({ queryKey: ['month-plan', query], queryFn: () => api.get<MonthPlan>(`/month-plan${qs(query)}`) });
  const { meta } = useLookups();

  const refresh = () => { for (const k of ['month-plan', 'scheduled', 'summary', 'cashflow', 'forecast', 'transactions', 'budgets', 'planned']) qc.invalidateQueries({ queryKey: [k] }); };
  // planned expenses: null = closed, 'new' = adding, an item = editing it
  const [plannedForm, setPlannedForm] = useState<PlannedItem | 'new' | null>(null);
  const plannedList = useQuery({ queryKey: ['planned'], queryFn: () => api.get<PlannedItem[]>('/planned?status=planned,matched') });
  const plannedAction = useMutation({
    mutationFn: ({ id, path = '', body, method = 'patch' }: { id: number; path?: string; body: Record<string, unknown>; method?: 'patch' | 'post' }) =>
      method === 'post' ? api.post(`/planned/${id}${path}`, body) : api.patch(`/planned/${id}${path}`, body),
    onSuccess: refresh,
  });
  const patch = useMutation({ mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch(`/scheduled/${id}`, body), onSuccess: refresh });
  const create = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post('/scheduled', body), onSuccess: () => { setAdding(null); refresh(); } });

  // links like /fixed#scheduled scroll to that section once the page has rendered
  useEffect(() => {
    if (data && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [data]);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;

  const current = todayIso().slice(0, 7);
  const listed = data.commitments.filter(c => c.status === 'confirmed');
  const fixedAll = data.fixed.total + data.otherFixed.amount;
  const suggested = data.commitments.filter(c => c.status === 'suggested').sort((a, b) => b.expected - a.expected);
  const groups = new Map<string, Commitment[]>();
  for (const c of listed) groups.set(groupOf(c), [...(groups.get(groupOf(c)) ?? []), c]);
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].reduce((s, c) => s + c.expected, 0) - a[1].reduce((s, c) => s + c.expected, 0));
  const isCard = (id: string | null) => !!id && meta?.accounts.find(a => a.id === id)?.kind === 'card';

  // the month as one bar: fixed | installments | variable spent | variable left
  const barTotal = Math.max(data.income, fixedAll + data.installments.total + data.planned.total + data.variableSpent);
  const seg = (v: number) => `${Math.max(0, (v / barTotal) * 100)}%`;
  const ofIncome = (v: number) => (data.income > 0 ? <span className="text-muted-foreground"> · {pct((v / data.income) * 100)}</span> : null);
  const composition = [
    { key: 'fixed', name: 'קבועות', legend: 'קבועות', value: fixedAll, color: COLORS.fixed, Icon: CalendarCheck },
    { key: 'installments', name: 'תשלומים', legend: 'תשלומים', value: data.installments.total, color: COLORS.installments, Icon: Layers },
    ...(data.planned.total > 0 ? [{ key: 'planned', name: 'הוצאות צפויות', legend: 'צפויות (עוד לא חויבו)', value: data.planned.total, color: COLORS.planned, Icon: Clock }] : []),
    { key: 'spent', name: 'משתנות — הוצא', legend: 'משתנות שהוצאו', value: data.variableSpent, color: COLORS.spent, Icon: Wallet },
    { key: 'left', name: 'משתנות — נשאר', legend: 'נשאר', value: Math.max(0, data.variableLeft), color: COLORS.left, Icon: Sparkles },
  ];

  return (
    <>
      <PageHeader title="קבועות החודש" icon={CalendarCheck}
        subtitle={`מחזור ${monthName(data.cycle.key)} · ${day(data.cycle.start)} – ${day(data.cycle.end)} · מה שידוע מראש, ומה נשאר להוצאות המשתנות`}
        actions={
          <Picker className="input w-auto min-w-44" value={cycleKey ?? ''} onChange={v => setCycleKey(v || null)} searchable={false} align="end"
            options={[
              { value: '', label: 'החודש הנוכחי', icon: <CalendarDays /> },
              { value: nextCycleKey(current), label: `החודש הבא (${monthName(nextCycleKey(current))})`, icon: <CalendarClock /> },
            ]} />
        } />

      <div className="grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 md:gap-4 lg:grid-cols-4">
        <Stat index={0} icon={Banknote} color="var(--positive)" label={`הכנסה ב${monthName(data.cycle.key)}`} value={data.income}
          hint={data.incomePending > 0
            ? <>נכנס <Money value={data.incomeReceived} /> · עוד צפוי <Money value={data.incomePending} /> (משכורות וקצבאות שלא נכנסו)</>
            : 'כל ההכנסות הקבועות כבר נכנסו'} />
        <Stat index={1} icon={CalendarCheck} color={COLORS.fixed} label="קבועות" value={fixedAll}
          hint={<>ברשימה <Money value={data.fixed.total} /> ({listed.length}) · שולם <Money value={data.fixed.paid} /> · עוד צפוי <Money value={data.fixed.remaining} />
            {data.otherFixed.amount > 0 && <> · מחוץ לרשימה <Money value={data.otherFixed.amount} /></>}</>} />
        <Stat index={2} icon={Layers} color={COLORS.installments} label="תשלומים (עסקאות בתשלומים)" value={data.installments.total}
          hint={<>{data.installments.items.length} תשלומים החודש</>} />
        <Stat index={3} icon={Wallet} label="נשאר להוצאות משתנות" value={data.variableLeft} tone={data.variableLeft < 0 ? 'bad' : 'good'}
          hint={<>מתוך <Money value={data.forVariable} /> · הוצאתם <Money value={data.variableSpent} />{data.daysLeft > 0 && data.variableLeft > 0 && <> · כ-<Money value={data.perDayLeft} /> ליום</>}</>} />
      </div>

      <div className="card mt-4">
        <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="min-w-0">
            <SectionTitle icon={PieChart}>{monthName(data.cycle.key)}</SectionTitle>
            <div className="flex h-4 w-full gap-px overflow-hidden rounded-full bg-muted">
              {composition.map((c, i) => (
                <motion.div key={c.key} className="h-full" title={c.name}
                  style={{ background: `linear-gradient(to left, ${c.color}, color-mix(in oklab, ${c.color} 70%, white))` }}
                  initial={{ width: 0 }} animate={{ width: seg(c.value) }}
                  transition={{ duration: 0.8, delay: 0.1 + i * 0.08, ease: [0.22, 1, 0.36, 1] }} />
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              {composition.map(c => (
                <div key={c.key} className="min-w-0 rounded-lg bg-muted/60 px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c.color }} />
                    <span className="truncate">{c.legend}</span>
                  </div>
                  <div className="mt-1"><Money value={c.value} animated className="text-sm font-semibold text-foreground" />{ofIncome(c.value)}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              הכנסה <Money value={data.income} /> − קבועות <Money value={fixedAll} /> − תשלומים <Money value={data.installments.total} />
              {data.planned.total > 0 && <> − הוצאות צפויות <Money value={data.planned.total} /></>} = <Money value={data.forVariable} /> להוצאות המשתנות.
              {' '}״קבוע״ = פריט ברשימה למטה, או תנועה בקטגוריה שמסומנת כקבועה.
            </p>
          </div>
          <div className="min-w-0 border-line-soft max-lg:border-t max-lg:pt-4 lg:border-s lg:ps-6">
            <DonutChart centerLabel={monthName(data.cycle.key)}
              data={composition.map(c => ({ key: c.key, name: c.legend, value: c.value, color: c.color, icon: <c.Icon /> }))} />
          </div>
        </div>
      </div>

      {suggested.length > 0 && (
        <div className="card mt-4 border-amber-200 bg-amber-50/30 dark:border-amber-800/60 dark:bg-amber-950/10">
          <SectionTitle icon={Sparkles} color="var(--chart-3)"
            action={<button className="btn btn-primary" onClick={() => suggested.forEach(c => patch.mutate({ id: c.id, body: { status: 'confirmed' } }))}>הוסף הכל</button>}>
            <span>זיהינו {suggested.length} חיובים שחוזרים כל חודש — להוסיף לקבועות?</span>
          </SectionTitle>
          <div className="stagger divide-y divide-line-soft">
            {suggested.map((c, i) => {
              const Icon = categoryIcon(c.categoryName ?? c.name);
              return (
              <div key={c.id} style={{ ['--i' as string]: i }} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5 text-sm">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="icon-tile h-8 w-8 rounded-lg [&_svg]:h-4 [&_svg]:w-4" style={{ ['--tile' as string]: 'var(--chart-3)' }}><Icon /></span>
                  <div className="min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{groupOf(c)} · {accountName(c.accountId)} · בסביבות ה-{c.day} בחודש</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 max-sm:w-full">
                  <Money value={c.expected} className="font-medium max-sm:me-auto" />
                  <button className="btn" onClick={() => patch.mutate({ id: c.id, body: { status: 'confirmed' } })}>הוסף</button>
                  <button className="btn-ghost text-xs" onClick={() => patch.mutate({ id: c.id, body: { status: 'dismissed' } })}>לא קבוע</button>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card mt-4">
        <SectionTitle icon={ListChecks} action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={view} onChange={setView} options={[
              { value: 'accounts', label: 'לפי חשבון וכרטיס', icon: Wallet },
              { value: 'categories', label: 'לפי קטגוריה', icon: PieChart },
            ]} />
            <button className="btn" onClick={() => setAdding({ name: '', amount: 0, day: 1, accountId: null, categoryId: null, matchPattern: '' })}>+ הוסף הוצאה קבועה</button>
          </div>
        }>
          <span>ההוצאות הקבועות שלנו</span>
        </SectionTitle>
        {listed.length === 0 && !data.installments.items.length ? <Empty>עוד אין הוצאות קבועות ברשימה — הוסיפו מההצעות למעלה או ידנית.</Empty>
          : view === 'accounts' ? <StartOfMonth data={data} /> : listed.length === 0 ? <Empty>עוד אין הוצאות קבועות ברשימה — הוסיפו מההצעות למעלה או ידנית.</Empty> : (
          <div className="scroll-x card-bleed"><table className="table">
            <thead><tr><th>מה</th><th>איך משולם</th><th>של מי</th><th>מתי</th><th className="text-end">צפוי</th><th className="text-end">בפועל החודש</th><th>מצב</th><th /></tr></thead>
            {sortedGroups.map(([group, items]) => (
              <tbody key={group}>
                <tr className="bg-muted/60">
                  <td colSpan={4} className="font-semibold">
                    <span className="flex items-center gap-2">
                      <GroupIcon name={group} />
                      {group}
                    </span>
                  </td>
                  <td className="text-end font-semibold"><Money value={items.reduce((s, c) => s + c.expected, 0)} /></td>
                  <td className="text-end font-semibold"><Money value={items.reduce((s, c) => s + c.actual, 0)} /></td>
                  <td colSpan={2} />
                </tr>
                {items.map(c => (
                  <tr key={c.id}>
                    <td className="min-w-40 ps-6">
                      <div className="font-medium">{c.name}</div>
                      {c.categoryName && c.categoryName !== group && <div className="text-xs text-muted-foreground">{c.categoryName}</div>}
                    </td>
                    <td className="min-w-32 text-xs text-muted-foreground">
                      {c.method === 'card' ? <>בכרטיס {accountName(c.accountId)}<div className="text-[11px]">נכלל בחיוב הכרטיס</div></> : <>מהבנק {accountName(c.accountId)}</>}
                    </td>
                    <td><MemberBadge id={c.memberId} /></td>
                    <td className="whitespace-nowrap text-sm">{day(c.dueDate)}</td>
                    <td className="text-end">
                      <input className="input num w-24 py-1 text-end" type="number" defaultValue={c.expected} key={`${c.id}-${c.expected}`}
                        onBlur={e => Number(e.target.value) !== c.expected && patch.mutate({ id: c.id, body: { amount: -Math.abs(Number(e.target.value)), amountMode: 'fixed' } })} />
                    </td>
                    <td className="text-end">
                      {c.actual > 0 ? (
                        <Link className="hover:underline" to={`/transactions?account=${encodeURIComponent(c.accountId)}&cycle=${data.cycle.key}&search=${encodeURIComponent(c.name.split(/\s+/).slice(0, 2).join(' '))}`}>
                          <Money value={c.actual} className={c.actual > c.expected * 1.1 ? 'text-rose-600' : ''} />
                        </Link>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="whitespace-nowrap"><span className={`chip ${STATE[c.state].cls}`}>{STATE[c.state].label}</span></td>
                    <td><button className="btn-ghost btn-icon" aria-label="הסר מהקבועות" title="הסר מהקבועות" onClick={() => patch.mutate({ id: c.id, body: { status: 'dismissed' } })}><X /></button></td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table></div>
        )}
        {data.otherFixed.count > 0 && (
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            בנוסף, <Money value={data.otherFixed.amount} /> ב-{data.otherFixed.count} תנועות נספרו כקבועות כי הקטגוריה שלהן מסומנת כקבועה, אבל הן לא ברשימה.
            {' '}<Link className="text-brand-600 hover:underline" to="/categories">הגדרת קטגוריות</Link>
          </p>
        )}
      </div>

      <div className="card mt-4">
        <SectionTitle icon={Layers} color={COLORS.installments} action={<span className="text-sm font-semibold"><Money value={data.installments.total} animated /></span>}>
          <span>תשלומים של עסקאות בתשלומים החודש</span>
        </SectionTitle>
        {data.installments.items.length === 0 ? <Empty>אין תשלומים החודש</Empty> : (
          <div className="scroll-x card-bleed"><table className="table">
            <thead><tr><th>עסקה</th><th>כרטיס</th><th>תאריך חיוב</th><th>תשלום</th><th className="text-end">סכום</th></tr></thead>
            <tbody>
              {data.installments.items.map((i, n) => (
                <tr key={n}>
                  <td>{i.description}</td>
                  <td className="text-xs text-muted-foreground">{accountName(i.accountId)}</td>
                  <td className="whitespace-nowrap text-sm">{day(i.date)}</td>
                  <td className="text-xs text-muted-foreground">{i.number ? `${i.number} מתוך ${i.of}` : `צפוי (מתוך ${i.of})`}</td>
                  <td className="text-end"><Money value={i.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      <PlannedCard items={data.planned.items} all={plannedList.data ?? []} month={monthName(data.cycle.key)}
        onAdd={() => setPlannedForm('new')} onEdit={item => setPlannedForm(item)}
        onAction={(id, body, path, method) => plannedAction.mutate({ id, body, path, method })} />

      <div id="scheduled" className="card mt-4 scroll-mt-20">
        <SectionTitle icon={Banknote} color="var(--positive)"><span>הכנסות קבועות ואומדני חיובי כרטיסים</span></SectionTitle>
        <ScheduledManager />
      </div>

      {plannedForm && <ManualEntry defaultPlanned planned={plannedForm === 'new' ? null : plannedForm}
        onClose={() => setPlannedForm(null)} onSaved={() => { refresh(); setPlannedForm(null); }} />}

      {adding && (
        <Modal title="הוצאה קבועה חדשה" onClose={() => setAdding(null)} footer={<>
          <button className="btn" onClick={() => setAdding(null)}>ביטול</button>
          <button className="btn btn-primary" disabled={!adding.name.trim() || !adding.amount || !adding.accountId || create.isPending}
            onClick={() => create.mutate({
              name: adding.name.trim(), kind: 'fixed_expense', amount: -Math.abs(adding.amount), amountMode: 'fixed', dayOfMonth: adding.day,
              bankAccountId: isCard(adding.accountId) ? null : adding.accountId, cardAccountId: isCard(adding.accountId) ? adding.accountId : null,
              categoryId: adding.categoryId, matchPattern: adding.matchPattern.trim() || null, status: 'confirmed',
            })}>הוסף</button>
        </>}>
          <Field label="שם"><input className="input" autoFocus value={adding.name} onChange={e => setAdding({ ...adding, name: e.target.value })} placeholder="גן — גני השקד" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="סכום חודשי"><input className="input num" type="number" value={adding.amount || ''} onChange={e => setAdding({ ...adding, amount: Number(e.target.value) })} /></Field>
            <Field label="יום בחודש"><input className="input num" type="number" min={1} max={31} value={adding.day} onChange={e => setAdding({ ...adding, day: Number(e.target.value) })} /></Field>
          </div>
          <Field label="משולם מ-"><AccountSelect value={adding.accountId} onChange={accountId => setAdding({ ...adding, accountId })} emptyLabel="בחר חשבון בנק או כרטיס" /></Field>
          <Field label="קטגוריה"><CategorySelect value={adding.categoryId} onChange={categoryId => setAdding({ ...adding, categoryId })} /></Field>
          <Field label="תיאור בדף הבנק / הכרטיס (לזיהוי שהתשלום ירד)">
            <input className="input" value={adding.matchPattern} onChange={e => setAdding({ ...adding, matchPattern: e.target.value })} placeholder="למשל: גני השקד חינוך" />
          </Field>
          <p className="text-xs leading-relaxed text-muted-foreground">הוצאה בכרטיס לא יורדת בנפרד מהבנק — היא נכללת בחיוב החודשי של הכרטיס, ולכן לא תיספר פעמיים בתחזית.</p>
        </Modal>
      )}
    </>
  );
}

const PLANNED_STATE = {
  planned: { label: 'צפוי ⏳', cls: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300' },
  overdue: { label: 'עוד לא חויב', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  choose: { label: 'לבחור חיוב', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
  matched: { label: 'חויב ✓', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
};

/** One-off expenses entered in advance: the ones falling in this month, charged ✓ or still expected. */
function PlannedCard({ items, all, month, onAdd, onEdit, onAction }: {
  items: MonthPlanned[]; all: PlannedItem[]; month: string; onAdd: () => void; onEdit: (item: PlannedItem) => void;
  onAction: (id: number, body: Record<string, unknown>, path?: string, method?: 'patch' | 'post') => void;
}) {
  const { accountName } = useLookups();
  // still expected in later months (so what was entered for next month is visible here too)
  const shown = new Set(items.map(i => i.id));
  const later = all.filter(i => i.status === 'planned' && !shown.has(i.id));
  return (
    <div className="card mt-4">
      <SectionTitle icon={Clock} color={COLORS.planned} action={<button className="btn" onClick={onAdd}><Plus />הוצאה צפויה</button>}>
        <span>הוצאות צפויות ב{month}</span>
      </SectionTitle>
      <p className="-mt-2 mb-3 text-xs leading-relaxed text-muted-foreground">
        הוצאות שידוע מראש שיחויבו (בכרטיס או בבנק) ועוד לא הופיעו. הן בתחזית ובתקציב עד שהחיוב מגיע, ואז נסגרות לבד.
      </p>
      {items.length === 0 ? <Empty>אין הוצאות צפויות החודש</Empty> : (
        <div className="scroll-x card-bleed"><table className="table">
          <thead><tr><th>מה</th><th>איך משולם</th><th>של מי</th><th>תאריך קנייה</th><th className="text-end">החודש</th><th>מצב</th><th /></tr></thead>
          <tbody>
            {items.map(i => {
              const state = i.status === 'matched' ? 'matched' : i.candidates.length > 1 ? 'choose' : i.overdue ? 'overdue' : 'planned';
              const full = all.find(x => x.id === i.id);
              return (
                <tr key={i.id}>
                  <td className="min-w-40">
                    <div className="font-medium">{i.description}</div>
                    {i.installments > 1 && <div className="text-xs text-muted-foreground">{i.installments} תשלומים</div>}
                    {state === 'choose' && (
                      <div className="mt-1.5 space-y-1">
                        <div className="text-xs text-muted-foreground">איזה מהחיובים זה?</div>
                        {i.candidates.map(c => (
                          <button key={c.id} className="btn min-h-7 w-full justify-between px-2 text-xs" onClick={() => onAction(i.id, { txId: c.id }, '/match', 'post')}>
                            <span className="truncate">{c.description} · {day(c.date)}</span><Money value={c.amount} />
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="text-xs text-muted-foreground">{accountName(i.accountId)}</td>
                  <td><MemberBadge id={i.memberId} /></td>
                  <td className="whitespace-nowrap text-sm">{day(i.date)}</td>
                  <td className="text-end"><Money value={i.amount} /></td>
                  <td className="whitespace-nowrap">
                    <span className={`chip ${PLANNED_STATE[state].cls}`}>{PLANNED_STATE[state].label}</span>
                    {state === 'overdue' && (
                      <div className="mt-1 flex gap-1">
                        <button className="btn-ghost min-h-6 px-1.5 text-xs" onClick={() => onAction(i.id, { postponeMonths: 1 })}>דחה לחודש הבא</button>
                        <button className="btn-ghost min-h-6 px-1.5 text-xs text-negative" onClick={() => onAction(i.id, { status: 'cancelled' })}>בטל</button>
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {i.status === 'matched'
                      ? <button className="btn-ghost min-h-7 px-2 text-xs" title="זה לא החיוב הנכון — להחזיר לצפוי" onClick={() => onAction(i.id, { status: 'planned' })}>לא זה</button>
                      : full && <button className="btn-ghost btn-icon" aria-label="עריכה" onClick={() => onEdit(full)}><Pencil /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      {later.length > 0 && (
        <div className="mt-4 border-t border-line-soft pt-3 text-sm">
          <div className="label">בחודשים הבאים</div>
          <div className="space-y-1">
            {later.map(i => (
              <button key={i.id} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-start hover:bg-accent/60" onClick={() => onEdit(i)}>
                <span className="min-w-0 truncate">{i.description} <span className="text-xs text-muted-foreground">· {day(i.date)} · {accountName(i.accountId)}{i.installments > 1 ? ` · ${i.installments} תשלומים` : ''}</span></span>
                <Money value={i.amount} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GroupIcon({ name }: { name: string }) {
  const Icon = categoryIcon(name);
  return <span className="icon-tile h-6 w-6 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5"><Icon /></span>;
}
