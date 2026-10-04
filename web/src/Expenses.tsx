import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, Cell, XAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { api, type ExpenseFilter, type ExpenseSource, type Range } from './api';
import { money, monthLong, monthShort, shortDay, type Currency } from './format';
import { SOURCE_OTHER, sourceColor } from './colors';
import { BarList, Card, Dot, Name, RangeToggle, SidePanel } from './ui';
import { cn } from '@/lib/utils';

/** A card's source colour; spend paid from the bank accounts is neutral. */
const colorOf = (s: ExpenseSource) => (s.kind === 'card' ? sourceColor(s.key) : SOURCE_OTHER);

const spendConfig = { total: { label: 'Spent' } } satisfies ChartConfig;

/** "All" and one pill per source (card account / Bank). */
function SourcePills({ sources, value, onChange }: { sources: ExpenseSource[]; value: string | null; onChange: (key: string | null) => void }) {
  const pill = (active: boolean) => cn('inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
    active ? 'border-transparent bg-accent/10 text-accent' : 'border-line bg-surface text-muted hover:text-ink');
  return (
    <div role="group" aria-label="Source" className="flex flex-wrap gap-1.5">
      <button type="button" aria-pressed={value == null} className={pill(value == null)} onClick={() => onChange(null)}>All</button>
      {sources.map(s => (
        <button key={s.key} type="button" aria-pressed={value === s.key} className={pill(value === s.key)} onClick={() => onChange(s.key)}>
          <Dot color={colorOf(s)} className="h-1.5 w-1.5" /><Name text={s.label} />
        </button>
      ))}
    </div>
  );
}

/** One source: this month's spend, last month's, and for a card its next charge and the installments left. */
function SourceCard({ s, active, onClick, fmt }: { s: ExpenseSource; active: boolean; onClick: () => void; fmt: (n: number) => string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('flex min-w-0 flex-col rounded-2xl border bg-surface px-5 py-4 text-left shadow-[0_1px_2px_rgba(20,33,61,0.04)] hover:bg-paper/60',
        active ? 'border-accent' : 'border-line')}>
      <span className="flex items-center gap-2 text-[13px] font-medium text-ink"><Dot color={colorOf(s)} /><Name text={s.label} /></span>
      <span className="mt-2 text-[22px] font-semibold leading-tight tabular-nums text-ink">{fmt(s.thisMonth)}</span>
      <span className="text-xs tabular-nums text-muted">Last month {fmt(s.lastMonth)}</span>
      {s.kind === 'card' && (
        <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs">
          <div>
            <dt className="text-muted">Next charge</dt>
            <dd className="mt-0.5 tabular-nums text-ink">{s.nextCharge ? <>{fmt(s.nextCharge.amount)} <span className="text-faint">· {shortDay(s.nextCharge.date)}</span></> : '—'}</dd>
          </div>
          <div>
            <dt className="text-muted">Installments left</dt>
            <dd className="mt-0.5 tabular-nums text-ink">
              {s.installments?.payments ? <>{fmt(s.installments.amount)} <span className="text-faint">· {s.installments.payments}</span></> : '—'}
            </dd>
          </div>
        </dl>
      )}
    </button>
  );
}

/** The rows behind a bar, a category or a merchant. */
function RowsPanel({ filter, kicker, title, onClose, fmt }: {
  filter: ExpenseFilter; kicker: string; title: string; onClose: () => void; fmt: (n: number) => string;
}) {
  const { data } = useQuery({ queryKey: ['expense-rows', filter], queryFn: () => api.expenseRows(filter) });
  const total = data?.reduce((s, r) => s + r.amount, 0);
  return (
    <SidePanel onClose={onClose} kicker={kicker} title={<bdi dir="auto">{title}</bdi>} wide
      meta={total != null && <span className="tabular-nums">{fmt(total)}</span>}>
      <div className="rounded-2xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-faint">
              <th className="px-3 py-2 pl-4 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-left font-medium">Merchant</th>
              <th className="px-3 py-2 text-left font-medium max-sm:hidden">Card</th>
              <th className="px-3 py-2 text-left font-medium max-md:hidden">Category</th>
              <th className="px-3 py-2 pr-4 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {data?.map(r => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-3 py-2.5 pl-4 text-muted">{shortDay(r.date)}</td>
                <td className="px-3 py-2.5 text-ink">
                  <bdi dir="auto">{r.merchant}</bdi>
                  <div className="text-xs text-faint sm:hidden"><Name text={r.account} /></div>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-muted max-sm:hidden"><Name text={r.account} /></td>
                <td className="px-3 py-2.5 text-muted max-md:hidden">{r.category ?? '—'}</td>
                <td className="whitespace-nowrap px-3 py-2.5 pr-4 text-right tabular-nums text-ink">
                  {fmt(r.amount)}
                  {r.installment && <div className="text-xs text-faint">{r.installment[0]}/{r.installment[1]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SidePanel>
  );
}

type Panel = { filter: ExpenseFilter; kicker: string; title: string };

export default function Expenses({ range, setRange, currency, convert }: {
  range: Range; setRange: (r: Range) => void; currency: Currency; convert: (n: number) => number;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const { data } = useQuery({ queryKey: ['expense-breakdown', range, source], queryFn: () => api.expenseBreakdown(range, source ?? undefined), placeholderData: p => p });
  if (!data) return null;
  const fmt = (n: number) => money(convert(n), currency);
  const sourceLabel = data.sources.find(s => s.key === source)?.label ?? 'All';
  const base: ExpenseFilter = source ? { source } : {};
  const rangeKicker = `${sourceLabel} · ${monthShort(data.from)} – ${monthShort(data.currentMonth)}`;
  const chart = data.months.map(m => ({ month: m.month, total: convert(m.total) }));

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.sources.map(s => (
          <SourceCard key={s.key} s={s} fmt={fmt} active={source === s.key} onClick={() => setSource(source === s.key ? null : s.key)} />
        ))}
      </div>

      <Card title="Spending" action={<RangeToggle value={range} onChange={setRange} />}>
        <SourcePills sources={data.sources} value={source} onChange={setSource} />
        <div className="mt-4 text-[28px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{fmt(data.total)}</div>
        <ChartContainer config={spendConfig} className="-mx-1 mt-4 aspect-auto h-48" initialDimension={{ width: 720, height: 192 }}>
          <BarChart data={chart} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            onClick={(e: { activeLabel?: string | number } | null) => {
              const m = e?.activeLabel != null ? String(e.activeLabel) : null;
              if (m) setPanel({ filter: { ...base, month: m }, kicker: sourceLabel, title: monthLong(m) });
            }}>
            <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: 'var(--color-faint)' }} minTickGap={6} />
            <ChartTooltip cursor={{ fill: 'rgba(22,33,62,0.04)' }}
              content={({ active, payload, label }) => active && payload?.length ? (
                <div className="rounded-xl border border-line bg-surface/95 px-3 py-2 text-xs shadow-lg">
                  <div className="text-muted">{monthLong(String(label))}</div>
                  <div className="mt-0.5 tabular-nums text-ink">{money(Number(payload[0].value), currency)}</div>
                </div>
              ) : null} />
            <Bar dataKey="total" radius={[5, 5, 5, 5]} maxBarSize={28} className="cursor-pointer" isAnimationActive={false}>
              {chart.map(m => <Cell key={m.month} fill={m.month === data.currentMonth ? 'var(--color-accent)' : '#dfe4ee'} />)}
            </Bar>
          </BarChart>
        </ChartContainer>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Top categories">
          {data.categories.length
            ? <BarList items={data.categories} format={fmt}
              onSelect={c => setPanel({ filter: { ...base, range, category: c.key }, kicker: rangeKicker, title: c.name })} />
            : <p className="text-sm text-faint">None</p>}
        </Card>
        <Card title="Top merchants">
          {data.merchants.length
            ? <BarList items={data.merchants} format={fmt}
              onSelect={m => setPanel({ filter: { ...base, range, merchant: m.key }, kicker: rangeKicker, title: m.name })} />
            : <p className="text-sm text-faint">None</p>}
        </Card>
      </div>

      {panel && <RowsPanel {...panel} fmt={fmt} onClose={() => setPanel(null)} />}
    </div>
  );
}
