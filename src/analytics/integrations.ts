import type { DB } from '../db/connection.js';
import { BANK_COMPANIES, NEEDS_CODE } from '../db/ingestRepo.js';
import type { Config } from '../scraper.js';
import { investmentSourceId } from '../sync/index.js';
import { round } from '../util.js';
import { firstName } from './owners.js';
import { STALE_MS, sourceLabel, summary } from './summary.js';

/** `/api/integrations`: each input source's health (from source_runs), what it brings, and the reports. */

export type IntegrationStatus = 'ok' | 'failed' | 'needs_code' | 'stale' | 'not_configured' | 'disabled';

/** A source from accounts.json — only whether its credentials are filled, never their values. */
export interface ConfiguredSource { id: string; kind: 'bank' | 'card' | 'investment'; configured: boolean; disabled?: boolean; owner?: string }

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/^YOUR_/.test(v.trim());

/** The owner's first name, when set. */
const owner = (full: string | undefined) => { const o = firstName(full); return o ? { owner: o } : {}; };

export function configuredSources(config: Config | null): ConfiguredSource[] {
  if (!config) return [];
  const banks = (config.accounts ?? []).map(a => {
    const values = Object.values(a.credentials ?? {});
    return { id: String(a.companyId), kind: BANK_COMPANIES.has(String(a.companyId)) ? 'bank' as const : 'card' as const,
      configured: values.length > 0 && values.every(filled), ...(a.disabled ? { disabled: true } : {}), ...owner(a.owner) };
  });
  const investments = (config.investments ?? []).map(s => {
    const configured = s.type === 'ibkr' ? filled(s.token) && filled(s.queryId)
      : s.type === 'wallets' ? filled(s.apiKey) && (s.wallets ?? []).some(w => filled(w.address))
      : s.type === 'exchange' ? filled(s.apiKey) && filled(s.secret)
      : false;
    return { id: investmentSourceId(s), kind: 'investment' as const, configured, ...(s.disabled ? { disabled: true } : {}), ...owner(s.owner) };
  });
  return [...banks, ...investments];
}

/**
 * Disabled › Not configured (credentials missing and it never succeeded — a bank logged into by hand in the browser,
 * like Hapoalim with empty credentials, is configured once it has a successful run) › Needs code (the latest run, unattended,
 * stopped at the bank's SMS code — a Refresh from the dashboard can answer it) › Failed (the latest run failed) ›
 * Stale (no success in 36 h) › OK.
 */
export function integrationStatus(x: { configured: boolean; disabled?: boolean; lastRunOk: boolean | null; lastSuccessAt: string | null; lastError?: string | null }, now = Date.now()): IntegrationStatus {
  if (x.disabled) return 'disabled';
  if (!x.configured && !x.lastSuccessAt) return 'not_configured';
  if (x.lastRunOk === false) return x.lastError?.startsWith(NEEDS_CODE) ? 'needs_code' : 'failed';
  if (!x.lastSuccessAt || now - Date.parse(x.lastSuccessAt) > STALE_MS) return 'stale';
  return 'ok';
}

export function integrations(db: DB, sources: ConfiguredSource[], now = Date.now()) {
  const s = summary(db);
  const recentRuns = db.prepare(`SELECT started_at AS at, ok, error FROM source_runs WHERE source = ? ORDER BY id DESC LIMIT 10`);
  const lastSuccess = db.prepare(`SELECT MAX(started_at) FROM source_runs WHERE source = ? AND ok = 1`).pluck();
  const bankAccounts = db.prepare(`SELECT COUNT(*) FROM accounts WHERE company = ? AND active = 1`).pluck();
  const holdingStats = db.prepare(`SELECT COUNT(DISTINCT source) AS accounts, COUNT(*) AS holdings FROM holdings
    WHERE archived = 0 AND substr(source, 1, length(?) + 1) = ? || ':'`);
  const valueOf = (keep: (source: string) => boolean) => {
    const values = s.accounts.filter(a => keep(a.source) && a.valueIls != null).map(a => a.valueIls!);
    return values.length ? round(values.reduce((a, v) => a + v, 0)) : null;
  };

  const list = sources.map(src => {
    const runs = (recentRuns.all(src.id) as { at: string; ok: number; error: string | null }[]).map(r => ({ at: r.at, ok: r.ok === 1, error: r.error }));
    const last = runs[0] ?? null;
    const lastSuccessAt = (lastSuccess.get(src.id) as string | null) ?? null;
    const stats = src.kind === 'investment'
      ? holdingStats.get(src.id, src.id) as { accounts: number; holdings: number }
      : { accounts: bankAccounts.get(src.id) as number, holdings: null };
    return {
      id: src.id, key: `${src.kind === 'investment' ? 'investments' : 'accounts'}:${src.id}`, label: sourceLabel(src.id), kind: src.kind,
      owner: src.owner ?? null,
      status: integrationStatus({ configured: src.configured, disabled: src.disabled, lastRunOk: last ? last.ok : null, lastSuccessAt, lastError: last?.error }, now),
      lastSuccessAt, lastAttemptAt: last?.at ?? null, lastError: last && !last.ok ? last.error : null,
      // what a successful run couldn't read (an exchange's trade history refused…)
      lastWarning: last && last.ok ? last.error : null,
      accounts: stats.accounts, holdings: stats.holdings, valueIls: valueOf(source => source === src.id),
      runs: runs.reverse(),
    };
  });

  const reportCounts = db.prepare(`SELECT status, COUNT(*) AS n FROM reports GROUP BY status`).all() as { status: string; n: number }[];
  const count = (status: string) => reportCounts.find(r => r.status === status)?.n ?? 0;
  const products = db.prepare(`SELECT COUNT(*) FROM holdings WHERE archived = 0 AND source LIKE 'report:%'`).pluck().get() as number;
  return {
    sources: list,
    reports: {
      imported: reportCounts.filter(r => r.status !== 'failed').reduce((a, r) => a + r.n, 0),
      failed: count('failed'),
      latestAsOf: db.prepare(`SELECT MAX(as_of) FROM reports WHERE status = 'applied'`).pluck().get() as string | null,
      lastImportAt: db.prepare(`SELECT replace(MAX(created_at), ' ', 'T') || 'Z' FROM reports`).pluck().get() as string | null,
      needsReview: db.prepare(`SELECT id, COALESCE(issuer, original_name) AS name FROM reports WHERE status = 'needs_review' ORDER BY id`).all() as { id: number; name: string | null }[],
      products,
      valueIls: valueOf(source => source.startsWith('report:')),
    },
  };
}
