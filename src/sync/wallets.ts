import type { SyncedAccount, SyncedPosition } from './holdings.js';
import { baseCoin, coinAssetClass } from './assets.js';

/**
 * Self-custody wallets (EVM) through Alchemy's Portfolio API: every token of each address on the configured
 * networks, native coin included, with Alchemy's USD price. Only the addresses are sent. A free key is enough.
 */
export interface WalletsSource {
  type: 'wallets';
  /** default "wallets" */
  id?: string;
  apiKey: string;
  /** Alchemy network ids; default eth-mainnet */
  networks?: string[];
  wallets: { address: string; label?: string }[];
  /** tokens worth less than this (USD) are left out — airdropped spam, dust; default 1 */
  minUsd?: number;
}

/** The coin a network pays its fees in, for native balances (they come without token metadata). */
const NATIVE: Record<string, string> = {
  'eth-mainnet': 'ETH', 'arb-mainnet': 'ETH', 'opt-mainnet': 'ETH', 'base-mainnet': 'ETH', 'zksync-mainnet': 'ETH',
  'linea-mainnet': 'ETH', 'scroll-mainnet': 'ETH', 'matic-mainnet': 'POL', 'polygon-mainnet': 'POL', 'bnb-mainnet': 'BNB',
  'avax-mainnet': 'AVAX',
};

/** Yahoo lists crypto as <SYMBOL>-USD (bridged stablecoins as their base); a symbol that isn't a plain ticker gets no quote. */
export const cryptoYahooSymbol = (symbol: string) => {
  const coin = baseCoin(symbol);
  return /^[A-Z0-9]{2,10}$/.test(coin) ? `${coin}-USD` : null;
};

const units = (balance: string | null | undefined, decimals: number) => {
  if (!balance) return 0;
  const raw = balance.startsWith('0x') ? BigInt(balance) : BigInt(balance.split('.')[0]);
  return Number(raw) / 10 ** decimals;
};

async function tokensOf(apiKey: string, address: string, networks: string[]): Promise<any[]> {
  const tokens: any[] = [];
  let pageKey: string | undefined;
  do {
    const res = await fetch(`https://api.g.alchemy.com/data/v1/${encodeURIComponent(apiKey)}/assets/tokens/by-address`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses: [{ address, networks }], withMetadata: true, withPrices: true, includeNativeTokens: true, pageKey }),
      signal: AbortSignal.timeout(30_000),
    });
    // never echo the URL: it carries the key
    if (!res.ok) throw new Error(`Alchemy HTTP ${res.status}`);
    const body = await res.json() as { data?: { tokens?: any[]; pageKey?: string } };
    tokens.push(...(body.data?.tokens ?? []));
    pageKey = body.data?.pageKey || undefined;
  } while (pageKey);
  return tokens;
}

const symbolOf = (t: any) => String(t.tokenMetadata?.symbol ?? (!t.tokenAddress ? NATIVE[t.network] ?? '' : '')).trim().toUpperCase();

/** Where each symbol of an address lives: its networks and token contracts (null = the network's native coin). */
export function tokenContracts(tokens: any[]): Map<string, { network: string; contract: string | null }[]> {
  const out = new Map<string, { network: string; contract: string | null }[]>();
  for (const t of tokens) {
    const symbol = symbolOf(t);
    if (!symbol || !t.network) continue;
    out.set(symbol, [...(out.get(symbol) ?? []), { network: t.network, contract: t.tokenAddress ?? null }]);
  }
  return out;
}

/** Alchemy's tokens of one address → positions, one per symbol (the same coin on several networks adds up). */
export function walletPositions(tokens: any[], minUsd = 1): SyncedPosition[] {
  const bySymbol = new Map<string, { name: string | null; quantity: number; value: number }>();
  for (const t of tokens) {
    const symbol = symbolOf(t);
    if (!symbol) continue;
    const quantity = units(t.tokenBalance, t.tokenMetadata?.decimals ?? 18);
    const price = Number((t.tokenPrices ?? []).find((p: any) => p.currency?.toLowerCase() === 'usd')?.value ?? 0);
    if (!quantity || !price) continue;
    const cur = bySymbol.get(symbol) ?? { name: t.tokenMetadata?.name ?? null, quantity: 0, value: 0 };
    cur.quantity += quantity;
    cur.value += quantity * price;
    bySymbol.set(symbol, cur);
  }
  return [...bySymbol.entries()]
    .filter(([, v]) => v.value >= minUsd)
    .map(([symbol, v]) => ({ symbol, yahoo: cryptoYahooSymbol(symbol), name: v.name, quantity: v.quantity, currency: 'USD',
      assetClass: coinAssetClass(symbol), price: v.value / v.quantity }));
}

/** Networks where Alchemy indexes internal (contract → address) native transfers. */
const INTERNAL_NETWORKS = new Set(['eth-mainnet', 'matic-mainnet', 'polygon-mainnet']);

/**
 * The first inbound transfer of an asset to an address (alchemy_getAssetTransfers, oldest first, one result): its
 * block time as YYYY-MM-DD, or null when there is none. The raw response is returned for the archive.
 */
export async function firstInbound(apiKey: string, network: string, address: string, contract: string | null): Promise<{ date: string | null; raw: unknown }> {
  const params: Record<string, unknown> = {
    fromBlock: '0x0', toBlock: 'latest', toAddress: address, order: 'asc', maxCount: '0x1', withMetadata: true, excludeZeroValue: true,
    category: contract ? ['erc20'] : INTERNAL_NETWORKS.has(network) ? ['external', 'internal'] : ['external'],
    ...(contract ? { contractAddresses: [contract] } : {}),
  };
  const res = await fetch(`https://${network}.g.alchemy.com/v2/${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
    signal: AbortSignal.timeout(30_000),
  });
  // never echo the URL: it carries the key
  if (!res.ok) throw new Error(`Alchemy transfers HTTP ${res.status}`);
  const body = await res.json() as { result?: { transfers?: { metadata?: { blockTimestamp?: string } }[] }; error?: { message?: string } };
  if (body.error) throw new Error(`Alchemy transfers: ${body.error.message ?? 'error'}`);
  const at = body.result?.transfers?.[0]?.metadata?.blockTimestamp;
  return { date: at ? at.slice(0, 10) : null, raw: body.result ?? null };
}

/**
 * `known(source, symbol)`: the opening date already stored for a holding — looked up once, then cached in the holding
 * (a wallet's first inbound transfer doesn't change).
 */
export async function fetchWallets(cfg: WalletsSource, opts: { known?: (source: string, symbol: string) => string | null } = {}):
  Promise<{ raw: unknown; accounts: SyncedAccount[]; asOf?: string | null; history?: unknown; warnings?: string[] }> {
  if (!cfg.apiKey) throw new Error('wallets: apiKey (Alchemy) is required');
  const id = cfg.id ?? 'wallets';
  const networks = cfg.networks?.length ? cfg.networks : ['eth-mainnet'];
  const raw: Record<string, unknown[]> = {};
  const history: Record<string, unknown> = {};
  const warnings = new Set<string>();
  const accounts: SyncedAccount[] = [];
  for (const w of cfg.wallets ?? []) {
    const address = w.address.trim().toLowerCase();
    const tokens = await tokensOf(cfg.apiKey, address, networks);
    raw[address] = tokens;
    const source = `${id}:${address}`;
    const positions = walletPositions(tokens, cfg.minUsd ?? 1);
    const contracts = tokenContracts(tokens);
    for (const p of positions) {
      const stored = opts.known?.(source, (p.yahoo ?? p.symbol).toUpperCase());
      if (stored) { p.openedAt = stored; continue; }
      const dates: string[] = [];
      let failed = false;
      for (const c of contracts.get(p.symbol) ?? []) {
        try {
          const r = await firstInbound(cfg.apiKey, c.network, address, c.contract);
          history[`${address}:${c.network}:${c.contract ?? 'native'}`] = r.raw;
          if (r.date) dates.push(r.date);
        } catch (err) {
          failed = true;
          warnings.add(`first transfers: ${(err as Error).message}`);
        }
      }
      // a failed lookup leaves the stored date alone (undefined); found nothing at all = unknown
      if (dates.length) p.openedAt = dates.sort()[0];
      else if (!failed) p.openedAt = null;
    }
    accounts.push({ source, broker: w.label ?? 'Crypto wallet', positions });
  }
  return { raw, accounts, asOf: new Date().toISOString(), history, warnings: [...warnings] };
}
