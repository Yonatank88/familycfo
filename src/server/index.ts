import Fastify from 'fastify';
import { getDb } from '../db/connection.js';
import { scrapeState, startScrape, submitOtp } from './scrapeJob.js';
import { RANGES, expenseRowsOf, expenses, history, rangeStart, summary, type Range } from '../analytics/summary.js';
import { priceChangeSince } from '../analytics/quotes.js';
import { round } from '../util.js';

const db = getDb();
// Local-only: this API exposes the household's full financial data and has no login
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4310);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const rangeOf = (v: unknown): Range => {
  const r = String(v ?? '1Y');
  if (!RANGES.includes(r as Range)) throw badRequest(`range must be one of ${RANGES.join(', ')}`);
  return r as Range;
};

// net worth, buckets, accounts and holdings (each with its price change over `range`, when it has a quote)
app.get('/api/summary', async req => {
  const range = rangeOf((req.query as Record<string, string>).range);
  const s = summary(db);
  const from = rangeStart(db, range);
  const quoted = new Set(db.prepare(`SELECT symbol FROM holdings WHERE archived = 0 AND manual_price IS NULL`).pluck().all() as string[]);
  const changes = await Promise.all(s.holdings.map(h => (quoted.has(h.symbol) ? priceChangeSince(h.symbol, from) : Promise.resolve(null))));
  return { ...s, range, holdings: s.holdings.map((h, i) => ({ ...h, changePct: changes[i] == null ? null : round(changes[i]!) })) };
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

// the scrape started from the UI: progress, and the bank's OTP request (the only writes)
app.get('/api/scrape', async () => scrapeState());
app.post('/api/scrape', async () => startScrape(db));
app.post('/api/scrape/otp', async req => {
  submitOtp(String((req.body as { code?: unknown })?.code ?? '').trim());
  return { ok: true };
});

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message });
});

await app.listen({ host: HOST, port: PORT });
console.log(`FamilyCFO API on http://${HOST}:${PORT}`);
