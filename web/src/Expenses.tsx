import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, Cell, XAxis } from 'recharts';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { api, type ExpenseCategory, type ExpenseFilter, type ExpenseSource, type Range } from './api';
import { compact, money, monthLong, monthShort, shortDay, type Currency } from './format';
import { OTHER, PALETTE, SOURCE_OTHER, sourceColor } from './colors';
import { BarList, Card, Dot, Name, SidePanel } from './ui';
import { cn } from '@/lib/utils';

/** A card's source colour; spend paid from the bank accounts is neutral. */
const colorOf = (s: ExpenseSource) => (s.kind === 'card' ? sourceColor(s.key) : SOURCE_OTHER);

const spendConfig = { total: { label: 'Spent' } } satisfies ChartConfig;

/** One source: the month's spend, the month before's, and for a card its next charge and the installments left. */
function SourceCard({ s, prev, active, onClick, fmt }: { s: ExpenseSource; prev: string; active: boolean; onClick: () => void; fmt: (n: number) => string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn('flex min-w-0 flex-col rounded-2xl border bg-surface px-5 py-4 text-left shadow-[0_1px_2px_rgba(20,33,61,0.04)] hover:bg-paper/60',
        active ? 'border-accent' : 'border-line')}>
      <span className="flex items-center gap-2 text-[13px] font-medium text-ink"><Dot color={colorOf(s)} /><Name text={s.label} /></span>
      <span className="mt-2 text-[22px] font-semibold leading-tight tabular-nums text-ink">{fmt(s.spent)}</span>
      <span className="text-xs tabular-nums text-muted">{monthShort(prev)} {fmt(s.previous)}</span>
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
function RowsPanel({ filter, kicker, title, onClose, fmt, byMerchant = false }: {
  filter: ExpenseFilter; kicker: string; title: string; onClose: () => void; fmt: (n: number) => string; byMerchant?: boolean;
}) {
  const { data } = useQuery({ queryKey: ['expense-rows', filter], queryFn: () => api.expenseRows(filter) });
  const total = data?.reduce((s, r) => s + r.amount, 0);
  const merchants = new Map<string, { key: string; name: string; total: number }>();
  if (byMerchant) for (const r of data ?? []) {
    const m = merchants.get(r.merchantKey) ?? { key: r.merchantKey, name: r.merchant, total: 0 };
    m.total += r.amount;
    merchants.set(r.merchantKey, m);
  }
  const ranked = [...merchants.values()].filter(m => m.total > 0).sort((a, b) => b.total - a.total);
  return (
    <SidePanel onClose={onClose} kicker={kicker} title={<bdi dir="auto">{title}</bdi>} wide
      meta={total != null && <span className="tabular-nums">{fmt(total)}</span>}>
      {ranked.length > 0 && (
        <div className="mb-4 rounded-2xl border border-line bg-surface px-4 py-3">
          <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Merchants</h3>
          <BarList items={ranked} format={fmt} />
        </div>
      )}
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

/** Every category of the month: amount, share of the month, a thin bar, and the change from the month before. */
function CategoryList({ items, format, delta, onSelect }: {
  items: ExpenseCategory[]; format: (n: number) => string; delta: (n: number) => string; onSelect: (c: ExpenseCategory) => void;
}) {
  const top = items[0]?.total || 1;
  return (
    <ol className="space-y-0.5 text-sm">
      {items.map((c, i) => {
        const diff = c.total - c.previous;
        return (
          <li key={c.key}>
            <button type="button" onClick={() => onSelect(c)}
              className="-mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-paper">
              <span className="min-w-0 flex-1 truncate text-ink"><bdi dir="auto">{c.name}</bdi></span>
              <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line max-sm:hidden lg:w-20 xl:w-24">
                <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (c.total / top) * 100)}%`, background: c.key === 'none' ? OTHER : PALETTE[i % PALETTE.length] }} />
              </span>
              <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">{Math.round(c.share)}%</span>
              <span className={cn('w-16 shrink-0 text-right text-xs tabular-nums', Math.abs(diff) < 1 ? 'text-faint' : diff > 0 ? 'text-down' : 'text-up')}>
                {Math.abs(diff) < 1 ? '–' : `${diff > 0 ? '▲' : '▼'} ${delta(Math.abs(diff))}`}
              </span>
              <span className="w-20 shrink-0 text-right tabular-nums text-ink">{format(c.total)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const MONTH = /^\d{4}-\d{2}$/;
const monthFromUrl = () => {
  const m = new URLSearchParams(window.location.search).get('month');
  return m && MONTH.test(m) ? m : null;
};
const prevOf = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

type Panel = { filter: ExpenseFilter; kicker: string; title: string; byMerchant?: boolean };

export default function Expenses({ range, setRange, currency, convert }: {
  range: Range; setRange: (r: Range) => void; currency: Currency; convert: (n: number) => number;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [month, setMonthState] = useState<string | null>(monthFromUrl);
  const [panel, setPanel] = useState<Panel | null>(null);
  useEffect(() => {
    const onPop = () => setMonthState(monthFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const setMonth = (m: string) => {
    setMonthState(m);
    window.history.replaceState(null, '', `${window.location.pathname}?month=${m}`);
  };
  const { data } = useQuery({
    queryKey: ['expense-breakdown', month, source],
    // the bars always cover the last 12 months; the month is picked by clicking one
    queryFn: () => api.expenseBreakdown('1Y', month, source ?? undefined), placeholderData: p => p,
  });
  if (!data) return null;
  const fmt = (n: number) => money(convert(n), currency);
  const delta = (n: number) => (convert(n) < 1000 ? fmt(n) : compact(convert(n), currency));
  const sourceLabel = data.sources.find(s => s.key === source)?.label ?? 'All';
  const selected = data.month;
  const base: ExpenseFilter = { ...(source ? { source } : {}), month: selected };
  const kicker = `${sourceLabel} · ${monthLong(selected)}`;
  const chart = data.bars.map(m => ({ month: m.month, total: convert(m.total) }));

  return (
    <div className="space-y-5">
      <Card title="Last 12 months" action={<span className="text-sm text-muted">{monthLong(selected)} · <span className="font-semibold tabular-nums text-ink">{fmt(data.monthTotal)}</span></span>}>
        <ChartContainer config={spendConfig} className="-mx-1 mt-2 aspect-auto h-48" initialDimension={{ width: 720, height: 192 }}>
          <BarChart data={chart} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            onClick={(e: { activeLabel?: string | number } | null) => {
              const m = e?.activeLabel != null ? String(e.activeLabel) : null;
              if (m) setMonth(m);
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
              {chart.map(m => <Cell key={m.month} fill={m.month === selected ? 'var(--color-accent)' : '#dfe4ee'} />)}
            </Bar>
          </BarChart>
        </ChartContainer>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.sources.map(s => (
          <SourceCard key={s.key} s={s} prev={prevOf(selected)} fmt={fmt} active={source === s.key} onClick={() => setSource(source === s.key ? null : s.key)} />
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Categories">
          {data.categories.length
            ? <CategoryList items={data.categories} format={fmt} delta={delta}
              onSelect={c => setPanel({ filter: { ...base, category: c.key }, kicker, title: c.name, byMerchant: true })} />
            : <p className="text-sm text-faint">None</p>}
        </Card>
        <Card title="Top merchants">
          {data.merchants.length
            ? <BarList items={data.merchants} format={fmt}
              onSelect={m => setPanel({ filter: { ...base, merchant: m.key }, kicker, title: m.name })} />
            : <p className="text-sm text-faint">None</p>}
        </Card>
      </div>

      {panel && <RowsPanel {...panel} fmt={fmt} onClose={() => setPanel(null)} />}
    </div>
  );
}
