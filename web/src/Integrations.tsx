import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type Integration, type IntegrationStatus, type ReportItem } from './api';
import { ago, asOf, money, type Currency } from './format';
import { ReportList } from './reports';
import { SidePanel, Tip } from './ui';

const STATUS: Record<IntegrationStatus | 'review', { label: string; className: string; dot: string }> = {
  ok: { label: 'OK', className: 'bg-up/10 text-up', dot: 'bg-up' },
  failed: { label: 'Failed', className: 'bg-down/10 text-down', dot: 'bg-down' },
  stale: { label: 'Stale', className: 'bg-warn/15 text-warn', dot: 'bg-warn' },
  not_configured: { label: 'Not configured', className: 'bg-ink/[0.05] text-muted', dot: 'bg-faint' },
  disabled: { label: 'Disabled', className: 'bg-ink/[0.05] text-faint', dot: 'bg-line' },
  review: { label: 'To review', className: 'bg-warn/15 text-warn', dot: 'bg-warn' },
};
const KIND: Record<Integration['kind'], string> = { bank: 'Bank', card: 'Card', investment: 'Investments' };

/** One row of the table: an integration, or the uploaded reports as a row of type "Upload". */
interface Row {
  key: string; label: string; type: string; owner: string | null; status: keyof typeof STATUS; error: string | null;
  lastSuccessAt: string | null; lastAttemptAt: string | null; runs: Integration['runs'] | null; valueIls: number | null;
  edit: () => void; editLabel: string;
}

export function StatusBadge({ status, error }: { status: keyof typeof STATUS; error?: string | null }) {
  const s = STATUS[status];
  const badge = (
    <span tabIndex={error ? 0 : undefined} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${s.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />{s.label}
    </span>
  );
  return error ? <Tip content={error}>{badge}</Tip> : badge;
}

const When = ({ iso }: { iso: string | null }) => (
  iso ? <Tip content={asOf(iso)}><span tabIndex={0} className="tabular-nums">{ago(iso)}</span></Tip> : <span className="text-faint">—</span>
);

/** Last success, and the last attempt under it only when it was a different run (a failure since). */
function LastSuccess({ r }: { r: Row }) {
  return (
    <div>
      <div className="text-ink"><When iso={r.lastSuccessAt} /></div>
      {r.lastAttemptAt && r.lastAttemptAt !== r.lastSuccessAt && (
        <div className="text-xs text-faint">Last attempt <When iso={r.lastAttemptAt} /></div>
      )}
    </div>
  );
}

function Runs({ runs }: { runs: Integration['runs'] }) {
  if (!runs.length) return <span className="text-faint">—</span>;
  return (
    <div className="flex items-end gap-1">
      {runs.map((r, i) => (
        <Tip key={i} content={`${asOf(r.at)} · ${r.ok ? 'OK' : r.error ?? 'Failed'}`}>
          <span className={`h-4 w-1.5 rounded-full ${r.ok ? 'bg-up' : 'bg-down'}`} />
        </Tip>
      ))}
    </div>
  );
}

export default function Integrations({ currency, convert, reports, onOpenReport, onEdit }: {
  currency: Currency; convert: (n: number) => number; reports: ReportItem[]; onOpenReport: (id: number) => void; onEdit: (key: string) => void;
}) {
  const { data, error } = useQuery({ queryKey: ['integrations'], queryFn: api.integrations, refetchInterval: 30_000 });
  const [reportList, setReportList] = useState(false);
  if (error) return <p className="text-sm text-down">{(error as Error).message}</p>;
  if (!data) return null;

  const value = (n: number | null) => (n == null ? '—' : money(convert(n), currency));
  const r = data.reports;
  const rows: Row[] = [
    ...data.sources.map(s => ({
      key: s.key, label: s.label, type: KIND[s.kind], owner: s.owner, status: s.status, error: s.lastError ?? s.lastWarning,
      lastSuccessAt: s.lastSuccessAt, lastAttemptAt: s.lastAttemptAt, runs: s.runs, valueIls: s.valueIls,
      edit: () => onEdit(s.key), editLabel: 'Edit',
    })),
    {
      key: 'reports', label: 'Reports', type: 'Upload', owner: null, status: r.needsReview.length ? 'review' : r.imported ? 'ok' : 'not_configured',
      error: r.failed ? `${r.failed} failed` : null, lastSuccessAt: r.lastImportAt, lastAttemptAt: null, runs: null, valueIls: r.valueIls,
      edit: () => setReportList(true), editLabel: 'Open',
    },
  ];

  return (
    <>
      {/* desktop: the full table */}
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(20,33,61,0.04)] max-md:hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-line hover:bg-transparent">
              {['Source', 'Type', 'Owner', 'Status', 'Last success', 'Runs', 'Value', ''].map((h, i) => (
                <TableHead key={i} className={`h-10 px-4 text-[11px] font-medium uppercase tracking-wide text-faint first:pl-5 last:pr-5 ${h === 'Value' ? 'text-right' : ''}`}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(x => (
              <TableRow key={x.key} className="border-line hover:bg-paper">
                <TableCell className="px-4 py-3 pl-5 font-medium text-ink"><bdi>{x.label}</bdi></TableCell>
                <TableCell className="px-4 py-3 text-muted">{x.type}</TableCell>
                <TableCell className="px-4 py-3 text-faint"><bdi>{x.owner}</bdi></TableCell>
                <TableCell className="px-4 py-3"><StatusBadge status={x.status} error={x.error} /></TableCell>
                <TableCell className="px-4 py-3"><LastSuccess r={x} /></TableCell>
                <TableCell className="px-4 py-3">{x.runs ? <Runs runs={x.runs} /> : <span className="text-faint">—</span>}</TableCell>
                <TableCell className="px-4 py-3 text-right tabular-nums text-ink">{value(x.valueIls)}</TableCell>
                <TableCell className="px-4 py-3 pr-5 text-right">
                  <button type="button" onClick={x.edit} className="min-h-9 rounded-lg px-2 text-[13px] font-medium text-muted hover:text-accent">{x.editLabel}</button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* mobile: compact rows; tapping one opens its editor */}
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface md:hidden">
        {rows.map(x => (
          <li key={x.key}>
            <button type="button" onClick={x.edit} className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-paper">
              <span aria-label={STATUS[x.status].label} className={`h-2 w-2 shrink-0 rounded-full ${STATUS[x.status].dot}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink"><bdi>{x.label}</bdi></span>
                <span className="block text-xs text-faint">{x.owner && <><bdi>{x.owner}</bdi> · </>}{x.lastSuccessAt ? ago(x.lastSuccessAt) : '—'}</span>
              </span>
              <span className="shrink-0 text-sm tabular-nums text-ink">{value(x.valueIls)}</span>
            </button>
          </li>
        ))}
      </ul>

      {reportList && (
        <SidePanel onClose={() => setReportList(false)} kicker="Uploads" title="Reports">
          {reports.length
            ? <div className="overflow-hidden rounded-2xl border border-line bg-surface"><ReportList reports={reports} onOpen={id => { setReportList(false); onOpenReport(id); }} /></div>
            : <p className="text-sm text-faint">No reports</p>}
        </SidePanel>
      )}
    </>
  );
}
