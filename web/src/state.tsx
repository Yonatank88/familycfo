import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Meta } from './api';

export interface Filters {
  memberId?: number;
  tagIds: number[];
}

interface Ctx {
  filters: Filters;
  setFilters: (f: Filters) => void;
  /** query params shared by every filtered endpoint */
  params: { member?: number; tags?: number[] };
}

const FiltersContext = createContext<Ctx | null>(null);

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<Filters>({ tagIds: [] });
  const value = useMemo(() => ({
    filters, setFilters,
    params: { member: filters.memberId, tags: filters.tagIds },
  }), [filters]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): Ctx {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error('useFilters outside FiltersProvider');
  return ctx;
}

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta'), staleTime: 60_000 });
}

/** Lookup helpers over meta. */
export function useLookups() {
  const { data } = useMeta();
  return useMemo(() => {
    const members = new Map((data?.members ?? []).map(m => [m.id, m]));
    const accounts = new Map((data?.accounts ?? []).map(a => [a.id, a]));
    const categories = new Map((data?.categories ?? []).map(c => [c.id, c]));
    const tags = new Map((data?.tags ?? []).map(t => [t.id, t]));
    return {
      meta: data,
      member: (id: number | null | undefined) => (id == null ? undefined : members.get(id)),
      accountName: (id: string | null | undefined) => (id ? accounts.get(id)?.displayName ?? id : '—'),
      category: (id: number | null | undefined) => (id == null ? undefined : categories.get(id)),
      tag: (id: number) => tags.get(id),
    };
  }, [data]);
}
