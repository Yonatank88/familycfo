import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import type { Tx } from '../api';
import { Money } from './ui';
import { DonutChart } from './charts';
import { categoryIcon, CHART_COLORS } from '@/lib/visuals';

// the same colour for a category in the donut and in the list; the donut's "rest" slice is grey
const DONUT_SLICES = 8;
const colorAt = (i: number) => (i < DONUT_SLICES ? CHART_COLORS[i % CHART_COLORS.length] : 'var(--muted-foreground)');

interface Group { key: string; categoryId: number | null; name: string; spend: number; fixed: number; count: number; children: Group[] }

/** Household spend of a row, net of paybacks; refunds count as negative spend (same as the server's spendOf − refundOf). */
function spendOf(t: Tx): number {
  if (t.excluded) return 0;
  if (t.kind === 'refund' && !t.linkedInflow) return -Math.max(0, t.personalAmount);
  if (t.kind !== 'expense') return 0;
  return Math.max(0, -t.personalAmount - t.paybackTotal * (t.personalAmount / (t.amount || 1)));
}

/**
 * Every category of the listed rows — parents with their sub-categories — as a donut and a ranked
 * list with amounts, share and number of transactions. Clicking a category filters the table to it.
 */
export function CategoryReport({ rows, truncated, onPick }: { rows: Tx[]; truncated: boolean; onPick: (categoryId: number | null) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const { groups, total, fixed } = useMemo(() => {
    const parents = new Map<string, Group>();
    let total = 0, fixed = 0;
    for (const t of rows) {
      const s = spendOf(t);
      if (!s) continue;
      total += s;
      if (t.fixed) fixed += s;
      const pid = t.categoryParentId ?? t.categoryId;
      const pkey = String(pid ?? 'none');
      const p = parents.get(pkey) ?? { key: pkey, categoryId: pid ?? null, name: t.categoryParentName ?? t.categoryName ?? 'ללא קטגוריה', spend: 0, fixed: 0, count: 0, children: [] };
      p.spend += s; p.count++;
      if (t.fixed) p.fixed += s;
      if (t.categoryParentId != null) {
        let c = p.children.find(x => x.categoryId === t.categoryId);
        if (!c) { c = { key: String(t.categoryId), categoryId: t.categoryId, name: t.categoryName ?? '—', spend: 0, fixed: 0, count: 0, children: [] }; p.children.push(c); }
        c.spend += s; c.count++;
      }
      parents.set(pkey, p);
    }
    const groups = [...parents.values()].filter(g => g.spend > 0).sort((a, b) => b.spend - a.spend);
    for (const g of groups) g.children.sort((a, b) => b.spend - a.spend);
    return { groups, total, fixed };
  }, [rows]);

  if (!groups.length) return <div className="py-6 text-center text-sm text-muted-foreground">אין הוצאות בתנועות שברשימה</div>;
  const max = groups[0].spend;
  const share = (v: number) => `${Math.round((v / total) * 100)}%`;
  const toggle = (key: string) => setOpen(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-2 text-sm">
        {[
          { label: 'סה״כ הוצאות', value: total },
          { label: 'קבועות', value: fixed },
          { label: 'משתנות', value: total - fixed },
        ].map(f => (
          <div key={f.label} className="rounded-lg bg-muted/60 px-3 py-2">
            <div className="label">{f.label}</div>
            <Money value={f.value} animated className="text-lg font-semibold" />
          </div>
        ))}
      </div>

      <DonutChart centerLabel="הוצאות" max={DONUT_SLICES} otherLabel="שאר הקטגוריות"
        data={groups.map((g, i) => {
          const Icon = categoryIcon(g.name);
          return { key: g.key, name: g.name, value: g.spend, color: colorAt(i), icon: <Icon /> };
        })} />

      <ul className="divide-y divide-line-soft border-t border-line-soft">
        {groups.map((g, i) => {
          const Icon = categoryIcon(g.name);
          const color = colorAt(i);
          const isOpen = open.has(g.key);
          return (
            <li key={g.key} className="py-2">
              <div className="flex items-center gap-2">
                {g.children.length > 0 ? (
                  <button type="button" className="btn-ghost btn-icon min-h-7 shrink-0" aria-expanded={isOpen}
                    aria-label={isOpen ? 'כווץ' : 'הצג תתי-קטגוריות'} onClick={() => toggle(g.key)}>
                    <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? '' : 'rotate-90'}`} />
                  </button>
                ) : <span className="w-7 shrink-0" />}
                <button type="button" className="min-w-0 flex-1 rounded-lg px-1 py-1 text-start transition-colors hover:bg-accent/60"
                  title="הצג את התנועות בקטגוריה" onClick={() => onPick(g.categoryId)}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="icon-tile h-6 w-6 shrink-0 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5" style={{ ['--tile' as string]: color }}><Icon /></span>
                      <span className="truncate font-medium">{g.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{g.count} תנועות{g.fixed > 0 && <> · קבועות <Money value={g.fixed} /></>}</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="num text-xs text-muted-foreground">{share(g.spend)}</span>
                      <Money value={g.spend} className="w-20 text-end font-semibold" />
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <motion.div className="h-full rounded-full" style={{ background: color }}
                      initial={{ width: 0 }} animate={{ width: `${(g.spend / max) * 100}%` }}
                      transition={{ duration: 0.7, delay: 0.05 + i * 0.03, ease: [0.22, 1, 0.36, 1] }} />
                  </div>
                </button>
              </div>
              {isOpen && (
                <ul className="animate-fade-in mt-1 space-y-0.5 ps-9">
                  {g.children.map(c => (
                    <li key={c.key}>
                      <button type="button" className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1 text-sm transition-colors hover:bg-accent/60"
                        onClick={() => onPick(c.categoryId)}>
                        <span className="min-w-0 truncate">└ {c.name} <span className="text-xs text-muted-foreground">· {c.count}</span></span>
                        <span className="flex shrink-0 items-baseline gap-2">
                          <span className="num text-xs text-muted-foreground">{Math.round((c.spend / g.spend) * 100)}% מ{g.name}</span>
                          <Money value={c.spend} className="w-20 text-end" />
                        </span>
                      </button>
                    </li>
                  ))}
                  {g.spend - g.children.reduce((s, c) => s + c.spend, 0) > 0.5 && (
                    <li className="flex justify-between gap-3 px-2 py-1 text-sm text-muted-foreground">
                      <span>└ ישירות ב{g.name}</span>
                      <Money value={g.spend - g.children.reduce((s, c) => s + c.spend, 0)} className="w-20 text-end" />
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs leading-relaxed text-muted-foreground">
        לפי הסינון הנוכחי בעמוד. חלק הבית בלבד (בלי חלק עסקי), אחרי החזרים וזיכויים. העברות, חסכונות ותשלומי כרטיס לא נספרים.
        {truncated && ' מוצגות רק 1,000 התנועות האחרונות — בחרו חודש כדי לראות את כל התמונה.'}
      </p>
    </div>
  );
}
