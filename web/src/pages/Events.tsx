import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, type Tx } from '../api';
import { useLookups } from '../state';
import { day, fullDate, moneyIn } from '../format';
import { CalendarDays, Coins, HandCoins, Hash, PieChart, Tags, Users, Wallet } from 'lucide-react';
import { Empty, ErrorBox, Field, Loading, MemberBadge, Modal, Money, PageHeader, Progress, SectionTitle, Stat } from '../components/ui';
import { Columns, DonutChart } from '../components/charts';
import { categoryIcon, hueFor, MemberAvatar } from '@/lib/visuals';

interface EventRow {
  id: number; name: string; color: string | null; startDate: string | null; endDate: string | null;
  budget: number | null; notes: string | null; archived: number; total: number; count: number;
  firstDate: string | null; lastDate: string | null;
}
type EventTx = Tx & { originalAmount?: number; originalCurrency?: string | null; foreign?: boolean };
interface Breakdown { key: string; amount: number; count: number }
interface EventDetail {
  event: EventRow; total: number; spend: number; refunds: number; count: number; firstDate: string | null; lastDate: string | null;
  byCategory: Breakdown[]; byMember: Breakdown[]; byDay: Breakdown[];
  byCurrency: { currency: string; original: number; ils: number; count: number }[];
  transactions: EventTx[];
}

export default function Events() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selected = params.get('id') ? Number(params.get('id')) : null;
  const [editing, setEditing] = useState<Partial<EventRow> | null>(null);

  const events = useQuery({ queryKey: ['events'], queryFn: () => api.get<EventRow[]>('/events') });
  const save = useMutation({
    mutationFn: (e: Partial<EventRow>) => {
      const body = { name: e.name, startDate: e.startDate || null, endDate: e.endDate || null, budget: e.budget || null, notes: e.notes || null, archived: e.archived ?? 0 };
      return e.id ? api.patch<EventRow>(`/tags/${e.id}`, body) : api.post<EventRow>('/tags', body);
    },
    onSuccess: saved => {
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['meta'] });
      qc.invalidateQueries({ queryKey: ['event'] });
      setEditing(null);
      setParams({ id: String(saved.id) });
    },
  });

  if (events.isLoading) return <Loading />;
  if (events.error) return <ErrorBox error={events.error} />;
  const list = events.data ?? [];
  const current = selected ?? list.find(e => !e.archived)?.id ?? null;

  return (
    <>
      <PageHeader icon={Tags} title="אירועים ותגיות" subtitle="תייגו הוצאות של חופשה, שיפוץ, חתונה או כל פרויקט — ותראו כמה עלה בסך הכל"
        actions={<button className="btn btn-primary" onClick={() => setEditing({})}>+ אירוע חדש</button>} />

      {list.length === 0 ? (
        <Empty>
          עוד אין אירועים. צרו אירוע (למשל ״חופשה בגרמניה״) עם תאריכים, ואז בחרו מהתנועות שבתאריכים האלה מה שייך אליו.
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-4">
          <div className="stagger grid content-start gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {list.map((e, i) => (
              <button key={e.id} onClick={() => setParams({ id: String(e.id) })}
                aria-pressed={current === e.id} style={{ ['--i' as string]: i }}
                className={`card card-hover relative block w-full overflow-hidden p-3.5 text-start md:p-3.5 ${current === e.id ? 'border-primary/45 bg-gradient-to-l from-primary/12 via-primary/5 to-card ring-1 ring-primary/35' : ''} ${e.archived ? 'opacity-50' : ''}`}>
                {current === e.id && <span aria-hidden className="absolute inset-y-0 start-0 w-1 bg-gradient-to-b from-[var(--chart-1)] to-[var(--chart-5)]" />}
                <div className="flex items-center gap-2">
                  <span className="icon-tile h-6 w-6 rounded-md [&_svg]:h-3.5 [&_svg]:w-3.5" style={{ ['--tile' as string]: e.color ?? hueFor(e.name) }}><Tags /></span>
                  <div className="min-w-0 truncate font-semibold">{e.name}</div>
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {e.startDate ? `${day(e.startDate)} – ${day(e.endDate ?? e.startDate)}` : e.firstDate ? `${day(e.firstDate)} – ${day(e.lastDate)}` : 'ללא תאריכים'}
                  {' · '}{e.count} תנועות
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <Money value={e.total} className="text-lg font-semibold tracking-tight" />
                  {e.budget ? <span className="text-xs text-zinc-500">מתוך <Money value={e.budget} /></span> : null}
                </div>
                {e.budget ? <Progress className="mt-2 h-1" value={e.total} max={e.budget} status={e.total > e.budget ? 'over' : e.total > e.budget * 0.8 ? 'warning' : 'ok'} /> : null}
              </button>
            ))}
          </div>
          <div className="min-w-0 lg:col-span-3">
            {current != null && <EventDetailView id={current} onEdit={e => setEditing(e)} />}
          </div>
        </div>
      )}

      {editing && (
        <Modal title={editing.id ? 'עריכת אירוע' : 'אירוע חדש'} onClose={() => setEditing(null)} footer={<>
          <button className="btn" onClick={() => setEditing(null)}>ביטול</button>
          {editing.id && <button className="btn" onClick={() => save.mutate({ ...editing, archived: editing.archived ? 0 : 1 })}>{editing.archived ? 'החזר מארכיון' : 'העבר לארכיון'}</button>}
          <button className="btn btn-primary" disabled={!editing.name?.trim()} onClick={() => save.mutate(editing)}>שמור</button>
        </>}>
          <Field label="שם"><input className="input" autoFocus value={editing.name ?? ''} placeholder="חופשה בגרמניה" onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="מתאריך"><input className="input" type="date" value={editing.startDate ?? ''} onChange={e => setEditing({ ...editing, startDate: e.target.value })} /></Field>
            <Field label="עד תאריך"><input className="input" type="date" value={editing.endDate ?? ''} onChange={e => setEditing({ ...editing, endDate: e.target.value })} /></Field>
          </div>
          <Field label="תקציב (לא חובה)"><input className="input num" type="number" value={editing.budget ?? ''} onChange={e => setEditing({ ...editing, budget: e.target.value ? Number(e.target.value) : null })} /></Field>
          <Field label="הערות"><textarea className="input" rows={2} value={editing.notes ?? ''} onChange={e => setEditing({ ...editing, notes: e.target.value })} /></Field>
          <p className="text-xs leading-relaxed text-zinc-500">התאריכים משמשים להצעת תנועות מתאימות. אפשר לתייג גם תנועות מחוץ לתאריכים (למשל טיסות שנקנו מראש).</p>
        </Modal>
      )}
    </>
  );
}

function EventDetailView({ id, onEdit }: { id: number; onEdit: (e: EventRow) => void }) {
  const qc = useQueryClient();
  const { member } = useLookups();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const detail = useQuery({ queryKey: ['event', id], queryFn: () => api.get<EventDetail>(`/events/${id}`) });
  const candidates = useQuery({
    queryKey: ['event-candidates', id, range],
    queryFn: () => api.get<{ from: string | null; to: string | null; rows: EventTx[] }>(`/events/${id}/candidates${qs(range ?? {})}`),
  });

  useEffect(() => { setRange(null); setPicked(new Set()); }, [id]);
  useEffect(() => {
    // pre-select foreign-currency rows — on a trip abroad those are almost always part of it
    setPicked(new Set((candidates.data?.rows ?? []).filter(r => r.foreign).map(r => r.id)));
  }, [candidates.data]);

  const change = useMutation({
    mutationFn: (b: { add?: number[]; remove?: number[] }) => api.post(`/events/${id}/transactions`, b),
    onSuccess: () => {
      setPicked(new Set());
      for (const k of ['event', 'event-candidates', 'events', 'transactions']) qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (detail.isLoading) return <Loading />;
  if (detail.error || !detail.data) return <ErrorBox error={detail.error} />;
  const d = detail.data;
  const ev = d.event;
  const days = d.byDay.length;
  const catSlices = d.byCategory.map(c => {
    const Icon = categoryIcon(c.key);
    return { key: c.key, name: `${c.key} (${c.count})`, value: c.amount, icon: <Icon /> };
  });
  const catNegative = d.byCategory.filter(c => c.amount <= 0);
  const dayData = d.byDay.map(b => ({
    label: days > 8 ? `${Number(b.key.slice(8, 10))}.${Number(b.key.slice(5, 7))}` : day(b.key),
    value: b.amount,
  }));
  const cands = candidates.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">{ev.name}</h2>
            <div className="mt-0.5 text-sm text-zinc-500">
              {ev.startDate ? `${fullDate(ev.startDate)} – ${fullDate(ev.endDate ?? ev.startDate)}` : 'ללא תאריכים'}
              {ev.notes && <> · {ev.notes}</>}
            </div>
          </div>
          <button className="btn" onClick={() => onEdit(ev)}>✎ עריכה</button>
        </div>
        {ev.budget ? (
          <div className="mt-4">
            <div className="mb-1.5 flex justify-between text-sm"><span>תקציב</span><span><Money value={d.total} /> מתוך <Money value={ev.budget} /></span></div>
            <Progress value={d.total} max={ev.budget} status={d.total > ev.budget ? 'over' : d.total > ev.budget * 0.8 ? 'warning' : 'ok'} />
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 max-[22.5rem]:grid-cols-1 md:gap-4 lg:grid-cols-4">
        <Stat index={0} icon={Wallet} label="עלות כוללת" value={d.total} />
        <Stat index={1} icon={Hash} color="var(--chart-6)" label="תנועות" value={<span className="num">{d.count}</span>} />
        <Stat index={2} icon={CalendarDays} color="var(--chart-3)" label="ממוצע ליום הוצאה" value={days ? d.total / days : 0}
          spark={d.byDay.length > 1 ? d.byDay.map(b => b.amount) : undefined} />
        <Stat index={3} icon={HandCoins} tone="good" label="זיכויים" value={d.refunds} />
      </div>

      {d.count > 0 && d.byDay.length > 1 && (
        <div className="card min-w-0">
          <SectionTitle icon={CalendarDays} color="var(--chart-3)">הוצאה לפי יום</SectionTitle>
          <div className="scroll-x card-bleed">
            <div style={{ minWidth: Math.max(0, dayData.length * 30) }}>
              <Columns data={dayData} height={190} color="var(--chart-3)" />
            </div>
          </div>
        </div>
      )}

      {d.count > 0 && (
        <div className="grid gap-4 md:grid-cols-3">
          <div className="card min-w-0 md:col-span-2">
            <SectionTitle icon={PieChart}>לפי קטגוריה</SectionTitle>
            <DonutChart data={catSlices} max={8} />
            {catNegative.length > 0 && (
              <div className="mt-3 space-y-0.5 border-t border-line-soft pt-3 text-sm">
                {catNegative.map(c => (
                  <div key={c.key} className="flex items-center justify-between gap-3 px-2 py-1">
                    <span className="min-w-0 truncate">{c.key} <span className="text-xs text-zinc-500">({c.count})</span></span><Money value={c.amount} colored />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            <div className="card">
              <SectionTitle icon={Coins} color="var(--chart-5)">לפי מטבע</SectionTitle>
              {d.byCurrency.map(c => (
                <div key={c.currency} className="flex justify-between gap-3 border-b border-line-soft py-2 text-sm last:border-0">
                  <span className="num">{moneyIn(c.original, c.currency)}</span><Money value={c.ils} />
                </div>
              ))}
            </div>
            <div className="card">
              <SectionTitle icon={Users} color="var(--chart-6)">מי שילם</SectionTitle>
              {d.byMember.map(m => {
                const mm = member(Number(m.key));
                return (
                  <div key={m.key} className="flex items-center justify-between gap-3 border-b border-line-soft py-2 text-sm last:border-0">
                    <span className="flex min-w-0 items-center gap-2">{mm && <MemberAvatar name={mm.name} color={mm.color} size={20} />}<span className="truncate">{mm?.name ?? '—'}</span></span>
                    <Money value={m.amount} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="card p-0">
        <div className="card-title">התנועות באירוע</div>
        {d.transactions.length === 0 ? <div className="px-4 pb-4 text-sm text-zinc-500 md:px-5 md:pb-5">עוד לא תויגו תנועות — בחרו מהרשימה למטה</div> : (
          <div className="scroll-x"><table className="table">
            <thead><tr><th>תאריך</th><th>תיאור</th><th>קטגוריה</th><th>של מי</th><th className="text-end">מקור</th><th className="text-end">בשקלים</th><th /></tr></thead>
            <tbody>
              {d.transactions.map(t => (
                <tr key={t.id}>
                  <td className="whitespace-nowrap text-zinc-500">{day(t.date)}</td>
                  <td className="font-medium">{t.description}</td>
                  <td className="text-xs text-zinc-500">{t.categoryName}</td>
                  <td><MemberBadge id={t.memberId} /></td>
                  <td className="text-end text-xs text-zinc-500 num">{t.originalCurrency && t.originalCurrency !== 'ILS' && t.originalAmount != null ? moneyIn(t.originalAmount, t.originalCurrency.replace('€', 'EUR').replace('$', 'USD')) : ''}</td>
                  <td className="text-end"><Money value={t.amount} cents colored /></td>
                  <td><button className="btn-ghost btn-icon" aria-label="הסר מהאירוע" title="הסר מהאירוע" onClick={() => change.mutate({ remove: [t.id] })}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      <div className="card p-0">
        <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-1 pt-4 md:px-5 md:pt-5">
          <div>
            <div className="font-semibold">הוספת תנועות</div>
            <div className="text-xs text-zinc-500">תנועות לא מתויגות בתאריכים — עסקאות במט״ח מסומנות מראש</div>
          </div>
          <div className="flex flex-wrap items-end gap-2 max-sm:w-full">
            <label className="max-sm:flex-1"><span className="label">מ-</span><input className="input" type="date" value={range?.from ?? candidates.data?.from ?? ''}
              onChange={e => setRange({ from: e.target.value, to: range?.to ?? candidates.data?.to ?? e.target.value })} /></label>
            <label className="max-sm:flex-1"><span className="label">עד</span><input className="input" type="date" value={range?.to ?? candidates.data?.to ?? ''}
              onChange={e => setRange({ from: range?.from ?? candidates.data?.from ?? e.target.value, to: e.target.value })} /></label>
            <button className="btn btn-primary max-sm:w-full" disabled={!picked.size || change.isPending} onClick={() => change.mutate({ add: [...picked] })}>
              הוסף {picked.size || ''} לאירוע
            </button>
          </div>
        </div>
        {!candidates.data?.from ? (
          <div className="p-4 text-sm leading-relaxed text-zinc-500 md:px-5 md:pb-5">הגדירו תאריכים לאירוע (✎ עריכה) או בחרו טווח כאן כדי לראות תנועות מתאימות. אפשר גם לתייג מעמוד התנועות.</div>
        ) : cands.length === 0 ? <div className="p-4 text-sm text-zinc-500 md:px-5 md:pb-5">אין תנועות נוספות בטווח הזה</div> : (
          <div className="scroll-x mt-3"><table className="table">
            <thead><tr>
              <th className="w-8"><input type="checkbox" checked={cands.every(c => picked.has(c.id))}
                onChange={e => setPicked(e.target.checked ? new Set(cands.map(c => c.id)) : new Set())} /></th>
              <th>תאריך</th><th>תיאור</th><th>קטגוריה</th><th className="text-end">מקור</th><th className="text-end">בשקלים</th>
            </tr></thead>
            <tbody>
              {cands.map(t => (
                <tr key={t.id} className={picked.has(t.id) ? 'bg-selected' : ''}>
                  <td><input type="checkbox" checked={picked.has(t.id)}
                    onChange={() => setPicked(p => { const n = new Set(p); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })} /></td>
                  <td className="whitespace-nowrap text-zinc-500">{day(t.date)}</td>
                  <td className="font-medium">{t.description}{t.foreign && <span className="chip ms-2">מט״ח</span>}</td>
                  <td className="text-xs text-zinc-500">{t.categoryName}</td>
                  <td className="text-end text-xs text-zinc-500 num">{t.foreign && t.originalAmount != null ? moneyIn(t.originalAmount, (t.originalCurrency ?? 'ILS').replace('€', 'EUR').replace('$', 'USD')) : ''}</td>
                  <td className="text-end"><Money value={t.amount} cents colored /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
