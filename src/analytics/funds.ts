import type { DB } from '../db/connection.js';
import type { StatedReturns } from '../reports/extract.js';
import { round, today } from '../util.js';
import { rateToIls } from './fx.js';
import { reportOwners } from './owners.js';
import { FUND_CLASSES, rangeStart, reportLabels, subTypeOf, type Range } from './summary.js';

/** A fund's value point from a report (the last of its date). */
export interface FundPoint { asOf: string; balance: number; returns: StatedReturns | null }

export type StatedPeriod = 'YTD' | '12M' | '36M';
export interface FundGrowth {
  growth: number | null;
  growthPct: number | null;
  /** the points it compares; null when it is a stated return */
  from: string | null;
  to: string | null;
  /** the report's own return used instead (fewer than two points over the range), and for which period */
  stated: StatedPeriod | null;
}

const monthsOf = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (30.44 * 86_400_000);
const ytdMonths = (date: string) => monthsOf(`${date.slice(0, 4)}-01-01`, date);

/**
 * A fund's growth over the range: the value change between the report points bracketing it — the last point on or
 * before the range's start (else the first after it) and the latest point. With fewer than two such points, the
 * return the latest report states for the period closest to the range's length (YTD, 12 or 36 months), marked stated.
 */
export function fundGrowth(points: FundPoint[], range: Range, from: string, asOf = today()): FundGrowth {
  const none: FundGrowth = { growth: null, growthPct: null, from: null, to: null, stated: null };
  const sorted = [...points].sort((a, b) => a.asOf.localeCompare(b.asOf));
  const end = sorted.at(-1);
  if (!end) return none;
  const start = sorted.filter(p => p.asOf <= from).at(-1) ?? sorted.find(p => p.asOf > from);
  if (start && start.asOf < end.asOf) {
    const growth = end.balance - start.balance;
    return { growth: round(growth), growthPct: start.balance ? round((growth / start.balance) * 100) : null, from: start.asOf, to: end.asOf, stated: null };
  }
  const printed = [...sorted].reverse().find(p => p.returns);
  if (!printed?.returns) return none;
  const length = range === '1M' ? 1 : range === '3M' ? 3 : range === '1Y' ? 12 : range === 'YTD' ? ytdMonths(asOf) : monthsOf(from, asOf);
  const periods = ([['YTD', printed.returns.ytd, ytdMonths(printed.asOf)], ['12M', printed.returns.m12, 12], ['36M', printed.returns.m36, 36]] as const)
    .filter(([, v]) => v != null)
    .sort((a, b) => Math.abs(a[2] - length) - Math.abs(b[2] - length));
  const [period, pct] = periods[0] ?? [];
  return period ? { growth: null, growthPct: pct!, from: null, to: null, stated: period } : none;
}

const parseReturns = (s: string | null): StatedReturns | null => { try { return s ? JSON.parse(s) as StatedReturns : null; } catch { return null; } };

/**
 * `/api/funds`: each fund (pension, study, provident, mutual — the Funds type) with its value, as-of, liquidity date,
 * growth over the range, the returns its latest report printed, and its report points.
 */
export function funds(db: DB, range: Range, asOf = today()) {
  const from = rangeStart(db, range, asOf);
  const labels = reportLabels(db);
  const owners = reportOwners(db);
  const holdings = (db.prepare(`SELECT source, symbol, name, broker, asset_class, currency FROM holdings
    WHERE archived = 0 AND source LIKE 'report:%'`).all() as { source: string; symbol: string; name: string | null; broker: string | null;
      asset_class: string; currency: string | null }[]).filter(h => FUND_CLASSES.has(h.asset_class));
  const pointsOf = db.prepare(`
    SELECT v.as_of, v.balance, v.currency, v.liquidity_date, v.returns FROM report_values v JOIN reports r ON r.id = v.report_id
    WHERE v.holding_source = ? AND r.status = 'applied' ORDER BY v.as_of, v.report_id
  `);
  const list = holdings.map(h => {
    const rows = pointsOf.all(h.source) as { as_of: string; balance: number; currency: string; liquidity_date: string | null; returns: string | null }[];
    const byDate = new Map(rows.map(r => [r.as_of, r]));
    const points = [...byDate.values()];
    const latest = points.at(-1);
    const currency = latest?.currency ?? h.currency ?? 'ILS';
    const rate = rateToIls(db, currency, asOf);
    const g = fundGrowth(points.map(p => ({ asOf: p.as_of, balance: p.balance, returns: parseReturns(p.returns) })), range, from, asOf);
    const printed = [...points].reverse().find(p => parseReturns(p.returns));
    return {
      source: h.source, name: labels.get(h.source) ?? h.name ?? h.symbol, provider: h.broker, owner: owners.get(h.source) ?? null,
      subType: subTypeOf(h.asset_class), currency,
      value: latest?.balance ?? null, valueIls: latest && rate != null ? round(latest.balance * rate) : null,
      asOf: latest?.as_of ?? null, liquidityDate: latest?.liquidity_date ?? null,
      growthIls: g.growth != null && rate != null ? round(g.growth * rate) : null, growthPct: g.growthPct,
      growthFrom: g.from, growthTo: g.to, stated: g.stated,
      returns: printed ? { ...parseReturns(printed.returns)!, asOf: printed.as_of } : null,
      points: points.map(p => {
        const r = rateToIls(db, p.currency, p.as_of);
        return { date: p.as_of, valueIls: r == null ? null : round(p.balance * r) };
      }),
    };
  }).sort((a, b) => (b.valueIls ?? 0) - (a.valueIls ?? 0));
  return { range, from, funds: list };
}
