import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, type BudgetStatus, type MonthIncome, type Tx } from '../api';
import { useFilters, useLookups } from '../state';
import { day, monthName, todayIso } from '../format';
import { Banknote, ChevronDown, PieChart, Target, TrendingUp } from 'lucide-react';
import { ErrorBox, Loading, Money, PageHeader, Progress, SectionTitle } from '../components/ui';
import { BarList, Gauge } from '../components/charts';
import { categoryIcon } from '@/lib/visuals';

const STATUS_COLOR: Record<BudgetStatus['status'], string> = {
  ok: 'var(--chart-1)', warning: 'var(--chart-3)', over: 'var(--negative)', none: 'var(--muted-foreground)',
};

export default function Budgets() {
  const { filters } = useFilters();
  const { member } = useLookups();
  const qc = useQueryClient();
  const [cycle, setCycle] = useState(todayIso().slice(0, 7));
  // parents are collapsed by default; a category's transactions open inline on click
  const [expandedParents, setExpandedParents] = useState<Set<number>>(new Set());
  const [openCategory, setOpenCategory] = useState<number | null>(null);
  const toggleParent = (id: number) => setExpandedParents(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const query = { cycle, member: filters.memberId };
  const { data, isLoading, error } = useQuery({ queryKey: ['budgets', query], queryFn: () => api.get<BudgetStatus[]>(`/budgets${qs(query)}`) });
  const income = useQuery({ queryKey: ['income', query], queryFn: () => api.get<MonthIncome>(`/income${qs(query)}`) });

  // a budget applies from the month it's set in onwards, until it's changed
  const save = useMutation({
    mutationFn: (b: { categoryId: number; monthlyAmount: number | null }) => api.put('/budgets', { ...b, memberId: filters.memberId ?? null, effectiveFrom: cycle }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['budgets'] }); qc.invalidateQueries({ queryKey: ['summary'] }); },
  });

  // a parent's budget already includes its sub-categories — don't count a budgeted child twice
  const budgetedIds = new Set(data?.filter(b => b.budget != null).map(b => b.categoryId));
  const counted = data?.filter(b => b.budget != null && !(b.parentId != null && budgetedIds.has(b.parentId))) ?? [];
  const totalBudget = counted.reduce((s, b) => s + (b.budget ?? 0), 0);
  const totalSpent = counted.reduce((s, b) => s + b.spent, 0);
  // show each parent followed by its sub-categories
  const ordered = (() => {
    const rows = data ?? [];
    const tops = rows.filter(b => b.parentId == null || !rows.some(p => p.categoryId === b.parentId));
    return tops.flatMap(t => [t, ...rows.filter(c => c.parentId === t.categoryId)]);
  })();
  const totalStatus = totalSpent > totalBudget ? 'over' : totalSpent > totalBudget * 0.8 ? 'warning' : 'ok';
  // top-level categories with the most spend this month, coloured by their budget status
  const topSpent = (data ?? [])
    .filter(b => b.spent > 0 && (b.parentId == null || !data!.some(p => p.categoryId === b.parentId)))
    .sort((a, b) => b.spent - a.spent).slice(0, 6)
    .map(b => {
      const Icon = categoryIcon(b.categoryName);
      return { key: String(b.categoryId), label: b.categoryName, value: b.spent, color: STATUS_COLOR[b.status], icon: <Icon />,
        sub: b.pct != null ? <span className="num">{b.pct}%</span> : undefined };
    });
  const unbudgeted = data?.filter(b => b.budget == null && b.typical > 0) ?? [];

  const shift = (months: number) => {
    const d = new Date(`${cycle}-01T12:00:00`);
    d.setMonth(d.getMonth() + months);
    setCycle(d.toISOString().slice(0, 7));
  };

  return (
    <>
      <PageHeader
        title="תקציב חודשי" icon={PieChart}
        subtitle={<>{filters.memberId ? `תקציב של ${member(filters.memberId)?.name}` : 'תקציב משפחתי'} · {monthName(cycle)}</>}
        actions={<>
          <button className="btn" onClick={() => shift(-1)}>→ הקודם</button>
          <button className="btn" onClick={() => shift(1)}>הבא ←</button>
          {unbudgeted.length > 0 && (
            <button className="btn btn-primary" onClick={() => unbudgeted.forEach(b => save.mutate({ categoryId: b.categoryId, monthlyAmount: Math.ceil(b.typical / 50) * 50 }))}>
              קבע תקציב לפי הממוצע ל-{unbudgeted.length} קטגוריות
            </button>
          )}
        </>}
      />

      {income.data && <AllocationCard income={income.data} budgeted={totalBudget} month={cycle} />}

      <div className="mb-4 grid gap-4 lg:grid-cols-5">
        <div className="card flex min-w-0 flex-col lg:col-span-2">
          <SectionTitle icon={Target} color={STATUS_COLOR[totalStatus]}>סה״כ בתקציב</SectionTitle>
          <div className="flex flex-1 flex-wrap items-center gap-5">
            <Gauge value={totalSpent} max={totalBudget} status={totalStatus} label="ניצול" size={128} />
            <div className="min-w-0 flex-1 space-y-1.5 text-sm">
              <Money value={totalSpent} animated className="block text-2xl font-bold tracking-tight" />
              <div className="text-muted-foreground">מתוך <Money value={totalBudget} /></div>
            </div>
          </div>
          <Progress className="mt-4" value={totalSpent} max={totalBudget} status={totalStatus} />
        </div>
        {topSpent.length > 0 && (
          <div className="card min-w-0 lg:col-span-3">
            <SectionTitle icon={TrendingUp} color="var(--chart-3)">הוצא</SectionTitle>
            <BarList items={topSpent} />
          </div>
        )}
      </div>

      {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : (
        <div className="card scroll-x p-0">
          <table className="table">
            <thead>
              <tr>
                <th>קטגוריה</th>
                <th className="w-36">תקציב</th>
                <th className="text-end">הוצא</th>
                <th className="text-end">צפי לסוף החודש</th>
                <th className="text-end">ממוצע 3 חודשים</th>
                <th className="w-56">ניצול</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map(b => {
                const isChild = b.parentId != null && ordered.some(p => p.categoryId === b.parentId);
                const childCount = ordered.filter(c => c.parentId === b.categoryId).length;
                if (isChild && !expandedParents.has(b.parentId!)) return null;
                return (
                  <Fragment key={b.categoryId}>
                    <tr className={`${childCount ? 'bg-muted/60' : ''} ${isChild ? 'animate-fade-in' : ''}`}>
                      <td className="min-w-48 font-medium" style={{ paddingInlineStart: isChild ? 28 : undefined }}>
                        <div className="flex items-center gap-1">
                          {childCount > 0 ? (
                            <button className="btn-ghost btn-icon min-h-7" title={expandedParents.has(b.categoryId) ? 'כווץ' : 'הצג תתי-קטגוריות'}
                              aria-expanded={expandedParents.has(b.categoryId)}
                              onClick={() => toggleParent(b.categoryId)}>
                              <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${expandedParents.has(b.categoryId) ? '' : 'rotate-90'}`} />
                            </button>
                          ) : isChild ? <span className="me-1 text-muted-foreground">└</span> : <span className="inline-block w-8" />}
                          {!isChild && <CategoryIcon name={b.categoryName} />}
                          <button className="rounded text-start underline-offset-4 hover:underline" title="הצג את התנועות" aria-expanded={openCategory === b.categoryId}
                            onClick={() => setOpenCategory(openCategory === b.categoryId ? null : b.categoryId)}>
                            {b.categoryName}
                          </button>
                          {childCount > 0 && <span className="text-xs text-muted-foreground">({childCount})</span>}
                        </div>
                      </td>
                      <td>
                        <input className="input num min-w-24 py-1" type="number" min={0} step={50} defaultValue={b.budget ?? ''} placeholder="—"
                          key={`${b.categoryId}-${b.budget}`}
                          onBlur={e => {
                            const v = e.target.value === '' ? null : Number(e.target.value);
                            if (v !== b.budget) save.mutate({ categoryId: b.categoryId, monthlyAmount: v });
                          }} />
                      </td>
                      <td className="text-end"><Money value={b.spent} /></td>
                      <td className={`text-end ${b.budget != null && b.projected > b.budget ? 'text-rose-600' : ''}`}>
                        <Money value={b.projected} />
                        {b.planned > 0 && <div className="text-[11px] text-muted-foreground" title="הוצאות שהזנת מראש ועוד לא חויבו">כולל צפוי <Money value={b.planned} /></div>}
                      </td>
                      <td className="whitespace-nowrap text-end text-muted-foreground">
                        <Money value={b.typical} />
                        {b.budget == null && b.typical > 0 && (
                          <button className="btn-ghost ms-1 text-xs" onClick={() => save.mutate({ categoryId: b.categoryId, monthlyAmount: Math.ceil(b.typical / 50) * 50 })}>
                            השתמש
                          </button>
                        )}
                      </td>
                      <td>
                        {b.budget != null ? (
                          <div className="flex min-w-36 items-center gap-2">
                            <Progress value={b.spent} max={b.budget} status={b.status} />
                            <span className="w-10 text-xs text-muted-foreground num">{b.pct}%</span>
                          </div>
                        ) : <span className="text-xs text-muted-foreground">ללא תקציב</span>}
                      </td>
                    </tr>
                    {openCategory === b.categoryId && (
                      <tr className="animate-fade-in"><td colSpan={6} className="bg-muted/50 p-0">
                        <CategoryTransactions categoryId={b.categoryId} cycle={cycle} memberId={filters.memberId} />
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** How much of the month's income the budgets already take — the reference for setting them. */
function AllocationCard({ income, budgeted, month }: { income: MonthIncome; budgeted: number; month: string }) {
  const free = income.total - budgeted;
  const used = income.total > 0 ? Math.min(100, (budgeted / income.total) * 100) : 0;
  return (
    <div className="card mb-4">
      <SectionTitle icon={Banknote} color="var(--positive)">מה אפשר לחלק ב{monthName(month)}</SectionTitle>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <div className="label">הכנסה בחודש</div>
          <Money value={income.total} animated className="text-lg font-semibold text-positive" />
          {income.pending > 0 && <div className="text-[11px] text-muted-foreground">מתוכה <Money value={income.pending} /> עוד לא נכנסו</div>}
        </div>
        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <div className="label">הוקצה לתקציבים</div>
          <Money value={budgeted} animated className="text-lg font-semibold" />
          <div className="text-[11px] text-muted-foreground num">{Math.round(used)}% מההכנסה</div>
        </div>
        <div className="rounded-lg bg-muted/60 px-3 py-2">
          <div className="label">{free >= 0 ? 'עוד לא הוקצה' : 'הוקצה יותר מההכנסה'}</div>
          <Money value={free} animated colored className="text-lg font-semibold" />
          <div className="text-[11px] text-muted-foreground">{free >= 0 ? 'לחיסכון או לקטגוריות בלי תקציב' : 'כדאי להקטין תקציבים'}</div>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-[width] duration-700 ${free < 0 ? 'bg-negative' : 'bg-primary'}`} style={{ width: `${used}%` }} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        תקציב נקבע פעם אחת לכל קטגוריה וממשיך מחודש לחודש עד שמשנים אותו. שינוי בחודש מסוים חל ממנו והלאה, וחודשים קודמים נשארים כמו שהיו.
        התקציבים כוללים גם קטגוריות של הוצאות קבועות (משכנתא, גן וכו׳), אז ההשוואה היא מול כל ההכנסה.
      </p>
    </div>
  );
}

/** The cycle's transactions of one category (and its sub-categories), shown under its budget row. */
function CategoryTransactions({ categoryId, cycle, memberId }: { categoryId: number; cycle: string; memberId?: number }) {
  const query = { category: categoryId, cycle, member: memberId, hideCardPayments: 1, limit: 200 };
  const { data, isLoading } = useQuery({
    queryKey: ['transactions', query],
    queryFn: () => api.get<{ total: number; rows: Tx[] }>(`/transactions${qs(query)}`),
  });
  if (isLoading) return <div className="p-3 text-sm text-muted-foreground">טוען…</div>;
  const rows = data?.rows ?? [];
  return (
    <div className="px-4 py-2 md:px-6">
      {rows.length === 0 ? <div className="py-2 text-sm text-muted-foreground">אין תנועות בחודש הזה</div> : (
        <table className="w-full text-sm">
          <tbody>
            {rows.slice(0, 50).map(t => (
              <tr key={t.id} className="border-b border-line-soft last:border-0">
                <td className="w-24 whitespace-nowrap py-1.5 text-muted-foreground">{day(t.date)}</td>
                <td className="py-1.5">{t.description}{t.categoryParentId === categoryId && <span className="ms-2 text-xs text-muted-foreground">{t.categoryName}</span>}</td>
                <td className="w-28 whitespace-nowrap py-1.5 text-end"><Money value={t.amount} cents colored /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Link className="mt-1.5 inline-block text-xs font-medium text-brand-600 hover:underline dark:text-brand-400" to={`/transactions?category=${categoryId}&cycle=${cycle}`}>
        {data && data.total > 50 ? `כל ${data.total} התנועות ←` : 'פתח בעמוד התנועות ←'}
      </Link>
    </div>
  );
}

function CategoryIcon({ name }: { name: string }) {
  const Icon = categoryIcon(name);
  return <span className="icon-tile me-1 h-6 w-6 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5"><Icon /></span>;
}
