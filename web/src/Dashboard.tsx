import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { api, type Account, type ExpenseMonth, type Group, type Holding, type Range, type ScrapeState, type Slice } from './api';
import { asOf, day, money, monthLong, monthShort, pct, shortDay, signedMoney, signedPct, type Currency } from './format';

const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const OTHER = 'var(--c7)';

/** A section: title (and an optional control) above a quiet card. */
function Section({ title, action, children, flush = false }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section>
      <div className="flex min-h-8 items-center justify-between gap-3 pb-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {action}
      </div>
      <div className={`rounded-xl border border-line/80 bg-surface/80 ${flush ? 'py-1' : 'p-4'}`}>{children}</div>
    </section>
  );
}

function Pills<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: (v: T) => boolean;
}) {
  return (
    <div className="inline-flex rounded-full bg-ink/[0.045] p-0.5 text-xs">
      {options.map(o => (
        <button key={o.value} type="button" disabled={disabled?.(o.value)} onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 font-medium transition-colors disabled:opacity-40 ${
            o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');

function Change({ now, start, currency }: { now: number; start: number | null | undefined; currency: Currency }) {
  if (start == null) return <span className="text-faint">—</span>;
  const diff = now - start;
  return (
    <span className={`tabular-nums ${tone(diff)}`}>
      {signedMoney(diff, currency)}<span className="mx-1.5 text-line">|</span>{signedPct(start ? (diff / Math.abs(start)) * 100 : null)}
    </span>
  );
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
          <label className="text-muted" htmlFor="otp">{state.otp.company} code</label>
          <input id="otp" value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
            className="w-24 rounded-full border border-line bg-surface px-3 py-1 outline-none focus:border-faint" />
          <button type="submit" className="rounded-full bg-ink px-3 py-1 font-medium text-paper">Send</button>
        </form>
      )}
      {error && <span className="text-down">{error}</span>}
      {running && <span className="tabular-nums text-muted">{state?.status === 'pipeline' ? 'Processing…' : `Refreshing ${done}/${state?.companies.length ?? 0}`}</span>}
      <button type="button" onClick={start} disabled={running}
        className="rounded-full border border-line bg-surface px-3.5 py-1 font-medium text-ink shadow-sm hover:bg-paper disabled:opacity-50">
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
    <div className="min-w-48 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-md backdrop-blur">
      <div className="mb-1.5 text-muted">{day(label)}</div>
      {rows.map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-6 py-0.5">
          <span className="flex items-center gap-1.5 text-muted"><span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />{labels[p.dataKey]}</span>
          <span className="tabular-nums text-ink">{money(p.value, currency)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-6 border-t border-line pt-1.5 font-medium text-ink">
        <span>Total</span><span className="tabular-nums">{money(total, currency)}</span>
      </div>
    </div>
  );
}

function Allocation({ slices, currency, convert, colorOf }: {
  slices: Slice[]; currency: Currency; convert: (n: number) => number; colorOf: (key: string) => string;
}) {
  const top = slices.length > 5 ? [...slices.slice(0, 4), { key: 'other', label: 'Other', value: slices.slice(4).reduce((s, x) => s + x.value, 0) }] : slices;
  const total = top.reduce((s, x) => s + x.value, 0);
  if (!total) return <p className="text-sm text-faint">No data</p>;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col">
      <div className="h-36 w-36 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={top} dataKey="value" nameKey="label" innerRadius="70%" outerRadius="100%" paddingAngle={2} cornerRadius={3}
              stroke="none" isAnimationActive={false}>
              {top.map(s => <Cell key={s.key} fill={colorOf(s.key)} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ol className="w-full min-w-0 flex-1 space-y-2 text-sm">
        {top.map(s => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-ink">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(s.key) }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
              <span className="text-muted">{money(convert(s.value), currency)}</span>
              <span className="w-9 text-right text-xs text-faint">{Math.round((s.value / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Accounts({ accounts, currency, convert }: { accounts: Account[]; currency: Currency; convert: (n: number) => number }) {
  return (
    <ul className="divide-y divide-line/70">
      {accounts.map(a => (
        <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm text-ink">
              <span className="truncate">{a.label}</span>
              {a.stale && <span title={`Last successful sync: ${asOf(a.lastSuccessAt)}`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
            </div>
            <div className="truncate text-xs text-faint">{a.label === a.sourceLabel ? '' : `${a.sourceLabel} · `}{asOf(a.asOf)}</div>
          </div>
          <div className="text-right tabular-nums">
            <div className={`text-sm ${a.fxMissing ? 'text-warn' : 'text-ink'}`}>{a.valueIls == null ? '—' : money(convert(a.valueIls), currency)}</div>
            {a.currency !== 'ILS' && a.value != null && <div className="text-xs text-faint">{money(a.value, a.currency)}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Holdings({ holdings, currency, convert }: { holdings: Holding[]; currency: Currency; convert: (n: number) => number }) {
  const [all, setAll] = useState(false);
  const shown = all ? holdings : holdings.slice(0, 10);
  const th = 'px-4 pb-2 pt-2 text-[11px] font-medium uppercase tracking-wide text-faint';
  return (
    <>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Symbol</th>
            <th className={`${th} text-right`}>Value</th>
            <th className={`${th} text-right max-sm:hidden`}>Weight</th>
            <th className={`${th} text-right`}>Change</th>
            <th className={`${th} text-right`}>Gain</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70 border-t border-line/70">
          {shown.map(h => (
            <tr key={h.id}>
              <td className="px-4 py-2.5">
                <div className="font-medium text-ink">{h.symbol}</div>
                <div className="max-w-40 truncate text-xs text-faint sm:max-w-56">{h.sourceLabel}{h.name !== h.symbol ? ` · ${h.name}` : ''}</div>
              </td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${h.fxMissing ? 'text-warn' : 'text-ink'}`}>
                {h.valueIls == null ? money(h.value, h.currency) : money(convert(h.valueIls), currency)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted max-sm:hidden">{pct(h.pctOfInvestments)}</td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${tone(h.changePct)}`}>{signedPct(h.changePct)}</td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${tone(h.gainPct)}`}>
                {h.gainIls == null ? <span className="text-faint">—</span> : (
                  <>
                    <div>{signedMoney(convert(h.gainIls), currency)}</div>
                    <div className="text-xs">{signedPct(h.gainPct)}</div>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {holdings.length > 10 && (
        <div className="border-t border-line/70 px-4 pb-2 pt-2.5">
          <button type="button" onClick={() => setAll(!all)} className="text-xs font-medium text-muted hover:text-ink">
            {all ? 'Show top 10' : `Show all ${holdings.length}`}
          </button>
        </div>
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
  const total = data?.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/15" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-line bg-paper shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 pb-4 pt-6">
          <div>
            <div className="text-xs text-muted">{monthLong(month)}</div>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-ink" dir="auto">{merchant?.name ?? 'Expenses'}</h2>
            {total != null && <div className="mt-1 text-sm tabular-nums text-muted">{money(total)}</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-xs font-medium text-muted hover:bg-ink/5 hover:text-ink">Close</button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="rounded-xl border border-line/80 bg-surface/80">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Description</th>
                  <th className="px-4 py-2 text-left font-medium max-sm:hidden">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70 border-t border-line/70">
                {data?.map(r => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{shortDay(r.date)}</td>
                    <td className="px-4 py-2.5 text-ink" dir="auto">{r.description}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted max-sm:hidden">{r.account}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    <Section title="Expenses" action={<span className="text-xs tabular-nums text-muted">{monthLong(month.month)} · {money(month.total)}</span>}>
      <div className="grid gap-6 md:grid-cols-5">
        <div className="h-48 md:col-span-3">
          <ResponsiveContainer>
            <BarChart data={months} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
              onClick={(e: { activeLabel?: string | number } | null) => {
                const m = e?.activeLabel != null ? String(e.activeLabel) : null;
                if (m) { setSelected(m); setPanel({ month: m }); }
              }}>
              <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: 'var(--color-faint)' }} />
              <Tooltip cursor={{ fill: 'rgba(29,28,26,0.04)' }}
                content={({ active, payload, label }) => active && payload?.length ? (
                  <div className="rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-md">
                    <div className="text-muted">{monthLong(String(label))}</div>
                    <div className="mt-0.5 tabular-nums text-ink">{money(Number(payload[0].value))}</div>
                  </div>
                ) : null} />
              <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={28} className="cursor-pointer" isAnimationActive={false}>
                {months.map(m => (
                  <Cell key={m.month} fill={m.month === current ? 'var(--c1)' : m.month === selected ? 'var(--c2)' : '#e3ded1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ol className="text-sm md:col-span-2">
          {month.merchants.map(m => (
            <li key={m.key}>
              <button type="button" onClick={() => setPanel({ month: month.month, merchant: { key: m.key, name: m.name } })}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-ink/[0.035]">
                <span className="truncate text-ink" dir="auto">{m.name}</span>
                <span className="shrink-0 tabular-nums text-muted">{money(m.total)}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {panel && <ExpenseRowsPanel month={panel.month} merchant={panel.merchant} onClose={() => setPanel(null)} />}
    </Section>
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
    if (key === 'other') return OTHER;
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
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-8">
        <span className="text-sm font-semibold tracking-tight text-ink">FamilyCFO</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Pills value={currency} onChange={setCurrency} disabled={v => v === 'USD' && !usdNow}
            options={[{ value: 'ILS', label: '₪' }, { value: 'USD', label: '$' }]} />
          <Refresh />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-12 sm:px-8">
        {summary.error && <p className="pt-8 text-sm text-down">{(summary.error as Error).message}</p>}

        {s && (
          <div className="pt-8">
            <div className="text-xs font-medium text-muted">Net worth</div>
            <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-ink">{money(convert(s.netWorth), currency)}</div>
            <div className="mt-1.5 text-sm font-light">
              <Change now={convert(s.netWorth)} start={startOf(h?.start?.netWorth)} currency={currency} />
            </div>
            <div className="mt-5 flex flex-wrap gap-x-10 gap-y-3">
              {buckets.map(b => (
                <div key={b.label}>
                  <div className="text-xs text-muted">{b.label}</div>
                  <div className="text-base font-medium tabular-nums text-ink">{money(convert(b.now), currency)}</div>
                  <div className="text-xs font-light"><Change now={convert(b.now)} start={startOf(b.start)} currency={currency} /></div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6">
          <div className="flex justify-end pb-1">
            <Pills value={group} onChange={setGroup} options={[{ value: 'type', label: 'Type' }, { value: 'source', label: 'Source' }]} />
          </div>
          <div className="h-72">
            {chart.length ? (
              <ResponsiveContainer>
                <AreaChart data={chart} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    {(h?.series ?? []).map(x => (
                      <linearGradient key={x.key} id={`fill-${x.key}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={colorOf(x.key)} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={colorOf(x.key)} stopOpacity={0.08} />
                      </linearGradient>
                    ))}
                  </defs>
                  <XAxis dataKey="date" tickFormatter={shortDay} tickLine={false} axisLine={false} fontSize={11}
                    tick={{ fill: 'var(--color-faint)' }} minTickGap={56} />
                  <Tooltip content={<ChartTooltip currency={currency} labels={labels} />}
                    cursor={{ stroke: 'var(--color-faint)', strokeWidth: 1, strokeDasharray: '3 3' }} />
                  {(h?.series ?? []).map(x => (
                    <Area key={x.key} dataKey={x.key} stackId="1" type="monotone" stroke={colorOf(x.key)} strokeWidth={1.25}
                      fill={`url(#fill-${x.key})`} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : <p className="pt-24 text-center text-sm text-faint">No data</p>}
          </div>
          <div className="flex justify-center pt-3">
            <Pills value={range} onChange={setRange} options={RANGES.map(r => ({ value: r, label: r }))} />
          </div>
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-3">
          <div className="min-w-0 space-y-8 lg:col-span-2">
            <Section title="Holdings" flush>{s && <Holdings holdings={s.holdings} currency={currency} convert={convert} />}</Section>
            {expenses.data && expenses.data.months.length > 0 && <Expenses months={expenses.data.months} current={expenses.data.currentMonth} />}
          </div>
          <div className="min-w-0 space-y-8">
            <Section title="Allocation">{s && <Allocation slices={s.allocation[group]} currency={currency} convert={convert} colorOf={colorOf} />}</Section>
            <Section title="Accounts" flush>{s && <Accounts accounts={s.accounts} currency={currency} convert={convert} />}</Section>
          </div>
        </div>
      </main>
    </div>
  );
}
