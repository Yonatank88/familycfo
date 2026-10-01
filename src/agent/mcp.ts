/**
 * MCP server (stdio) that gives the chat agent read-only access to the household data — and nothing
 * else. Launched by `claude -p` from src/server/agent.ts; the agent has no other tools (no files, no shell).
 *
 *   api: GET an endpoint of the household API — the same numbers the screens show
 *   sql: a read-only SELECT on bank.db (opened read-only + query_only)
 */
import Database from 'better-sqlite3';
import { createInterface } from 'readline';

const DB_PATH = process.env.BANK_DB ?? 'bank.db';
const API = process.env.HOUSEHOLD_API ?? 'http://127.0.0.1:4310';
const MAX_ROWS = 300;
const MAX_CHARS = 60_000;

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');

// GET endpoints the agent may read (all are read-only)
const API_PATHS = /^\/(summary|income|cashflow|forecast|cards\/upcoming|month-plan|installments|recurring|budgets|planning|alerts|recommendations|networth|transactions|planned|categories|meta|events(\/\d+)?|businesses\/\d+\/report|members|accounts|businesses|tags|funds|assets|liabilities|scheduled|sync-status|insurance|pension|investments)$/;

const TOOLS = [
  {
    name: 'api',
    description: `GET an endpoint of the household API (JSON). Prefer it: the numbers match the app's screens.
Paths: /summary, /month-plan?cycle=YYYY-MM, /cashflow?cycles=N (per-month income/spend/byCategory), /budgets?cycle=, /income?cycle=,
/transactions?cycle=YYYY-MM|from=&to=&category=ID&search=TEXT&kind=expense,income&account=ID&limit=N, /installments, /cards/upcoming,
/forecast, /recurring, /planned, /networth, /recommendations, /alerts, /categories, /meta (members, accounts, categories, tags),
/insurance (policies, their documents with a path to open with Read, actual payments, insurance charges with no policy),
/pension (pension / study / provident funds: value, fees, tracks + returns, deposits, expected pension; the latest report's totals),
/investments (stock-market holdings: live price, value in ILS, gain vs buy price / baseline, today's change, value history).
Common filters on most: member=ID, business=ID, tags=ID,ID.`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. /cashflow?cycles=6' } },
      required: ['path'],
    },
  },
  {
    name: 'sql',
    description: `Run one read-only SQLite SELECT (or WITH … SELECT) on bank.db. Max ${MAX_ROWS} rows. Use for questions the API doesn't answer.`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
];

const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…[truncated — narrow the request]` : s);

async function callApi(path: string): Promise<string> {
  const [pathname, search = ''] = path.trim().replace(/^\/api/, '').split('?');
  if (!API_PATHS.test(pathname)) throw new Error(`path not allowed: ${pathname}`);
  const res = await fetch(`${API}/api${pathname}${search ? `?${search}` : ''}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  return clip(body);
}

function runSql(query: string): string {
  const q = query.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(q) || /\b(attach|detach|pragma|vacuum|load_extension)\b/i.test(q)) {
    throw new Error('only a single SELECT / WITH query is allowed');
  }
  const stmt = db.prepare(q);
  if (!stmt.reader) throw new Error('only queries that return rows are allowed');
  const rows: unknown[] = [];
  for (const row of stmt.iterate()) {
    rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return clip(JSON.stringify({ rows, truncated: rows.length >= MAX_ROWS }));
}

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
const send = (msg: object): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); };

async function handle(msg: Msg): Promise<void> {
  if (msg.id == null) return; // notifications (initialized, cancelled)
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'household', version: '1.0.0' },
      } });
    case 'ping':
      return send({ id: msg.id, result: {} });
    case 'tools/list':
      return send({ id: msg.id, result: { tools: TOOLS } });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {};
      try {
        const text = name === 'api' ? await callApi(String(args.path ?? ''))
          : name === 'sql' ? runSql(String(args.query ?? ''))
          : (() => { throw new Error(`unknown tool ${name}`); })();
        return send({ id: msg.id, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        return send({ id: msg.id, result: { content: [{ type: 'text', text: String(err instanceof Error ? err.message : err) }], isError: true } });
      }
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg: Msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(err => process.stderr.write(`${err}\n`));
});
