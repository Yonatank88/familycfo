import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, type Account, type ExpenseMonth, type Group, type Holding, type Range, type ScrapeState, type Slice } from './api';
import { asOf, compact, day, money, monthLong, monthShort, pct, shortDay, signedMoney, signedPct, type Currency } from './format';

const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];
const COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#64748b'];

function Card({ title, actions, children, className = '' }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold text-slate-700">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: (v: T) => boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs">
      {options.map(o => (
        <button key={o.value} type="button" disabled={disabled?.(o.value)} onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 font-medium disabled:opacity-40 ${o.value === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const changeClass = (n: number | null | undefined) => (n == null || n === 0 ? 'text-slate-500' : n > 0 ? 'text-emerald-600' : 'text-rose-600');

function Change({ now, start, currency }: { now: number; start: number | null | undefined; currency: Currency }) {
  if (start == null) return <span className="text-slate-400">—</span>;
  const diff = now - start;
  return <span className={changeClass(diff)}>{signedMoney(diff, currency)} · {signedPct(start ? (diff / Math.abs(start)) * 100 : null)}</span>;
}

function useScrape() {
  const qc = useQueryClient();
  const [state, setState] = useState<ScrapeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = state?.status === 'running' || state?.status === 'pipeline';

  useEffect(() => { api.scrape().then(setState).catch(() => {}); }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api.scrape().then(s => {
        setState(s);
        if (s.status === 'done' || s.status === 'failed') qc.invalidateQueries();
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [running, qc]);

  return {
    state, running, error,
    start: () => { setError(null); api.startScrape().then(setState).catch(e => setError((e as Error).message)); },
    otp: (code: string) => api.submitOtp(code).then(() => api.scrape().then(setState)).catch(e => setError((e as Error).message)),
  };
}

function Refresh() {
  const { state, running, error, start, otp } = useScrape();
  const [code, setCode] = useState('');
  const done = state?.companies.filter(c => c.status === 'done' || c.status === 'failed').length ?? 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      {state?.otp && (
        <form className="flex items-center gap-1.5" onSubmit={e => { e.preventDefault(); otp(code.trim()); setCode(''); }}>
          <label className="text-slate-600" htmlFor="otp">{state.otp.company} code</label>
          <input id="otp" value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
            className="w-24 rounded-md border border-slate-300 px-2 py-1" />
          <button type="submit" className="rounded-md bg-slate-900 px-2.5 py-1 font-medium text-white">Send</button>
        </form>
      )}
      {error && <span className="text-rose-600">{error}</span>}
      {running && <span className="text-slate-500">{state?.status === 'pipeline' ? 'Processing…' : `Refreshing ${done}/${state?.companies.length ?? 0}`}</span>}
      <button type="button" onClick={start} disabled={running}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        Refresh
      </button>
    </div>
  );
}

function ChartTooltip({ active, payload, label, currency, labels }: {
  active?: boolean; payload?: { dataKey: string; value: number; color: string }[]; label?: string; currency: Currency; labels: Record<string, string>;
}) {
  if (!active || !payload?.length || !label) return null;
  const rows = [...payload].filter(p => p.value).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, p) => s + p.value, 0);
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 font-medium text-slate-700">{day(label)}</div>
      {rows.map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-6">
          <span className="flex items-center gap-1.5 text-slate-600"><span className="h-2 w-2 rounded-sm" style={{ background: p.color }} />{labels[p.dataKey]}</span>
          <span className="tabular-nums text-slate-900">{money(p.value, currency)}</span>
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-6 border-t border-slate-100 pt-1 font-medium">
        <span>Total</span><span className="tabular-nums">{money(total, currency)}</span>
      </div>
    </div>
  );
}

function Allocation({ slices, currency, convert, colorOf }: { slices: Slice[]; currency: Currency; convert: (n: number) => number; colorOf: (key: string) => string }) {
  const top = slices.length > 5 ? [...slices.slice(0, 4), { key: 'other', label: 'Other', value: slices.slice(4).reduce((s, x) => s + x.value, 0) }] : slices;
  const total = top.reduce((s, x) => s + x.value, 0);
  if (!total) return <p className="text-sm text-slate-400">No data</p>;
  return (
    <div className="flex items-center gap-5">
      <div className="h-36 w-36 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={top} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="100%" stroke="none" isAnimationActive={false}>
              {top.map(s => <Cell key={s.key} fill={colorOf(s.key)} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ol className="min-w-0 flex-1 space-y-1.5 text-sm">
        {top.map(s => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-slate-700">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorOf(s.key) }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="shrink-0 tabular-nums text-slate-500">
              {money(convert(s.value), currency)} <span className="ml-1 inline-block w-10 text-right">{Math.round((s.value / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Accounts({ accounts, currency, convert }: { accounts: Account[]; currency: Currency; convert: (n: number) => number }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {accounts.map(a => (
          <tr key={a.id} className="border-t border-slate-100 first:border-0">
            <td className="py-2 pr-2">
              <span title={a.stale ? `Last successful sync: ${asOf(a.lastSuccessAt)}` : undefined}
                className={`inline-block h-2 w-2 rounded-full ${a.stale ? 'bg-amber-500' : 'bg-transparent'}`} />
            </td>
            <td className="py-2 pr-3">
              <div className="text-slate-800">{a.label}</div>
              <div className="text-xs text-slate-400">{a.label === a.sourceLabel ? '' : `${a.sourceLabel} · `}as of {asOf(a.asOf)}</div>
            </td>
            <td className="py-2 text-right tabular-nums">
              <div className={a.fxMissing ? 'text-amber-600' : 'text-slate-900'}>{a.valueIls == null ? '—' : money(convert(a.valueIls), currency)}</div>
              {a.currency !== 'ILS' && a.value != null && <div className="text-xs text-slate-400">{money(a.value, a.currency)}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Holdings({ holdings, currency, convert }: { holdings: Holding[]; currency: Currency; convert: (n: number) => number }) {
  const [all, setAll] = useState(false);
  const shown = all ? holdings : holdings.slice(0, 10);
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-400">
            <th className="pb-2 text-left font-normal">Symbol</th>
            <th className="pb-2 text-right font-normal">Value</th>
            <th className="pb-2 text-right font-normal">Share</th>
            <th className="pb-2 text-right font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {shown.map(h => (
            <tr key={h.id} className="border-t border-slate-100">
              <td className="py-2 pr-3">
                <div className="text-slate-800">{h.symbol}</div>
                <div className="max-w-48 truncate text-xs text-slate-400">{h.sourceLabel}{h.name !== h.symbol ? ` · ${h.name}` : ''}</div>
              </td>
              <td className={`py-2 text-right tabular-nums ${h.fxMissing ? 'text-amber-600' : 'text-slate-900'}`}>
                {h.valueIls == null ? money(h.value, h.currency) : money(convert(h.valueIls), currency)}
              </td>
              <td className="py-2 text-right tabular-nums text-slate-500">{pct(h.pctOfInvestments)}</td>
              <td className={`py-2 text-right tabular-nums ${changeClass(h.changePct)}`}>{signedPct(h.changePct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {holdings.length > 10 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-800">
          {all ? 'Show top 10' : `Show all ${holdings.length}`}
        </button>
      )}
    </>
  );
}

function ExpenseRowsPanel({ month, merchant, onClose }: { month: string; merchant?: { key: string; name: string }; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['expense-rows', month, merchant?.key], queryFn: () => api.expenseRows(month, merchant?.key) });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-800">{monthLong(month)}{merchant ? ` · ${merchant.name}` : ''}</h2>
          <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">Close</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400">
                <th className="py-2 text-left font-normal">Date</th>
                <th className="py-2 text-left font-normal">Description</th>
                <th className="py-2 text-left font-normal">Account</th>
                <th className="py-2 text-right font-normal">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data?.map(r => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="whitespace-nowrap py-2 pr-3 text-slate-500">{shortDay(r.date)}</td>
                  <td className="py-2 pr-3 text-slate-800" dir="auto">{r.description}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-slate-500">{r.account}</td>
                  <td className="py-2 text-right tabular-nums text-slate-900">{money(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}

function Expenses({ months, current }: { months: ExpenseMonth[]; current: string }) {
  const [selected, setSelected] = useState(months.some(m => m.month === current) ? current : months.at(-1)!.month);
  const [panel, setPanel] = useState<{ month: string; merchant?: { key: string; name: string } } | null>(null);
  const month = months.find(m => m.month === selected) ?? months.at(-1)!;
  return (
    <Card title="Expenses">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="h-56 lg:col-span-2">
          <ResponsiveContainer>
            <BarChart data={months} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
              onClick={(e: { activeLabel?: string | number } | null) => {
                const m = e?.activeLabel != null ? String(e.activeLabel) : null;
                if (m) { setSelected(m); setPanel({ month: m }); }
              }}>
              <CartesianGrid vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} fontSize={11} stroke="#94a3b8" />
              <YAxis tickFormatter={v => compact(v, 'ILS')} tickLine={false} axisLine={false} fontSize={11} stroke="#94a3b8" width={56} />
              <Tooltip cursor={{ fill: '#f8fafc' }} formatter={v => money(Number(v))} labelFormatter={l => monthLong(String(l))} />
              <Bar dataKey="total" name="Spent" radius={[3, 3, 0, 0]} className="cursor-pointer" isAnimationActive={false}>
                {months.map(m => (
                  <Cell key={m.month} fill={m.month === current ? '#2563eb' : m.month === selected ? '#94a3b8' : '#cbd5e1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-slate-700">{monthLong(month.month)}</h3>
            <span className="text-sm tabular-nums text-slate-900">{money(month.total)}</span>
          </div>
          <ol className="text-sm">
            {month.merchants.map(m => (
              <li key={m.key}>
                <button type="button" onClick={() => setPanel({ month: month.month, merchant: { key: m.key, name: m.name } })}
                  className="flex w-full items-center justify-between gap-3 border-t border-slate-100 py-1.5 text-left hover:bg-slate-50">
                  <span className="truncate text-slate-700" dir="auto">{m.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">{money(m.total)}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
      {panel && <ExpenseRowsPanel month={panel.month} merchant={panel.merchant} onClose={() => setPanel(null)} />}
    </Card>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState<Range>('1Y');
  const [group, setGroup] = useState<Group>('type');
  const [currency, setCurrency] = useState<Currency>('ILS');

  const summary = useQuery({ queryKey: ['summary', range], queryFn: () => api.summary(range), placeholderData: p => p });
  const history = useQuery({ queryKey: ['history', range, group], queryFn: () => api.history(range, group), placeholderData: p => p });
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: api.expenses });

  const s = summary.data;
  const h = history.data;
  const usdNow = s?.usdRate ?? null;
  const convert = (n: number) => (currency === 'USD' && usdNow ? n / usdNow : n);
  const atRate = (n: number, rate: number | null) => (currency === 'USD' && rate ? n / rate : n);

  const chart = useMemo(() => (h?.points ?? []).map(p => ({
    date: p.date,
    ...Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, atRate(v, p.usdRate)])),
  })), [h, currency]);
  const labels = Object.fromEntries((h?.series ?? []).map(x => [x.key, x.label]));
  // one color per series key, shared by the chart and the allocation
  const seriesKeys = (h?.series ?? []).map(x => x.key);
  const colorOf = (key: string) => {
    if (key === 'other') return '#94a3b8';
    const i = seriesKeys.indexOf(key);
    return COLORS[(i >= 0 ? i : seriesKeys.length + (s?.allocation[group].findIndex(x => x.key === key) ?? 0)) % COLORS.length];
  };

  // the change compares today with the first day of the range, each converted at its own day's rate in $
  const first = h?.points[0];
  const startOf = (n: number | null | undefined) => (n == null || !first ? null : atRate(n, first.usdRate));
  const buckets = s ? [
    { label: 'Bank', now: s.bank, start: h?.start?.bank },
    { label: 'Investments', now: s.investments, start: h?.start?.investments },
    ...(s.cardsOwed != null ? [{ label: 'Cards owed', now: s.cardsOwed, start: h?.start?.cardsOwed }] : []),
  ] : [];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <h1 className="text-base font-semibold text-slate-900">FamilyCFO</h1>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented value={range} onChange={setRange} options={RANGES.map(r => ({ value: r, label: r }))} />
            <Segmented value={currency} onChange={setCurrency} disabled={v => v === 'USD' && !usdNow}
              options={[{ value: 'ILS', label: '₪' }, { value: 'USD', label: '$' }]} />
            <Refresh />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
        {summary.error && <Card><p className="text-sm text-rose-600">{(summary.error as Error).message}</p></Card>}
        {s && (
          <Card>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Net worth</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="text-3xl font-semibold tabular-nums text-slate-900">{money(convert(s.netWorth), currency)}</span>
              <span className="text-sm tabular-nums"><Change now={convert(s.netWorth)} start={startOf(h?.start?.netWorth)} currency={currency} /></span>
            </div>
            <div className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
              {buckets.map(b => (
                <div key={b.label}>
                  <div className="text-xs text-slate-500">{b.label}</div>
                  <div className="tabular-nums text-slate-900">{money(convert(b.now), currency)}</div>
                  <div className="text-xs tabular-nums"><Change now={convert(b.now)} start={startOf(b.start)} currency={currency} /></div>
                </div>
              ))}
            </div>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Over time" className="lg:col-span-2"
            actions={<Segmented value={group} onChange={setGroup} options={[{ value: 'type', label: 'Type' }, { value: 'source', label: 'Source' }]} />}>
            <div className="h-64">
              {chart.length ? (
                <ResponsiveContainer>
                  <AreaChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="date" tickFormatter={shortDay} tickLine={false} axisLine={false} fontSize={11} stroke="#94a3b8" minTickGap={40} />
                    <YAxis tickFormatter={v => compact(v, currency)} tickLine={false} axisLine={false} fontSize={11} stroke="#94a3b8" width={56} />
                    <Tooltip content={<ChartTooltip currency={currency} labels={labels} />} />
                    {(h?.series ?? []).map(x => (
                      <Area key={x.key} dataKey={x.key} stackId="1" type="monotone" stroke={colorOf(x.key)}
                        fill={colorOf(x.key)} fillOpacity={0.25} strokeWidth={1.5} isAnimationActive={false} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-slate-400">No data</p>}
            </div>
          </Card>
          <Card title="Allocation">
            {s && <Allocation slices={s.allocation[group]} currency={currency} convert={convert} colorOf={colorOf} />}
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Accounts">{s && <Accounts accounts={s.accounts} currency={currency} convert={convert} />}</Card>
          <Card title="Holdings">{s && <Holdings holdings={s.holdings} currency={currency} convert={convert} />}</Card>
        </div>

        {expenses.data && expenses.data.months.length > 0 && <Expenses months={expenses.data.months} current={expenses.data.currentMonth} />}
      </main>
    </div>
  );
}
