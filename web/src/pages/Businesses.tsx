import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, type Tx } from '../api';
import { useLookups } from '../state';
import { day, monthName, todayIso } from '../format';
import { Briefcase, CalendarDays, CalendarRange, Download, Hash, PieChart, Receipt, TrendingUp } from 'lucide-react';
import { Empty, Loading, Money, PageHeader, Picker, SectionTitle, Segmented, Stat } from '../components/ui';
import { BarList, Columns, DonutChart } from '../components/charts';
import { categoryIcon, CHART_COLORS } from '@/lib/visuals';

const shortMonth = (key: string) => new Intl.DateTimeFormat('he-IL', { month: 'short' }).format(new Date(`${key}-01T12:00:00`));

/** The last 24 calendar months, newest first (YYYY-MM). */
function recentMonths(n = 24): string[] {
  const d = new Date(`${todayIso().slice(0, 7)}-01T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(d);
    x.setUTCMonth(d.getUTCMonth() - i);
    return x.toISOString().slice(0, 7);
  });
}
const monthEnd = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

interface Report { transactions: Tx[]; months: { month: string; income: number; expenses: number }[]; totals: { income: number; expenses: number } }

/** The business's expenses in the period by type (category), largest first. */
function ByType({ transactions }: { transactions: Tx[] }) {
  const types = useMemo(() => {
    const byCat = new Map<string, { name: string; value: number; count: number }>();
    for (const t of transactions) {
      if (t.businessAmount >= 0) continue;
      const name = t.categoryParentName ?? t.categoryName ?? 'ללא קטגוריה';
      const cur = byCat.get(name) ?? { name, value: 0, count: 0 };
      cur.value += -t.businessAmount;
      cur.count++;
      byCat.set(name, cur);
    }
    return [...byCat.values()].sort((a, b) => b.value - a.value);
  }, [transactions]);
  return (
    <div className="card min-w-0">
      <SectionTitle icon={PieChart} color="var(--chart-4)">הוצאות לפי סוג</SectionTitle>
      {types.length === 0 ? <div className="text-sm text-muted-foreground">אין הוצאות בתקופה</div> : (
        <>
          <DonutChart centerLabel="הוצאות העסק" max={7} otherLabel="שאר הסוגים"
            data={types.map((c, i) => {
              const Icon = categoryIcon(c.name);
              return { key: c.name, name: c.name, value: c.value, color: i < 7 ? CHART_COLORS[i] : undefined, icon: <Icon /> };
            })} />
          {types.length > 7 && (
            <div className="mt-4 border-t border-line-soft pt-3">
              <BarList items={types.slice(7).map(c => ({ key: c.name, label: c.name, value: c.value, sub: `${c.count} תנועות` }))} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Businesses() {
  const { meta } = useLookups();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  // what period to look at: one month, a date range, or everything
  const [mode, setMode] = useState<'month' | 'range' | 'all'>('month');
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const from = mode === 'month' ? `${month}-01` : mode === 'range' ? rangeFrom : '';
  const to = mode === 'month' ? monthEnd(month) : mode === 'range' ? rangeTo : '';
  const months = useMemo(() => recentMonths(), []);
  const [newName, setNewName] = useState('');
  const businesses = meta?.businesses.filter(b => !b.archived) ?? [];
  const current = selected ?? businesses[0]?.id ?? null;

  const report = useQuery({
    queryKey: ['business', current, from, to], enabled: current != null,
    queryFn: () => api.get<Report>(`/businesses/${current}/report${qs({ from, to })}`),
  });
  const create = useMutation({
    mutationFn: (name: string) => api.post<{ id: number }>('/businesses', { name }),
    onSuccess: r => { qc.invalidateQueries({ queryKey: ['meta'] }); setSelected(r.id); setNewName(''); },
  });

  return (
    <>
      <PageHeader icon={Briefcase} title="עסקים" subtitle="הוצאות והכנסות שסומנו לעסק. לסימון: בעמוד התנועות בוחרים עסק (ואחוז, אם רק חלק מההוצאה עסקי)."
        actions={<>
          <input className="input w-44 max-sm:flex-1" placeholder="שם עסק חדש" value={newName} onChange={e => setNewName(e.target.value)} />
          <button className="btn btn-primary" disabled={!newName.trim()} onClick={() => create.mutate(newName.trim())}>הוסף עסק</button>
        </>} />

      {businesses.length === 0 ? <Empty>עוד אין עסקים. הוסף עסק ואז סמן אליו תנועות.</Empty> : (
        <>
          <div className="mb-5 flex flex-wrap items-end gap-3">
            <Segmented className="max-w-full overflow-x-auto" value={current ?? undefined} onChange={v => v != null && setSelected(v)}
              options={businesses.map(b => ({ value: b.id as number | undefined, label: b.name, icon: Briefcase }))} />
            <div className="ms-auto flex flex-wrap items-end gap-2 max-sm:w-full">
              <Segmented value={mode} onChange={setMode} options={[
                { value: 'month', label: 'חודש', icon: CalendarDays },
                { value: 'range', label: 'טווח', icon: CalendarRange },
                { value: 'all', label: 'הכל' },
              ]} />
              {mode === 'month' && (
                <Picker className="input w-auto min-w-40" value={month} onChange={v => v && setMonth(v)} searchable={false} aria-label="חודש"
                  options={months.map(m => ({ value: m, label: monthName(m), icon: <CalendarDays /> }))} />
              )}
              {mode === 'range' && <>
                <label className="max-sm:min-w-0 max-sm:flex-1"><span className="label">מתאריך</span><input className="input" type="date" value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} /></label>
                <label className="max-sm:min-w-0 max-sm:flex-1"><span className="label">עד</span><input className="input" type="date" value={rangeTo} onChange={e => setRangeTo(e.target.value)} /></label>
              </>}
              <a className="btn max-sm:w-full" href={`/api/businesses/${current}/export.csv${qs({ from, to })}`}><Download className="h-4 w-4" />ייצוא CSV לרו״ח</a>
            </div>
          </div>

          {report.isLoading ? <Loading /> : report.data && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4">
                <Stat index={0} icon={Receipt} color="var(--chart-3)" label="הוצאות" value={report.data.totals.expenses}
                  spark={report.data.months.length > 1 ? [...report.data.months].sort((a, b) => a.month.localeCompare(b.month)).map(m => m.expenses) : undefined} />
                <Stat index={1} icon={TrendingUp} tone="good" label="הכנסות" value={report.data.totals.income}
                  spark={report.data.months.length > 1 ? [...report.data.months].sort((a, b) => a.month.localeCompare(b.month)).map(m => m.income) : undefined} />
                <Stat index={2} icon={Hash} color="var(--chart-6)" label="תנועות" value={<span className="num">{report.data.transactions.length}</span>} />
              </div>
              <div className="mb-4 grid gap-4 lg:grid-cols-2">
                <ByType transactions={report.data.transactions} />
                <div className="card min-w-0">
                  <SectionTitle icon={CalendarRange} color="var(--chart-3)">לפי חודש</SectionTitle>
                  {report.data.months.length > 0 && (
                    <div className="mb-3">
                      <Columns height={160} color="var(--chart-3)"
                        data={[...report.data.months].sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ label: shortMonth(m.month), value: m.expenses }))} />
                    </div>
                  )}
                  {report.data.months.map(m => (
                    <div key={m.month} className="flex justify-between gap-3 border-b border-line-soft py-2 text-sm last:border-0">
                      <span>{monthName(m.month)}</span><span><Money value={-m.expenses} colored />{m.income > 0 && <> · <Money value={m.income} colored /></>}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="card scroll-x min-w-0 p-0">
                  <table className="table">
                    <thead><tr><th>תאריך</th><th>תיאור</th><th>קטגוריה</th><th className="text-end">סכום</th><th className="text-end">חלק עסקי</th></tr></thead>
                    <tbody>
                      {report.data.transactions.map(t => (
                        <tr key={t.id}>
                          <td className="whitespace-nowrap text-zinc-500">{day(t.date)}</td><td className="min-w-40">{t.description}</td>
                          <td className="text-xs text-zinc-500">{t.categoryName}</td><td className="text-end"><Money value={t.amount} cents /></td>
                          <td className="text-end font-medium"><Money value={t.businessAmount} cents /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
