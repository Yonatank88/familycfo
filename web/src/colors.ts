/** One colour per asset type, shared by the chart, the allocation and the holdings' tags. */
export const TYPE_COLORS: Record<string, string> = {
  bank: 'var(--c1)', stock: 'var(--c2)', crypto: 'var(--c3)', stablecoin: 'var(--c6)', broker_cash: 'var(--c10)',
  mutual_fund: 'var(--c8)', pension: 'var(--c4)', study_fund: 'var(--c5)', provident_fund: 'var(--c9)', deposit: 'var(--c6)',
  other: 'var(--c7)', cards_owed: 'var(--c5)',
};
export const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c8)', 'var(--c9)'];
export const OTHER = 'var(--c7)';
export const TYPE_LABELS: Record<string, string> = {
  bank: 'Bank', stock: 'Stock', mutual_fund: 'Fund', crypto: 'Crypto', stablecoin: 'Stable', broker_cash: 'Cash',
  pension: 'Pension', study_fund: 'Study fund', provident_fund: 'Provident', deposit: 'Deposit', other: 'Other',
};
