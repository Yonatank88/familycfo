import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { api, type Account, type ExpenseMonth, type Group, type Holding, type Range, type ReportDetail, type ReportItem, type ReportStatus,
  type ScrapeState, type Slice } from './api';
import { asOf, day, money, monthLong, monthShort, pct, shortDay, signedMoney, signedPct, type Currency } from './format';

const RANGES: Range[] = ['1M', '3M', 'YTD', '1Y', 'All'];
const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const OTHER = 'var(--c7)';

/** A section: title (and an optional control) above a quiet card. */
function Section({ title, action, children, flush = false }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section>
      <div className="flex min-h-8 items-center justify-between gap-3 pb-2">
        <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {action}
      </div>
      <div className={`rounded-xl border border-line/80 bg-surface/80 ${flush ? 'py-1' : 'p-4'}`}>{children}</div>
    </section>
  );
}

function Pills<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: (v: T) => boolean;
}) {
  return (
    <div className="inline-flex rounded-full bg-ink/[0.045] p-0.5 text-xs">
      {options.map(o => (
        <button key={o.value} type="button" disabled={disabled?.(o.value)} onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1 font-medium transition-colors disabled:opacity-40 ${
            o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');

function Change({ now, start, currency }: { now: number; start: number | null | undefined; currency: Currency }) {
  if (start == null) return <span className="text-faint">—</span>;
  const diff = now - start;
  return (
    <span className={`tabular-nums ${tone(diff)}`}>
      {signedMoney(diff, currency)}<span className="mx-1.5 text-line">|</span>{signedPct(start ? (diff / Math.abs(start)) * 100 : null)}
    </span>
  );
}

function useScrape() {
  const qc = useQueryClient();
  const [state, setState] = useState<ScrapeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = state?.status === 'running' || state?.status === 'pipeline';

  useEffect(() => { api.scrape().then(setState).catch(() => {}); }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api.scrape().then(s => {
        setState(s);
        if (s.status === 'done' || s.status === 'failed') qc.invalidateQueries();
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [running, qc]);

  return {
    state, running, error,
    start: () => { setError(null); api.startScrape().then(setState).catch(e => setError((e as Error).message)); },
    otp: (code: string) => api.submitOtp(code).then(() => api.scrape().then(setState)).catch(e => setError((e as Error).message)),
  };
}

function Refresh() {
  const { state, running, error, start, otp } = useScrape();
  const [code, setCode] = useState('');
  const done = state?.companies.filter(c => c.status === 'done' || c.status === 'failed').length ?? 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      {state?.otp && (
        <form className="flex items-center gap-1.5" onSubmit={e => { e.preventDefault(); otp(code.trim()); setCode(''); }}>
          <label className="text-muted" htmlFor="otp">{state.otp.company} code</label>
          <input id="otp" value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
            className="w-24 rounded-full border border-line bg-surface px-3 py-1 outline-none focus:border-faint" />
          <button type="submit" className="rounded-full bg-ink px-3 py-1 font-medium text-paper">Send</button>
        </form>
      )}
      {error && <span className="text-down">{error}</span>}
      {running && <span className="tabular-nums text-muted">{state?.status === 'pipeline' ? 'Processing…' : `Refreshing ${done}/${state?.companies.length ?? 0}`}</span>}
      <button type="button" onClick={start} disabled={running}
        className="rounded-full border border-line bg-surface px-3.5 py-1 font-medium text-ink shadow-sm hover:bg-paper disabled:opacity-50">
        Refresh
      </button>
    </div>
  );
}

function ChartTooltip({ active, payload, label, currency, labels }: {
  active?: boolean; payload?: { dataKey: string; value: number; color: string }[]; label?: string; currency: Currency; labels: Record<string, string>;
}) {
  if (!active || !payload?.length || !label) return null;
  const rows = [...payload].filter(p => p.value).sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, p) => s + p.value, 0);
  return (
    <div className="min-w-48 rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-md backdrop-blur">
      <div className="mb-1.5 text-muted">{day(label)}</div>
      {rows.map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-6 py-0.5">
          <span className="flex items-center gap-1.5 text-muted"><span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />{labels[p.dataKey]}</span>
          <span className="tabular-nums text-ink">{money(p.value, currency)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between gap-6 border-t border-line pt-1.5 font-medium text-ink">
        <span>Total</span><span className="tabular-nums">{money(total, currency)}</span>
      </div>
    </div>
  );
}

function Allocation({ slices, currency, convert, colorOf }: {
  slices: Slice[]; currency: Currency; convert: (n: number) => number; colorOf: (key: string) => string;
}) {
  const top = slices.length > 5 ? [...slices.slice(0, 4), { key: 'other', label: 'Other', value: slices.slice(4).reduce((s, x) => s + x.value, 0) }] : slices;
  const total = top.reduce((s, x) => s + x.value, 0);
  if (!total) return <p className="text-sm text-faint">No data</p>;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col">
      <div className="h-36 w-36 shrink-0">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={top} dataKey="value" nameKey="label" innerRadius="70%" outerRadius="100%" paddingAngle={2} cornerRadius={3}
              stroke="none" isAnimationActive={false}>
              {top.map(s => <Cell key={s.key} fill={colorOf(s.key)} />)}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ol className="w-full min-w-0 flex-1 space-y-2 text-sm">
        {top.map(s => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-ink">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(s.key) }} />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
              <span className="text-muted">{money(convert(s.value), currency)}</span>
              <span className="w-9 text-right text-xs text-faint">{Math.round((s.value / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Accounts({ accounts, currency, convert }: { accounts: Account[]; currency: Currency; convert: (n: number) => number }) {
  return (
    <ul className="divide-y divide-line/70">
      {accounts.map(a => (
        <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm text-ink">
              <span className="truncate">{a.label}</span>
              {a.stale && <span title={`Last successful sync: ${asOf(a.lastSuccessAt)}`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
            </div>
            <div className="truncate text-xs text-faint">{a.label === a.sourceLabel ? '' : <><bdi>{a.sourceLabel}</bdi> · </>}{asOf(a.asOf)}</div>
          </div>
          <div className="text-right tabular-nums">
            <div className={`text-sm ${a.fxMissing ? 'text-warn' : 'text-ink'}`}>{a.valueIls == null ? '—' : money(convert(a.valueIls), currency)}</div>
            {a.currency !== 'ILS' && a.value != null && <div className="text-xs text-faint">{money(a.value, a.currency)}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Holdings({ holdings, currency, convert }: { holdings: Holding[]; currency: Currency; convert: (n: number) => number }) {
  const [all, setAll] = useState(false);
  const shown = all ? holdings : holdings.slice(0, 10);
  const th = 'px-4 pb-2 pt-2 text-[11px] font-medium uppercase tracking-wide text-faint';
  return (
    <>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Symbol</th>
            <th className={`${th} text-right`}>Value</th>
            <th className={`${th} text-right max-sm:hidden`}>Weight</th>
            <th className={`${th} text-right`}>Change</th>
            <th className={`${th} text-right`}>Gain</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70 border-t border-line/70">
          {shown.map(h => (
            <tr key={h.id}>
              <td className="px-4 py-2.5">
                <div className="font-medium text-ink">{h.symbol}</div>
                <div className="max-w-40 truncate text-xs text-faint sm:max-w-56"><bdi>{h.sourceLabel}</bdi>{h.name !== h.symbol && <> · <bdi>{h.name}</bdi></>}</div>
                {h.liquidityDate && <div className="text-xs text-faint">Liquid from {day(h.liquidityDate)}</div>}
              </td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${h.fxMissing ? 'text-warn' : 'text-ink'}`}>
                {h.valueIls == null ? money(h.value, h.currency) : money(convert(h.valueIls), currency)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted max-sm:hidden">{pct(h.pctOfInvestments)}</td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${tone(h.changePct)}`}>{signedPct(h.changePct)}</td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${tone(h.gainPct)}`}>
                {h.gainIls == null ? <span className="text-faint">—</span> : (
                  <>
                    <div>{signedMoney(convert(h.gainIls), currency)}</div>
                    <div className="text-xs">{signedPct(h.gainPct)}</div>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {holdings.length > 10 && (
        <div className="border-t border-line/70 px-4 pb-2 pt-2.5">
          <button type="button" onClick={() => setAll(!all)} className="text-xs font-medium text-muted hover:text-ink">
            {all ? 'Show top 10' : `Show all ${holdings.length}`}
          </button>
        </div>
      )}
    </>
  );
}

const PRODUCT_TYPES: Record<string, string> = {
  pension: 'Pension', study_fund: 'Study fund', provident_fund: 'Provident fund', brokerage: 'Brokerage', deposit: 'Deposit', other: 'Other',
};
const STATUS: Record<ReportStatus, { label: string; className: string }> = {
  extracting: { label: 'Reading…', className: 'bg-ink/[0.045] text-muted' },
  needs_review: { label: 'Review', className: 'bg-warn/15 text-warn' },
  applied: { label: 'Applied', className: 'bg-up/10 text-up' },
  superseded: { label: 'Replaced', className: 'bg-ink/[0.045] text-faint' },
  failed: { label: 'Failed', className: 'bg-down/10 text-down' },
};

function StatusChip({ status }: { status: ReportStatus }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS[status].className}`}>{STATUS[status].label}</span>;
}

/** "Add report": the dialog from the header button, and the same dialog as a drop target while a file is dragged over the page. */
function AddReport() {
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
        if (r.duplicate) setError('Already imported');
        else setOpen(false);
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <button type="button" onClick={() => { setError(null); setOpen(true); }}
        className="rounded-full border border-line bg-surface px-3.5 py-1 text-xs font-medium text-ink shadow-sm hover:bg-paper">
        Add report
      </button>
      {(open || dragging) && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-ink/15 p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-line bg-paper shadow-xl" onClick={e => e.stopPropagation()}>
            <div className={`m-4 flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-sm transition-colors ${
              dragging ? 'bg-surface' : 'border-line'}`} style={dragging ? { borderColor: 'var(--c1)' } : undefined}>
              <span className="font-medium text-ink">{busy ? 'Uploading…' : 'Drop a report'}</span>
              <button type="button" disabled={busy} onClick={() => input.current?.click()}
                className="rounded-full border border-line bg-surface px-3.5 py-1 text-xs font-medium text-ink shadow-sm hover:bg-paper disabled:opacity-50">
                Choose file
              </button>
              <input ref={input} type="file" className="hidden" accept=".pdf,.csv,.tsv,.txt,.xlsx,.png,.jpg,.jpeg,.webp,.gif"
                onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
              {error && <span className="text-xs text-down">{error}</span>}
            </div>
            <div className="border-t border-line/70 px-5 py-3 text-xs text-faint">Sent to Anthropic through your Claude login.</div>
          </div>
        </div>
      )}
    </>
  );
}

function Reports({ reports, onOpen }: { reports: ReportItem[]; onOpen: (id: number) => void }) {
  return (
    <ul className="divide-y divide-line/70">
      {reports.map(r => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ink/[0.025]">
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

function ReportPanel({ id, onClose }: { id: number; onClose: () => void }) {
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
  const field = 'rounded-md border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-faint';

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/15" onClick={onClose}>
      <aside className="flex h-full w-full max-w-2xl flex-col border-l border-line bg-paper shadow-xl" onClick={e => e.stopPropagation()}>
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
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-xs font-medium text-muted hover:bg-ink/5 hover:text-ink">Close</button>
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
                        className={`rounded-full border px-3 py-1 text-xs font-medium ${answers[q.id] === o ? 'border-ink bg-ink text-paper' : 'border-line bg-surface text-ink hover:bg-paper'}`}>
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
            <div className="rounded-xl border border-line/80 bg-surface/80">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-faint">
                    <th className="px-4 py-2 text-left font-medium">Product</th>
                    <th className="px-4 py-2 text-left font-medium max-sm:hidden">Type</th>
                    <th className="px-4 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70 border-t border-line/70">
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
                  <tfoot className="border-t border-line/70 text-muted">
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
        <div className="flex items-center justify-between gap-3 border-t border-line/70 px-6 py-3 text-xs">
          <button type="button" onClick={remove} className="font-medium text-muted hover:text-down">Delete</button>
          <div className="flex items-center gap-3">
            {error && <span className="text-down">{error}</span>}
            {review && (
              <button type="button" disabled={busy} onClick={() => send(r)}
                className="rounded-full bg-ink px-3.5 py-1 font-medium text-paper disabled:opacity-50">
                {busy ? 'Checking…' : 'Send'}
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function useReports() {
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

function ExpenseRowsPanel({ month, merchant, onClose }: { month: string; merchant?: { key: string; name: string }; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['expense-rows', month, merchant?.key], queryFn: () => api.expenseRows(month, merchant?.key) });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const total = data?.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/15" onClick={onClose}>
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-line bg-paper shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 pb-4 pt-6">
          <div>
            <div className="text-xs text-muted">{monthLong(month)}</div>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-ink" dir="auto">{merchant?.name ?? 'Expenses'}</h2>
            {total != null && <div className="mt-1 text-sm tabular-nums text-muted">{money(total)}</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-xs font-medium text-muted hover:bg-ink/5 hover:text-ink">Close</button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="rounded-xl border border-line/80 bg-surface/80">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Description</th>
                  <th className="px-4 py-2 text-left font-medium max-sm:hidden">Account</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70 border-t border-line/70">
                {data?.map(r => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{shortDay(r.date)}</td>
                    <td className="px-4 py-2.5 text-ink" dir="auto">{r.description}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted max-sm:hidden">{r.account}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Expenses({ months, current }: { months: ExpenseMonth[]; current: string }) {
  const [selected, setSelected] = useState(months.some(m => m.month === current) ? current : months.at(-1)!.month);
  const [panel, setPanel] = useState<{ month: string; merchant?: { key: string; name: string } } | null>(null);
  const month = months.find(m => m.month === selected) ?? months.at(-1)!;
  return (
    <Section title="Expenses" action={<span className="text-xs tabular-nums text-muted">{monthLong(month.month)} · {money(month.total)}</span>}>
      <div className="grid gap-6 md:grid-cols-5">
        <div className="h-48 md:col-span-3">
          <ResponsiveContainer>
            <BarChart data={months} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
              onClick={(e: { activeLabel?: string | number } | null) => {
                const m = e?.activeLabel != null ? String(e.activeLabel) : null;
                if (m) { setSelected(m); setPanel({ month: m }); }
              }}>
              <XAxis dataKey="month" tickFormatter={monthShort} tickLine={false} axisLine={false} fontSize={11} tick={{ fill: 'var(--color-faint)' }} />
              <Tooltip cursor={{ fill: 'rgba(29,28,26,0.04)' }}
                content={({ active, payload, label }) => active && payload?.length ? (
                  <div className="rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-md">
                    <div className="text-muted">{monthLong(String(label))}</div>
                    <div className="mt-0.5 tabular-nums text-ink">{money(Number(payload[0].value))}</div>
                  </div>
                ) : null} />
              <Bar dataKey="total" radius={[4, 4, 0, 0]} maxBarSize={28} className="cursor-pointer" isAnimationActive={false}>
                {months.map(m => (
                  <Cell key={m.month} fill={m.month === current ? 'var(--c1)' : m.month === selected ? 'var(--c2)' : '#e3ded1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ol className="text-sm md:col-span-2">
          {month.merchants.map(m => (
            <li key={m.key}>
              <button type="button" onClick={() => setPanel({ month: month.month, merchant: { key: m.key, name: m.name } })}
                className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left hover:bg-ink/[0.035]">
                <span className="truncate text-ink" dir="auto">{m.name}</span>
                <span className="shrink-0 tabular-nums text-muted">{money(m.total)}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      {panel && <ExpenseRowsPanel month={panel.month} merchant={panel.merchant} onClose={() => setPanel(null)} />}
    </Section>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState<Range>('1Y');
  const [group, setGroup] = useState<Group>('type');
  const [currency, setCurrency] = useState<Currency>('ILS');

  const summary = useQuery({ queryKey: ['summary', range], queryFn: () => api.summary(range), placeholderData: p => p });
  const history = useQuery({ queryKey: ['history', range, group], queryFn: () => api.history(range, group), placeholderData: p => p });
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: api.expenses });
  const reports = useReports();
  const [openReport, setOpenReport] = useState<number | null>(null);

  const s = summary.data;
  const h = history.data;
  const usdNow = s?.usdRate ?? null;
  const convert = (n: number) => (currency === 'USD' && usdNow ? n / usdNow : n);
  const atRate = (n: number, rate: number | null) => (currency === 'USD' && rate ? n / rate : n);

  const chart = useMemo(() => (h?.points ?? []).map(p => ({
    date: p.date,
    ...Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, atRate(v, p.usdRate)])),
  })), [h, currency]);
  const labels = Object.fromEntries((h?.series ?? []).map(x => [x.key, x.label]));
  // one color per series key, shared by the chart and the allocation
  const seriesKeys = (h?.series ?? []).map(x => x.key);
  const colorOf = (key: string) => {
    if (key === 'other') return OTHER;
    const i = seriesKeys.indexOf(key);
    return COLORS[(i >= 0 ? i : seriesKeys.length + (s?.allocation[group].findIndex(x => x.key === key) ?? 0)) % COLORS.length];
  };

  // the change compares today with the first day of the range, each converted at its own day's rate in $
  const first = h?.points[0];
  const startOf = (n: number | null | undefined) => (n == null || !first ? null : atRate(n, first.usdRate));
  const buckets = s ? [
    { label: 'Bank', now: s.bank, start: h?.start?.bank },
    { label: 'Investments', now: s.investments, start: h?.start?.investments },
    ...(s.cardsOwed != null ? [{ label: 'Cards owed', now: s.cardsOwed, start: h?.start?.cardsOwed }] : []),
  ] : [];

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-8">
        <span className="text-sm font-semibold tracking-tight text-ink">FamilyCFO</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Pills value={currency} onChange={setCurrency} disabled={v => v === 'USD' && !usdNow}
            options={[{ value: 'ILS', label: '₪' }, { value: 'USD', label: '$' }]} />
          <AddReport />
          <Refresh />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-12 sm:px-8">
        {summary.error && <p className="pt-8 text-sm text-down">{(summary.error as Error).message}</p>}

        {s && (
          <div className="pt-8">
            <div className="text-xs font-medium text-muted">Net worth</div>
            <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums text-ink">{money(convert(s.netWorth), currency)}</div>
            <div className="mt-1.5 text-sm font-light">
              <Change now={convert(s.netWorth)} start={startOf(h?.start?.netWorth)} currency={currency} />
            </div>
            <div className="mt-5 flex flex-wrap gap-x-10 gap-y-3">
              {buckets.map(b => (
                <div key={b.label}>
                  <div className="text-xs text-muted">{b.label}</div>
                  <div className="text-base font-medium tabular-nums text-ink">{money(convert(b.now), currency)}</div>
                  <div className="text-xs font-light"><Change now={convert(b.now)} start={startOf(b.start)} currency={currency} /></div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-6">
          <div className="flex justify-end pb-1">
            <Pills value={group} onChange={setGroup} options={[{ value: 'type', label: 'Type' }, { value: 'source', label: 'Source' }]} />
          </div>
          <div className="h-72">
            {chart.length ? (
              <ResponsiveContainer>
                <AreaChart data={chart} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
                  <defs>
                    {(h?.series ?? []).map(x => (
                      <linearGradient key={x.key} id={`fill-${x.key}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={colorOf(x.key)} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={colorOf(x.key)} stopOpacity={0.08} />
                      </linearGradient>
                    ))}
                  </defs>
                  <XAxis dataKey="date" tickFormatter={shortDay} tickLine={false} axisLine={false} fontSize={11}
                    tick={{ fill: 'var(--color-faint)' }} minTickGap={56} />
                  <Tooltip content={<ChartTooltip currency={currency} labels={labels} />}
                    cursor={{ stroke: 'var(--color-faint)', strokeWidth: 1, strokeDasharray: '3 3' }} />
                  {(h?.series ?? []).map(x => (
                    <Area key={x.key} dataKey={x.key} stackId="1" type="monotone" stroke={colorOf(x.key)} strokeWidth={1.25}
                      fill={`url(#fill-${x.key})`} activeDot={{ r: 3, strokeWidth: 0 }} isAnimationActive={false} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            ) : <p className="pt-24 text-center text-sm text-faint">No data</p>}
          </div>
          <div className="flex justify-center pt-3">
            <Pills value={range} onChange={setRange} options={RANGES.map(r => ({ value: r, label: r }))} />
          </div>
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-3">
          <div className="min-w-0 space-y-8 lg:col-span-2">
            <Section title="Holdings" flush>{s && <Holdings holdings={s.holdings} currency={currency} convert={convert} />}</Section>
            {expenses.data && expenses.data.months.length > 0 && <Expenses months={expenses.data.months} current={expenses.data.currentMonth} />}
          </div>
          <div className="min-w-0 space-y-8">
            <Section title="Allocation">{s && <Allocation slices={s.allocation[group]} currency={currency} convert={convert} colorOf={colorOf} />}</Section>
            <Section title="Accounts" flush>{s && <Accounts accounts={s.accounts} currency={currency} convert={convert} />}</Section>
            {reports.length > 0 && <Section title="Reports" flush><Reports reports={reports} onOpen={setOpenReport} /></Section>}
          </div>
        </div>
      </main>
      {openReport != null && <ReportPanel id={openReport} onClose={() => setOpenReport(null)} />}
    </div>
  );
}
