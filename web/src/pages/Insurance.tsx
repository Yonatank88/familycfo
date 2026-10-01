import { useRef, useState, type ComponentType, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Accessibility, Activity, Briefcase, CalendarClock, Car, ExternalLink, FileText, FileUp, Heart, HeartPulse, House, Landmark,
  MessageCircleQuestion, PawPrint, Plane, Plus, Receipt, Shield, ShieldCheck, Sparkles, Trash2, Wallet,
} from 'lucide-react';
import { api, type InsuranceDocument, type InsuranceOverview, type InsurancePolicy, type InsuranceType } from '../api';
import { useLookups } from '../state';
import { day, fullDate, todayIso } from '../format';
import { AccountSelect, Empty, ErrorBox, Field, Loading, MemberBadge, MemberSelect, Modal, Money, PageHeader, Picker, SectionTitle, Stat } from '../components/ui';
import { askAgent } from '../components/AgentChat';
import { cn } from '@/lib/utils';

const TYPES: { value: InsuranceType; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: 'health', label: 'בריאות', icon: HeartPulse },
  { value: 'life', label: 'חיים', icon: Heart },
  { value: 'nursing', label: 'סיעודי', icon: Accessibility },
  { value: 'critical_illness', label: 'מחלות קשות', icon: Activity },
  { value: 'disability', label: 'אובדן כושר עבודה', icon: Briefcase },
  { value: 'car', label: 'רכב', icon: Car },
  { value: 'home', label: 'דירה', icon: House },
  { value: 'mortgage', label: 'משכנתא (חיים ומבנה)', icon: Landmark },
  { value: 'travel', label: 'נסיעות לחו"ל', icon: Plane },
  { value: 'pet', label: 'חיית מחמד', icon: PawPrint },
  { value: 'other', label: 'אחר', icon: Shield },
];
const typeOf = (t: InsuranceType) => TYPES.find(x => x.value === t) ?? TYPES[TYPES.length - 1];
const FREQUENCIES = [{ value: 'monthly', label: 'לחודש' }, { value: 'yearly', label: 'לשנה' }, { value: 'one_time', label: 'חד-פעמי' }];
const DOC_KINDS = [
  { value: 'policy', label: 'פוליסה' }, { value: 'appendix', label: 'נספח' }, { value: 'renewal', label: 'חידוש' },
  { value: 'claim', label: 'תביעה' }, { value: 'other', label: 'אחר' },
];
const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** Guess a new policy from an insurance charge on the statement. */
function fromCharge(u: InsuranceOverview['unlinked'][number]): Partial<InsurancePolicy> {
  const d = u.description;
  const type: InsuranceType = /חובה|רכב|מקיף/.test(d) ? 'car' : /בריאות/.test(d) ? 'health' : /חיים/.test(d) ? 'life'
    : /דירה|מבנה|תכולה/.test(d) ? 'home' : /סיעוד/.test(d) ? 'nursing' : 'other';
  return {
    name: d, type, insurer: d.split(/\s+/)[0], matchPattern: d, paymentAccountId: u.accountId,
    premium: Math.round(u.lastAmount * 100) / 100, premiumFrequency: 'monthly',
  };
}

export default function Insurance() {
  const qc = useQueryClient();
  const { accountName } = useLookups();
  const { data, isLoading, error } = useQuery({ queryKey: ['insurance'], queryFn: () => api.get<InsuranceOverview>('/insurance') });
  const [editing, setEditing] = useState<Partial<InsurancePolicy> | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;

  const visible = data.policies.filter(p => showArchived || !p.archived);
  const groups = TYPES.map(t => ({ ...t, policies: visible.filter(p => p.type === t.value) })).filter(g => g.policies.length);
  const archivedCount = data.policies.filter(p => p.archived).length;
  const open = (p: Partial<InsurancePolicy>) => setEditing(p);

  return (
    <>
      <PageHeader title="ביטוחים" icon={ShieldCheck} subtitle="כל הפוליסות במקום אחד: כיסוי, עלות בפועל, מועדי חידוש והמסמכים עצמם — ואפשר לשאול עליהם את העוזר"
        actions={<>
          <button type="button" className="btn" onClick={() => askAgent('תן לי סקירה של כל הביטוחים שלנו: מה יש, כמה זה עולה, כפל ביטוח ומה מתחדש בקרוב', true)}>
            <Sparkles />סקירה עם העוזר
          </button>
          <button type="button" className="btn btn-primary" onClick={() => open({ type: 'health', premiumFrequency: 'monthly' })}><Plus />פוליסה</button>
        </>} />

      <div className="grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 md:gap-4 lg:grid-cols-4">
        <Stat index={0} icon={ShieldCheck} label="פוליסות פעילות" value={data.totals.count} format={n => String(Math.round(n))}
          hint={`${data.totals.documents} מסמכים שמורים`} />
        <Stat index={1} icon={Wallet} label="פרמיה חודשית (לפי מה שהוזן)" value={data.totals.monthly}
          hint={`כ-₪${Math.round(data.totals.monthly * 12).toLocaleString('he-IL')} בשנה`} />
        <Stat index={2} icon={Receipt} color="var(--chart-5)" label="חויב בפועל ב-12 החודשים" value={data.totals.paidLast12}
          hint="לפי הטקסט בדף החיוב של כל פוליסה" />
        <Stat index={3} icon={CalendarClock} tone={data.totals.renewalsSoon ? 'warn' : undefined} label="מתחדשות ב-60 הימים הקרובים"
          value={data.totals.renewalsSoon} format={n => String(Math.round(n))} hint="זמן טוב להשוות מחירים" />
      </div>

      {data.unlinked.length > 0 && (
        <section className="card mt-4 md:mt-6">
          <SectionTitle icon={Receipt} as="h2">חיובי ביטוח בלי פוליסה</SectionTitle>
          <p className="mb-3 text-sm text-fg-subtle">חיובים מהשנה האחרונה שנראים כמו ביטוח ועוד לא שויכו לפוליסה. הוספת פוליסה תעקוב אחרי העלות שלהם.</p>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>בדף החיוב</th><th>מאיפה</th><th className="text-end">חיובים</th><th className="text-end">אחרון</th><th className="text-end">ב-12 חודשים</th><th /></tr></thead>
              <tbody>
                {data.unlinked.map(u => (
                  <tr key={`${u.description}|${u.accountId}`}>
                    <td className="font-medium">{u.description}</td>
                    <td className="text-fg-subtle">{accountName(u.accountId)}</td>
                    <td className="num text-end">{u.count}</td>
                    <td className="text-end"><Money value={u.lastAmount} /> <span className="text-xs text-fg-subtle">{day(u.lastDate)}</span></td>
                    <td className="text-end"><Money value={u.total} /></td>
                    <td className="text-end"><button type="button" className="btn btn-sm" onClick={() => open(fromCharge(u))}><Plus />פוליסה</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="mt-4 space-y-6 md:mt-6">
        {groups.length === 0 && (
          <Empty>
            עוד אין פוליסות. הוסף פוליסה (או צור אחת מחיוב ביטוח למעלה) וצרף את מסמך הפוליסה —<br />
            אחר כך אפשר לשאול את העוזר ✨ שאלות כמו "האם ביטוח הבריאות מכסה ניתוח בחו"ל?"
          </Empty>
        )}
        {groups.map(g => (
          <section key={g.value}>
            <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-fg-muted"><g.icon className="h-4 w-4" />{g.label}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.policies.map(p => <PolicyCard key={p.id} policy={p} onOpen={() => open(p)} />)}
            </div>
          </section>
        ))}
        {archivedCount > 0 && (
          <button type="button" className="btn-ghost text-sm" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? 'הסתר פוליסות שהסתיימו' : `הצג ${archivedCount} פוליסות שהסתיימו`}
          </button>
        )}
      </div>

      {editing && <PolicyEditor policy={editing} onClose={() => setEditing(null)}
        onSaved={p => { qc.invalidateQueries({ queryKey: ['insurance'] }); setEditing(p); }} />}
    </>
  );
}

function PolicyCard({ policy: p, onOpen }: { policy: InsurancePolicy; onOpen: () => void }) {
  const T = typeOf(p.type);
  const expired = !!p.endDate && p.endDate < todayIso();
  return (
    <button type="button" onClick={onOpen} className={cn('card card-hover flex flex-col gap-3 text-start', p.archived && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <span className="icon-tile h-9 w-9 shrink-0 rounded-lg [&_svg]:h-4 [&_svg]:w-4"><T.icon /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{p.name}</div>
          <div className="truncate text-xs text-fg-subtle">{[p.insurer, p.policyNumber && `פוליסה ${p.policyNumber}`].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        {p.insuredMemberId != null ? <MemberBadge id={p.insuredMemberId} /> : <span className="chip text-[11px]">כל המשפחה</span>}
      </div>
      {p.coverage && <p className="line-clamp-2 text-sm text-fg-muted">{p.coverage}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-subtle">
        <span>{p.premium != null ? <><Money value={p.premium} className="font-semibold text-fg" /> {FREQUENCIES.find(f => f.value === p.premiumFrequency)?.label}</> : 'פרמיה לא הוזנה'}</span>
        {p.payments.count > 0 && <span title={`${p.payments.count} חיובים, אחרון ${day(p.payments.lastDate)}`}>בפועל <Money value={p.payments.last12} /> ב-12 ח׳</span>}
        {p.endDate && (
          <span className={cn('chip text-[11px]', expired ? 'text-fg-subtle' : p.renewalSoon && 'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300')}>
            <CalendarClock className="h-3 w-3" />{expired ? 'הסתיימה' : 'מתחדשת'} {day(p.endDate)}
          </span>
        )}
        <span className="ms-auto inline-flex items-center gap-1"><FileText className="h-3.5 w-3.5" />{p.documents.length || 'אין'} מסמכים</span>
      </div>
    </button>
  );
}

function PolicyEditor({ policy, onClose, onSaved }: {
  policy: Partial<InsurancePolicy>; onClose: () => void; onSaved: (p: InsurancePolicy) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<InsurancePolicy>>(policy);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<InsurancePolicy>) => setDraft(d => ({ ...d, ...patch }));
  const overview = qc.getQueryData<InsuranceOverview>(['insurance']);
  // documents come from the list, so an upload shows up as soon as the list is refetched
  const documents = overview?.policies.find(p => p.id === draft.id)?.documents ?? [];

  const save = useMutation({
    mutationFn: () => {
      const { id, documents: _d, payments: _p, monthlyPremium: _m, renewalSoon: _r, ...body } = draft as InsurancePolicy;
      return id ? api.patch<InsurancePolicy>(`/insurance/${id}`, body) : api.post<InsurancePolicy>('/insurance', body);
    },
    onSuccess: saved => onSaved({ ...(draft as InsurancePolicy), ...saved }),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/insurance/${draft.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['insurance'] }); onClose(); },
  });

  const text = (key: keyof InsurancePolicy, placeholder?: string, dir?: 'ltr') => (
    <input className="input" dir={dir} value={(draft[key] as string | null) ?? ''} placeholder={placeholder}
      onChange={e => set({ [key]: e.target.value || null } as Partial<InsurancePolicy>)} />
  );

  return (
    <Modal wide title={draft.id ? draft.name ?? 'פוליסה' : 'פוליסה חדשה'} onClose={onClose} footer={<>
      {draft.id && (confirmDelete
        ? <button type="button" className="btn btn-danger me-auto" onClick={() => remove.mutate()} disabled={remove.isPending}><Trash2 />למחוק גם את המסמכים?</button>
        : <button type="button" className="btn-ghost me-auto text-negative" onClick={() => setConfirmDelete(true)}><Trash2 />מחיקה</button>)}
      <button type="button" className="btn" onClick={onClose}>סגירה</button>
      <button type="button" className="btn btn-primary" disabled={!draft.name?.trim() || save.isPending} onClick={() => save.mutate()}>
        {draft.id ? 'שמירה' : 'שמירה והמשך לצירוף מסמכים'}
      </button>
    </>}>
      {save.error && <ErrorBox error={save.error} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="שם">{text('name', 'ביטוח בריאות — הראל')}</Field>
        <Field label="סוג">
          <Picker value={draft.type} onChange={v => v && set({ type: v as InsuranceType })}
            options={TYPES.map(t => ({ value: t.value, label: t.label, icon: <t.icon /> }))} />
        </Field>
        <Field label="חברת ביטוח">{text('insurer', 'הראל, מגדל, כלל…')}</Field>
        <Field label="מספר פוליסה">{text('policyNumber', undefined, 'ltr')}</Field>
        <Field label="מבוטח"><MemberSelect value={draft.insuredMemberId} emptyLabel="כל המשפחה / משותף" onChange={id => set({ insuredMemberId: id })} /></Field>
        <Field label="פרטי המבוטח / הנכס">{text('insuredDetails', 'ילדים, מספר רכב, כתובת…')}</Field>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="פרמיה">
            <input className="input num" type="number" step="0.01" value={draft.premium ?? ''} onChange={e => set({ premium: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
          <Field label="תדירות">
            <Picker className="input w-28" value={draft.premiumFrequency ?? 'monthly'} onChange={v => v && set({ premiumFrequency: v as InsurancePolicy['premiumFrequency'] })} options={FREQUENCIES} />
          </Field>
        </div>
        <Field label="משולם מ"><AccountSelect value={draft.paymentAccountId} emptyLabel="לא ידוע" onChange={id => set({ paymentAccountId: id })} /></Field>
        <Field label="הטקסט בדף החיוב (לזיהוי התשלומים)">{text('matchPattern', 'מגדל חיים/בריאות')}</Field>
        <Field label="השתתפות עצמית">{text('deductible')}</Field>
        <Field label="תחילת ביטוח"><input className="input" type="date" value={draft.startDate ?? ''} onChange={e => set({ startDate: e.target.value || null })} /></Field>
        <Field label="סיום / חידוש"><input className="input" type="date" value={draft.endDate ?? ''} onChange={e => set({ endDate: e.target.value || null })} /></Field>
        <div className="sm:col-span-2">
          <Field label="מה מכוסה (בקצרה)">
            <textarea className="input min-h-20" value={draft.coverage ?? ''} onChange={e => set({ coverage: e.target.value || null })}
              placeholder="ניתוחים בארץ ובחו״ל, תרופות מחוץ לסל, השתלות…" />
          </Field>
        </div>
        <Field label="סוכן">{text('agentName')}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="טלפון">{text('agentPhone', undefined, 'ltr')}</Field>
          <Field label="אימייל">{text('agentEmail', undefined, 'ltr')}</Field>
        </div>
        <div className="sm:col-span-2"><Field label="הערות"><textarea className="input min-h-16" value={draft.notes ?? ''} onChange={e => set({ notes: e.target.value || null })} /></Field></div>
        {draft.id && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={!!draft.archived} onChange={e => set({ archived: e.target.checked ? 1 : 0 })} />
            הפוליסה הסתיימה / בוטלה (תוסתר מהרשימה ומהסיכומים)
          </label>
        )}
      </div>

      <div className="border-t pt-4">
        <SectionTitle icon={FileText} as="h3" action={draft.id ? (
          <button type="button" className="btn btn-sm" onClick={() => askAgent(`לגבי ${draft.name}${draft.insurer ? ` (${draft.insurer})` : ''}: `)}>
            <MessageCircleQuestion />שאל על הפוליסה
          </button>
        ) : undefined}>מסמכים</SectionTitle>
        {draft.id
          ? <Documents policyId={draft.id} documents={documents} />
          : <p className="text-sm text-fg-subtle">שמור את הפוליסה כדי לצרף אליה את מסמך הפוליסה, נספחים וחידושים.</p>}
      </div>
    </Modal>
  );
}

function Documents({ policyId, documents }: { policyId: number; documents: InsuranceDocument[] }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['insurance'] });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const mime = file.type || MIME_BY_EXT[file.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
        const res = await fetch(`/api/insurance/${policyId}/documents?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'content-type': mime }, body: file,
        });
        if (!res.ok) throw new Error(`${file.name}: ${(await res.json().catch(() => null))?.error ?? res.statusText}`);
      }
    },
    onSettled: refresh,
  });
  const setKind = useMutation({ mutationFn: (d: { id: number; kind: string }) => api.patch(`/insurance/documents/${d.id}`, { kind: d.kind }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/insurance/documents/${id}`), onSuccess: () => { setConfirm(null); refresh(); } });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) upload.mutate([...e.dataTransfer.files]);
  };

  return (
    <div className="space-y-3">
      <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
        className={cn('flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center text-sm text-fg-subtle transition-colors',
          dragging && 'border-primary bg-primary/5')}>
        <FileUp className="h-5 w-5" />
        <span>גרור לכאן PDF או תמונה של הפוליסה, או</span>
        <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={upload.isPending}>
          {upload.isPending ? 'מעלה…' : 'בחירת קבצים'}
        </button>
        <input ref={input} type="file" multiple hidden accept="application/pdf,image/png,image/jpeg,image/webp"
          onChange={e => { if (e.target.files?.length) upload.mutate([...e.target.files]); e.target.value = ''; }} />
        <span className="text-xs">הקבצים נשמרים אצלך במחשב (data/policies). כשהעוזר עונה על שאלה, הוא קורא את המסמך הרלוונטי.</span>
      </div>
      {upload.error && <ErrorBox error={upload.error} />}
      {documents.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {documents.map(d => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-fg-subtle" />
              <a href={`/api/insurance/documents/${d.id}/file`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium hover:underline">
                {d.originalName} <ExternalLink className="inline h-3 w-3 opacity-50" />
              </a>
              <span className="text-xs text-fg-subtle">{kb(d.size)} · {fullDate(d.uploadedAt)}</span>
              <Picker className="input h-8 w-24 text-xs" value={d.kind} onChange={v => v && setKind.mutate({ id: d.id, kind: v })} options={DOC_KINDS} />
              {confirm === d.id
                ? <button type="button" className="btn btn-danger btn-sm" onClick={() => remove.mutate(d.id)}>למחוק?</button>
                : <button type="button" className="btn-ghost btn-icon" aria-label="מחיקת מסמך" onClick={() => setConfirm(d.id)}><Trash2 /></button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
