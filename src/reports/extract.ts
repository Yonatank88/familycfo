import { spawn } from 'child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import readExcelFile from 'read-excel-file/node';

/**
 * Report → structured balances, by the user's own Claude Code (`claude -p`, their subscription): Opus, structured output,
 * and the one tool `Read`, confined to a temp dir that holds only the report. The prompts are prompt.md and revise.md.
 */

export const PRODUCT_TYPES = ['pension', 'study_fund', 'provident_fund', 'mutual_fund', 'brokerage', 'deposit', 'other'] as const;
export type ProductType = typeof PRODUCT_TYPES[number];

/** Returns a report prints for a product, in % (5.2 = 5.2%): year to date, last 12 and 36 months. */
export interface StatedReturns { ytd: number | null; m12: number | null; m36: number | null }

export interface ExtractedProduct {
  provider: string;
  productType: ProductType;
  accountNumber: string | null;
  name: string;
  balance: number;
  currency: string;
  liquidityDate: string | null;
  confidence: number;
  evidence: string;
  /** optional: only when the report prints them */
  returns?: StatedReturns | null;
}

export interface Question { id: string; text: string; options?: string[] }

export interface Extraction {
  issuer: string;
  reportType: string;
  asOf: string | null;
  owner: string | null;
  statedTotal: number | null;
  currency: string;
  products: ExtractedProduct[];
  questions: Question[];
}

const nullable = (type: string) => ({ type: [type, 'null'] });
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issuer', 'reportType', 'asOf', 'owner', 'statedTotal', 'currency', 'products', 'questions'],
  properties: {
    issuer: { type: 'string' },
    reportType: { type: 'string' },
    asOf: { ...nullable('string'), description: 'YYYY-MM-DD' },
    owner: nullable('string'),
    statedTotal: nullable('number'),
    currency: { type: 'string', description: 'ISO 4217' },
    products: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'productType', 'accountNumber', 'name', 'balance', 'currency', 'liquidityDate', 'confidence', 'evidence'],
        properties: {
          provider: { type: 'string' },
          productType: { type: 'string', enum: PRODUCT_TYPES },
          accountNumber: { ...nullable('string'), description: 'the account / policy number; for a mutual fund, its fund number (מספר קרן) when printed' },
          name: { type: 'string' },
          balance: { type: 'number' },
          currency: { type: 'string' },
          liquidityDate: { ...nullable('string'), description: 'YYYY-MM-DD' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: { type: 'string' },
          returns: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['ytd', 'm12', 'm36'],
            description: 'returns printed for this product, in percent (5.2 = 5.2%); null when none is printed',
            properties: { ytd: nullable('number'), m12: nullable('number'), m36: nullable('number') },
          },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: { id: { type: 'string' }, text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
} as const;

/** What a revision pass is given besides the file: the extraction, the questions it raised and their answers. */
export interface RevisionInput { extraction: Extraction; questions: Question[]; answers: Record<string, string> }

/** The AI call — injectable, so tests never run Claude. */
export type Extractor = (file: string, revision?: RevisionInput) => Promise<Extraction>;

const MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 10 * 60_000;
const TEXT_TYPES = new Set(['.csv', '.tsv', '.txt']);
const SHEET_TYPES = new Set(['.xlsx']);
export const REPORT_TYPES = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', ...TEXT_TYPES, ...SHEET_TYPES]);

const promptFile = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

/** A spreadsheet as text (one tab-separated block per sheet) — Read can't open .xlsx. */
async function sheetText(file: string): Promise<string> {
  const sheets = await readExcelFile(file);
  return sheets.map(({ sheet, data }) => `# ${sheet}\n${data
    .map(row => row.map(c => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))).join('\t'))
    .join('\n')}`).join('\n\n');
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // the user's Claude subscription login, not an API key that may be set for other tools
  delete env.ANTHROPIC_API_KEY;
  // the API may itself run inside a Claude Code session
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function runClaude(cwd: string, prompt: string): Promise<unknown> {
  const args = [
    '-p', '--model', MODEL, '--output-format', 'json', '--json-schema', JSON.stringify(EXTRACTION_SCHEMA),
    // one tool, Read, confined to the temp dir (cwd = --add-dir); no settings, hooks, MCP servers or session files
    '--tools', 'Read', '--allowedTools', 'Read', '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
    '--add-dir', cwd, '--restricted', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', e => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Claude Code (claude) is not installed or not on PATH') : e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      let result: Record<string, any> | null = null;
      try { result = JSON.parse(out); } catch { /* reported below */ }
      if (!result || result.is_error || code !== 0) {
        return reject(new Error(String(result?.result ?? result?.subtype ?? (err.trim().slice(-600) || `claude exited with code ${code}`))));
      }
      if (result.structured_output == null) return reject(new Error('claude returned no structured output'));
      resolve(result.structured_output);
    });
    child.stdin.end(prompt);
  });
}

/** Read the report (or revise an earlier extraction of it) with Claude. */
export const claudeExtractor: Extractor = async (file, revision) => {
  const dir = mkdtempSync(join(tmpdir(), 'familycfo-report-'));
  try {
    const ext = extname(file).toLowerCase();
    // CSV / XLSX go in as text; PDFs and images are read directly
    let name: string;
    if (SHEET_TYPES.has(ext)) { name = 'report.txt'; writeFileSync(join(dir, name), await sheetText(file)); }
    else if (TEXT_TYPES.has(ext)) { name = 'report.txt'; copyFileSync(file, join(dir, name)); }
    else { name = `report${ext}`; copyFileSync(file, join(dir, name)); }

    let prompt = `${promptFile('prompt.md')}\n\nThe report: ./${name}\n`;
    if (revision) {
      prompt += `\n${promptFile('revise.md')}\n\nYour extraction:\n${JSON.stringify(revision.extraction, null, 1)}\n\n`
        + `Questions and answers:\n${revision.questions.map(q => `- ${q.text}\n  Answer: ${revision.answers[q.id] ?? '(none)'}`).join('\n')}\n`;
    }
    return normalizeExtraction(await runClaude(dir, prompt));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const pctOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1000 ? v : null);
/** The printed returns, or null when none is. */
export function statedReturns(v: unknown): StatedReturns | null {
  const r = (v ?? {}) as Record<string, unknown>;
  const out = { ytd: pctOrNull(r.ytd), m12: pctOrNull(r.m12), m36: pctOrNull(r.m36) };
  return out.ytd == null && out.m12 == null && out.m36 == null ? null : out;
}

const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The model's output, checked and tidied: valid dates or null, upper-case currencies, numbers as numbers. */
export function normalizeExtraction(raw: unknown): Extraction {
  const r = (raw ?? {}) as Record<string, any>;
  if (!Array.isArray(r.products)) throw new Error('extraction has no products');
  const currency = (str(r.currency) ?? 'ILS').toUpperCase();
  return {
    issuer: str(r.issuer) ?? 'Unknown',
    reportType: (str(r.reportType) ?? 'other').toLowerCase(),
    asOf: isoDate(r.asOf),
    owner: str(r.owner),
    statedTotal: Number.isFinite(r.statedTotal) ? Number(r.statedTotal) : null,
    currency,
    products: r.products.filter((p: any) => p && Number.isFinite(p.balance)).map((p: any): ExtractedProduct => ({
      provider: str(p.provider) ?? str(r.issuer) ?? 'Unknown',
      productType: PRODUCT_TYPES.includes(p.productType) ? p.productType : 'other',
      accountNumber: str(p.accountNumber),
      name: str(p.name) ?? '',
      balance: Number(p.balance),
      currency: (str(p.currency) ?? currency).toUpperCase(),
      liquidityDate: isoDate(p.liquidityDate),
      confidence: Number.isFinite(p.confidence) ? Math.max(0, Math.min(1, Number(p.confidence))) : 0,
      evidence: str(p.evidence) ?? '',
      returns: statedReturns(p.returns),
    })),
    questions: (Array.isArray(r.questions) ? r.questions : [])
      .filter((q: any) => q && str(q.text))
      .map((q: any, i: number) => ({ id: str(q.id) ?? String(i + 1), text: q.text.trim(), ...(Array.isArray(q.options) && q.options.length ? { options: q.options.map(String) } : {}) })),
  };
}
