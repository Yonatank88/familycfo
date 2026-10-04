/** How a position counts on the dashboard. Set by each sync adapter, stored on the holding. */
export type AssetClass = 'stock' | 'crypto' | 'stablecoin' | 'broker_cash';

/**
 * USD-pegged stablecoins — one list for pricing (they're quoted like any coin, never assumed to be $1) and for the
 * Stablecoins bucket. FRAX isn't here: on exchanges that ticker is now Frax's governance token.
 */
export const STABLECOINS = new Set([
  'USDT', 'USDC', 'DAI', 'FDUSD', 'PYUSD', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'LUSD', 'USDS', 'USDE', 'USD1', 'RLUSD', 'USDG', 'CRVUSD', 'GHO',
]);

/** Fiat balances held at an exchange (cash, not coins). */
export const FIAT = new Set(['USD', 'EUR', 'ILS', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD']);

/** Bridged / wrapped stablecoin tickers → their base (USDC.e, USDbC, axlUSDC → USDC). */
const STABLE_ALIASES: Record<string, string> = { USDBC: 'USDC', AXLUSDC: 'USDC', 'USDC.E': 'USDC', 'USDT.E': 'USDT', 'DAI.E': 'DAI', USDT0: 'USDT', XDAI: 'DAI', WXDAI: 'DAI' };

/** The coin a ticker stands for: bridged / wrapped stablecoins map to their base, anything else stays as it is. */
export function baseCoin(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (STABLE_ALIASES[s]) return STABLE_ALIASES[s];
  const head = s.split('.')[0];
  return STABLECOINS.has(head) ? head : s;
}

export const isStablecoin = (symbol: string) => STABLECOINS.has(baseCoin(symbol));

/** A coin or currency held at an exchange or in a wallet. */
export function coinAssetClass(symbol: string): AssetClass {
  const s = symbol.trim().toUpperCase();
  if (FIAT.has(s)) return 'broker_cash';
  return isStablecoin(s) ? 'stablecoin' : 'crypto';
}

/** An IBKR position: securities are stocks & ETFs, crypto is crypto, cash is broker cash. */
export function ibkrAssetClass(assetCategory: string): AssetClass {
  if (assetCategory === 'CRYPTO') return 'crypto';
  if (assetCategory === 'CASH') return 'broker_cash';
  // STK / ETF / FUND — and the rare others (warrants, options, bonds) count with the securities
  return 'stock';
}
