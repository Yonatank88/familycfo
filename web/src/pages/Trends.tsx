import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChartColumn, ChevronLeft, TrendingDown, TrendingUp } from 'lucide-react';
import { api, qs, type CycleSummary } from '../api';
import { useFilters, useLookups } from '../state';
import { monthName, todayIso } from '../format';
import { Empty, ErrorBox, Loading, Money, PageHeader, SectionTitle, Segmented } from '../components/ui';
import { StackedColumns } from '../components/charts';
import { categoryIcon, CHART_COLORS } from '@/lib/visuals';

const shortMonth = (key: string) => new Intl.DateTimeFormat('he-IL', { month: 'short', year: '2-digit' }).format(new Date(`${key}-01T12:00:00`));
/** at most this many coloured series; the rest are summed into "אחר" */
const MAX_SERIES = 8;
const DIRECT = 'direct';

interface Series { key: string; name: string; categoryId: number | null; hasChildren: boolean; values: number[]; total: number }

/**
 * Spend of each category month by month. Top level: the parent categories; click one to see its
 * sub-categories, click a sub-category to see it alone (with its average). Same amounts as the
 * budget and the overview: the household share, net of refunds and paybacks.
 */
export default function Trends() {
  const { params } = useFilters();
  const { category } = useLookups();
  // the drill-down level lives in the URL so Back goes up a level
  const [url, setUrl] = useSearchParams();
  const parentId = url.get('parent') ? Number(url.get('parent')) : null;
  const leafKey = url.get('leaf');
  const [cycles, setCycles] = useState(12);
  const go = (parent: number | null, leaf: string | null = null) => {
    const next = new URLSearchParams();
    if (parent != null) next.set('parent', String(parent));
    if (leaf != null) next.set('leaf', leaf);
    setUrl(next);
  };

  const query = { ...params, cycles };
  const history = useQuery({ queryKey: ['cashflow', query], queryFn: () => api.get<CycleSummary[]>(`/cashflow${qs(query)}`) });
  const { isLoading, error } = history;
  // drop the empty months before the data starts (before the first scrape)
  const data = useMemo(() => {
    if (!history.data) return undefined;
    const maxRows = Math.max(0, ...history.data.map(h => h.txCount));
    const first = history.data.findIndex(h => h.txCount >= maxRows * 0.4);
    return first > 0 ? history.data.slice(first) : history.data;
  }, [history.data]);

  const view = useMemo(() => {
    if (!data) return null;
    const months = data.map(h => h.cycle.key);
    const byKey = new Map<string, Series>();
    const add = (key: string, name: string, categoryId: number | null, i: number, v: number, hasChildren = false) => {
      const s = byKey.get(key) ?? { key, name, categoryId, hasChildren, values: months.map(() => 0), total: 0 };
      s.values[i] += v;
      s.total += v;
      s.hasChildren ||= hasChildren;
      byKey.set(key, s);
    };
    data.forEach((h, i) => {
      for (const c of h.byCategory) {
        if (!c.spend) continue;
        if (parentId == null) {
          // top level: every row under its parent (a top-level category holds its own rows)
          const top = c.parentId ?? c.categoryId;
          add(String(top ?? 'none'), c.parentName ?? c.name, top, i, c.spend, c.parentId != null);
        } else if (c.parentId === parentId) {
          add(String(c.categoryId), c.name, c.categoryId, i, c.spend);
        } else if (c.categoryId === parentId) {
          add(DIRECT, `ישירות ב${c.name}`, c.categoryId, i, c.spend);
        }
      }
    });
    let series = [...byKey.values()].filter(s => s.total > 0.5).sort((a, b) => b.total - a.total);
    if (leafKey != null) series = series.filter(s => s.key === leafKey);
    return { months, series };
  }, [data, parentId, leafKey]);

  if (isLoading) return <Loading />;
  if (error || !data || !view) return <ErrorBox error={error} />;

  const { months, series } = view;
  const current = todayIso().slice(0, 7);
  const shown = series.slice(0, MAX_SERIES);
  const rest = series.slice(MAX_SERIES);
  const colored = [
    ...shown.map((s, i) => ({ ...s, color: CHART_COLORS[i % CHART_COLORS.length] })),
    ...(rest.length ? [{ key: '_rest', name: `אחר (${rest.length})`, categoryId: null, hasChildren: false, color: 'var(--muted-foreground)',
      values: months.map((_, i) => rest.reduce((s, r) => s + r.values[i], 0)), total: rest.reduce((s, r) => s + r.total, 0) }] : []),
  ];
  const chartData = months.map((m, i) => ({
    label: shortMonth(m), partial: m >= current ? 1 : 0,
    ...Object.fromEntries(colored.map(s => [s.key, Math.round(s.values[i])])),
  }));
  // averages skip the current (partial) month and months the database has (almost) no rows for
  // (before the first scrape) — they'd drag every average down
  const maxRows = Math.max(0, ...data.map(h => h.txCount));
  const covered = (i: number) => data[i].txCount >= maxRows * 0.4;
  const full = months.map((m, i) => ({ m, i })).filter(x => x.m < current && covered(x.i));
  const avg = (s: { values: number[] }) => (full.length ? full.reduce((sum, x) => sum + s.values[x.i], 0) / full.length : 0);
  const totals = months.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const totalAvg = avg({ values: totals });
  const lastFull = full.at(-1);
  const prev3 = full.slice(-4, -1);
  const prev3Avg = prev3.length ? prev3.reduce((s, x) => s + totals[x.i], 0) / prev3.length : 0;
  const trend = lastFull && prev3Avg > 0 ? totals[lastFull.i] / prev3Avg - 1 : null;
  const peak = full.reduce<{ m: string; v: number } | null>((best, x) => (!best || totals[x.i] > best.v ? { m: x.m, v: totals[x.i] } : best), null);

  const parent = parentId != null ? category(parentId) : undefined;
  const leaf = leafKey != null ? series[0] : undefined;
  const title = leaf?.name ?? parent?.name ?? 'כל הקטגוריות';
  const pick = (key: string) => {
    if (key === '_rest') return;
    const s = series.find(x => x.key === key);
    if (!s) return;
    if (parentId == null && s.hasChildren && s.categoryId != null) go(s.categoryId);
    else if (parentId == null) go(null, key);
    else go(parentId, key);
  };
  const txHref = (s: Series, month: string) => s.categoryId != null ? `/transactions?category=${s.categoryId}&cycle=${month}` : `/transactions?review=1`;

  return (
    <>
      <PageHeader title="מגמות הוצאות" icon={ChartColumn}
        subtitle="כמה הוצא בכל קטגוריה בכל חודש. לחיצה על קטגוריה פותחת את תתי-הקטגוריות שלה."
        actions={<Segmented value={cycles} onChange={setCycles} options={[
          { value: 6, label: '6 חודשים' }, { value: 12, label: 'שנה' }, { value: 24, label: 'שנתיים' },
        ]} />} />

      <nav aria-label="רמת פירוט" className="mb-4 flex flex-wrap items-center gap-1 text-sm">
        <button className={`rounded-md px-2 py-1 ${parentId == null && leafKey == null ? 'font-semibold' : 'text-brand-600 hover:underline'}`} onClick={() => go(null)}>כל הקטגוריות</button>
        {parent && <>
          <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          <button className={`rounded-md px-2 py-1 ${leafKey == null ? 'font-semibold' : 'text-brand-600 hover:underline'}`} onClick={() => go(parentId)}>{parent.name}</button>
        </>}
        {leaf && <><ChevronLeft className="h-4 w-4 text-muted-foreground" /><span className="px-2 py-1 font-semibold">{leaf.name}</span></>}
      </nav>

      {series.length === 0 ? <Empty>אין הוצאות בתקופה הזו</Empty> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure label="ממוצע חודשי" value={<Money value={totalAvg} animated />} hint={`${full.length} חודשים מלאים`} />
            <Figure label={lastFull ? `ב${monthName(lastFull.m)}` : 'החודש האחרון'} value={<Money value={lastFull ? totals[lastFull.i] : 0} animated />}
              hint={trend != null ? (
                <span className={`inline-flex items-center gap-1 ${trend > 0.05 ? 'text-negative' : trend < -0.05 ? 'text-positive' : ''}`}>
                  {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {Math.abs(Math.round(trend * 100))}% מול 3 החודשים שלפניו
                </span>) : undefined} />
            <Figure label={`${monthName(current)} עד היום`} value={<Money value={totals[months.indexOf(current)] ?? 0} animated />} hint="חודש לא מלא" />
            <Figure label="החודש הגבוה" value={<Money value={peak?.v ?? 0} animated />} hint={peak ? monthName(peak.m) : undefined} />
          </div>

          <div className="card mb-4">
            <SectionTitle icon={ChartColumn} color="var(--chart-2)">{title}</SectionTitle>
            <StackedColumns data={chartData} series={colored.map(s => ({ key: s.key, name: s.name, color: s.color }))}
              average={leaf ? totalAvg : undefined} onPick={leaf ? undefined : pick} height={320} />
            {!leaf && <p className="mt-2 text-xs text-muted-foreground">לחיצה על עמודה או על שם בקטגוריה — פירוט שלה.</p>}
          </div>

          <div className="card scroll-x p-0">
            <table className="table">
              <thead>
                <tr>
                  <th className="sticky start-0 z-10 bg-card">קטגוריה</th>
                  {months.map((m, i) => <th key={m} className={`whitespace-nowrap text-end ${covered(i) ? '' : 'opacity-50'}`} title={covered(i) ? undefined : 'אין נתונים מלאים לחודש הזה'}>{shortMonth(m)}{m >= current ? '*' : ''}</th>)}
                  <th className="text-end">ממוצע</th>
                  <th className="text-end">סה״כ</th>
                </tr>
              </thead>
              <tbody>
                {series.map((s, idx) => {
                  const Icon = categoryIcon(s.name);
                  const drillable = !leaf && s.key !== DIRECT;
                  return (
                    <tr key={s.key}>
                      <td className="sticky start-0 z-10 min-w-44 bg-card">
                        <button type="button" disabled={!drillable} onClick={() => pick(s.key)}
                          className={`flex items-center gap-2 text-start ${drillable ? 'hover:underline' : ''}`}>
                          <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: idx < MAX_SERIES ? CHART_COLORS[idx % CHART_COLORS.length] : 'var(--muted-foreground)' }} />
                          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-medium">{s.name}</span>
                          {s.hasChildren && !leaf && <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />}
                        </button>
                      </td>
                      {months.map((m, i) => (
                        <td key={m} className="text-end">
                          {s.values[i] > 0.5
                            ? <Link className="hover:underline" to={txHref(s, m)} title="התנועות של החודש"><Money value={s.values[i]} className={s.values[i] > avg(s) * 1.3 && m < current ? 'text-negative' : ''} /></Link>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                      ))}
                      <td className="text-end font-medium"><Money value={avg(s)} /></td>
                      <td className="text-end text-muted-foreground"><Money value={s.total} /></td>
                    </tr>
                  );
                })}
                {series.length > 1 && (
                  <tr className="bg-muted/60 font-semibold">
                    <td className="sticky start-0 z-10 bg-muted">סה״כ</td>
                    {totals.map((t, i) => <td key={months[i]} className="text-end"><Money value={t} /></td>)}
                    <td className="text-end"><Money value={totalAvg} /></td>
                    <td className="text-end"><Money value={totals.reduce((a, b) => a + b, 0)} /></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            * חודש לא מלא — לא נכלל בממוצע. גם חודשים בלי נתונים מלאים (לפני שהסריקות התחילו) לא נכללים. באדום: חודש גבוה ביותר מ-30% מהממוצע של הקטגוריה. חלק הבית בלבד, אחרי החזרים וזיכויים — אותם סכומים כמו בתקציב.
          </p>
        </>
      )}
    </>
  );
}

function Figure({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="card min-w-0">
      <div className="label">{label}</div>
      <div className="text-xl font-bold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
