import { useQuery } from '@tanstack/react-query';
import { api, type Integration, type IntegrationStatus, type Integrations as Data } from './api';
import { ago, asOf, day, money, type Currency } from './format';
import { Card } from './ui';

const STATUS: Record<IntegrationStatus, { label: string; className: string; dot: string }> = {
  ok: { label: 'OK', className: 'bg-up/10 text-up', dot: 'bg-up' },
  failed: { label: 'Failed', className: 'bg-down/10 text-down', dot: 'bg-down' },
  stale: { label: 'Stale', className: 'bg-warn/15 text-warn', dot: 'bg-warn' },
  not_configured: { label: 'Not configured', className: 'bg-ink/[0.05] text-muted', dot: 'bg-faint' },
};
const KIND: Record<Integration['kind'], string> = { bank: 'Bank', card: 'Card', investment: 'Investments' };

export function StatusBadge({ status }: { status: IntegrationStatus }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${s.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />{s.label}
    </span>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-0.5 truncate text-[15px] font-semibold tabular-nums text-ink">{children}</div>
    </div>
  );
}

function When({ label, iso }: { label: string; iso: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="tabular-nums text-ink" title={iso ? asOf(iso) : undefined}>{ago(iso)}</span>
    </div>
  );
}

function Runs({ runs }: { runs: Integration['runs'] }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-muted">Recent runs</span>
      {runs.length ? (
        <div className="flex items-end gap-1">
          {runs.map((r, i) => (
            <span key={i} title={`${asOf(r.at)} · ${r.ok ? 'OK' : r.error ?? 'Failed'}`}
              className={`h-4 w-1.5 rounded-full ${r.ok ? 'bg-up' : 'bg-down'}`} />
          ))}
        </div>
      ) : <span className="text-[13px] text-faint">—</span>}
    </div>
  );
}

function SourceCard({ s, currency, convert, extra }: { s: Integration; currency: Currency; convert: (n: number) => number; extra?: React.ReactNode }) {
  return (
    <Card title={<span className="flex items-baseline gap-2">{s.label}<span className="text-xs font-normal text-faint">{KIND[s.kind]}</span></span>}
      action={<StatusBadge status={s.status} />}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Value">{s.valueIls == null ? '—' : money(convert(s.valueIls), currency)}</Stat>
        <Stat label="Accounts">{s.accounts}</Stat>
        <Stat label="Holdings">{s.holdings ?? '—'}</Stat>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-line pt-3">
        <When label="Last success" iso={s.lastSuccessAt} />
        <When label="Last attempt" iso={s.lastAttemptAt} />
        <Runs runs={s.runs} />
      </div>
      {s.lastError && (
        <p className="mt-3 rounded-lg bg-down/5 px-3 py-2 text-xs text-down" title={s.lastError}><span className="line-clamp-2 break-all">{s.lastError}</span></p>
      )}
      {extra}
    </Card>
  );
}

function ReportsCard({ r, currency, convert, onOpenReport }: {
  r: Data['reports']; currency: Currency; convert: (n: number) => number; onOpenReport: (id: number) => void;
}) {
  return (
    <Card title={<span className="flex items-baseline gap-2">Reports<span className="text-xs font-normal text-faint">Uploads</span></span>}
      action={r.needsReview.length > 0 && <span className="rounded-md bg-warn/15 px-2 py-0.5 text-xs font-medium text-warn">{r.needsReview.length} to review</span>}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Value">{r.valueIls == null ? '—' : money(convert(r.valueIls), currency)}</Stat>
        <Stat label="Imported">{r.imported}</Stat>
        <Stat label="Products">{r.products}</Stat>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-line pt-3 text-[13px]">
        <div className="flex justify-between gap-3"><span className="text-muted">Latest report</span><span className="tabular-nums text-ink">{r.latestAsOf ? day(r.latestAsOf) : '—'}</span></div>
        <When label="Last upload" iso={r.lastImportAt} />
        <div className="flex justify-between gap-3"><span className="text-muted">Needs review</span><span className="tabular-nums text-ink">{r.needsReview.length}</span></div>
        {r.failed > 0 && <div className="flex justify-between gap-3"><span className="text-muted">Failed</span><span className="tabular-nums text-down">{r.failed}</span></div>}
      </div>
      {r.needsReview.length > 0 && (
        <ul className="mt-3 space-y-1">
          {r.needsReview.map(x => (
            <li key={x.id}>
              <button type="button" onClick={() => onOpenReport(x.id)}
                className="flex w-full items-center justify-between gap-3 rounded-lg bg-warn/10 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-warn/15">
                <span className="truncate"><bdi>{x.name ?? `Report ${x.id}`}</bdi></span><span className="shrink-0 text-warn">Review</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function Integrations({ currency, convert, onOpenReport }: {
  currency: Currency; convert: (n: number) => number; onOpenReport: (id: number) => void;
}) {
  const { data, error } = useQuery({ queryKey: ['integrations'], queryFn: api.integrations, refetchInterval: 30_000 });
  if (error) return <p className="text-sm text-down">{(error as Error).message}</p>;
  if (!data) return null;
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {data.sources.map(s => <SourceCard key={s.id} s={s} currency={currency} convert={convert} />)}
      <ReportsCard r={data.reports} currency={currency} convert={convert} onOpenReport={onOpenReport} />
    </div>
  );
}
