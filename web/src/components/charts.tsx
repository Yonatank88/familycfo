import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { ForecastEvent, ForecastPoint } from '../api';
import { day, money } from '../format';
import { cn } from '@/lib/utils';
import { CHART_COLORS } from '@/lib/visuals';

const axis = { fontSize: 11, fill: 'var(--muted-foreground)' };
const EASE = 'ease-out' as const;
export const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 100_000) return `${Math.round(n / 1000)}K`;
  if (a >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
};

/** Shared tooltip card for every chart. */
function TooltipCard({ title, rows, footer }: { title?: ReactNode; rows: { label: ReactNode; value: ReactNode; color?: string }[]; footer?: ReactNode }) {
  return (
    <div dir="rtl" className="min-w-40 max-w-72 rounded-xl border bg-popover/95 px-3 py-2.5 text-xs leading-5 shadow-(--shadow-overlay) backdrop-blur">
      {title && <div className="mb-1 font-semibold">{title}</div>}
      <div className="space-y-0.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {r.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />}
              {r.label}
            </span>
            <span className="num font-medium">{r.value}</span>
          </div>
        ))}
      </div>
      {footer && <div className="mt-1.5 border-t pt-1.5 text-muted-foreground">{footer}</div>}
    </div>
  );
}

/** Scheduled items (salary, card charges, loans...) per date. */
export function eventsByDate(events: ForecastEvent[]): Map<string, ForecastEvent[]> {
  const byDate = new Map<string, ForecastEvent[]>();
  for (const e of events) if (e.source !== 'dynamic') byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  return byDate;
}

/**
 * Projected balance with a low/high band, the buffer line, and markers on days with scheduled
 * items. Hover a day to see what's charged / paid in; click it to pin it (onSelectDate).
 */
export function ForecastChart({ points, buffer, events = [], height = 260, lowest, dailyRate = 0, selectedDate, onSelectDate }: {
  points: ForecastPoint[]; buffer: number; events?: ForecastEvent[]; height?: number; lowest?: { date: string; amount: number };
  dailyRate?: number; selectedDate?: string | null; onSelectDate?: (date: string | null) => void;
}) {
  const id = useId().replace(/:/g, '');
  const data = points.map(p => ({ ...p, band: [p.low, p.high] as [number, number] }));
  const byDate = eventsByDate(events);
  return (
    <div dir="ltr" style={{ height }} className={onSelectDate ? 'cursor-pointer' : ''}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
          onClick={state => {
            const label = (state as { activeLabel?: string | number } | null)?.activeLabel;
            if (onSelectDate && label != null) onSelectDate(String(label) === selectedDate ? null : String(label));
          }}>
          <defs>
            <linearGradient id={`fc-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="date" tick={axis} tickFormatter={d => day(d)} minTickGap={24} axisLine={false} tickLine={false} />
          <YAxis tick={axis} tickFormatter={compact} width={44} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ stroke: 'var(--chart-1)', strokeOpacity: 0.35, strokeDasharray: '3 3' }}
            content={({ active, label }) => active && label != null
              ? <DayTooltip date={String(label)} point={points.find(p => p.date === String(label))} events={byDate.get(String(label)) ?? []} dailyRate={dailyRate} />
              : null} />
          <Area type="monotone" dataKey="band" stroke="none" fill="var(--chart-1)" fillOpacity={0.08} isAnimationActive={false} name="band" />
          <Area type="monotone" dataKey="expected" stroke="none" fill={`url(#fc-${id})`} animationDuration={900} animationEasing={EASE} />
          <Line type="monotone" dataKey="expected" stroke="var(--chart-1)" strokeWidth={2.5} animationDuration={900} animationEasing={EASE} name="צפוי"
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }}
            dot={(props: { cx?: number; cy?: number; payload?: { date: string } }) => {
              const evs = props.payload ? byDate.get(props.payload.date) : undefined;
              if (!evs || props.cx == null || props.cy == null) return <g key={`${props.payload?.date}-none`} />;
              const net = evs.reduce((s, e) => s + e.amount, 0);
              return <circle key={props.payload!.date} cx={props.cx} cy={props.cy} r={4.5} fill={net >= 0 ? 'var(--positive)' : 'var(--negative)'} stroke="var(--card)" strokeWidth={2} />;
            }} />
          <ReferenceLine y={buffer} stroke="var(--chart-3)" strokeDasharray="5 4" label={{ value: 'כרית', position: 'insideTopLeft', fontSize: 11, fill: 'var(--chart-3)' }} />
          <ReferenceLine y={0} stroke="var(--negative)" strokeOpacity={0.45} />
          {selectedDate && <ReferenceLine x={selectedDate} stroke="var(--chart-1)" strokeWidth={2} />}
          {lowest && <ReferenceDot x={lowest.date} y={lowest.amount} r={6} fill="var(--negative)" stroke="var(--card)" strokeWidth={2} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function DayTooltip({ date, point, events, dailyRate }: { date: string; point?: ForecastPoint; events: ForecastEvent[]; dailyRate: number }) {
  return (
    <TooltipCard
      title={<>{day(date)}{point && <span className="ms-2 font-normal text-muted-foreground">יתרה צפויה <span className="num font-semibold text-foreground">{money(point.expected)}</span></span>}</>}
      rows={events.length
        ? events.map(e => ({ label: `${e.name}${e.estimated ? ' ~' : ''}`, value: <span className={e.amount < 0 ? 'text-negative' : 'text-positive'}>{money(e.amount)}</span>, color: e.amount < 0 ? 'var(--negative)' : 'var(--positive)' }))
        : [{ label: <span className="text-muted-foreground">אין חיובים מתוכננים ביום הזה</span>, value: '' }]}
      footer={<>{dailyRate > 0 && <div>+ שוטף משוער ~{money(dailyRate)} ליום</div>}<div className="text-[10px]">לחצו על היום לפירוט</div></>} />
  );
}

/** Income vs fixed + variable per cycle, with gradients and a net line. */
export function CashflowBars({ data, height = 260 }: { data: { label: string; income: number; fixed: number; dynamic: number }[]; height?: number }) {
  const id = useId().replace(/:/g, '');
  const rows = data.map(d => ({ ...d, net: d.income - d.fixed - d.dynamic }));
  const series = [
    { key: 'income', name: 'הכנסות', color: 'var(--chart-2)' },
    { key: 'fixed', name: 'קבועות', color: 'var(--chart-1)' },
    { key: 'dynamic', name: 'משתנות', color: 'var(--chart-3)' },
  ];
  return (
    <div>
      <Legend items={[...series.map(s => ({ label: s.name, color: s.color })), { label: 'נטו', color: 'var(--chart-4)', line: true }]} />
      <div dir="ltr" style={{ height }}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 10, right: 10, bottom: 0, left: 0 }} barGap={3}>
            <defs>
              {series.map(s => (
                <linearGradient key={s.key} id={`cf-${s.key}-${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={1} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.55} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="label" tick={axis} axisLine={false} tickLine={false} />
            <YAxis tick={axis} tickFormatter={compact} width={44} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ fill: 'var(--accent)', opacity: 0.5 }}
              content={({ active, payload, label }) => active && payload?.length ? (
                <TooltipCard title={label as string}
                  rows={series.map(s => ({ label: s.name, value: money(Number(payload.find(p => p.dataKey === s.key)?.value ?? 0)), color: s.color }))}
                  footer={<span>נטו <span className="num font-semibold text-foreground">{money(Number(payload[0].payload.net))}</span></span>} />
              ) : null} />
            <Bar dataKey="income" name="הכנסות" fill={`url(#cf-income-${id})`} radius={[6, 6, 0, 0]} maxBarSize={28} animationDuration={800} animationEasing={EASE} />
            <Bar dataKey="fixed" name="קבועות" stackId="out" fill={`url(#cf-fixed-${id})`} maxBarSize={28} animationDuration={800} animationEasing={EASE} />
            <Bar dataKey="dynamic" name="משתנות" stackId="out" fill={`url(#cf-dynamic-${id})`} radius={[6, 6, 0, 0]} maxBarSize={28} animationDuration={800} animationEasing={EASE} />
            <Line dataKey="net" type="monotone" stroke="var(--chart-4)" strokeWidth={2} dot={{ r: 3, fill: 'var(--card)', strokeWidth: 2 }} animationDuration={900} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** A value over time as a soft gradient area. */
export function SimpleLine({ data, dataKey, height = 200, color = 'var(--chart-1)', xKey = 'date', formatX, valueLabel = 'שווי' }: {
  data: Record<string, unknown>[]; dataKey: string; height?: number; color?: string; xKey?: string; formatX?: (v: string) => string; valueLabel?: string;
}) {
  const id = useId().replace(/:/g, '');
  return (
    <div dir="ltr" style={{ height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`sl-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey={xKey} tick={axis} axisLine={false} tickLine={false} tickFormatter={formatX} minTickGap={20} />
          <YAxis tick={axis} tickFormatter={compact} width={50} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ stroke: color, strokeOpacity: 0.35 }}
            content={({ active, payload, label }) => active && payload?.length
              ? <TooltipCard title={formatX ? formatX(String(label)) : String(label)} rows={[{ label: valueLabel, value: money(Number(payload[0].value)), color }]} /> : null} />
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2.5} fill={`url(#sl-${id})`}
            dot={{ r: 2.5, fill: 'var(--card)', strokeWidth: 2 }} activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }} animationDuration={900} animationEasing={EASE} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Tiny trend line for KPI cards. */
export function Sparkline({ data, color = 'var(--chart-1)', className }: { data: number[]; color?: string; className?: string }) {
  const id = useId().replace(/:/g, '');
  const rows = data.map((v, i) => ({ i, v }));
  return (
    <div dir="ltr" className={cn('pointer-events-none', className)} aria-hidden>
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 2, right: 1, bottom: 2, left: 1 }}>
          <defs>
            <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#sp-${id})`} dot={false} animationDuration={1100} animationEasing={EASE} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Legend({ items, className }: { items: { label: ReactNode; color: string; line?: boolean; value?: ReactNode }[]; className?: string }) {
  return (
    <div className={cn('mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground', className)}>
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <span className={cn('shrink-0', it.line ? 'h-0.5 w-3 rounded-full' : 'h-2.5 w-2.5 rounded-[3px]')} style={{ background: it.color }} />
          {it.label}{it.value != null && <span className="num font-medium text-foreground">{it.value}</span>}
        </span>
      ))}
    </div>
  );
}

export interface Slice { key: string; name: string; value: number; color?: string; href?: string; icon?: ReactNode }

/**
 * Donut with the total in the middle and a ranked legend beside it. Hovering a slice or a legend
 * row highlights both.
 */
export function DonutChart({ data, centerLabel, height = 220, max = 7, otherLabel = 'אחר' }: {
  data: Slice[]; centerLabel?: string; height?: number; max?: number; otherLabel?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const sorted = [...data].filter(d => d.value > 0).sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, max);
  const rest = sorted.slice(max);
  const slices = [...top, ...(rest.length ? [{ key: '_other', name: otherLabel, value: rest.reduce((s, d) => s + d.value, 0), color: 'var(--muted-foreground)' }] : [])]
    .map((d, i) => ({ ...d, color: d.color ?? CHART_COLORS[i % CHART_COLORS.length] }));
  const total = slices.reduce((s, d) => s + d.value, 0);
  const shown = active != null ? slices[active] : null;
  if (!total) return null;

  return (
    <div className="@container"><div className="grid items-center gap-4 @lg:grid-cols-[minmax(0,12rem)_1fr]">
      <div dir="ltr" className="relative mx-auto aspect-square w-full max-w-52" style={{ maxHeight: height }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="92%" paddingAngle={2} cornerRadius={4}
              stroke="var(--card)" strokeWidth={2} startAngle={90} endAngle={-270} animationDuration={900} animationEasing={EASE}
              onMouseEnter={(_, i) => setActive(i)} onMouseLeave={() => setActive(null)}>
              {slices.map((s, i) => <Cell key={s.key} fill={s.color} fillOpacity={active == null || active === i ? 1 : 0.28}
                style={{ transition: 'fill-opacity 180ms ease-out' }} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center" dir="rtl">
          <span className="max-w-[70%] truncate text-[11px] text-muted-foreground">{shown ? shown.name : centerLabel ?? 'סה״כ'}</span>
          <span className="num text-lg font-bold tracking-tight">{money(shown ? shown.value : total)}</span>
          {shown && <span className="num text-[11px] font-medium text-muted-foreground">{Math.round((shown.value / total) * 100)}%</span>}
        </div>
      </div>
      <ul className="min-w-0 space-y-0.5 text-sm">
        {slices.map((s, i) => {
          const row = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
              {s.icon && <span className="shrink-0 text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">{s.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="num text-xs text-muted-foreground">{Math.round((s.value / total) * 100)}%</span>
              <span className="num w-20 text-end font-medium">{money(s.value)}</span>
            </>
          );
          const cls = cn('flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors', active === i ? 'bg-accent' : 'hover:bg-accent/60');
          return (
            <li key={s.key} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
              {s.href ? <Link to={s.href} className={cls}>{row}</Link> : <div className={cls}>{row}</div>}
            </li>
          );
        })}
      </ul>
    </div></div>
  );
}

/** Ranked horizontal bars that grow in — "top N" lists. */
export function BarList({ items, format = money, color = 'var(--chart-1)' }: {
  items: { key: string; label: ReactNode; value: number; color?: string; icon?: ReactNode; href?: string; sub?: ReactNode }[];
  format?: (n: number) => string; color?: string;
}) {
  const max = Math.max(1, ...items.map(i => Math.abs(i.value)));
  return (
    <ul className="space-y-1">
      {items.map((it, i) => {
        const body = (
          <>
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                {it.icon && <span className="icon-tile h-6 w-6 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5" style={{ ['--tile' as string]: it.color ?? color }}>{it.icon}</span>}
                <span className="truncate">{it.label}</span>
                {it.sub && <span className="shrink-0 text-xs text-muted-foreground">{it.sub}</span>}
              </span>
              <span className="num shrink-0 font-medium">{format(it.value)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <motion.div className="h-full rounded-full" style={{ background: `linear-gradient(to left, ${it.color ?? color}, color-mix(in oklab, ${it.color ?? color} 55%, white))` }}
                initial={{ width: 0 }} animate={{ width: `${(Math.abs(it.value) / max) * 100}%` }}
                transition={{ duration: 0.8, delay: 0.1 + i * 0.05, ease: [0.22, 1, 0.36, 1] }} />
            </div>
          </>
        );
        return (
          <li key={it.key}>
            {it.href
              ? <Link to={it.href} className="-mx-2 block rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/60">{body}</Link>
              : <div className="py-1.5">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** Ring gauge (e.g. budget used). */
export function Gauge({ value, max, label, sub, size = 132, status }: { value: number; max: number; label?: ReactNode; sub?: ReactNode; size?: number; status?: 'ok' | 'warning' | 'over' }) {
  const pctv = max > 0 ? Math.min(1, value / max) : 0;
  const r = 44, c = 2 * Math.PI * r;
  const color = status === 'over' ? 'var(--negative)' : status === 'warning' ? 'var(--chart-3)' : 'var(--chart-1)';
  const id = useId().replace(/:/g, '');
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(pctv * 100)}%`}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden>
        <defs>
          <linearGradient id={`g-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor="var(--chart-5)" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--muted)" strokeWidth="9" />
        <motion.circle cx="50" cy="50" r={r} fill="none" stroke={status === 'ok' || !status ? `url(#g-${id})` : color} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - pctv) }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="num text-xl font-bold tracking-tight">{Math.round(pctv * 100)}%</span>
        {label && <span className="text-[11px] text-muted-foreground">{label}</span>}
        {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}

/** Simple column chart (one series). */
export function Columns({ data, height = 180, color = 'var(--chart-1)', format = money, highlightLast, valueLabel = 'סכום' }: {
  data: { label: string; value: number }[]; height?: number; color?: string; format?: (n: number) => string; highlightLast?: boolean; valueLabel?: string;
}) {
  const id = useId().replace(/:/g, '');
  return (
    <div dir="ltr" style={{ height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 6, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`col-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={1} />
              <stop offset="100%" stopColor={color} stopOpacity={0.45} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 4" vertical={false} />
          <XAxis dataKey="label" tick={axis} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
          <YAxis tick={axis} tickFormatter={compact} width={40} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: 'var(--accent)', opacity: 0.5 }}
            content={({ active, payload, label }) => active && payload?.length
              ? <TooltipCard title={String(label)} rows={[{ label: valueLabel, value: format(Number(payload[0].value)), color }]} /> : null} />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={34} animationDuration={800} animationEasing={EASE}>
            {data.map((_, i) => <Cell key={i} fill={highlightLast && i === data.length - 1 ? 'var(--chart-6)' : `url(#col-${id})`} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Stacked monthly columns, one colour per series (a category), with an optional average line.
 * Clicking a segment or a legend item calls onPick with that series' key (drill down).
 */
export function StackedColumns({ data, series, height = 300, average, onPick }: {
  data: Record<string, number | string>[]; series: { key: string; name: string; color: string }[]; height?: number;
  /** a dashed reference line (e.g. the monthly average of a single category) */
  average?: number; onPick?: (key: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
        {series.map(s => (
          <button key={s.key} type="button" disabled={!onPick}
            className={cn('flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors', onPick && 'hover:bg-accent hover:text-foreground', active === s.key && 'bg-accent text-foreground')}
            onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)} onClick={() => onPick?.(s.key)}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />{s.name}
          </button>
        ))}
        {average != null && <span className="flex items-center gap-1.5 px-1.5 text-muted-foreground"><span className="h-0 w-4 border-t-2 border-dashed border-[var(--chart-4)]" />ממוצע</span>}
      </div>
      <div dir="ltr" style={{ height }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 4" vertical={false} />
            <XAxis dataKey="label" tick={axis} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={6} />
            <YAxis tick={axis} tickFormatter={compact} width={44} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ fill: 'var(--accent)', opacity: 0.5 }}
              content={({ active: on, payload, label }) => {
                if (!on || !payload?.length) return null;
                const row = payload[0].payload as Record<string, number | string>;
                const rows = [...series].reverse().filter(s => Number(row[s.key] ?? 0) > 0)
                  .map(s => ({ label: s.name, value: money(Number(row[s.key])), color: s.color }));
                const total = series.reduce((sum, s) => sum + Number(row[s.key] ?? 0), 0);
                return <TooltipCard title={`${label}${row.partial ? ' (עד היום)' : ''}`} rows={rows}
                  footer={series.length > 1 ? <span>סה״כ <span className="num font-semibold text-foreground">{money(total)}</span></span> : undefined} />;
              }} />
            {average != null && average > 0 && <ReferenceLine y={average} stroke="var(--chart-4)" strokeDasharray="5 4" strokeWidth={1.5} />}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.name} stackId="s" fill={s.color} maxBarSize={38}
                fillOpacity={active == null || active === s.key ? 1 : 0.3}
                radius={i === series.length - 1 ? [6, 6, 0, 0] : 0} animationDuration={700} animationEasing={EASE}
                cursor={onPick ? 'pointer' : undefined} onClick={() => onPick?.(s.key)}
                onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
