import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { api, type Account, type ExpenseMonth, type Group, type Holding, type History, type Range, type ReportItem, type Slice, type Summary } from './api';
import { OTHER, PALETTE, TYPE_COLORS, TYPE_LABELS } from './colors';
import { asOf, day, money, monthLong, monthShort, pct, shortDay, signedMoney, signedPct, type Currency } from './format';
import { ReportList } from './reports';
import { Card, CardLink, ChangeChip, Dot, Panel, Pills, Tag } from './ui';

const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];

const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');
const changePct = (now: number, start: number | null | undefined) => (start == null || !start ? null : ((now - start) / Math.abs(start)) * 100);

function ChartTooltip({ active, payload, label, currency, labels }: {
  active?: boolean; payload?: { dataKey: string; value: number; color: string }[]; label?: string; currency: Currency; labels: Record<string, string>;
}) {
  if (!active || !payload?.length || !label) return null;
  const rows = [...payload].filter(p => p.value).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, p) => s + p.value, 0);
  return (
    <div className="min-w-48 rounded-xl border border-line bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <div className="mb-1.5 text-muted">{day(label)}</div>
      {rows.map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-6 py-0.5">
          <span className="flex items-center gap-1.5 text-muted"><Dot color={p.color} className="h-1.5 w-1.5" />{labels[p.dataKey]}</span>
          <span className="tabular-nums text-ink">{money(p.value, currency)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-6 border-t border-line pt-1.5 font-medium text-ink">
        <span>Total</span><span className="tabular-nums">{money(total, currency)}</span>
      </div>
    </div>
  );
}

function NetWorth({ s, h, range, setRange, group, setGroup, currency, convert, atRate, colorOf }: {
  s: Summary; h?: History; range: Range; setRange: (r: Range) => void; group: Group; setGroup: (g: Group) => void;
  currency: Currency; convert: (n: number) => number; atRate: (n: number, rate: number | null) => number; colorOf: (key: string) => string;
}) {
  const chart = useMemo(() => (h?.points ?? []).map(p => ({
    date: p.date,
    ...Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, atRate(v, p.usdRate)])),
  })), [h, atRate]);
  const labels = Object.fromEntries((h?.series ?? []).map(x => [x.key, x.label]));

  // the change compares today with the first day of the range, each converted at its own day's rate in $
  const first = h?.points[0];
  const startOf = (n: number | null | undefined) => (n == null || !first ? null : atRate(n, first.usdRate));
  const st = h?.start;
  const netNow = convert(s.netWorth);
  const netStart = startOf(st?.netWorth);
  const assetsNow = convert(s.bank + s.investments);
  const assetsStart = st?.bank != null && st.investments != null ? startOf(st.bank + st.investments) : null;
  const debtsNow = convert(s.cardsOwed ?? 0);
  const debtsStart = s.cardsOwed == null ? null : startOf(st?.cardsOwed);

  return (
    <Card title="Net worth" action={<Pills size="xs" value={group} onChange={setGroup} options={[{ value: 'type', label: 'Type' }, { value: 'source', label: 'Source' }]} />}>
      <div className="text-center">
        <div className="text-[32px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{money(netNow, currency)}</div>
        <div className={`mt-0.5 text-[13px] tabular-nums ${netStart == null ? 'text-faint' : tone(netNow - netStart)}`}>
          {netStart == null ? '—' : <>{signedMoney(netNow - netStart, currency)} · {signedPct(changePct(netNow, netStart))}</>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {[
          { label: 'Assets', color: 'var(--c1)', now: assetsNow, start: assetsStart, goodWhenUp: true },
          { label: 'Debts', color: 'var(--c3)', now: debtsNow, start: debtsStart, goodWhenUp: false },
        ].map(x => (
          <div key={x.label} className="flex flex-col items-center gap-1">
            <span className="flex items-center gap-1.5 text-xs text-muted"><Dot color={x.color} className="h-1.5 w-1.5" />{x.label}</span>
            <span className="text-lg font-semibold tabular-nums text-ink">{money(x.now, currency)}</span>
            <ChangeChip pct={changePct(x.now, x.start)} goodWhenUp={x.goodWhenUp} />
          </div>
        ))}
      </div>
      <div className="-mx-5 mt-4 h-52">
        {chart.length ? (
          <ResponsiveContainer>
            <AreaChart data={chart} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
              <defs>
                {(h?.series ?? []).map(x => (
                  <linearGradient key={x.key} id={`fill-${x.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colorOf(x.key)} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={colorOf(x.key)} stopOpacity={0.06} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis dataKey="date" tickFormatter={shortDay} tickLine={false} axisLine={false} fontSize={11}
                tick={{ fill: 'var(--color-faint)' }} minTickGap={56} padding={{ left: 20, right: 20 }} />
              <Tooltip content={<ChartTooltip currency={currency} labels={labels} />}
                cursor={{ stroke: 'var(--color-faint)', strokeWidth: 1, strokeDasharray: '3 3' }} />
              {(h?.series ?? []).map(x => (
                <Area key={x.key} dataKey={x.key} stackId="1" type="monotone" stroke={colorOf(x.key)} strokeWidth={1.5}
                  fill={`url(#fill-${x.key})`} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : <p className="pt-20 text-center text-sm text-faint">No data</p>}
      </div>
      <div className="flex justify-center pt-3">
        <Pills value={range} onChange={setRange} options={RANGES.map(r => ({ value: r, label: r.toUpperCase() }))} />
      </div>
    </Card>
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
    <Panel onClose={onClose}>
      <div className="flex items-start justify-between px-6 pb-4 pt-6">
        <div>
          <div className="text-xs text-muted">{monthLong(month)}</div>
          <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-ink" dir="auto">{merchant?.name ?? 'Expenses'}</h2>
          {total != null && <div className="mt-1 text-sm tabular-nums text-muted">{money(total)}</div>}
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-xs font-medium text-muted hover:bg-ink/5 hover:text-ink">Close</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="rounded-2xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-faint">
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Description</th>
                <th className="px-4 py-2 text-left font-medium max-sm:hidden">Account</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-t border-line">
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
    </Panel>
  );
}

function Spending({ months, current }: { months: ExpenseMonth[]; current: string }) {
  const [selected, setSelected] = useState(months.some(m => m.month === current) ? current : months.at(-1)!.month);
  const [panel, setPanel] = useState<{ month: string; merchant?: { key: string; name: string } } | null>(null);
  const idx = Math.max(0, months.findIndex(m => m.month === selected));
  const month = months[idx];
  const prev = months[idx - 1];
  const top = month.merchants[0]?.total || 1;
  return (
    <Card title="Spending" action={<CardLink onClick={() => setPanel({ month: month.month })}>Transactions</CardLink>}>
      <div className="text-center">
        <div className="text-[32px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{money(month.total)} <span className="text-xl font-medium text-muted">spent</span></div>
        <div className="mt-0.5 text-[13px] tabular-nums text-accent">
          {month.month !== current && <span className="text-muted">{monthLong(month.month)} · </span>}
          {prev ? `${money(prev.total)} ${month.month === current ? 'last month' : 'the month before'}` : '—'}
        </div>
      </div>
      <div className="-mx-1 mt-4 h-40">
        <ResponsiveContainer>
          <BarChart data={months} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            onClick={(e: { activeLabel?: string | number } | null) => {
              const m = e?.activeLabel != null ? String(e.activeLabel) : null;
              if (m) { setSelected(m); setPanel({ month: m }); }
            }}>
            <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: 'var(--color-faint)' }} minTickGap={6} />
            <Tooltip cursor={{ fill: 'rgba(22,33,62,0.04)' }}
              content={({ active, payload, label }) => active && payload?.length ? (
                <div className="rounded-xl border border-line bg-surface/95 px-3 py-2 text-xs shadow-lg">
                  <div className="text-muted">{monthLong(String(label))}</div>
                  <div className="mt-0.5 tabular-nums text-ink">{money(Number(payload[0].value))}</div>
                </div>
              ) : null} />
            <Bar dataKey="total" radius={[5, 5, 5, 5]} maxBarSize={22} className="cursor-pointer" isAnimationActive={false}>
              {months.map(m => (
                <Cell key={m.month} fill={m.month === selected ? 'var(--color-accent)' : m.month === current ? 'color-mix(in srgb, var(--color-accent) 45%, white)' : '#e4e8f1'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ol className="mt-4 space-y-0.5 text-sm">
        {month.merchants.map((m, i) => (
          <li key={m.key}>
            <button type="button" onClick={() => setPanel({ month: month.month, merchant: { key: m.key, name: m.name } })}
              className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-paper">
              <span className="min-w-0 flex-1 truncate text-ink" dir="auto">{m.name}</span>
              <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-line sm:w-28">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (m.total / top) * 100)}%`, background: PALETTE[i % PALETTE.length] }} />
              </span>
              <span className="w-20 shrink-0 text-right tabular-nums text-ink">{money(m.total)}</span>
            </button>
          </li>
        ))}
      </ol>
      {panel && <ExpenseRowsPanel month={panel.month} merchant={panel.merchant} onClose={() => setPanel(null)} />}
    </Card>
  );
}

function Allocation({ slices, currency, convert, colorOf }: {
  slices: Slice[]; currency: Currency; convert: (n: number) => number; colorOf: (key: string) => string;
}) {
  const top = slices.length > 6 ? [...slices.slice(0, 5), { key: 'other', label: 'Other', value: slices.slice(5).reduce((s, x) => s + x.value, 0) }] : slices;
  const total = top.reduce((s, x) => s + x.value, 0);
  return (
    <Card title="Allocation">
      {!total ? <p className="text-sm text-faint">No data</p> : (
        <div className="flex flex-col items-center gap-6 sm:flex-row">
          <div className="h-36 w-36 shrink-0">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={top} dataKey="value" nameKey="label" innerRadius="72%" outerRadius="100%" paddingAngle={2} cornerRadius={4}
                  stroke="none" isAnimationActive={false}>
                  {top.map(s => <Cell key={s.key} fill={colorOf(s.key)} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ol className="w-full min-w-0 flex-1 space-y-2.5 text-sm">
            {top.map(s => (
              <li key={s.key} className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 items-center gap-2 text-ink"><Dot color={colorOf(s.key)} /><span className="truncate"><bdi>{s.label}</bdi></span></span>
                <span className="tabular-nums text-ink">{money(convert(s.value), currency)}</span>
                <span className="w-9 text-right text-xs tabular-nums text-faint">{Math.round((s.value / total) * 100)}%</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

const KIND_COLOR: Record<Account['kind'], string> = { bank: 'var(--c1)', card: 'var(--c3)', investment: 'var(--c2)' };

function Accounts({ accounts, currency, convert }: { accounts: Account[]; currency: Currency; convert: (n: number) => number }) {
  return (
    <Card title="Accounts" flush>
      <ul>
        {accounts.map(a => (
          <li key={a.id} className="flex items-center gap-3 px-5 py-2">
            <Dot color={a.source.startsWith('report:') ? 'var(--c4)' : KIND_COLOR[a.kind]} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-sm text-ink">
                <span className="truncate"><bdi>{a.label}</bdi></span>
                {a.stale && <span title={`Last successful sync: ${asOf(a.lastSuccessAt)}`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
              </div>
              <div className="truncate text-xs text-faint">{a.label === a.sourceLabel ? '' : <><bdi>{a.sourceLabel}</bdi> · </>}{asOf(a.asOf)}</div>
            </div>
            <div className="text-right tabular-nums">
              <div className={`text-sm ${a.fxMissing ? 'text-warn' : 'text-ink'}`}>{a.valueIls == null ? '—' : money(convert(a.valueIls), currency)}</div>
              {a.currency !== 'ILS' && a.value != null && <div className="text-xs text-faint">{money(a.value, a.currency)}</div>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Holdings({ holdings, currency, convert }: { holdings: Holding[]; currency: Currency; convert: (n: number) => number }) {
  const [all, setAll] = useState(false);
  const shown = all ? holdings : holdings.slice(0, 10);
  const th = 'px-2 sm:px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-faint first:pl-5 last:pr-5';
  const td = 'px-2 sm:px-3 py-2 first:pl-5 last:pr-5 [&:not(:first-child)]:whitespace-nowrap';
  return (
    <Card title="Holdings" flush className="lg:col-span-2"
      action={holdings.length > 10 && <CardLink onClick={() => setAll(!all)}>{all ? 'Top 10' : `All ${holdings.length}`}</CardLink>}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className={`${th} text-left`}>Name</th>
              <th className={`${th} text-left max-md:hidden`}>Type</th>
              <th className={`${th} text-right`}>Value</th>
              <th className={`${th} text-right max-sm:hidden`}>Weight</th>
              <th className={`${th} text-right max-sm:hidden`}>Change</th>
              <th className={`${th} text-right`}>Gain</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(h => (
              <tr key={h.id} className="hover:bg-paper">
                <td className={td}>
                  <div className="font-medium text-ink">{h.symbol}</div>
                  <div className="max-w-36 truncate text-xs text-faint sm:max-w-72"><bdi>{h.sourceLabel}</bdi>{h.name !== h.symbol && <> · <bdi>{h.name}</bdi></>}</div>
                  {h.liquidityDate && <div className="text-xs text-faint">Liquid from {day(h.liquidityDate)}</div>}
                </td>
                <td className={`${td} max-md:hidden`}><Tag color={TYPE_COLORS[h.assetClass] ?? OTHER}>{TYPE_LABELS[h.assetClass] ?? h.assetClass}</Tag></td>
                <td className={`${td} text-right tabular-nums ${h.fxMissing ? 'text-warn' : 'text-ink'}`}>
                  {h.valueIls == null ? money(h.value, h.currency) : money(convert(h.valueIls), currency)}
                  <div className={`text-xs sm:hidden ${tone(h.changePct)}`}>{signedPct(h.changePct)}</div>
                </td>
                <td className={`${td} text-right tabular-nums text-muted max-sm:hidden`}>{pct(h.pctOfInvestments)}</td>
                <td className={`${td} text-right tabular-nums max-sm:hidden ${tone(h.changePct)}`}>{signedPct(h.changePct)}</td>
                <td className={`${td} text-right tabular-nums ${tone(h.gainPct)}`}>
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
    </Card>
  );
}

export default function Dashboard({ summary: s, range, setRange, currency, convert, reports, onOpenReport }: {
  summary?: Summary; range: Range; setRange: (r: Range) => void; currency: Currency; convert: (n: number) => number;
  reports: ReportItem[]; onOpenReport: (id: number) => void;
}) {
  const [group, setGroup] = useState<Group>('type');
  const history = useQuery({ queryKey: ['history', range, group], queryFn: () => api.history(range, group), placeholderData: p => p });
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: api.expenses });
  const h = history.data;
  const atRate = useMemo(() => (n: number, rate: number | null) => (currency === 'USD' && rate ? n / rate : n), [currency]);

  // one colour per key, shared by the chart and the allocation: types have their own, sources cycle the palette
  const seriesKeys = (h?.series ?? []).map(x => x.key);
  const colorOf = (key: string) => {
    if (key === 'other') return OTHER;
    if (group === 'type') return TYPE_COLORS[key] ?? OTHER;
    const i = seriesKeys.indexOf(key);
    return PALETTE[(i >= 0 ? i : seriesKeys.length + (s?.allocation.source.findIndex(x => x.key === key) ?? 0)) % PALETTE.length];
  };

  if (!s) return null;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <NetWorth s={s} h={h} range={range} setRange={setRange} group={group} setGroup={setGroup}
        currency={currency} convert={convert} atRate={atRate} colorOf={colorOf} />
      {expenses.data && expenses.data.months.length > 0
        ? <Spending months={expenses.data.months} current={expenses.data.currentMonth} />
        : <Card title="Spending"><p className="text-sm text-faint">No data</p></Card>}
      <Holdings holdings={s.holdings} currency={currency} convert={convert} />
      <div className="flex min-w-0 flex-col gap-5">
        <Allocation slices={s.allocation[group]} currency={currency} convert={convert} colorOf={colorOf} />
        {reports.length > 0 && <Card title="Reports" flush><ReportList reports={reports} onOpen={onOpenReport} /></Card>}
      </div>
      <Accounts accounts={s.accounts} currency={currency} convert={convert} />
    </div>
  );
}
