import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, ComposedChart, Line, LineChart, ReferenceLine, XAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type FlowRow, type Range } from './api';
import { PALETTE } from './colors';
import { day, money, monthLong, monthShort, monthYear, monthYearTiny, shortDay, signedMoney, type Currency } from './format';
import { Card, Dot, Name, RangeToggle, SidePanel } from './ui';
import { cn } from '@/lib/utils';

const IN = 'color-mix(in srgb, var(--color-up) 75%, white)';
const OUT = 'color-mix(in srgb, var(--color-down) 70%, white)';
const tone = (n: number) => (n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');

/** "All accounts" and one pill per bank account. */
function Pills({ accounts, value, onChange }: { accounts: { id: string; label: string }[]; value: string | null; onChange: (id: string | null) => void }) {
  const pill = (active: boolean) => cn('min-h-9 rounded-full border px-3 text-xs font-medium',
    active ? 'border-transparent bg-accent/10 text-accent' : 'border-line bg-surface text-muted hover:text-ink');
  return (
    <div role="group" aria-label="Account" className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={value == null} className={pill(value == null)} onClick={() => onChange(null)}>All accounts</button>
      {accounts.map(a => (
        <button key={a.id} type="button" aria-pressed={value === a.id} className={pill(value === a.id)} onClick={() => onChange(a.id)}><Name text={a.label} /></button>
      ))}
    </div>
  );
}

const flowConfig = { in: { label: 'In' }, out: { label: 'Out' }, net: { label: 'Net' } } satisfies ChartConfig;

function FlowTooltip({ active, payload, label, currency }: {
  active?: boolean; payload?: readonly { payload?: { in: number; out: number; net: number } }[]; label?: unknown; currency: Currency;
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p || !label) return null;
  return (
    <div className="min-w-44 rounded-xl border border-line bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <div className="mb-1.5 text-muted">{monthLong(String(label))}</div>
      {[['In', p.in, IN], ['Out', -p.out, OUT]].map(([name, v, color]) => (
        <div key={name as string} className="flex items-center justify-between gap-6 py-0.5">
          <span className="flex items-center gap-1.5 text-muted"><Dot color={color as string} className="h-1.5 w-1.5" />{name}</span>
          <span className="tabular-nums text-ink">{money(v as number, currency)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-6 border-t border-line pt-1.5 font-medium text-ink">
        <span>Net</span><span className="tabular-nums">{signedMoney(p.net, currency)}</span>
      </div>
    </div>
  );
}

function RowsTable({ rows, convert, currency }: { rows: FlowRow[]; convert: (n: number) => number; currency: Currency }) {
  return (
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
          {rows.map(r => (
            <tr key={r.id}>
              <td className="whitespace-nowrap px-4 py-2.5 text-muted">{shortDay(r.date)}</td>
              <td className="px-4 py-2.5 text-ink"><bdi dir="auto">{r.description}</bdi></td>
              <td className="whitespace-nowrap px-4 py-2.5 text-muted max-sm:hidden"><Name text={r.account} /></td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-ink">{money(convert(Math.abs(r.amount)), currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthPanel({ month, account, accountLabel, onClose, currency, convert }: {
  month: string; account: string | null; accountLabel: string; onClose: () => void; currency: Currency; convert: (n: number) => number;
}) {
  const { data } = useQuery({ queryKey: ['cashflow-rows', month, account], queryFn: () => api.cashFlowRows(month, account ?? undefined) });
  const sum = (rows: FlowRow[]) => rows.reduce((s, r) => s + Math.abs(r.amount), 0);
  return (
    <SidePanel onClose={onClose} kicker={accountLabel} title={monthLong(month)}
      meta={data && <span className="tabular-nums">In {money(convert(sum(data.in)), currency)} · Out {money(convert(sum(data.out)), currency)}</span>}>
      {data && (['in', 'out'] as const).map(side => (
        <section key={side} className="mt-2 first:mt-0">
          <h3 className="flex items-center justify-between pb-2 pt-3 text-[13px] font-semibold text-ink">
            <span className="flex items-center gap-2"><Dot color={side === 'in' ? IN : OUT} />{side === 'in' ? 'In' : 'Out'}</span>
            <span className="tabular-nums">{money(convert(sum(data[side])), currency)}</span>
          </h3>
          {data[side].length ? <RowsTable rows={data[side]} convert={convert} currency={currency} /> : <p className="text-sm text-faint">None</p>}
        </section>
      ))}
    </SidePanel>
  );
}

export default function Bank({ range, setRange, currency, convert }: {
  range: Range; setRange: (r: Range) => void; currency: Currency; convert: (n: number) => number;
}) {
  const [account, setAccount] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['cashflow', range, account], queryFn: () => api.cashFlow(range, account ?? undefined), placeholderData: p => p });
  const chart = useMemo(() => (data?.months ?? []).map(m => ({ month: m.month, in: convert(m.in), out: -convert(m.out), net: convert(m.net) })), [data, convert]);
  const balances = useMemo(() => (data?.balances.points ?? []).map(p => ({
    date: p.date, ...Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, convert(v)])),
  })), [data, convert]);
  if (!data) return null;

  const series = data.balances.series;
  const colorOf = (key: string) => PALETTE[Math.max(0, series.findIndex(s => s.key === key)) % PALETTE.length];
  const balanceConfig = Object.fromEntries(series.map(s => [s.key, { label: s.label }])) satisfies ChartConfig;
  const latest = data.balances.points.at(-1)?.values ?? {};
  const accountLabel = data.accounts.find(a => a.id === account)?.label ?? 'All accounts';
  const t = data.totals;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title="Cash flow" className="lg:col-span-2" action={<RangeToggle value={range} onChange={setRange} />}>
        <Pills accounts={data.accounts} value={account} onChange={setAccount} />
        <div className="mt-5 grid grid-cols-3 gap-3 text-center">
          {[
            { label: 'In', color: IN, value: money(convert(t.in), currency), cls: 'text-ink' },
            { label: 'Out', color: OUT, value: money(convert(t.out), currency), cls: 'text-ink' },
            { label: 'Net', color: 'var(--color-accent)', value: signedMoney(convert(t.net), currency), cls: tone(t.net) },
          ].map(x => (
            <div key={x.label} className="flex flex-col items-center gap-1">
              <span className="flex items-center gap-1.5 text-xs text-muted"><Dot color={x.color} className="h-1.5 w-1.5" />{x.label}</span>
              <span className={cn('text-lg font-semibold tabular-nums sm:text-[22px]', x.cls)}>{x.value}</span>
            </div>
          ))}
        </div>
        {t.moved !== 0 && (
          <div className="mt-2 text-center text-[13px] text-muted">
            Moved to savings/investments <span className="tabular-nums text-ink">{money(convert(t.moved), currency)}</span>
          </div>
        )}
        <ChartContainer config={flowConfig} className="-mx-1 mt-4 aspect-auto h-56" initialDimension={{ width: 720, height: 224 }}>
          <ComposedChart data={chart} stackOffset="sign" margin={{ top: 6, right: 0, bottom: 0, left: 0 }}
            onClick={(e: { activeLabel?: string | number } | null) => { if (e?.activeLabel != null) setMonth(String(e.activeLabel)); }}>
            <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: 'var(--color-faint)' }} minTickGap={6} />
            <ReferenceLine y={0} stroke="var(--color-line)" />
            <ChartTooltip cursor={{ fill: 'rgba(22,33,62,0.04)' }} content={p => <FlowTooltip {...p} currency={currency} />} />
            <Bar dataKey="in" stackId="flow" fill={IN} radius={[5, 5, 0, 0]} maxBarSize={22} className="cursor-pointer" isAnimationActive={false} />
            <Bar dataKey="out" stackId="flow" fill={OUT} radius={[0, 0, 5, 5]} maxBarSize={22} className="cursor-pointer" isAnimationActive={false} />
            <Line dataKey="net" type="monotone" stroke="var(--color-accent)" strokeWidth={1.75} dot={{ r: 2.5, strokeWidth: 0, fill: 'var(--color-accent)' }}
              activeDot={{ r: 3.5, strokeWidth: 0 }} isAnimationActive={false} />
          </ComposedChart>
        </ChartContainer>
      </Card>

      <Card title="Balance">
        {balances.length >= 2 && (
          <ChartContainer config={balanceConfig} className="-mx-1 aspect-auto h-52" initialDimension={{ width: 360, height: 208 }}>
            <LineChart data={balances} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
              <XAxis dataKey="date" tickFormatter={shortDay} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: 'var(--color-faint)' }} minTickGap={48} />
              <ChartTooltip cursor={{ stroke: 'var(--color-faint)', strokeWidth: 1, strokeDasharray: '3 3' }}
                content={({ active, payload, label }) => active && payload?.length ? (
                  <div className="min-w-44 rounded-xl border border-line bg-surface/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
                    <div className="mb-1.5 text-muted">{day(String(label))}</div>
                    {payload.map(p => (
                      <div key={String(p.dataKey)} className="flex items-center justify-between gap-6 py-0.5">
                        <span className="flex items-center gap-1.5 text-muted"><Dot color={colorOf(String(p.dataKey))} className="h-1.5 w-1.5" /><Name text={balanceConfig[String(p.dataKey)]?.label ?? ''} /></span>
                        <span className="tabular-nums text-ink">{money(Number(p.value), currency)}</span>
                      </div>
                    ))}
                  </div>
                ) : null} />
              {series.map(s => (
                <Line key={s.key} dataKey={s.key} type="monotone" stroke={colorOf(s.key)} strokeWidth={1.5} dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ChartContainer>
        )}
        <ul className="mt-3 space-y-1 text-sm">
          {series.map(s => (
            <li key={s.key} className="flex items-center gap-2 py-0.5">
              <Dot color={colorOf(s.key)} />
              <span className="min-w-0 flex-1 truncate text-ink"><Name text={s.label} /></span>
              <span className="tabular-nums text-ink">{latest[s.key] == null ? '—' : money(convert(latest[s.key]), currency)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Months" flush className="lg:col-span-3">
        <Table>
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              {['Month', 'In', 'Out', 'Net'].map(h => (
                <TableHead key={h} className={cn('h-9 px-2 text-[11px] sm:px-3 font-medium uppercase tracking-wide text-faint first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5', h !== 'Month' && 'text-right')}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...data.months].reverse().map(m => (
              <TableRow key={m.month} onClick={() => setMonth(m.month)} className="cursor-pointer border-line hover:bg-paper">
                <TableCell className="px-2 py-2.5 pl-4 font-medium text-ink sm:px-3 sm:pl-5">
                  <button type="button" onClick={e => { e.stopPropagation(); setMonth(m.month); }} className="text-left hover:text-accent">
                    <span className="sm:hidden">{monthYearTiny(m.month)}</span><span className="max-sm:hidden">{monthYear(m.month)}</span>
                  </button>
                </TableCell>
                <TableCell className="px-2 py-2.5 text-right tabular-nums text-ink sm:px-3">{money(convert(m.in), currency)}</TableCell>
                <TableCell className="px-2 py-2.5 text-right tabular-nums text-ink sm:px-3">{money(convert(m.out), currency)}</TableCell>
                <TableCell className={cn('px-2 py-2.5 pr-4 text-right tabular-nums sm:px-3 sm:pr-5', tone(m.net))}>{signedMoney(convert(m.net), currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {month && <MonthPanel month={month} account={account} accountLabel={accountLabel} onClose={() => setMonth(null)} currency={currency} convert={convert} />}
    </div>
  );
}
