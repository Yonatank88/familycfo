import type { Account } from './api';

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

/** The sidebar's groups, matched on the account's type. Card balances owed sit with the bank. */
export const ACCOUNT_GROUPS = [
  { key: 'bank', label: 'Bank' },
  { key: 'investments', label: 'Investments' },
  { key: 'funds', label: 'Funds' },
] as const;
export const accountGroup = (a: Account): (typeof ACCOUNT_GROUPS)[number]['key'] =>
  a.type === 'bank' || a.type === 'cards_owed' ? 'bank' : a.type === 'funds' ? 'funds' : 'investments';

/** An account row's second line: its source (when the label doesn't already say it) and sub-type. */
export const accountSub = (a: Account) => [
  a.label.includes(a.sourceLabel) ? null : a.sourceLabel,
  a.subType,
].filter(Boolean).join(' · ');
