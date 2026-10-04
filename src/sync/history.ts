/**
 * When a position was opened and what it cost, from the source's own history: IBKR's openDateTime, an exchange's trades
 * and deposits. Pure functions — the fetching lives with each adapter.
 */

/** IBKR's openDateTime ("20240115;093000", "20240115", "2024-01-15, 09:30:00", "2024-01-15 09:30:00") → YYYY-MM-DD. */
export function parseIbkrDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:$|[;,\sT])/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? `${y}-${mo}-${d}` : null;
}

/** One movement of a coin: a buy (its cost in USD, null when it can't be converted), a sell, or a transfer in / out. */
export interface CoinEvent {
  /** ms since epoch */
  at: number;
  type: 'buy' | 'sell' | 'in' | 'out';
  quantity: number;
  /** buys only: what the units cost in USD, fees included; null = unknown */
  costUsd?: number | null;
}

export interface CostResult {
  /** YYYY-MM-DD: the buy or deposit that opened the current position (after the last time it went to zero) */
  openedAt: string | null;
  /** USD cost of the current quantity; null when part of it came in without a known cost */
  costBasis: number | null;
  costSource: 'trades' | null;
}

/** Below this share of the position, units without a known cost (rounding, dust) don't make the cost unknown. */
const UNKNOWN_TOLERANCE = 0.01;
/** Units held beyond the pool, as a share of the holding, that still count as rewards at zero cost. */
const REWARD_TOLERANCE = 0.05;
const EPS = 1e-9;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Average cost (not FIFO): every buy adds its units and cost to one pool; a sell or a transfer out takes units at the
 * pool's average, so the average doesn't change; a transfer in adds units of unknown cost. The cost of the current
 * quantity is the pool's — unknown when more than 1% of the pool came in without a cost. Up to 5% more units than the
 * pool (earn interest, rewards) count at zero cost; more than that came from somewhere the history doesn't show (a
 * conversion, an airdrop), so the cost is unknown. Fewer units than the pool (fees, untracked moves) count at the average.
 * Opened = the first buy / transfer in after the pool was last empty.
 */
export function averageCost(events: CoinEvent[], currentQuantity: number): CostResult {
  let qty = 0, cost = 0, unknown = 0;
  let opened: number | null = null;
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (!(e.quantity > 0)) continue;
    if (e.type === 'buy' || e.type === 'in') {
      if (qty <= EPS) { opened = e.at; qty = 0; cost = 0; unknown = 0; }
      qty += e.quantity;
      if (e.type === 'buy' && e.costUsd != null) cost += e.costUsd;
      else unknown += e.quantity;
    } else {
      const f = Math.min(1, e.quantity / (qty || 1));
      cost *= 1 - f;
      unknown *= 1 - f;
      qty = Math.max(0, qty - e.quantity);
      if (qty <= EPS) { qty = 0; cost = 0; unknown = 0; opened = null; }
    }
  }
  if (opened == null || qty <= EPS) return { openedAt: null, costBasis: null, costSource: null };
  const openedAt = isoDay(opened);
  if (unknown / qty > UNKNOWN_TOLERANCE) return { openedAt, costBasis: null, costSource: null };
  if (currentQuantity > qty && (currentQuantity - qty) / currentQuantity > REWARD_TOLERANCE) return { openedAt, costBasis: null, costSource: null };
  const costBasis = currentQuantity >= qty ? cost : (cost / qty) * currentQuantity;
  return { openedAt, costBasis, costSource: 'trades' };
}
