import type { ReactNode } from 'react';
import { ArrowDown, ArrowDownRight, ArrowUp, ArrowUpRight, ChevronRight } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Range } from './api';
import { OTHER, PALETTE } from './colors';

/** "••1234": the last 4 digits of an account number — the only way one is shown. */
export const mask = (last4: string | null | undefined) => {
  const digits = String(last4 ?? '').replace(/\D/g, '');
  return digits ? `••${digits.slice(-4)}` : '';
};

/**
 * A name from the data (Hebrew or English) in its own direction. A server label "⁨name⁩ ••1234" (the name in a bidi
 * isolate, then the ••last4 suffix) renders the name isolated and the suffix after it, so a Hebrew name can't pull
 * the suffix to its left.
 */
export function Name({ text }: { text: string }) {
  const m = text.match(/^\u2068([\s\S]*)\u2069(\s+\S+)$/);
  return m ? <span><bdi>{m[1]}</bdi>{m[2]}</span> : <bdi>{text}</bdi>;
}

/** Parts joined by " · ", each in its own direction (a Hebrew owner can't reorder its neighbours). */
export function Parts({ parts }: { parts: (string | null | undefined)[] }) {
  return <>{parts.filter(Boolean).map((p, i) => <span key={i}>{i > 0 && ' · '}<bdi>{p}</bdi></span>)}</>;
}

/** A rounded card: title top-left, an optional quiet action top-right. */
export function Card({ title, action, children, className = '', flush = false }: {
  title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(20,33,61,0.04)]', className)}>
      <header className="flex min-h-12 items-center justify-between gap-3 px-5 pt-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {action}
      </header>
      <div className={cn('flex-1', flush ? 'pb-2' : 'px-5 pb-5')}>{children}</div>
    </section>
  );
}

export function CardLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="-mr-2 flex min-h-9 items-center gap-0.5 rounded-lg px-2 text-[13px] text-muted hover:text-accent">
      {children}<ChevronRight className="size-3.5" />
    </button>
  );
}

/**
 * A ranked list with proportional bars (top merchants, top categories): name, bar, amount. Each row opens `onSelect`
 * when given; the "none" key (uncategorised) is grey.
 */
export function BarList({ items, format, onSelect }: {
  items: { key: string; name: string; total: number }[]; format: (n: number) => string; onSelect?: (item: { key: string; name: string }) => void;
}) {
  const top = items[0]?.total || 1;
  return (
    <ol className="space-y-0.5 text-sm">
      {items.map((m, i) => {
        const inner = (
          <>
            <span className="min-w-0 flex-1 truncate text-ink"><bdi dir="auto">{m.name}</bdi></span>
            <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-line sm:w-28">
              <span className="block h-full rounded-full" style={{ width: `${Math.max(4, (m.total / top) * 100)}%`, background: m.key === 'none' ? OTHER : PALETTE[i % PALETTE.length] }} />
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums text-ink">{format(m.total)}</span>
          </>
        );
        const row = '-mx-2 flex min-h-9 w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-1.5 text-left';
        return (
          <li key={m.key}>
            {onSelect
              ? <button type="button" onClick={() => onSelect({ key: m.key, name: m.name })} className={cn(row, 'hover:bg-paper')}>{inner}</button>
              : <div className={row}>{inner}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** A single-choice segmented control (Radix ToggleGroup): never empty, arrow keys move between options. */
export function Segmented<T extends string>({ value, options, onChange, disabled, label, size = 'sm' }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: (v: T) => boolean; label: string; size?: 'sm' | 'xs';
}) {
  return (
    <ToggleGroup type="single" value={value} aria-label={label} spacing={1}
      onValueChange={v => { if (v) onChange(v as T); }}>
      {options.map(o => (
        <ToggleGroupItem key={o.value} value={o.value} disabled={disabled?.(o.value)} aria-label={o.label}
          className={cn('min-h-9 rounded-md px-2.5 font-medium text-muted data-[state=on]:text-accent',
            size === 'xs' ? 'h-9 text-[11px]' : 'h-9 text-xs')}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];

/** The page's range (1M 3M YTD 1Y ALL) — shared by every page. */
export function RangeToggle({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return <Segmented label="Range" value={value} onChange={onChange} options={RANGES.map(r => ({ value: r, label: r.toUpperCase() }))} />;
}

/** A small coloured change chip: green when the move is good, red when bad. Nothing when there is no change. */
export function ChangeChip({ pct, goodWhenUp = true }: { pct: number | null | undefined; goodWhenUp?: boolean }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const up = pct > 0;
  const good = pct === 0 ? null : up === goodWhenUp;
  const cls = good == null ? 'bg-ink/[0.04] text-muted' : good ? 'bg-up/10 text-up' : 'bg-down/10 text-down';
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${cls}`}>
      {pct !== 0 && <Arrow className="size-3" />}{Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** A coloured type tag (only top-level types get colour). */
export function Tag({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      {children}
    </span>
  );
}

/** A small neutral grey tag: a sub-type (Pension, Study fund…). */
export function SubTag({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded bg-ink/[0.05] px-1.5 py-px text-[10.5px] font-medium text-muted">{children}</span>;
}

export const Dot = ({ color, className = '' }: { color: string; className?: string }) => (
  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`} style={{ background: color }} />
);

/** A hover/focus tooltip on any element (replaces title=). */
export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  if (content == null || content === '') return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-80 break-words">{content}</TooltipContent>
    </Tooltip>
  );
}

/** The stale marker: an amber dot, its last successful sync in a tooltip. */
export function StaleDot({ lastSuccess }: { lastSuccess: string }) {
  return (
    <Tip content={`Last successful sync: ${lastSuccess}`}>
      <span tabIndex={0} aria-label="Stale" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
    </Tip>
  );
}

/** A right-hand side panel (Radix Dialog: focus trap, Esc, focus returns): a kicker, a title, the body, a footer. */
export function SidePanel({ open = true, onClose, kicker, title, meta, children, footer, wide = false }: {
  open?: boolean; onClose: () => void; kicker?: ReactNode; title: ReactNode; meta?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={o => { if (!o) onClose(); }}>
      {/* focus the panel itself on open, not its first button (which may be Delete) */}
      <SheetContent className={cn('w-full gap-0 border-line bg-paper p-0 outline-none sm:max-w-xl', wide && 'sm:max-w-2xl')}
        onOpenAutoFocus={e => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}>
        <div className="px-6 pb-4 pr-12 pt-6">
          <SheetDescription className="truncate text-xs text-muted">{kicker}</SheetDescription>
          <SheetTitle className="mt-0.5 text-lg font-semibold tracking-tight text-ink">{title}</SheetTitle>
          {meta && <div className="mt-1 text-sm text-muted">{meta}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-3 text-xs">{footer}</div>}
      </SheetContent>
    </Sheet>
  );
}

export const button = 'inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-paper disabled:opacity-50';
export const primaryButton = 'inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50';

/** A sortable column header (TanStack Table): the label, and an arrow when sorted. */
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
