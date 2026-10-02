import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CreditCard, Landmark, Trash2, Wallet } from 'lucide-react';
import { api, type PlannedItem, type Tx } from '../api';
import { useLookups } from '../state';
import { todayIso } from '../format';
import { CategorySelect, Field, Modal, Picker, Segmented, TagPicker } from './ui';
import { MemberAvatar } from '@/lib/visuals';

const PAID = 'paid';

/**
 * Add or edit an expense that isn't on the statements yet:
 * - paid in cash / by someone else (already happened) → a manual row, counted right away;
 * - to be charged to a card or bank account (not charged yet) → a planned expense: it counts in the
 *   forecast and the budget until the real row arrives, then it's matched to it and stops counting.
 */
export function ManualEntry({ tx, planned, defaultMemberId, defaultPlanned, onClose, onSaved }: {
  tx?: Tx | null; planned?: PlannedItem | null; defaultMemberId?: number;
  /** open in "not charged yet" mode (e.g. from the month plan) */
  defaultPlanned?: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const { meta } = useLookups();
  const accounts = (meta?.accounts ?? []).filter(a => (a.kind === 'card' || a.kind === 'bank') && a.active && !/-ID_\d+$|-[A-Z]{3}$/.test(a.id));
  const firstCard = accounts.find(a => a.kind === 'card')?.id ?? accounts[0]?.id ?? PAID;
  const [form, setForm] = useState({
    payWith: planned ? planned.accountId : tx ? PAID : defaultPlanned ? firstCard : PAID,
    kind: (tx?.kind === 'income' ? 'income' : 'expense') as 'expense' | 'income',
    date: planned?.date ?? tx?.date ?? todayIso(),
    amount: planned?.amount ?? (tx ? Math.abs(tx.amount) : 0),
    description: planned?.description ?? tx?.description ?? '',
    categoryId: planned?.categoryId ?? tx?.categoryId ?? null,
    memberId: planned?.memberId ?? tx?.memberId ?? defaultMemberId ?? null,
    tagIds: planned?.tagIds ?? tx?.tagIds ?? [],
    notes: planned?.notes ?? tx?.notes ?? '',
    installments: planned?.installments ?? 1,
    matchPattern: planned?.matchPattern ?? '',
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));
  const isPlanned = form.payWith !== PAID;

  const save = useMutation({
    mutationFn: () => {
      if (isPlanned) {
        const body = { ...form, accountId: form.payWith };
        return planned ? api.put(`/planned/${planned.id}`, body) : api.post('/planned', body);
      }
      return tx ? api.put(`/transactions/${tx.id}/manual`, form) : api.post('/transactions/manual', form);
    },
    onSuccess: onSaved,
  });
  const remove = useMutation({ mutationFn: () => api.del(planned ? `/planned/${planned.id}` : `/transactions/${tx!.id}`), onSuccess: onSaved });
  const valid = form.description.trim() && form.amount > 0 && form.date;
  const editing = !!(tx || planned);
  const memberOptions = [
    { value: '', label: isPlanned ? 'לפי בעל הכרטיס / החשבון' : 'משותף' },
    ...(meta?.members ?? []).map(m => ({ value: String(m.id), label: m.name, icon: <MemberAvatar name={m.name} color={m.color} size={18} /> })),
  ];
  const payOptions = [
    // a manual row can't become a planned one (and back) — it's a different thing
    ...(planned ? [] : [{ value: PAID, label: 'מזומן / אחר — כבר שולם', icon: <Wallet /> }]),
    ...(tx ? [] : accounts.map(a => ({ value: a.id, label: `${a.displayName ?? a.id} — עוד לא חויב`, icon: a.kind === 'card' ? <CreditCard /> : <Landmark /> }))),
  ];

  return (
    <Modal title={planned ? 'עריכת הוצאה צפויה' : tx ? 'עריכת תנועה ידנית' : isPlanned ? 'הוספת הוצאה צפויה' : 'הוספת הוצאה ידנית'} onClose={onClose} footer={<>
      {editing && (confirmDelete
        ? <button className="btn border-negative/40 text-negative me-auto" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 />בטוח? למחוק</button>
        : <button className="btn-ghost text-negative me-auto" onClick={() => setConfirmDelete(true)}><Trash2 />מחיקה</button>)}
      <button className="btn" onClick={onClose}>ביטול</button>
      <button className="btn btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{editing ? 'שמור' : 'הוסף'}</button>
    </>}>
      <Field label="איך משלמים">
        <Picker className="input" value={form.payWith} options={payOptions} searchable={false} onChange={v => v && set({ payWith: v })} />
      </Field>
      {!isPlanned && (
        <Segmented value={form.kind} onChange={kind => set({ kind })} options={[
          { value: 'expense', label: 'הוצאה', icon: ArrowUpRight },
          { value: 'income', label: 'הכנסה', icon: ArrowDownLeft },
        ]} />
      )}
      <div className={`grid gap-3 ${isPlanned ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <Field label={isPlanned ? 'סכום כולל (₪)' : 'סכום (₪)'}><input className="input num" type="number" min={0} step="0.01" autoFocus value={form.amount || ''} onChange={e => set({ amount: Number(e.target.value) })} /></Field>
        <Field label={isPlanned ? 'תאריך הקנייה (צפוי)' : 'תאריך'}><input className="input" type="date" value={form.date} onChange={e => set({ date: e.target.value })} /></Field>
        {isPlanned && <Field label="תשלומים"><input className="input num" type="number" min={1} max={60} value={form.installments} onChange={e => set({ installments: Math.max(1, Number(e.target.value) || 1) })} /></Field>}
      </div>
      <Field label="תיאור"><input className="input" value={form.description} onChange={e => set({ description: e.target.value })}
        placeholder={isPlanned ? 'למשל: ספה, טיסה, מקדמה לחוג' : 'למשל: עוזרת בית, בייביסיטר, שוק'} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="קטגוריה"><CategorySelect value={form.categoryId} onChange={categoryId => set({ categoryId })} /></Field>
        <Field label="שייך ל"><Picker className="input" value={form.memberId != null ? String(form.memberId) : ''} options={memberOptions} searchable={false}
          onChange={v => set({ memberId: v ? Number(v) : null })} /></Field>
      </div>
      {isPlanned && (
        <Field label="איך זה יופיע בדף הכרטיס (לא חובה)">
          <input className="input" value={form.matchPattern} onChange={e => set({ matchPattern: e.target.value })} placeholder="למשל: IKEA — עוזר לזהות את החיוב" />
        </Field>
      )}
      <Field label="תגיות"><TagPicker value={form.tagIds} onChange={tagIds => set({ tagIds })} /></Field>
      <Field label="הערות"><textarea className="input" rows={2} value={form.notes} onChange={e => set({ notes: e.target.value })} placeholder={isPlanned ? '' : 'למשל: שולם במזומן'} /></Field>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {isPlanned ? <>
          עד שהחיוב מגיע, ההוצאה נכנסת לתחזית (בחיוב הכרטיס שבו היא תיפול{form.installments > 1 ? `, תשלום בכל חודש` : ''}) ולתקציב של החודש.
          כשהחיוב האמיתי מופיע (אותו כרטיס, סכום דומה, עד חודש מהתאריך) — היא נסגרת לבד, והקטגוריה והתגיות עוברות אליו. אם יש כמה חיובים מתאימים, תתבקש לבחור.
        </> : <>
          נספר בכל החישובים (הוצאות, תקציב, קטגוריות) אבל לא יורד מאף חשבון בתחזית היתרה.
          אם שילמת ממזומן שמשכת בכספומט — המשיכה כבר נספרה כהוצאה (קטגוריית ״מזומן״). כדי שלא ייספר פעמיים, סמנו את המשיכה כ״העברה״ או ״הסתר מהחישובים״.
        </>}
      </p>
      {(save.error || remove.error) && <div className="text-sm text-negative">{String((save.error ?? remove.error) as Error)}</div>}
    </Modal>
  );
}
