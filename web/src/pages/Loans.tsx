import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Liability, type NetWorth } from '../api';
import { useLookups } from '../state';
import { day, todayIso } from '../format';
import { CircleDashed, Home, Landmark, Lock, type LucideIcon, Pencil, Percent, TrendingUp } from 'lucide-react';
import { AccountSelect, Empty, Field, Loading, MemberBadge, MemberSelect, Modal, Money, PageHeader, Picker } from '../components/ui';
import { Gauge } from '../components/charts';

const INDEX_TYPES: Record<string, string> = { prime: 'פריים', cpi: 'צמוד מדד', fixed: 'קבועה לא צמודה', other: 'אחר' };
const INDEX_ICONS: Record<string, LucideIcon> = { prime: Percent, cpi: TrendingUp, fixed: Lock, other: CircleDashed };
const LOAN_TYPES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: 'mortgage', label: 'משכנתא', icon: Home }, { value: 'loan', label: 'הלוואה', icon: Landmark }, { value: 'other', label: 'אחר', icon: CircleDashed },
];

export default function Loans() {
  const qc = useQueryClient();
  const { accountName } = useLookups();
  const loans = useQuery({ queryKey: ['liabilities'], queryFn: () => api.get<Liability[]>('/liabilities') });
  const nw = useQuery({ queryKey: ['networth'], queryFn: () => api.get<NetWorth>('/networth') });
  const [editing, setEditing] = useState<Partial<Liability> & { balance?: number } | null>(null);
  const [balanceFor, setBalanceFor] = useState<{ loan: Liability; balance: number; date: string } | null>(null);

  const refresh = () => { for (const k of ['liabilities', 'networth', 'forecast', 'summary']) qc.invalidateQueries({ queryKey: [k] }); };
  const save = useMutation({
    mutationFn: async (l: Partial<Liability> & { balance?: number }) => {
      const { balance, id, ...body } = l;
      const saved = id ? await api.patch<Liability>(`/liabilities/${id}`, body) : await api.post<Liability>('/liabilities', body);
      if (balance != null && !id) await api.post('/liability-snapshots', { liabilityId: saved.id, date: todayIso(), balance });
      // a loan with a payment day and bank account becomes a scheduled outflow in the cash-flow forecast
      if (!id && saved.monthlyPayment && saved.paymentDay && saved.bankAccountId) {
        await api.post('/scheduled', {
          name: saved.name, kind: saved.type === 'mortgage' ? 'mortgage' : 'loan', amount: -Math.abs(saved.monthlyPayment),
          dayOfMonth: saved.paymentDay, bankAccountId: saved.bankAccountId, memberId: saved.ownerMemberId,
          matchPattern: saved.matchPattern, liabilityId: saved.id, endDate: saved.endDate, status: 'confirmed',
        }).catch(() => undefined);
      }
    },
    onSuccess: () => { refresh(); setEditing(null); },
  });
  const addBalance = useMutation({
    mutationFn: (b: { loan: Liability; balance: number; date: string }) => api.post('/liability-snapshots', { liabilityId: b.loan.id, date: b.date, balance: b.balance }),
    onSuccess: () => { refresh(); setBalanceFor(null); },
  });

  if (loans.isLoading) return <Loading />;
  const active = (loans.data ?? []).filter(l => !l.archived);
  const balanceOf = (l: Liability) => -(nw.data?.items.find(i => i.id === `liability:${l.id}`)?.valueIls ?? 0);
  const totalBalance = active.reduce((s, l) => s + balanceOf(l), 0);
  const totalMonthly = active.reduce((s, l) => s + (l.monthlyPayment ?? 0), 0);

  return (
    <>
      <PageHeader icon={Home} title="הלוואות ומשכנתא" subtitle={<>יתרה כוללת <Money value={totalBalance} animated className="font-semibold text-foreground" /> · החזר חודשי <Money value={totalMonthly} animated className="font-semibold text-foreground" /></>}
        actions={<button className="btn btn-primary" onClick={() => setEditing({ type: 'mortgage' })}>+ הלוואה / משכנתא</button>} />

      {active.length === 0 ? <Empty>הוסיפו את המשכנתא וההלוואות. אם תגדירו יום חיוב וחשבון בנק, ההחזר ייכנס אוטומטית לתחזית התזרים.</Empty> : (
        <div className="stagger grid gap-4 md:grid-cols-2">
          {active.map((l, idx) => {
            const balance = balanceOf(l);
            const paidPct = l.originalPrincipal ? Math.max(0, Math.min(100, (1 - balance / l.originalPrincipal) * 100)) : null;
            const monthsLeft = l.endDate ? Math.max(0, Math.round((Date.parse(l.endDate) - Date.now()) / (30.4 * 86_400_000))) : null;
            return (
              <div key={l.id} style={{ ['--i' as string]: idx }} className="card card-hover min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="icon-tile h-10 w-10 rounded-xl [&_svg]:h-5 [&_svg]:w-5" style={{ ['--tile' as string]: l.type === 'mortgage' ? 'var(--chart-1)' : 'var(--chart-6)' }}>
                      {l.type === 'mortgage' ? <Home /> : <Landmark />}
                    </span>
                    <div className="min-w-0">
                      <div className="text-base font-semibold tracking-tight">{l.name}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-zinc-500">{l.lender} · {l.type === 'mortgage' ? 'משכנתא' : 'הלוואה'} <MemberBadge id={l.ownerMemberId} /></div>
                    </div>
                  </div>
                  <button className="btn-ghost btn-icon -me-2 -mt-1" aria-label="עריכה" onClick={() => setEditing(l)}><Pencil /></button>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-line-soft pt-4">
                <div className="grid min-w-0 flex-1 basis-60 grid-cols-2 gap-x-3 gap-y-3.5 text-sm sm:grid-cols-3">
                  <div><div className="label">יתרה</div><Money value={balance} animated className="font-semibold" /></div>
                  <div><div className="label">החזר חודשי</div><Money value={l.monthlyPayment} /></div>
                  <div><div className="label">ריבית</div><span className="num">{l.interestRate != null ? `${l.interestRate}%` : '—'}</span> <span className="text-xs text-zinc-500">{l.indexType ? INDEX_TYPES[l.indexType] : ''}</span></div>
                  <div><div className="label">סיום</div>{day(l.endDate)}{monthsLeft != null && <div className="text-xs text-zinc-500">{monthsLeft} חודשים</div>}</div>
                  <div><div className="label">יום חיוב</div>{l.paymentDay ?? '—'} <span className="text-xs text-zinc-500">{l.bankAccountId ? accountName(l.bankAccountId) : ''}</span></div>
                  <div><div className="label">סכום מקורי</div><Money value={l.originalPrincipal} /></div>
                </div>
                {paidPct != null && (
                  <div className="mx-auto shrink-0">
                    <Gauge value={paidPct} max={100} size={112} label="שולם" />
                  </div>
                )}
                </div>
                <button className="btn mt-4" onClick={() => setBalanceFor({ loan: l, balance, date: todayIso() })}>עדכן יתרה</button>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? 'עריכה' : 'הלוואה / משכנתא חדשה'} onClose={() => setEditing(null)} footer={<>
          <button className="btn" onClick={() => setEditing(null)}>ביטול</button>
          {editing.id && <button className="btn" onClick={() => save.mutate({ id: editing.id, archived: 1 })}>סיום / ארכיון</button>}
          <button className="btn btn-primary" disabled={!editing.name} onClick={() => save.mutate(editing)}>שמור</button>
        </>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="שם"><input className="input" value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="משכנתא — לאומי" /></Field>
            <Field label="סוג"><Picker value={editing.type} onChange={v => v && setEditing({ ...editing, type: v })}
              options={LOAN_TYPES.map(t => ({ value: t.value, label: t.label, icon: <t.icon /> }))} /></Field>
            <Field label="מלווה"><input className="input" value={editing.lender ?? ''} onChange={e => setEditing({ ...editing, lender: e.target.value })} /></Field>
            <Field label="של מי"><MemberSelect value={editing.ownerMemberId} emptyLabel="משותף" onChange={id => setEditing({ ...editing, ownerMemberId: id })} /></Field>
            <Field label="סכום מקורי"><input className="input num" type="number" value={editing.originalPrincipal ?? ''} onChange={e => setEditing({ ...editing, originalPrincipal: Number(e.target.value) })} /></Field>
            {!editing.id && <Field label="יתרה נוכחית"><input className="input num" type="number" value={editing.balance ?? ''} onChange={e => setEditing({ ...editing, balance: Number(e.target.value) })} /></Field>}
            <Field label="ריבית (%)"><input className="input num" type="number" step="0.01" value={editing.interestRate ?? ''} onChange={e => setEditing({ ...editing, interestRate: Number(e.target.value) })} /></Field>
            <Field label="הצמדה"><Picker value={editing.indexType ?? ''} onChange={v => setEditing({ ...editing, indexType: v })} placeholder="—"
              options={[{ value: '', label: '—' }, ...Object.entries(INDEX_TYPES).map(([k, v]) => { const Icon = INDEX_ICONS[k] ?? CircleDashed; return { value: k, label: v, icon: <Icon /> }; })]} /></Field>
            <Field label="החזר חודשי"><input className="input num" type="number" value={editing.monthlyPayment ?? ''} onChange={e => setEditing({ ...editing, monthlyPayment: Number(e.target.value) })} /></Field>
            <Field label="יום חיוב בחודש"><input className="input num" type="number" min={1} max={31} value={editing.paymentDay ?? ''} onChange={e => setEditing({ ...editing, paymentDay: Number(e.target.value) })} /></Field>
            <Field label="מחשבון"><AccountSelect kind="bank" value={editing.bankAccountId} onChange={id => setEditing({ ...editing, bankAccountId: id })} /></Field>
            <Field label="תיאור בדף הבנק"><input className="input" value={editing.matchPattern ?? ''} onChange={e => setEditing({ ...editing, matchPattern: e.target.value })} placeholder="לאומי למשכנת" /></Field>
            <Field label="התחלה"><input className="input" type="date" value={editing.startDate ?? ''} onChange={e => setEditing({ ...editing, startDate: e.target.value })} /></Field>
            <Field label="סיום"><input className="input" type="date" value={editing.endDate ?? ''} onChange={e => setEditing({ ...editing, endDate: e.target.value })} /></Field>
          </div>
        </Modal>
      )}

      {balanceFor && (
        <Modal title={`עדכון יתרה — ${balanceFor.loan.name}`} onClose={() => setBalanceFor(null)} footer={<>
          <button className="btn" onClick={() => setBalanceFor(null)}>ביטול</button>
          <button className="btn btn-primary" onClick={() => addBalance.mutate(balanceFor)}>שמור</button>
        </>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="יתרה לסילוק"><input className="input num" type="number" value={balanceFor.balance} onChange={e => setBalanceFor({ ...balanceFor, balance: Number(e.target.value) })} /></Field>
            <Field label="נכון לתאריך"><input className="input" type="date" value={balanceFor.date} onChange={e => setBalanceFor({ ...balanceFor, date: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
