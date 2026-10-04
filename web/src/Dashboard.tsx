import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, Cell, XAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { api, type ExpenseMonth, type Group, type Holding, type History, type Range, type Slice, type Summary } from './api';
import { OTHER, PALETTE, TYPE_COLORS, TYPE_LABELS } from './colors';
import { day, money, monthLong, monthShort, pct, shortDay, signedMoney, signedPct, type Currency } from './format';
import { AccountGroups } from './Layout';
import { Card, CardLink, ChangeChip, Dot, Name, Parts, Segmented, SidePanel, SubTag } from './ui';
import { cn } from '@/lib/utils';

const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];

const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');
const changePct = (now: number, start: number | null | undefined) => (start == null || !start ? null : ((now - start) / Math.abs(start)) * 100);

function HistoryTooltip({ active, payload, label, currency, labels }: {
  active?: boolean; payload?: readonly { dataKey?: unknown; value?: unknown; color?: string }[]; label?: unknown; currency: Currency; labels: Record<string, string>;
}) {
  if (!active || !payload?.length || !label) return null;
  const rows = payload.map(p => ({ key: String(p.dataKey), value: Number(p.value), color: p.color ?? OTHER }))
    .filter(p => p.value).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, p) => s + p.value, 0);
  return (
    <div className="min-w-48 rounded-xl border border-line bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <div className="mb-1.5 text-muted">{day(String(label))}</div>
      {rows.map(p => (
        <div key={p.key} className="flex items-center justify-between gap-6 py-0.5">
          <span className="flex items-center gap-1.5 text-muted"><Dot color={p.color} className="h-1.5 w-1.5" /><Name text={labels[p.key] ?? p.key} /></span>
          <span className="tabular-nums text-ink">{money(p.value, currency)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-6 border-t border-line pt-1.5 font-medium text-ink">
        <span>Total</span><span className="tabular-nums">{money(total, currency)}</span>
      </div>
    </div>
  );
}

/** The allocation under the chart: a 100% stacked bar and a bar list, in the chart's colours — its legend. */
function Allocation({ slices, currency, convert, colorOf }: {
  slices: Slice[]; currency: Currency; convert: (n: number) => number; colorOf: (key: string) => string;
}) {
  const top = slices.length > 6 ? [...slices.slice(0, 5), { key: 'other', label: 'Other', value: slices.slice(5).reduce((s, x) => s + x.value, 0) }] : slices;
  const total = top.reduce((s, x) => s + x.value, 0);
  if (!total) return null;
  return (
    <div className="mt-5">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Allocation">
        {top.map(s => <span key={s.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(s.value / total) * 100}%`, background: colorOf(s.key) }} />)}
      </div>
      <ol className="mt-3 space-y-1 text-sm">
        {top.map(s => {
          const share = (s.value / total) * 100;
          return (
            <li key={s.key} className="grid grid-cols-[minmax(0,1fr)_auto_2.5rem] items-center gap-x-3 py-0.5 sm:grid-cols-[minmax(0,1fr)_6rem_auto_2.5rem]">
              <span className="flex min-w-0 items-center gap-2 text-ink"><Dot color={colorOf(s.key)} /><span className="truncate"><Name text={s.label} /></span></span>
              <span className="h-1.5 overflow-hidden rounded-full bg-line max-sm:hidden">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, share)}%`, background: colorOf(s.key) }} />
              </span>
              <span className="text-right tabular-nums text-ink">{money(convert(s.value), currency)}</span>
              <span className="text-right text-xs tabular-nums text-faint">{Math.round(share)}%</span>
            </li>
          );
        })}
      </ol>
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
  const series = h?.series ?? [];
  const labels = Object.fromEntries(series.map(x => [x.key, x.label]));
  const config = Object.fromEntries(series.map(x => [x.key, { label: x.label }])) satisfies ChartConfig;

  // the change compares today with the first day of the range, each converted at its own day's rate in $
  const first = h?.points[0];
  const startOf = (n: number | null | undefined) => (n == null || !first ? null : atRate(n, first.usdRate));
  const st = h?.start;
  const netNow = convert(s.netWorth);
  const netStart = startOf(st?.netWorth);
  const assetsNow = convert(s.bank + s.investments);
  const assetsStart = st?.bank != null && st.investments != null ? startOf(st.bank + st.investments) : null;
  const debtsNow = convert(s.cardsOwed ?? 0);
  const debtsStart = startOf(st?.cardsOwed);
  const hasDebts = s.cardsOwed != null && s.cardsOwed !== 0;

  return (
    <Card title="Net worth" action={<Segmented label="Group by" size="xs" value={group} onChange={setGroup} options={[{ value: 'type', label: 'Type' }, { value: 'source', label: 'Source' }]} />}>
      <div className="text-center">
        <div className="text-[32px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{money(netNow, currency)}</div>
        {netStart != null && (
          <div className={`mt-0.5 text-[13px] tabular-nums ${tone(netNow - netStart)}`}>
            {signedMoney(netNow - netStart, currency)} · {signedPct(changePct(netNow, netStart))}
          </div>
        )}
      </div>
      {hasDebts && (
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
      )}
      {chart.length >= 2 && (
        <>
          <ChartContainer config={config} className="-mx-5 mt-4 aspect-auto h-52" initialDimension={{ width: 560, height: 208 }}>
            <AreaChart data={chart} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
              <defs>
                {series.map((x, i) => (
                  <linearGradient key={x.key} id={`fill-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colorOf(x.key)} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={colorOf(x.key)} stopOpacity={0.06} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis dataKey="date" tickFormatter={shortDay} tickLine={false} axisLine={false} fontSize={11}
                tick={{ fill: 'var(--color-faint)' }} minTickGap={56} padding={{ left: 20, right: 20 }} />
              <ChartTooltip content={p => <HistoryTooltip {...p} currency={currency} labels={labels} />}
                cursor={{ stroke: 'var(--color-faint)', strokeWidth: 1, strokeDasharray: '3 3' }} />
              {series.map((x, i) => (
                <Area key={x.key} dataKey={x.key} name={x.label} stackId="1" type="monotone" stroke={colorOf(x.key)} strokeWidth={1.5}
                  fill={`url(#fill-${i})`} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
              ))}
            </AreaChart>
          </ChartContainer>
          <div className="flex justify-center pt-3">
            <Segmented label="Range" value={range} onChange={setRange} options={RANGES.map(r => ({ value: r, label: r.toUpperCase() }))} />
          </div>
        </>
      )}
      <Allocation slices={s.allocation[group]} currency={currency} convert={convert} colorOf={colorOf} />
    </Card>
  );
}

function ExpenseRowsPanel({ month, merchant, onClose }: { month: string; merchant?: { key: string; name: string }; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['expense-rows', month, merchant?.key], queryFn: () => api.expenseRows(month, merchant?.key) });
  const total = data?.reduce((s, r) => s + r.amount, 0);
  return (
    <SidePanel onClose={onClose} kicker={monthLong(month)} title={merchant ? <bdi dir="auto">{merchant.name}</bdi> : 'Transactions'}
      meta={total != null && <span className="tabular-nums">{money(total)}</span>}>
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
                <td className="px-4 py-2.5 text-ink"><bdi dir="auto">{r.description}</bdi></td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted max-sm:hidden"><bdi>{r.account}</bdi></td>
                <td className="px-4 py-2.5 text-right tabular-nums text-ink">{money(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SidePanel>
  );
}

const spendConfig = { total: { label: 'Spent' } } satisfies ChartConfig;

function Spending({ months, current }: { months: ExpenseMonth[]; current: string }) {
  const [selected, setSelected] = useState(months.some(m => m.month === current) ? current : months.at(-1)!.month);
  const [panel, setPanel] = useState<{ month: string; merchant?: { key: string; name: string } } | null>(null);
  const idx = Math.max(0, months.findIndex(m => m.month === selected));
  const month = months[idx];
  const prev = months[idx - 1];
  const merchants = month.merchants.slice(0, 5);
  const top = merchants[0]?.total || 1;
  return (
    <Card title="Spending" action={<CardLink onClick={() => setPanel({ month: month.month })}>Transactions</CardLink>}>
      <div className="text-center">
        <div className="text-[32px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{money(month.total)} <span className="text-xl font-medium text-muted">spent</span></div>
        <div className="mt-0.5 text-[13px] tabular-nums text-accent">
          {month.month !== current && <span className="text-muted">{monthLong(month.month)} · </span>}
          {prev ? `${money(prev.total)} ${month.month === current ? 'last month' : 'the month before'}` : null}
        </div>
      </div>
      <ChartContainer config={spendConfig} className="-mx-1 mt-4 aspect-auto h-40" initialDimension={{ width: 560, height: 160 }}>
        <BarChart data={months} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          onClick={(e: { activeLabel?: string | number } | null) => {
            const m = e?.activeLabel != null ? String(e.activeLabel) : null;
            if (m) setSelected(m);
          }}>
          <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: 'var(--color-faint)' }} minTickGap={6} />
          <ChartTooltip cursor={{ fill: 'rgba(22,33,62,0.04)' }}
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
      </ChartContainer>
      <ol className="mt-4 space-y-0.5 text-sm">
        {merchants.map((m, i) => (
          <li key={m.key}>
            <button type="button" onClick={() => setPanel({ month: month.month, merchant: { key: m.key, name: m.name } })}
              className="-mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-paper">
              <span className="min-w-0 flex-1 truncate text-ink"><bdi dir="auto">{m.name}</bdi></span>
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

// ---- holdings ----------------------------------------------------------------------------------------------

/** The holdings' group: the top-level type (all fund-type products are Funds). */
const groupOf = (h: Holding) => h.type;
const groupLabel = (g: string) => TYPE_LABELS[g] ?? g;
const groupColor = (g: string) => TYPE_COLORS[g] ?? OTHER;

/** A holding's second line: its source (unless the name already says it) and its name (when not the row's label). */
const holdingSub = (h: Holding): string[] => [
  h.name.includes(h.sourceLabel) || h.label.includes(h.sourceLabel) ? null : h.sourceLabel,
  h.label.includes(h.name) || h.name === h.symbol ? null : h.name,
].filter((x): x is string => !!x);

const valueIls = (h: Holding) => h.valueIls ?? -Infinity;

export function SortHead({ label, column, align = 'right' }: { label: string; column: { getIsSorted: () => false | 'asc' | 'desc'; toggleSorting: (desc?: boolean) => void }; align?: 'left' | 'right' }) {
  const sorted = column.getIsSorted();
  const Icon = sorted === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button type="button" onClick={() => column.toggleSorting(sorted !== 'desc')}
      className={cn('inline-flex min-h-9 items-center gap-1 uppercase tracking-wide hover:text-ink', align === 'right' && 'flex-row-reverse')}>
      {label}<Icon className={cn('size-3', !sorted && 'invisible')} />
    </button>
  );
}

function Holdings({ holdings, currency, convert }: { holdings: Holding[]; currency: Currency; convert: (n: number) => number }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'value', desc: true }]);
  const money$ = (h: Holding) => (h.valueIls == null ? money(h.value, h.currency) : money(convert(h.valueIls), currency));
  const columns = useMemo<ColumnDef<Holding>[]>(() => [
    { id: 'name', accessorFn: h => h.label, header: ({ column }) => <SortHead label="Name" column={column} align="left" /> },
    { id: 'owner', accessorFn: h => h.owner ?? '', header: ({ column }) => <SortHead label="Owner" column={column} align="left" /> },
    { id: 'value', accessorFn: valueIls, header: ({ column }) => <SortHead label="Value" column={column} /> },
    { id: 'weight', accessorFn: h => h.pctOfInvestments ?? -Infinity, header: ({ column }) => <SortHead label="Weight" column={column} /> },
    { id: 'change', accessorFn: h => h.changePct ?? -Infinity, header: ({ column }) => <SortHead label="Change" column={column} /> },
    { id: 'gain', accessorFn: h => h.gainPct ?? -Infinity, header: ({ column }) => <SortHead label="Gain" column={column} /> },
  ], []);
  const table = useReactTable({ data: holdings, columns, state: { sorting }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });

  // the sorted rows, bucketed by type; groups by subtotal
  const groups = useMemo(() => {
    const by = new Map<string, Holding[]>();
    for (const r of table.getRowModel().rows) by.set(groupOf(r.original), [...(by.get(groupOf(r.original)) ?? []), r.original]);
    return [...by].map(([key, rows]) => ({ key, rows, total: rows.reduce((s, h) => s + (h.valueIls ?? 0), 0),
      weight: rows.reduce((s, h) => s + (h.pctOfInvestments ?? 0), 0) })).sort((a, b) => b.total - a.total);
  }, [table.getRowModel().rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const th = 'px-2 sm:px-3 py-1 text-[11px] font-medium text-faint first:pl-5 last:pr-5';
  const td = 'px-2 sm:px-3 py-2 first:pl-5 last:pr-5';
  const headers = table.getHeaderGroups()[0].headers;
  const hide: Record<string, string> = { owner: 'max-md:hidden', weight: 'max-md:hidden', change: '', gain: 'max-lg:hidden' };

  return (
    <Card title="Holdings" flush className="lg:col-span-2">
      {/* sm and up: the table */}
      <div className="max-sm:hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              {headers.map(h => (
                <th key={h.id} className={cn(th, h.id === 'name' || h.id === 'owner' ? 'text-left' : 'text-right', hide[h.id])}>
                  {h.isPlaceholder ? null : typeof h.column.columnDef.header === 'function' ? h.column.columnDef.header(h.getContext()) : null}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map(g => {
            const funds = g.key === 'funds';
            return (
              <tbody key={g.key} className="border-b border-line last:border-0">
                <tr className="bg-paper/60">
                  <td className={cn(td, 'py-1.5')}><span className="flex items-center gap-2 text-xs font-semibold text-ink"><Dot color={groupColor(g.key)} />{groupLabel(g.key)}</span></td>
                  <td className={cn(td, hide.owner)} />
                  <td className={cn(td, 'py-1.5 text-right text-xs font-semibold tabular-nums text-ink')}>{money(convert(g.total), currency)}</td>
                  <td className={cn(td, 'py-1.5 text-right text-xs tabular-nums text-muted', hide.weight)}>{pct(g.weight)}</td>
                  {funds
                    ? <td colSpan={2} className={cn(td, 'py-1.5 text-right text-[11px] font-medium uppercase tracking-wide text-faint')}>Liquid from</td>
                    : <><td className={td} /><td className={cn(td, hide.gain)} /></>}
                </tr>
                {g.rows.map(h => {
                  const sub = holdingSub(h);
                  return (
                    <tr key={h.id} className="hover:bg-paper">
                      <td className={td}>
                        <div className="flex flex-wrap items-center gap-x-2 font-medium text-ink"><Name text={h.label} />{h.subType && <SubTag>{h.subType}</SubTag>}</div>
                        {(sub.length > 0 || h.owner) && (
                          <div className="text-xs text-faint">
                            {h.owner && <span className="md:hidden"><bdi>{h.owner}</bdi>{sub.length > 0 && ' · '}</span>}<Parts parts={sub} />
                          </div>
                        )}
                      </td>
                      <td className={cn(td, 'text-xs text-faint', hide.owner)}><bdi>{h.owner}</bdi></td>
                      <td className={cn(td, 'whitespace-nowrap text-right tabular-nums', h.fxMissing ? 'text-warn' : 'text-ink')}>{money$(h)}</td>
                      <td className={cn(td, 'whitespace-nowrap text-right tabular-nums text-muted', hide.weight)}>{pct(h.pctOfInvestments)}</td>
                      {funds ? (
                        <td colSpan={2} className={cn(td, 'whitespace-nowrap text-right tabular-nums text-muted')}>{h.liquidityDate ? day(h.liquidityDate) : '—'}</td>
                      ) : (
                        <>
                          <td className={cn(td, 'whitespace-nowrap text-right tabular-nums', tone(h.changePct))}>{h.changePct == null ? '' : signedPct(h.changePct)}</td>
                          <td className={cn(td, 'whitespace-nowrap text-right tabular-nums', tone(h.gainPct), hide.gain)}>
                            {h.gainIls != null && <><div>{signedMoney(convert(h.gainIls), currency)}</div><div className="text-xs">{signedPct(h.gainPct)}</div></>}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>

      {/* below sm: two-line list rows */}
      <div className="sm:hidden">
        {groups.map(g => (
          <section key={g.key} className="border-t border-line first:border-0">
            <div className="flex items-center justify-between bg-paper/60 px-5 py-1.5 text-xs font-semibold text-ink">
              <span className="flex items-center gap-2"><Dot color={groupColor(g.key)} />{groupLabel(g.key)}</span>
              <span className="tabular-nums">{money(convert(g.total), currency)}</span>
            </div>
            <ul>
              {g.rows.map(h => (
                <li key={h.id} className="flex min-h-12 items-center gap-3 px-5 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm font-medium text-ink"><Name text={h.label} /></div>
                    <div className="flex items-center gap-1.5 truncate text-xs text-faint">
                      {h.owner && <bdi>{h.owner}</bdi>}
                      {h.subType ? <SubTag>{h.subType}</SubTag> : !h.owner && <Parts parts={holdingSub(h)} />}
                    </div>
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className={cn('text-sm', h.fxMissing ? 'text-warn' : 'text-ink')}>{money$(h)}</div>
                    <div className={cn('text-xs', g.key === 'funds' ? 'text-faint' : tone(h.changePct))}>
                      {g.key === 'funds' ? (h.liquidityDate ? `Liquid ${day(h.liquidityDate)}` : '') : h.changePct == null ? '' : signedPct(h.changePct)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Card>
  );
}

export default function Dashboard({ summary: s, range, setRange, currency, convert }: {
  summary?: Summary; range: Range; setRange: (r: Range) => void; currency: Currency; convert: (n: number) => number;
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
      <Card title="Accounts" className="lg:hidden">
        <div className="-mx-3"><AccountGroups accounts={s.accounts} currency={currency} convert={convert} /></div>
      </Card>
    </div>
  );
}
