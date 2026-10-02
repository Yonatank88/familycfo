import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CreditCard, Home, Landmark, Plus, Receipt, TrendingUp, X } from 'lucide-react';
import { api, type ScheduledItem } from '../api';
import { useLookups } from '../state';
import { SCHEDULED_KIND_LABELS } from '../format';
import { AccountSelect, MemberSelect, Picker, type PickerOption } from './ui';

const SCHEDULED_KIND_ICONS: Record<string, ReactNode> = {
  income: <TrendingUp />, fixed_expense: <Receipt />, loan: <Landmark />, mortgage: <Home />, card_charge: <CreditCard />,
};
// 'planned' items live in their own list (הוצאות צפויות)
const SCHEDULED_KIND_OPTIONS: PickerOption[] = Object.entries(SCHEDULED_KIND_LABELS).filter(([k]) => k !== 'planned').map(([k, v]) => ({ value: k, label: v, icon: SCHEDULED_KIND_ICONS[k] }));

/**
 * Everything the balance forecast plans with on a day of the month: salaries and other income, the
 * card-charge estimates, and the fixed payments debited from a bank account (with the day, the
 * account and the text that tells they already went out). Fixed payments made with a card are in
 * the list above them (they're part of the card charge).
 */
export function ScheduledManager() {
  const qc = useQueryClient();
  const { meta } = useLookups();
  const scheduled = useQuery({ queryKey: ['scheduled'], queryFn: () => api.get<ScheduledItem[]>('/scheduled') });
  const refresh = () => { for (const k of ['scheduled', 'summary', 'forecast', 'month-plan', 'transactions', 'planning', 'income']) qc.invalidateQueries({ queryKey: [k] }); };
  const patch = useMutation({ mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) => api.patch(path, body), onSuccess: refresh });
  const create = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post('/scheduled', body), onSuccess: refresh });
  const all = scheduled.data ?? [];
  const onPatch = (path: string, body: Record<string, unknown>) => patch.mutate({ path, body });
  const onBank = all.filter(s => !(s.cardAccountId && s.kind !== 'card_charge'));
  const active = onBank.filter(s => s.status !== 'dismissed');
  const incomeAndCards = active.filter(s => s.kind === 'income' || s.kind === 'card_charge');
  const payments = active.filter(s => s.kind !== 'income' && s.kind !== 'card_charge');
  const dismissed = onBank.filter(s => s.status === 'dismissed');
  const firstBank = meta?.accounts.find(a => a.kind === 'bank')?.id ?? null;

  return (
    <>
      <p className="-mt-2 mb-3 text-xs leading-relaxed text-muted-foreground">
        כל פריט פעיל נכנס לתחזית היתרה ביום שלו בחודש, מהחשבון שלו — אלא אם כבר ירד החודש (מזוהה לפי ״תיאור בדף הבנק״).
        אומדן חיוב כרטיס משמש רק כשהכרטיס עוד לא דיווח על החיוב. פריטים שהוסרו לא נספרים בשום חישוב.
      </p>
      {incomeAndCards.length > 0 && <div className="scroll-x card-bleed"><ScheduledTable items={incomeAndCards} onPatch={onPatch} /></div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" onClick={() => create.mutate({ name: 'הכנסה חדשה', kind: 'income', amount: 1000, dayOfMonth: 1, bankAccountId: firstBank, status: 'confirmed' })}>
          <Plus />הכנסה קבועה
        </button>
      </div>
      {payments.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">עריכה מתקדמת של תשלומים מהבנק — יום, חשבון, זיהוי ({payments.length})</summary>
          <div className="scroll-x card-bleed"><ScheduledTable items={payments} onPatch={onPatch} /></div>
        </details>
      )}
      {dismissed.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">הוסרו — לא נספרים בחישובים ({dismissed.length})</summary>
          <div className="scroll-x card-bleed"><ScheduledTable items={dismissed} dismissed onPatch={onPatch} /></div>
        </details>
      )}
    </>
  );
}

/** Where a scheduled item comes from, and (for removed ones) why it doesn't count. */
function sourceOf(s: ScheduledItem): { label: string; why?: string } {
  if (s.kind === 'card_charge') return { label: 'חיוב כרטיס', why: 'הסכום משמש רק כשהכרטיס עוד לא דיווח על החיוב; כשיש פירוט — נספר הסכום האמיתי' };
  return { label: 'זוהה מהיסטוריית הבנק' };
}

function ScheduledTable({ items, dismissed, onPatch }: {
  items: ScheduledItem[]; dismissed?: boolean; onPatch: (path: string, body: Record<string, unknown>) => void;
}) {
  return (
    <table className={`table ${dismissed ? 'mt-3 opacity-70' : ''}`}>
      <thead><tr><th>שם</th><th>מקור</th><th>סוג</th><th className="w-28">סכום</th><th className="w-20">יום</th><th>חשבון</th><th>של מי</th>
        <th title="הטקסט בדף הבנק שלפיו מזהים שהתשלום כבר ירד החודש">תיאור בדף הבנק</th><th>סטטוס</th><th /></tr></thead>
      <tbody>
        {items.map(s => {
          const path = `/scheduled/${s.id}`;
          const src = sourceOf(s);
          return (
            <tr key={s.id} className={s.status === 'suggested' ? 'bg-amber-50/50 dark:bg-amber-950/10' : ''}>
              <td className="min-w-44"><input className="input py-1" defaultValue={s.name} onBlur={e => e.target.value !== s.name && onPatch(path, { name: e.target.value })} /></td>
              <td className="min-w-32 text-xs">
                <span className="text-zinc-500">{src.label}</span>
                {src.why && <div className="text-[11px] text-zinc-500">{src.why}</div>}
              </td>
              <td className="min-w-32"><Picker className="input py-1" value={s.kind} options={SCHEDULED_KIND_OPTIONS} searchable={false}
                onChange={v => v && onPatch(path, { kind: v })} /></td>
              <td className="min-w-28"><input className="input py-1 num" type="number" defaultValue={s.amount} onBlur={e => Number(e.target.value) !== s.amount && onPatch(path, { amount: Number(e.target.value), amountMode: 'fixed' })} /></td>
              <td className="min-w-20"><input className="input py-1 num" type="number" min={1} max={31} defaultValue={s.dayOfMonth} onBlur={e => Number(e.target.value) !== s.dayOfMonth && onPatch(path, { dayOfMonth: Number(e.target.value) })} /></td>
              <td className="min-w-36"><AccountSelect className="input py-1" kind="bank" value={s.bankAccountId} onChange={id => onPatch(path, { bankAccountId: id })} /></td>
              <td className="min-w-28"><MemberSelect className="input py-1" value={s.memberId} emptyLabel="משותף" onChange={id => onPatch(path, { memberId: id })} /></td>
              <td className="min-w-32">{s.kind === 'card_charge' ? <span className="text-xs text-zinc-400">—</span> : (
                <input className="input py-1 text-xs" defaultValue={s.matchPattern ?? ''} placeholder="לפי השם"
                  onBlur={e => e.target.value !== (s.matchPattern ?? '') && onPatch(path, { matchPattern: e.target.value || null })} />
              )}</td>
              <td>{s.status === 'suggested'
                ? <button className="btn btn-primary" onClick={() => onPatch(path, { status: 'confirmed' })}>אשר</button>
                : s.status === 'dismissed' ? <span className="chip">הוסר</span> : <span className="chip">מאושר</span>}</td>
              <td>{dismissed
                ? <button className="btn-ghost text-xs" title="החזר לחישובים" onClick={() => onPatch(path, { status: 'confirmed' })}>שחזר</button>
                : <button className="btn-ghost btn-icon" aria-label="הסר מהחישובים" title="הסר מהחישובים" onClick={() => onPatch(path, { status: 'dismissed' })}><X /></button>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
