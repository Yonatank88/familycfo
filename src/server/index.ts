import Fastify from 'fastify';
import { getDb } from '../db/connection.js';
import { scrapeState, startScrape, submitOtp } from './scrapeJob.js';

const db = getDb();
// Local-only: this API exposes the household's full financial data and has no login
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4310);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });

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
