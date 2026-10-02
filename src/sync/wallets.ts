import type { SyncedAccount, SyncedPosition } from './holdings.js';

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
  wallets: { address: string; label?: string; ownerMemberId?: number }[];
  /** tokens worth less than this (USD) are left out — airdropped spam, dust; default 1 */
  minUsd?: number;
}

/** The coin a network pays its fees in, for native balances (they come without token metadata). */
const NATIVE: Record<string, string> = {
  'eth-mainnet': 'ETH', 'arb-mainnet': 'ETH', 'opt-mainnet': 'ETH', 'base-mainnet': 'ETH', 'zksync-mainnet': 'ETH',
  'linea-mainnet': 'ETH', 'scroll-mainnet': 'ETH', 'matic-mainnet': 'POL', 'polygon-mainnet': 'POL', 'bnb-mainnet': 'BNB',
  'avax-mainnet': 'AVAX',
};

/** Yahoo lists crypto as <SYMBOL>-USD; a symbol that isn't a plain ticker gets no quote. */
export const cryptoYahooSymbol = (symbol: string) => (/^[A-Z0-9]{2,10}$/.test(symbol) ? `${symbol}-USD` : null);

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

/** Alchemy's tokens of one address → positions, one per symbol (the same coin on several networks adds up). */
export function walletPositions(tokens: any[], minUsd = 1): SyncedPosition[] {
  const bySymbol = new Map<string, { name: string | null; quantity: number; value: number }>();
  for (const t of tokens) {
    const native = !t.tokenAddress;
    const symbol = String(t.tokenMetadata?.symbol ?? (native ? NATIVE[t.network] ?? '' : '')).trim().toUpperCase();
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
    .map(([symbol, v]) => ({ symbol, yahoo: cryptoYahooSymbol(symbol), name: v.name, quantity: v.quantity, currency: 'USD', price: v.value / v.quantity }));
}

export async function fetchWallets(cfg: WalletsSource): Promise<{ raw: unknown; accounts: SyncedAccount[] }> {
  if (!cfg.apiKey) throw new Error('wallets: apiKey (Alchemy) is required');
  const id = cfg.id ?? 'wallets';
  const networks = cfg.networks?.length ? cfg.networks : ['eth-mainnet'];
  const raw: Record<string, unknown[]> = {};
  const accounts: SyncedAccount[] = [];
  for (const w of cfg.wallets ?? []) {
    const address = w.address.trim().toLowerCase();
    const tokens = await tokensOf(cfg.apiKey, address, networks);
    raw[address] = tokens;
    accounts.push({ source: `${id}:${address}`, broker: w.label ?? 'ארנק קריפטו', ownerMemberId: w.ownerMemberId ?? null,
      positions: walletPositions(tokens, cfg.minUsd ?? 1) });
  }
  return { raw, accounts };
}
