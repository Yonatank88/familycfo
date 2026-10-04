import { XMLParser } from 'fast-xml-parser';
import type { SyncedAccount, SyncedPosition } from './holdings.js';
import { ibkrAssetClass } from './assets.js';
import { parseIbkrDate } from './history.js';

/**
 * Interactive Brokers through the Flex Web Service: open positions + cash of every account in a Flex Query.
 * Set up once in Client Portal → Performance & Reports → Flex Queries: an Activity Flex Query with the sections
 * "Open Positions" (Summary) and "Cash Report", then Flex Web Service → generate a token.
 */
export interface IbkrSource {
  type: 'ibkr';
  /** source id (SCRAPE_ONLY, sync status, raw archive); default "ibkr" */
  id?: string;
  token: string;
  queryId: string;
  /** broker name on the holdings; default "IBKR" */
  label?: string;
}

const BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';

/** IBKR listing exchange → Yahoo suffix. US listings have none; anything else unknown isn't quoted. */
const YAHOO_SUFFIX: Record<string, string> = {
  TASE: '.TA', LSE: '.L', LSEETF: '.L', IBIS: '.DE', IBIS2: '.DE', FWB: '.F', SBF: '.PA', AEB: '.AS', BVME: '.MI',
  BM: '.MC', EBS: '.SW', TSE: '.TO', VENTURE: '.V', ASX: '.AX', SEHK: '.HK', TSEJ: '.T',
};
const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'BATS', 'BYX', 'IEX', 'NYSENAT', 'ISLAND', 'PINK', 'CBOE']);

/** The Yahoo symbol of an IBKR position, or null when it has none (options, futures, bonds…). */
export function ibkrYahooSymbol(p: { symbol: string; assetCategory: string; listingExchange?: string; currency: string }): string | null {
  const symbol = String(p.symbol).trim().replace(/[ .]+/g, '-'); // "BRK B" → BRK-B
  if (p.assetCategory === 'CRYPTO') return `${symbol}-USD`;
  if (!['STK', 'ETF', 'FUND'].includes(p.assetCategory)) return null;
  const exchange = String(p.listingExchange ?? '').toUpperCase();
  if (YAHOO_SUFFIX[exchange]) return symbol + YAHOO_SUFFIX[exchange];
  return US_EXCHANGES.has(exchange) || (!exchange && p.currency === 'USD') ? symbol : null;
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));

async function flex(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'user-agent': 'familycfo/1.0' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`IBKR HTTP ${res.status}`);
  // values stay strings (reference codes and account ids aren't numbers)
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false }).parse(await res.text());
}

/** The statement's data date (the end of its period, e.g. the last business day) — YYYY-MM-DD. */
export function flexAsOf(raw: any): string | null {
  const dates = asArray(raw?.FlexQueryResponse?.FlexStatements?.FlexStatement)
    .map((st: any) => String(st.toDate ?? '')).filter(d => /^\d{8}$/.test(d)).sort();
  const d = dates.at(-1);
  return d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

/** A parsed Flex statement → one account per IBKR account: its positions and its cash (one holding per currency). */
export function parseFlexStatement(raw: any, cfg: IbkrSource): SyncedAccount[] {
  const id = cfg.id ?? 'ibkr';
  return asArray(raw?.FlexQueryResponse?.FlexStatements?.FlexStatement).map((st: any): SyncedAccount => {
    // a query with lots lists each lot too; the summary row is the position
    const all = asArray(st.OpenPositions?.OpenPosition) as any[];
    const rows = all.filter((p: any) => !p.levelOfDetail || p.levelOfDetail === 'SUMMARY');
    const lots = all.filter((p: any) => p.levelOfDetail === 'LOT');
    const positions: SyncedPosition[] = rows.filter((p: any) => p.assetCategory !== 'CASH').map((p: any) => {
      const quantity = Number(p.position);
      const value = num(p.positionValue);
      const costBasis = num(p.costBasisMoney);
      return {
        symbol: String(p.symbol), yahoo: ibkrYahooSymbol(p), name: p.description ?? null, quantity, currency: p.currency,
        assetClass: ibkrAssetClass(p.assetCategory),
        // per unit, multiplier included (an option's price is per share, its value per contract)
        price: value != null && quantity ? value / quantity : num(p.markPrice),
        costBasis, costSource: costBasis == null ? null : 'broker',
        openedAt: ibkrOpenedAt(p, lots),
      };
    });
    const cash = new Map<string, number>();
    for (const c of asArray(st.CashReport?.CashReportCurrency) as any[]) {
      if (c.currency === 'BASE_SUMMARY' || c.levelOfDetail === 'BaseCurrency') continue;
      cash.set(c.currency, Number(c.endingCash ?? 0));
    }
    for (const [currency, amount] of cash) {
      if (amount) positions.push({ symbol: `CASH.${currency}`, yahoo: null, name: `Cash ${currency}`, quantity: amount, currency, assetClass: 'broker_cash', price: 1 });
    }
    return { source: `${id}:${st.accountId}`, broker: cfg.label ?? 'IBKR', positions };
  });
}

/** The summary row's openDateTime; without one, its earliest lot's (lots of the same contract). */
export function ibkrOpenedAt(summary: any, lots: any[]): string | null {
  const own = parseIbkrDate(summary.openDateTime);
  if (own) return own;
  const mine = lots.filter(l => (summary.conid ? l.conid === summary.conid : l.symbol === summary.symbol));
  return mine.map(l => parseIbkrDate(l.openDateTime)).filter((d): d is string => !!d).sort()[0] ?? null;
}

/** Request the statement, then poll until IBKR has generated it (usually a few seconds). */
export async function fetchIbkr(cfg: IbkrSource, opts: { pollMs?: number; attempts?: number } = {}): Promise<{ raw: unknown; accounts: SyncedAccount[]; asOf?: string | null }> {
  if (!cfg.token || !cfg.queryId) throw new Error('IBKR: token and queryId are required');
  const pollMs = opts.pollMs ?? 5000;
  const sent = (await flex(`${BASE}/SendRequest?t=${encodeURIComponent(cfg.token)}&q=${encodeURIComponent(cfg.queryId)}&v=3`))?.FlexStatementResponse;
  if (sent?.Status !== 'Success' || !sent.ReferenceCode) throw new Error(`IBKR refused the request: ${sent?.ErrorCode ?? ''} ${sent?.ErrorMessage ?? 'no reference code'}`.trim());

  for (let attempt = 0; attempt < (opts.attempts ?? 12); attempt++) {
    if (pollMs) await new Promise(r => setTimeout(r, pollMs));
    const raw = await flex(`${BASE}/GetStatement?t=${encodeURIComponent(cfg.token)}&q=${sent.ReferenceCode}&v=3`);
    if (raw?.FlexQueryResponse) return { raw, accounts: parseFlexStatement(raw, cfg), asOf: flexAsOf(raw) };
    // 1019 = still generating; anything else is a real error
    const status = raw?.FlexStatementResponse;
    if (status?.ErrorCode && String(status.ErrorCode) !== '1019') throw new Error(`IBKR: ${status.ErrorCode} ${status.ErrorMessage ?? ''}`.trim());
  }
  throw new Error('IBKR: the statement was not ready in time');
}
