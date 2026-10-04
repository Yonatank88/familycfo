import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { mkdtempSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { getDb } from '../db/connection.js';
import { answerReport, deleteReport, failInterrupted, listReports, processReport, registerReport, reportDetail, setReportOwner } from '../reports/index.js';
import { scrapeRunning, scrapeState, startScrape, submitOtp } from './scrapeJob.js';
import { RANGES, expenseRowsOf, expenses, history, rangeStart, summary, type Range } from '../analytics/summary.js';
import { priceChangeSince } from '../analytics/quotes.js';
import { cashFlow, cashFlowRows } from '../analytics/cashflow.js';
import { funds } from '../analytics/funds.js';
import { configuredSources, integrations } from '../analytics/integrations.js';
import { configOwners } from '../analytics/owners.js';
// which sources are configured and whether their credentials are filled — the values never leave configuredSources
import { ACCOUNTS_FILE, loadConfig } from '../config.js';
// add / edit / remove integrations: secrets come in, only masked values go out
import { applyDraft, catalog, listIntegrations, onlyEntry, readConfigFile, removeEntry, setDisabled, writeConfigFile, type Draft } from '../integrations/manage.js';
import { deleteSourceData } from '../integrations/data.js';
import { LINKABLE, startLink, type LinkSession } from '../integrations/link.js';
import { round } from '../util.js';

const db = getDb();
// Local-only: this API exposes the household's full financial data and has no login
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4310);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
failInterrupted(db);

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const idOf = (params: unknown) => {
  const id = Number((params as { id?: string }).id);
  if (!Number.isInteger(id) || id < 1) throw badRequest('bad report id');
  return id;
};
/** accounts.json, or null when there is none (every source is then "not configured", no one owns anything) */
const configOrNull = () => { try { return loadConfig(); } catch { return null; } };

const rangeOf = (v: unknown): Range => {
  const r = String(v ?? '1Y');
  if (!RANGES.includes(r as Range)) throw badRequest(`range must be one of ${RANGES.join(', ')}`);
  return r as Range;
};

/** The summary's holdings, each with its price change over `range` (when it has a quote). */
async function withChanges(s: ReturnType<typeof summary>, range: Range) {
  const from = rangeStart(db, range);
  const quoted = new Set(db.prepare(`SELECT symbol FROM holdings WHERE archived = 0 AND manual_price IS NULL`).pluck().all() as string[]);
  const changes = await Promise.all(s.holdings.map(h => (quoted.has(h.symbol) ? priceChangeSince(h.symbol, from) : Promise.resolve(null))));
  return s.holdings.map((h, i) => ({ ...h, changePct: changes[i] == null ? null : round(changes[i]!) }));
}

// net worth, buckets, accounts and holdings (each with its price change over `range`, when it has a quote)
app.get('/api/summary', async req => {
  const range = rangeOf((req.query as Record<string, string>).range);
  // each integration's owner (display only) — inherited by its accounts and holdings
  const s = summary(db, undefined, configOwners(configOrNull()));
  return { ...s, range, holdings: await withChanges(s, range) };
});

// every investment holding (not funds): value, opened, gain since opened, change over the range; totals with the
// gain where its cost is known and the share of the value that covers
app.get('/api/investments', async req => {
  const range = rangeOf((req.query as Record<string, string>).range);
  const s = summary(db, undefined, configOwners(configOrNull()));
  const holdings = (await withChanges(s, range)).filter(h => h.type !== 'funds');
  const value = holdings.reduce((a, h) => a + (h.valueIls ?? 0), 0);
  const known = holdings.filter(h => h.gainIls != null && h.valueIls != null);
  const gain = known.reduce((a, h) => a + h.gainIls!, 0);
  const coveredValue = known.reduce((a, h) => a + h.valueIls!, 0);
  const cost = coveredValue - gain;
  return {
    range, usdRate: s.usdRate,
    totals: { valueIls: round(value), gainIls: known.length ? round(gain) : null, gainPct: known.length && cost ? round((gain / Math.abs(cost)) * 100) : null,
      coveredPct: value ? round((coveredValue / value) * 100) : null },
    holdings,
  };
});

app.get('/api/history', async req => {
  const q = req.query as Record<string, string>;
  const group = q.group ?? 'type';
  if (group !== 'type' && group !== 'source') throw badRequest('group must be type or source');
  return history(db, rangeOf(q.range), group);
});

app.get('/api/expenses', async req => {
  const months = Number((req.query as Record<string, string>).months ?? 12);
  if (!Number.isInteger(months) || months < 1 || months > 120) throw badRequest('months must be 1–120');
  return expenses(db, months);
});

app.get('/api/expenses/rows', async req => {
  const q = req.query as Record<string, string>;
  if (!/^\d{4}-\d{2}$/.test(q.month ?? '')) throw badRequest('month must be YYYY-MM');
  return expenseRowsOf(db, q.month, q.merchant || undefined);
});

// each fund (pension, study, provident, mutual) with its growth over the range and the returns its reports state
app.get('/api/funds', async req => funds(db, rangeOf((req.query as Record<string, string>).range)));

// the bank accounts' money in / out per month (one account, or all), and their balances
const accountOf = (v: unknown) => {
  const a = String(v ?? '');
  if (!a) return undefined;
  if (!db.prepare(`SELECT 1 FROM accounts WHERE id = ? AND kind = 'bank'`).get(a)) throw badRequest('no such bank account');
  return a;
};
app.get('/api/cashflow', async req => {
  const q = req.query as Record<string, string>;
  return cashFlow(db, rangeOf(q.range), accountOf(q.account));
});
app.get('/api/cashflow/rows', async req => {
  const q = req.query as Record<string, string>;
  if (!/^\d{4}-\d{2}$/.test(q.month ?? '')) throw badRequest('month must be YYYY-MM');
  return cashFlowRows(db, q.month, accountOf(q.account));
});

// writes to /api/integrations/* (they edit accounts.json) only from the dashboard itself: a local Host and, when the
// browser sends one, a local Origin — another site open in the browser can't post here, nor reach it by DNS rebinding
const WEB_PORT = Number(process.env.WEB_PORT ?? 5180);
const LOCAL_ORIGINS = new Set([`http://127.0.0.1:${WEB_PORT}`, `http://localhost:${WEB_PORT}`, `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/integrations/') || req.method === 'GET') return;
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const origin = req.headers.origin;
  if (!['127.0.0.1', 'localhost'].includes(host) || (origin !== undefined && !LOCAL_ORIGINS.has(origin))) {
    return reply.code(403).send({ error: 'only the local dashboard can change integrations' });
  }
});

// every input source's health from source_runs, what it brings, and the reports (read-only)
app.get('/api/integrations', async () => integrations(db, configuredSources(configOrNull())));

// the integrations in accounts.json (secrets masked) and what can be added
app.get('/api/integrations/config', async () => ({ catalog: catalog(), integrations: listIntegrations(readConfigFile(ACCOUNTS_FILE)) }));
const draftOf = (body: unknown) => (body ?? {}) as Draft;
const keyParam = (params: unknown) => decodeURIComponent(String((params as { key?: string }).key ?? ''));
const save = (config: ReturnType<typeof readConfigFile>) => {
  writeConfigFile(ACCOUNTS_FILE, config);
  return { integrations: listIntegrations(config) };
};
app.post('/api/integrations/config', async req => {
  const { config, key } = applyDraft(readConfigFile(ACCOUNTS_FILE), draftOf(req.body));
  return { key, ...save(config) };
});
app.put('/api/integrations/config/:key', async req => {
  const { config, key } = applyDraft(readConfigFile(ACCOUNTS_FILE), draftOf(req.body), keyParam(req.params));
  return { key, ...save(config) };
});
app.post('/api/integrations/config/:key/disabled', async req =>
  save(setDisabled(readConfigFile(ACCOUNTS_FILE), keyParam(req.params), !!(req.body as { disabled?: unknown })?.disabled)));
// remove from accounts.json; its data stays unless keepData=false
app.delete('/api/integrations/config/:key', async req => {
  if (scrapeRunning()) throw Object.assign(new Error('a refresh is running'), { statusCode: 409 });
  const { config, source, section } = removeEntry(readConfigFile(ACCOUNTS_FILE), keyParam(req.params));
  const result = save(config);
  if ((req.query as Record<string, string>).keepData === 'false') deleteSourceData(db, source, section);
  return result;
});
// "Test connection": run that one integration with the form's values (an edit merges into the saved one); its settings
// are written only when the run succeeds. Progress, the OTP prompt and the outcome come through /api/scrape.
app.post('/api/integrations/test', async req => {
  const body = (req.body ?? {}) as { key?: string; draft: Draft };
  const { config, key } = applyDraft(readConfigFile(ACCOUNTS_FILE), body.draft ?? draftOf(null), body.key || undefined);
  return startScrape(db, { key, config: onlyEntry(config, key), onSuccess: () => {
    // re-apply on the file as it is now, so an edit made meanwhile isn't lost
    const fresh = readConfigFile(ACCOUNTS_FILE);
    const exists = listIntegrations(fresh).some(x => x.key === key);
    writeConfigFile(ACCOUNTS_FILE, applyDraft(fresh, body.draft, exists ? key : undefined).config);
  } });
});
// One Zero's SMS enrollment: send the code, then trade it for the idToken (saved, never returned)
let link: { session: LinkSession; at: number } | null = null;
app.post('/api/integrations/link/:company/start', async req => {
  const companyId = LINKABLE[String((req.params as { company: string }).company).toLowerCase()];
  if (!companyId) throw badRequest('not linkable');
  link = { session: await startLink(companyId, ACCOUNTS_FILE), at: Date.now() };
  return { ok: true };
});
app.post('/api/integrations/link/:company/code', async req => {
  const code = String((req.body as { code?: unknown })?.code ?? '').trim();
  if (!link || Date.now() - link.at > 10 * 60_000) throw Object.assign(new Error('send a new code first'), { statusCode: 409 });
  if (!/^\d{4,8}$/.test(code)) throw badRequest('the code must be 4–8 digits');
  await link.session.finish(code);
  link = null;
  return { ok: true };
});

// the scrape started from the UI: progress, and the bank's OTP request (the only writes)
app.get('/api/scrape', async () => scrapeState());
app.post('/api/scrape', async () => startScrape(db));
app.post('/api/scrape/otp', async req => {
  submitOtp(String((req.body as { code?: unknown })?.code ?? '').trim());
  return { ok: true };
});

// reports: the upload is read by Claude in the background; the list shows its progress
app.post('/api/reports', async req => {
  if (!req.isMultipart()) throw badRequest('send the report as multipart/form-data');
  const part = await req.file();
  if (!part) throw badRequest('no file');
  const dir = mkdtempSync(join(tmpdir(), 'familycfo-upload-'));
  try {
    const name = basename(part.filename || 'report');
    const path = join(dir, name);
    await writeFile(path, await part.toBuffer());
    const { report, duplicate } = registerReport(db, path, name);
    if (!duplicate) processReport(db, report.id).catch(err => app.log.error(err));
    return { id: report.id, status: report.status, duplicate };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
app.get('/api/reports', async () => listReports(db));
app.get('/api/reports/:id', async (req, reply) => reportDetail(db, idOf(req.params)) ?? reply.code(404).send({ error: 'no such report' }));
app.post('/api/reports/:id/answers', async req => {
  const body = (req.body ?? {}) as { answers?: Record<string, unknown>; edits?: { asOf?: unknown; balances?: Record<string, unknown> } };
  const answers = Object.fromEntries(Object.entries(body.answers ?? {}).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v));
  const balances = Object.fromEntries(Object.entries(body.edits?.balances ?? {}).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v)));
  const r = await answerReport(db, idOf(req.params), answers, { asOf: body.edits?.asOf ? String(body.edits.asOf) : undefined, balances });
  return { id: r.id, status: r.status };
});
// the owner printed on the report, corrected from the review panel
app.put('/api/reports/:id/owner', async req => {
  const r = setReportOwner(db, idOf(req.params), String((req.body as { owner?: unknown })?.owner ?? ''));
  return { id: r.id, status: r.status };
});
app.delete('/api/reports/:id', async (req, reply) => (deleteReport(db, idOf(req.params)) ? { ok: true } : reply.code(404).send({ error: 'no such report' })));

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message });
});

await app.listen({ host: HOST, port: PORT });
console.log(`FamilyCFO API on http://${HOST}:${PORT}`);
