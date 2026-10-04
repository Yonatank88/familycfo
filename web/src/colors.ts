import type { Account } from './api';

/** One colour per asset type, shared by the chart, the allocation and the holdings' tags. */
export const TYPE_COLORS: Record<string, string> = {
  bank: 'var(--c1)', stock: 'var(--c2)', crypto: 'var(--c3)', stablecoin: 'var(--c6)', broker_cash: 'var(--c10)',
  mutual_fund: 'var(--c8)', pension: 'var(--c4)', study_fund: 'var(--c5)', provident_fund: 'var(--c9)', deposit: 'var(--c6)',
  other: 'var(--c7)', cards_owed: 'var(--c5)',
};
export const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c8)', 'var(--c9)'];
export const OTHER = 'var(--c7)';
export const TYPE_LABELS: Record<string, string> = {
  bank: 'Bank', stock: 'Stocks & ETFs', mutual_fund: 'Mutual funds', crypto: 'Crypto', stablecoin: 'Stablecoins', broker_cash: 'Broker cash',
  pension: 'Pension', study_fund: 'Study funds', provident_fund: 'Provident funds', deposit: 'Deposits', other: 'Other',
};

/** Fund-type money: report products that can't be traded (withdrawable from their liquidity date). */
export const FUND_CLASSES = new Set(['pension', 'study_fund', 'provident_fund', 'mutual_fund']);
export const SUB_TYPE_LABELS: Record<string, string> = {
  pension: 'Pension', study_fund: 'Study fund', provident_fund: 'Provident fund', mutual_fund: 'Mutual fund',
};

/** The sidebar's groups, matched on the account's asset class. Card balances owed sit with the bank. */
export const ACCOUNT_GROUPS = [
  { key: 'bank', label: 'Bank' },
  { key: 'investments', label: 'Investments' },
  { key: 'funds', label: 'Funds' },
] as const;
export const accountGroup = (a: Account): (typeof ACCOUNT_GROUPS)[number]['key'] =>
  a.assetClass === 'bank' || a.assetClass === 'cards_owed' ? 'bank' : FUND_CLASSES.has(a.assetClass) ? 'funds' : 'investments';

/** An account row's second line: its source (when the label doesn't already say it) and sub-type. */
export const accountSub = (a: Account) => [
  a.label.includes(a.sourceLabel) ? null : a.sourceLabel,
  SUB_TYPE_LABELS[a.assetClass] ?? null,
].filter(Boolean).join(' · ');
