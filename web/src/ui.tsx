import type { ReactNode, SVGProps } from 'react';

/** A rounded card: title top-left, an optional quiet action top-right. */
export function Card({ title, action, children, className = '', flush = false }: {
  title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(20,33,61,0.04)] ${className}`}>
      <header className="flex min-h-12 items-center justify-between gap-3 px-5 pt-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {action}
      </header>
      <div className={`flex-1 ${flush ? 'pb-2' : 'px-5 pb-5'}`}>{children}</div>
    </section>
  );
}

export function CardLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-0.5 text-[13px] text-muted hover:text-accent">
      {children}<ChevronRight className="h-3.5 w-3.5" />
    </button>
  );
}

export function Pills<T extends string>({ value, options, onChange, disabled, size = 'sm' }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: (v: T) => boolean; size?: 'sm' | 'xs';
}) {
  return (
    <div className={`inline-flex gap-0.5 ${size === 'xs' ? 'text-[11px]' : 'text-xs'}`}>
      {options.map(o => (
        <button key={o.value} type="button" disabled={disabled?.(o.value)} onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 font-medium transition-colors disabled:opacity-40 ${
            o.value === value ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A small coloured change chip: green when the move is good, red when bad. */
export function ChangeChip({ pct, goodWhenUp = true }: { pct: number | null | undefined; goodWhenUp?: boolean }) {
  if (pct == null || !Number.isFinite(pct)) return <span className="inline-flex rounded-md bg-ink/[0.04] px-1.5 py-0.5 text-xs text-faint">—</span>;
  const up = pct > 0;
  const good = pct === 0 ? null : up === goodWhenUp;
  const cls = good == null ? 'bg-ink/[0.04] text-muted' : good ? 'bg-up/10 text-up' : 'bg-down/10 text-down';
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${cls}`}>
      {pct !== 0 && <Arrow className="h-3 w-3" />}{Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** A coloured category tag, like Copilot's. */
export function Tag({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
      {children}
    </span>
  );
}

export const Dot = ({ color, className = '' }: { color: string; className?: string }) => (
  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`} style={{ background: color }} />
);

export function Panel({ onClose, children, wide = false }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-ink/20" onClick={onClose}>
      <aside className={`flex h-full w-full flex-col border-l border-line bg-paper shadow-xl ${wide ? 'max-w-2xl' : 'max-w-xl'}`}
        onClick={e => e.stopPropagation()}>
        {children}
      </aside>
    </div>
  );
}

export const button = 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink shadow-sm hover:bg-paper disabled:opacity-50';
export const primaryButton = 'inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50';

// ---- line icons (lucide-style, 24px grid, currentColor) ----

const icon = (paths: ReactNode) => (props: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
    {paths}
  </svg>
);
export const ChevronRight = icon(<path d="m9 18 6-6-6-6" />);
export const ChevronDown = icon(<path d="m6 9 6 6 6-6" />);
export const ArrowUpRight = icon(<path d="M7 17 17 7M8 7h9v9" />);
export const ArrowDownRight = icon(<path d="M7 7l10 10M17 8v9H8" />);
export const LayoutIcon = icon(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>);
export const PlugIcon = icon(<><path d="M12 22v-5M9 8V2M15 8V2" /><path d="M18 8v5a6 6 0 0 1-12 0V8z" /></>);
export const MenuIcon = icon(<path d="M4 6h16M4 12h16M4 18h16" />);
export const CloseIcon = icon(<path d="M18 6 6 18M6 6l12 12" />);
export const RefreshIcon = icon(<><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>);
export const UploadIcon = icon(<><path d="M12 15V3M7 8l5-5 5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></>);
export const LogoIcon = icon(<><path d="M3 20h18" /><path d="M6 16v-5M11 16V7M16 16v-8M21 16V4" /></>);
