export type Range = '1M' | '3M' | 'YTD' | '1Y' | 'All';
export type Group = 'type' | 'source';

export interface Account {
  id: string; source: string; sourceLabel: string; label: string; kind: 'bank' | 'card' | 'investment';
  valueIls: number | null; value: number | null; currency: string; asOf: string | null; lastSuccessAt: string | null;
  stale: boolean; fxMissing: boolean;
}
export interface Holding {
  id: number; symbol: string; name: string; source: string; sourceLabel: string; assetClass: string;
  quantity: number; currency: string; price: number | null; value: number; valueIls: number | null;
  pctOfInvestments: number | null; changePct: number | null; fxMissing: boolean;
  /** since purchase, from the source's cost basis (IBKR only) */
  gainIls: number | null; gainPct: number | null;
}
export interface Slice { key: string; label: string; value: number }
export interface Summary {
  asOf: string; range: Range; netWorth: number; bank: number; investments: number; cardsOwed: number | null;
  usdRate: number | null; accounts: Account[]; holdings: Holding[]; allocation: Record<Group, Slice[]>;
}
export interface HistoryPoint {
  date: string; values: Record<string, number>; netWorth: number; bank: number; investments: number;
  cardsOwed: number | null; usdRate: number | null;
}
export interface History {
  range: Range; from: string; series: { key: string; label: string }[]; points: HistoryPoint[];
  start: { netWorth: number | null; bank: number | null; investments: number | null; cardsOwed: number | null } | null;
}
export interface ExpenseMonth { month: string; total: number; merchants: { key: string; name: string; total: number; count: number }[] }
export interface Expenses { currentMonth: string; months: ExpenseMonth[] }
export interface ExpenseRow { id: number; date: string; description: string; account: string; amount: number }
export interface ScrapeState {
  status: 'idle' | 'running' | 'pipeline' | 'done' | 'failed';
  companies: { company: string; status: string; error: string | null }[];
  otp: { company: string; requestedAt: string } | null;
  error: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body?: unknown) => request<T>(path, {
  method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
});

export const api = {
  summary: (range: Range) => request<Summary>(`/api/summary?range=${range}`),
  history: (range: Range, group: Group) => request<History>(`/api/history?range=${range}&group=${group}`),
  expenses: () => request<Expenses>('/api/expenses?months=12'),
  expenseRows: (month: string, merchant?: string) =>
    request<ExpenseRow[]>(`/api/expenses/rows?month=${month}${merchant ? `&merchant=${encodeURIComponent(merchant)}` : ''}`),
  scrape: () => request<ScrapeState>('/api/scrape'),
  startScrape: () => post<ScrapeState>('/api/scrape'),
  submitOtp: (code: string) => post<{ ok: true }>('/api/scrape/otp', { code }),
};
