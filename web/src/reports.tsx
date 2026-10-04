import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ReportDetail, type ReportItem, type ReportStatus } from './api';
import { day, money } from './format';
import { Panel, UploadIcon, button, primaryButton } from './ui';

const PRODUCT_TYPES: Record<string, string> = {
  pension: 'Pension', study_fund: 'Study fund', provident_fund: 'Provident fund', mutual_fund: 'Fund', brokerage: 'Brokerage', deposit: 'Deposit',
  other: 'Other',
};
const STATUS: Record<ReportStatus, { label: string; className: string }> = {
  extracting: { label: 'Reading…', className: 'bg-ink/[0.05] text-muted' },
  needs_review: { label: 'Review', className: 'bg-warn/15 text-warn' },
  applied: { label: 'Applied', className: 'bg-up/10 text-up' },
  superseded: { label: 'Replaced', className: 'bg-ink/[0.05] text-faint' },
  failed: { label: 'Failed', className: 'bg-down/10 text-down' },
};

export function StatusChip({ status }: { status: ReportStatus }) {
  return <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${STATUS[status].className}`}>{STATUS[status].label}</span>;
}

/** "Add report": the dialog from the top-bar button, and the same dialog as a drop target while a file is dragged over the page. */
export function AddReport() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); depth.current++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth.current <= 0) { depth.current = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) upload(file);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('keydown', key);
    };
  }, []);

  function upload(file: File) {
    setError(null);
    setBusy(true);
    setOpen(true);
    api.uploadReport(file)
      .then(r => {
        qc.invalidateQueries({ queryKey: ['reports'] });
        qc.invalidateQueries({ queryKey: ['integrations'] });
        if (r.duplicate) setError('Already imported');
        else setOpen(false);
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <button type="button" onClick={() => { setError(null); setOpen(true); }} className={button}>
        <UploadIcon className="h-3.5 w-3.5" /><span className="max-sm:hidden">Add report</span>
      </button>
      {(open || dragging) && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-xl" onClick={e => e.stopPropagation()}>
            <div className={`m-4 flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-sm transition-colors ${
              dragging ? 'border-accent bg-accent/5' : 'border-line'}`}>
              <UploadIcon className="h-6 w-6 text-faint" />
              <span className="font-medium text-ink">{busy ? 'Uploading…' : 'Drop a report'}</span>
              <button type="button" disabled={busy} onClick={() => input.current?.click()} className={button}>Choose file</button>
              <input ref={input} type="file" className="hidden" accept=".pdf,.csv,.tsv,.txt,.xlsx,.png,.jpg,.jpeg,.webp,.gif"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
              {error && <span className="text-xs text-down">{error}</span>}
            </div>
            <div className="border-t border-line px-5 py-3 text-xs text-faint">Sent to Anthropic through your Claude login.</div>
          </div>
        </div>
      )}
    </>
  );
}

export function ReportList({ reports, onOpen }: { reports: ReportItem[]; onOpen: (id: number) => void }) {
  return (
    <ul>
      {reports.map(r => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)} className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-paper">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink"><bdi>{r.issuer ?? r.name ?? `Report ${r.id}`}</bdi></div>
              <div className="truncate text-xs text-faint">{r.asOf ? day(r.asOf) : '—'}{r.name && r.issuer ? <> · <bdi>{r.name}</bdi></> : ''}</div>
            </div>
            <StatusChip status={r.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ReportPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: r } = useQuery({ queryKey: ['report', id], queryFn: () => api.report(id),
    refetchInterval: q => (q.state.data?.status === 'extracting' ? 2000 : false) });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => { setAnswers({}); setBalances({}); setDate(r?.asOf ?? ''); }, [r?.status, r?.asOf]);

  const review = r?.status === 'needs_review';
  const refresh = () => qc.invalidateQueries();
  const send = (detail: ReportDetail) => {
    setBusy(true);
    setError(null);
    const edits = {
      asOf: date && date !== detail.asOf ? date : undefined,
      balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, Number(v.replace(/,/g, ''))]).filter(([, v]) => Number.isFinite(v))),
    };
    api.answerReport(detail.id, answers, edits).then(refresh).catch(e => setError((e as Error).message)).finally(() => setBusy(false));
  };
  const remove = () => {
    if (!confirm('Delete this report and its values?')) return;
    api.deleteReport(id).then(() => { refresh(); onClose(); }).catch(e => setError((e as Error).message));
  };
  const field = 'rounded-lg border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent';

  return (
    <Panel onClose={onClose} wide>
      <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-6">
        <div className="min-w-0">
          <div className="truncate text-xs text-muted"><bdi>{r?.name}</bdi></div>
          <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-ink"><bdi>{r?.issuer ?? 'Report'}</bdi></h2>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted">
            {r && <StatusChip status={r.status} />}
            {r?.asOf && <span>{day(r.asOf)}</span>}
            {r?.owner && <span>· <bdi>{r.owner}</bdi></span>}
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1 text-xs font-medium text-muted hover:bg-ink/5 hover:text-ink">Close</button>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-6">
        {r?.error && <p className="text-sm text-down">{r.error}</p>}
        {review && r.questions.length > 0 && (
          <ol className="space-y-4">
            {r.questions.map(q => (
              <li key={q.id} className="text-sm">
                <div className="text-ink" dir="auto">{q.text}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {q.id === 'asof' ? (
                    <input type="date" value={answers.asof ?? ''} onChange={e => setAnswers({ ...answers, asof: e.target.value })} className={field} />
                  ) : q.options?.length ? q.options.map(o => (
                    <button key={o} type="button" onClick={() => setAnswers({ ...answers, [q.id]: o })}
                      className={`rounded-lg border px-3 py-1 text-xs font-medium ${answers[q.id] === o ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink hover:bg-paper'}`}>
                      <bdi>{o}</bdi>
                    </button>
                  )) : (
                    <input value={answers[q.id] ?? ''} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} dir="auto" className={`${field} w-full`} />
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {r && r.products.length > 0 && (
          <div className="rounded-2xl border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 text-left font-medium">Product</th>
                  <th className="px-4 py-2 text-left font-medium max-sm:hidden">Type</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line border-t border-line">
                {r.products.map(p => (
                  <tr key={p.key} title={p.evidence}>
                    <td className="px-4 py-2.5">
                      <div className="text-ink"><bdi>{p.name}</bdi>{p.accountNumber && <span className="text-faint"> ••{p.accountNumber.replace(/\D/g, '').slice(-4)}</span>}</div>
                      <div className="text-xs text-faint"><bdi>{p.provider}</bdi>{p.liquidityDate && <> · Liquid from {day(p.liquidityDate)}</>}</div>
                    </td>
                    <td className="px-4 py-2.5 text-muted max-sm:hidden">{PRODUCT_TYPES[p.productType] ?? p.productType}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {review ? (
                        <input inputMode="decimal" value={balances[p.key] ?? String(p.balance)} onChange={e => setBalances({ ...balances, [p.key]: e.target.value })}
                          className={`${field} w-32 text-right tabular-nums ${p.confidence < 0.8 ? 'border-warn' : ''}`} />
                      ) : <span className="text-ink">{money(p.balance, p.currency)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {r.statedTotal != null && (
                <tfoot className="border-t border-line text-muted">
                  <tr><td className="px-4 py-2.5" colSpan={2}>Report total</td><td className="px-4 py-2.5 text-right tabular-nums">{money(r.statedTotal, r.currency ?? 'ILS')}</td></tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {review && (
          <label className="flex items-center gap-2 text-sm text-muted">
            Date <input type="date" value={date} onChange={e => setDate(e.target.value)} className={field} />
          </label>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-3 text-xs">
        <button type="button" onClick={remove} className="font-medium text-muted hover:text-down">Delete</button>
        <div className="flex items-center gap-3">
          {error && <span className="text-down">{error}</span>}
          {review && <button type="button" disabled={busy} onClick={() => send(r)} className={primaryButton}>{busy ? 'Checking…' : 'Send'}</button>}
        </div>
      </div>
    </Panel>
  );
}

export function useReports() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['reports'], queryFn: api.reports,
    refetchInterval: q => (q.state.data?.some(r => r.status === 'extracting') ? 2000 : false) });
  // a report finished reading: its values may have changed the dashboard
  const reading = query.data?.filter(r => r.status === 'extracting').length ?? 0;
  const before = useRef(reading);
  useEffect(() => {
    if (reading < before.current) qc.invalidateQueries({ predicate: q => q.queryKey[0] !== 'reports' });
    before.current = reading;
  }, [reading, qc]);
  return query.data ?? [];
}
