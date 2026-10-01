import { CreditCard, Layers } from 'lucide-react';
import type { Commitment, MonthPlan } from '../api';
import { day, pct } from '../format';
import { useLookups } from '../state';
import { accountIcon, categoryIcon, hueFor, MemberAvatar } from '@/lib/visuals';
import { BarList } from './charts';
import { MemberBadge, Money, Progress } from './ui';

type Installment = MonthPlan['installments']['items'][number];

interface Source {
  accountId: string;
  kind: 'bank' | 'card';
  items: Commitment[];
  installments: Installment[];
  total: number;
}

const STATE_LABEL: Record<Commitment['state'], { label: string; cls: string }> = {
  paid: { label: 'ירד ✓', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' },
  partial: { label: 'חלקי', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  pending: { label: 'צפוי', cls: '' },
  missing: { label: 'עוד לא נראה', cls: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200' },
};

/**
 * How the month starts: every known fixed payment grouped by the family member, then by the bank
 * account or card it's paid from — and for each bank account, what leaves it in total once the
 * cards it pays are charged.
 */
export function StartOfMonth({ data }: { data: MonthPlan }) {
  const { meta, accountName, member } = useLookups();
  const accountOf = (id: string) => meta?.accounts.find(a => a.id === id);
  const confirmed = data.commitments.filter(c => c.status === 'confirmed');

  const sources = new Map<string, Source>();
  const sourceFor = (accountId: string, kind: 'bank' | 'card') => {
    const s = sources.get(accountId) ?? { accountId, kind, items: [], installments: [], total: 0 };
    sources.set(accountId, s);
    return s;
  };
  for (const c of confirmed) {
    const s = sourceFor(c.accountId, c.method);
    s.items.push(c);
    s.total += Math.max(c.expected, c.actual);
  }
  for (const i of data.installments.items) {
    const s = sourceFor(i.accountId, accountOf(i.accountId)?.kind === 'bank' ? 'bank' : 'card');
    s.installments.push(i);
    s.total += i.amount;
  }

  // the bank account each card's statement is paid from (from the items, else the account settings)
  const payerOf = (s: Source) => s.items.find(c => c.payingAccountId)?.payingAccountId ?? data.billing?.[s.accountId] ?? accountOf(s.accountId)?.billingBankAccountId ?? null;
  const cardsPaidFrom = (bankId: string) => [...sources.values()].filter(s => s.kind === 'card' && payerOf(s) === bankId);
  // a bank account that only pays cards still shows what leaves it
  for (const s of [...sources.values()]) {
    const payer = s.kind === 'card' ? payerOf(s) : null;
    if (payer && accountOf(payer)) sourceFor(payer, 'bank');
  }

  // group by the owner of the account/card (shared accounts together)
  const byMember = new Map<string, Source[]>();
  for (const s of sources.values()) {
    const key = String(accountOf(s.accountId)?.ownerMemberId ?? 'shared');
    byMember.set(key, [...(byMember.get(key) ?? []), s]);
  }
  const members = [...byMember.entries()].sort(([a], [b]) => (a === 'shared' ? 1 : b === 'shared' ? -1 : Number(a) - Number(b)));
  const grand = [...sources.values()].reduce((s, x) => s + x.total, 0);

  if (!sources.size) return null;

  // one bar per account / card: what's known in advance on it (direct items + installments)
  const summary = [...sources.values()].filter(s => s.total > 0).sort((a, b) => b.total - a.total).map(s => {
    const Icon = accountIcon(s.kind);
    const owner = accountOf(s.accountId)?.ownerMemberId;
    const m = owner != null ? member(owner) : undefined;
    return {
      key: s.accountId, label: accountName(s.accountId), value: s.total, color: hueFor(s.accountId), icon: <Icon />,
      sub: m ? <MemberAvatar name={m.name} color={m.color} size={16} /> : undefined,
    };
  });

  return (
    <div className="space-y-6">
      {summary.length > 1 && (
        <div className="animate-rise-in rounded-xl border border-line-soft bg-muted/40 p-3 md:p-4">
          <div className="mb-1 text-xs font-medium text-muted-foreground">לפי חשבון וכרטיס</div>
          <BarList items={summary} />
        </div>
      )}
      {members.map(([key, list]) => {
        const memberTotal = list.reduce((s, x) => s + x.total, 0);
        const ordered = [...list].sort((a, b) => (a.kind === b.kind ? b.total - a.total : a.kind === 'bank' ? -1 : 1));
        const m = key === 'shared' ? undefined : member(Number(key));
        const name = key === 'shared' ? 'משותף' : m?.name ?? '—';
        return (
          <section key={key} className="animate-rise-in">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <h3 className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">
                <MemberAvatar name={name} color={m?.color ?? (key === 'shared' ? 'var(--chart-4)' : undefined)} size={26} />
                {name}
              </h3>
              <span className="text-sm text-muted-foreground">
                <Money value={memberTotal} animated className="font-semibold text-fg" />
                {data.income > 0 && <> · {pct((memberTotal / data.income) * 100)} מההכנסה</>}
              </span>
            </div>
            <div className="stagger grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {ordered.map((s, i) => <SourceCard key={s.accountId} index={i} source={s} payer={s.kind === 'card' ? payerOf(s) : null}
                memberTotal={memberTotal} cardsPaidHere={s.kind === 'bank' ? cardsPaidFrom(s.accountId) : []} accountName={accountName} />)}
            </div>
          </section>
        );
      })}
      <p className="text-xs leading-relaxed text-muted-foreground">
        סה״כ ידוע מראש <Money value={grand} /> (קבועות מהרשימה ותשלומים). תשלום בכרטיס יורד מהבנק ביום החיוב של הכרטיס —
        כך הוא נכנס גם לתחזית: אם הכרטיס עוד לא דיווח עליו, הסכום מתווסף לחיוב הכרטיס הקרוב.
      </p>
    </div>
  );
}

function SourceCard({ source: s, payer, cardsPaidHere, accountName, memberTotal, index }: {
  source: Source; payer: string | null; cardsPaidHere: Source[]; accountName: (id: string | null | undefined) => string;
  memberTotal: number; index: number;
}) {
  const chargeDates = [...new Set(s.items.map(c => c.chargeDate).filter(Boolean) as string[])].sort();
  const viaCards = cardsPaidHere.reduce((sum, c) => sum + c.total, 0);
  const items = [...s.items].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.expected - a.expected);
  const instTotal = s.installments.reduce((sum, i) => sum + i.amount, 0);
  const Icon = accountIcon(s.kind);
  const tile = hueFor(s.accountId);

  return (
    <div style={{ ['--i' as string]: index }} className="card-hover flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-card">
      <div className="border-b border-line-soft px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="icon-tile h-9 w-9 rounded-lg" style={{ ['--tile' as string]: tile }}><Icon /></span>
          <div className="min-w-0">
          <div className="truncate font-medium">{accountName(s.accountId)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {s.kind === 'bank' ? (cardsPaidHere.length ? 'סה״כ יורד מהחשבון, כולל חיובי כרטיסים' : 'יורד ישירות מהחשבון') : (
              <>יורד {payer ? <>מ{accountName(payer)}</> : 'מחשבון לא ידוע'}{chargeDates.length > 0 && <> · בחיוב {chargeDates.map(d => day(d)).join(', ')}</>}</>
            )}
          </div>
          </div>
        </div>
        <Money value={s.total + viaCards} className="shrink-0 text-base font-semibold tracking-tight" />
      </div>
      {memberTotal > 0 && (
        <div className="mt-2.5 flex items-center gap-2" title={pct((s.total / memberTotal) * 100)}>
          <Progress value={s.total} max={memberTotal} className="h-1" />
          <span className="num w-9 shrink-0 text-end text-[11px] text-muted-foreground">{pct((s.total / memberTotal) * 100)}</span>
        </div>
      )}
      </div>

      <ul className="flex-1 divide-y divide-line-soft px-4 text-sm">
        {items.map(c => {
          const CatIcon = categoryIcon(c.categoryName ?? c.name);
          return (
          <li key={c.id} className="flex items-center justify-between gap-3 py-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"><CatIcon /></span>
              <div className="min-w-0">
              <div className="truncate">{c.name}</div>
              <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                <span>ב-{c.day} לחודש</span>
                {c.categoryName && <span>· {c.categoryName}</span>}
                {c.estimated && <span>· הערכה</span>}
                {c.memberId != null && <MemberBadge id={c.memberId} />}
              </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {c.state !== 'pending' && <span className={`chip ${STATE_LABEL[c.state].cls}`}>{STATE_LABEL[c.state].label}</span>}
              <Money value={Math.max(c.expected, c.actual)} />
            </div>
          </li>
          );
        })}
        {s.installments.length > 0 && (
          <li className="flex items-center justify-between gap-3 py-2 text-muted-foreground">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:h-3.5 [&_svg]:w-3.5"><Layers /></span>
              <span className="truncate">עסקאות בתשלומים ({s.installments.length})</span>
            </span>
            <Money value={instTotal} />
          </li>
        )}
      </ul>

      {s.kind === 'bank' && cardsPaidHere.length > 0 && (
        <div className="space-y-1 border-t border-line-soft bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
          <div className="flex justify-between gap-3">
            <span>ישירות מהחשבון</span>
            <Money value={s.total} />
          </div>
          {cardsPaidHere.map(c => (
            <div key={c.accountId} className="flex justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5 truncate"><CreditCard className="h-3 w-3 shrink-0 opacity-70" />+ קבועות בכרטיס {accountName(c.accountId)}</span>
              <Money value={c.total} />
            </div>
          ))}
          <div className="flex justify-between gap-3 border-t border-line-soft pt-1.5 text-sm font-semibold text-fg">
            <span>סה״כ יורד מהחשבון</span>
            <Money value={s.total + viaCards} />
          </div>
        </div>
      )}
    </div>
  );
}
