/** One colour per top-level type, shared by the chart, the allocation and the holdings' groups. Sub-types get none. */
export const TYPE_COLORS: Record<string, string> = {
  bank: 'var(--c1)', stock: 'var(--c2)', crypto: 'var(--c3)', stablecoin: 'var(--c6)', broker_cash: 'var(--c10)', funds: 'var(--c4)',
  deposit: 'var(--c8)', other: 'var(--c7)', cards_owed: 'var(--c5)',
};
export const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c8)', 'var(--c9)'];
export const OTHER = 'var(--c7)';
export const TYPE_LABELS: Record<string, string> = {
  bank: 'Bank', stock: 'Stocks & ETFs', funds: 'Funds', crypto: 'Crypto', stablecoin: 'Stablecoins', broker_cash: 'Broker cash',
  deposit: 'Deposits', other: 'Other',
};

/** Each source's colour token (index.css `--color-src-*`): banks, cards, brokers, exchanges, wallets; report products by provider fall back to Reports. */
export const SOURCE_COLORS: Record<string, string> = {
  oneZero: 'var(--color-src-onezero)', hapoalim: 'var(--color-src-hapoalim)', otsarHahayal: 'var(--color-src-otsarhahayal)',
  isracard: 'var(--color-src-isracard)', max: 'var(--color-src-max)', ibkr: 'var(--color-src-ibkr)', binance: 'var(--color-src-binance)',
  kraken: 'var(--color-src-kraken)', wallets: 'var(--color-src-wallets)', report: 'var(--color-src-reports)',
};
export const SOURCE_OTHER = 'var(--color-src-other)';
/** A source id (company, investment source, `report` / `report:…`, or `<source>:<account>`) → its colour. */
export const sourceColor = (source: string | null | undefined) => {
  if (!source) return SOURCE_OTHER;
  const id = source.split(':')[0];
  return SOURCE_COLORS[id] ?? SOURCE_OTHER;
};

/** Spend natures: muted tints of the palette, so the stacked bars stay quiet. */
export const NATURE_COLORS: Record<'monthly' | 'everyday' | 'one_off', string> = {
  monthly: 'color-mix(in srgb, var(--c1) 78%, white)',
  everyday: 'color-mix(in srgb, var(--c6) 70%, white)',
  one_off: 'color-mix(in srgb, var(--c3) 80%, white)',
};
export const NATURE_LABELS: Record<'monthly' | 'everyday' | 'one_off', string> = { monthly: 'Monthly', everyday: 'Everyday', one_off: 'One-off' };
