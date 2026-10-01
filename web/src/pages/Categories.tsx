import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, CornerDownLeft, CreditCard, Layers, PiggyBank, Plus, Search, ShoppingBag, Trash2, TrendingUp } from 'lucide-react';
import { api } from '../api';
import { KIND_LABELS } from '../format';
import { CategorySelect, ErrorBox, Field, Loading, Modal, Money, PageHeader, Picker, type PickerOption } from '../components/ui';
import { categoryIcon, hueFor } from '@/lib/visuals';

interface CategoryRow {
  id: number; name: string; parentId: number | null; kind: string; defaultFixed: number; discretionary: number;
  transactions: number; total: number;
}

const KINDS = ['expense', 'income', 'transfer', 'card_payment', 'savings'];
const KIND_ICONS: Record<string, ReactNode> = {
  expense: <ShoppingBag />, income: <TrendingUp />, transfer: <ArrowLeftRight />, card_payment: <CreditCard />, savings: <PiggyBank />,
};
const KIND_OPTIONS: PickerOption[] = KINDS.map(k => ({ value: k, label: KIND_LABELS[k], icon: KIND_ICONS[k] }));

export default function Categories() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ name: string; parentId: number | null } | null>(null);
  const [deleting, setDeleting] = useState<{ cat: CategoryRow; moveTo: number | null } | null>(null);
  const [filter, setFilter] = useState('');
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api.get<CategoryRow[]>('/categories') });

  const refresh = () => { for (const k of ['categories', 'meta', 'transactions', 'summary', 'budgets', 'cashflow']) qc.invalidateQueries({ queryKey: [k] }); };
  const onError = (e: Error) => setError(e.message);
  const patch = useMutation({ mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch(`/categories/${id}`, body), onSuccess: () => { setError(null); refresh(); }, onError });
  const create = useMutation({ mutationFn: (b: { name: string; parentId: number | null }) => api.post('/categories', b), onSuccess: () => { setError(null); setAdding(null); refresh(); }, onError });
  const remove = useMutation({
    mutationFn: ({ id, moveTo }: { id: number; moveTo: number | null }) => api.del<{ moved: number }>(`/categories/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`),
    onSuccess: () => { setError(null); setDeleting(null); refresh(); }, onError,
  });

  if (cats.isLoading) return <Loading />;
  if (cats.error) return <ErrorBox error={cats.error} />;
  const all = cats.data ?? [];
  const byName = (a: CategoryRow, b: CategoryRow) => a.name.localeCompare(b.name, 'he');
  const childrenOf = (id: number) => all.filter(c => c.parentId === id).sort(byName);
  const q = filter.trim();
  const matches = (c: CategoryRow) => !q || c.name.includes(q) || childrenOf(c.id).some(ch => ch.name.includes(q));
  const tops = all.filter(c => c.parentId == null && matches(c)).sort(byName);

  const row = (c: CategoryRow, depth: number) => {
    const hasChildren = childrenOf(c.id).length > 0;
    const parentName = c.parentId != null ? all.find(p => p.id === c.parentId)?.name : undefined;
    const Icon = categoryIcon(parentName ? `${c.name} ${parentName}` : c.name);
    return (
      <tr key={c.id} className={depth === 0 && hasChildren ? 'bg-surface-muted' : ''}>
        <td className="min-w-56" style={{ paddingInlineStart: depth ? 32 : 8 }}>
          <div className="flex items-center gap-2">
            {depth > 0 && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />}
            <span className="icon-tile h-7 w-7 rounded-lg [&_svg]:h-4 [&_svg]:w-4" style={{ ['--tile' as string]: hueFor(parentName ?? c.name) }}><Icon /></span>
            <input className={`input py-1 ${depth === 0 && hasChildren ? 'font-semibold' : ''}`} defaultValue={c.name} key={`${c.id}-${c.name}`}
              onBlur={e => e.target.value.trim() && e.target.value !== c.name && patch.mutate({ id: c.id, body: { name: e.target.value } })} />
          </div>
        </td>
        <td className="min-w-44">
          {hasChildren ? <span className="text-xs text-zinc-500">קטגוריה ראשית · {childrenOf(c.id).length} תתי-קטגוריות</span> : (
            <CategorySelect className="input py-1" value={c.parentId} onlyTopLevel exclude={c.id} emptyLabel="— ראשית —"
              onChange={parentId => patch.mutate({ id: c.id, body: { parentId } })} />
          )}
        </td>
        <td className="min-w-32">
          <Picker className="input py-1" value={c.kind} options={KIND_OPTIONS} searchable={false}
            onChange={v => v && patch.mutate({ id: c.id, body: { kind: v } })} />
        </td>
        <td className="text-center"><input type="checkbox" checked={!!c.defaultFixed} onChange={e => patch.mutate({ id: c.id, body: { defaultFixed: e.target.checked ? 1 : 0 } })} /></td>
        <td className="text-center"><input type="checkbox" checked={!!c.discretionary} onChange={e => patch.mutate({ id: c.id, body: { discretionary: e.target.checked ? 1 : 0 } })} /></td>
        <td className="text-end text-xs text-zinc-500">
          {c.transactions > 0 ? <Link className="hover:underline" to={`/transactions`}>{c.transactions} תנועות</Link> : '—'}
          {c.transactions > 0 && <div><Money value={c.total} /></div>}
        </td>
        <td className="whitespace-nowrap">
          <div className="flex items-center justify-end gap-0.5">
          {depth === 0 && <button className="btn-ghost text-xs" onClick={() => setAdding({ name: '', parentId: c.id })}><Plus />תת-קטגוריה</button>}
          <button className="btn-ghost text-xs text-rose-600 hover:text-rose-700 dark:text-rose-400" onClick={() => setDeleting({ cat: c, moveTo: c.parentId })}><Trash2 />מחק / מזג</button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <>
      <PageHeader title="קטגוריות" icon={Layers} subtitle="הוסיפו קטגוריות, קבצו אותן תחת קטגוריה ראשית (למשל ״רכב״ ← דלק, חניונים, ביטוח רכב), ומזגו כפילויות"
        actions={<>
          <div className="relative max-sm:flex-1">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input className="input w-48 ps-8 max-sm:w-full" placeholder="חיפוש…" value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={() => setAdding({ name: '', parentId: null })}><Plus />קטגוריה חדשה</button>
        </>} />

      {error && <div role="alert" className="card animate-rise-in mb-3 border-rose-200 bg-rose-50/60 text-sm text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200">{error}</div>}

      <div className="card animate-rise-in scroll-x p-0">
        <table className="table">
          <thead>
            <tr>
              <th>שם</th><th>קטגוריית אב</th><th>סוג</th>
              <th className="text-center" title="נספרת כהוצאה קבועה כברירת מחדל">קבועה</th>
              <th className="text-center" title="ניתנת לצמצום בחודש לחוץ">ניתנת לצמצום</th>
              <th className="text-end">שימוש</th><th />
            </tr>
          </thead>
          <tbody>
            {tops.map(c => [row(c, 0), ...childrenOf(c.id).filter(ch => !q || ch.name.includes(q) || c.name.includes(q)).map(ch => row(ch, 1))])}
          </tbody>
        </table>
      </div>

      {adding && (
        <Modal title={adding.parentId ? 'תת-קטגוריה חדשה' : 'קטגוריה חדשה'} onClose={() => setAdding(null)} footer={<>
          <button className="btn" onClick={() => setAdding(null)}>ביטול</button>
          <button className="btn btn-primary" disabled={!adding.name.trim() || create.isPending} onClick={() => create.mutate(adding)}>הוסף</button>
        </>}>
          <Field label="שם"><input className="input" autoFocus value={adding.name} onChange={e => setAdding({ ...adding, name: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && adding.name.trim() && create.mutate(adding)} /></Field>
          <Field label="קטגוריית אב (לא חובה)">
            <CategorySelect value={adding.parentId} onlyTopLevel emptyLabel="— ראשית —" onChange={parentId => setAdding({ ...adding, parentId })} />
          </Field>
          <p className="text-xs leading-relaxed text-zinc-500">תת-קטגוריה יורשת מהאב את הסוג ואת ההגדרה קבועה/ניתנת לצמצום.</p>
        </Modal>
      )}

      {deleting && (
        <Modal title={`מחיקת ״${deleting.cat.name}״`} onClose={() => setDeleting(null)} footer={<>
          <button className="btn" onClick={() => setDeleting(null)}>ביטול</button>
          <button className="btn btn-danger" disabled={remove.isPending}
            onClick={() => remove.mutate({ id: deleting.cat.id, moveTo: deleting.moveTo })}>
            {deleting.moveTo ? 'מזג ומחק' : 'מחק'}
          </button>
        </>}>
          <p className="text-sm">
            {deleting.cat.transactions > 0
              ? <>ל״{deleting.cat.name}״ משויכות {deleting.cat.transactions} תנועות. לאן להעביר אותן (יחד עם התקציב והכללים)?</>
              : 'הקטגוריה לא בשימוש.'}
          </p>
          <Field label="להעביר ל-">
            <CategorySelect value={deleting.moveTo} exclude={deleting.cat.id} emptyLabel="ללא קטגוריה (לסיווג מחדש)"
              onChange={moveTo => setDeleting({ ...deleting, moveTo })} />
          </Field>
          {childrenOf(deleting.cat.id).length > 0 && <p className="text-xs text-amber-600">תתי-הקטגוריות שלה יהפכו לקטגוריות ראשיות.</p>}
        </Modal>
      )}
    </>
  );
}
