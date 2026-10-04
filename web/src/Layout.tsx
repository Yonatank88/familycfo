import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartNoAxesColumn, Landmark, LayoutGrid, Menu, PiggyBank, Plug, Plus, RefreshCw, TrendingUp } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { api, type ScrapeState, type Summary } from './api';
import { asOf, type Currency } from './format';
import { AddReport } from './reports';
import { Segmented, button, primaryButton } from './ui';

export type Page = '/' | '/bank' | '/expenses' | '/investments' | '/funds' | '/integrations';
export const PAGES: { path: Page; label: string; icon: typeof LayoutGrid }[] = [
  { path: '/', label: 'Dashboard', icon: LayoutGrid },
  { path: '/bank', label: 'Bank', icon: Landmark },
  { path: '/investments', label: 'Investments', icon: TrendingUp },
  { path: '/funds', label: 'Funds', icon: PiggyBank },
  { path: '/integrations', label: 'Integrations', icon: Plug },
];

/** The scrape job's state, shared by the top bar and the Integrations page (a "Test connection" is a scrape too). */
export function useScrape() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: state = null } = useQuery({ queryKey: ['scrape'], queryFn: api.scrape,
    refetchInterval: q => (q.state.data?.status === 'running' || q.state.data?.status === 'pipeline' ? 2000 : false) });
  const running = state?.status === 'running' || state?.status === 'pipeline';
  // a run ended: everything it touched may have changed
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) qc.invalidateQueries({ predicate: q => q.queryKey[0] !== 'scrape' });
    was.current = running;
  }, [running, qc]);
  const set = (s: ScrapeState) => qc.setQueryData(['scrape'], s);

  return {
    state, running, error, set,
    start: () => { setError(null); api.startScrape().then(set).catch(e => setError((e as Error).message)); },
    otp: (code: string) => api.submitOtp(code).then(() => api.scrape().then(set)).catch(e => setError((e as Error).message)),
  };
}

/** The refresh progress and the bank's OTP prompt: a strip under the top bar while there is something to show. */
function ScrapeStrip({ scrape }: { scrape: ReturnType<typeof useScrape> }) {
  const { state, running, error, otp } = scrape;
  const [code, setCode] = useState('');
  if (!state?.otp && !error && !running) return null;
  const done = state?.companies.filter(c => c.status === 'done' || c.status === 'failed').length ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-2 text-xs sm:px-6">
      {running && <span className="tabular-nums text-muted">{state?.status === 'pipeline' ? 'Processing…' : `Refreshing ${done}/${state?.companies.length ?? 0}`}</span>}
      {state?.otp && (
        <form className="flex items-center gap-1.5" onSubmit={e => { e.preventDefault(); otp(code.trim()); setCode(''); }}>
          <label className="font-medium text-ink" htmlFor="otp">{state.otp.company} code</label>
          <input id="otp" value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus
            className="min-h-9 w-24 rounded-lg border border-line bg-surface px-2.5 py-1 outline-none focus:border-accent" />
          <button type="submit" className={primaryButton}>Send</button>
        </form>
      )}
      {error && <span className="text-down">{error}</span>}
    </div>
  );
}

function Sidebar({ page, navigate, summary }: { page: Page; navigate: (p: Page) => void; summary?: Summary }) {
  const accounts = summary?.accounts ?? [];
  const synced = accounts.map(a => a.lastSuccessAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const stale = accounts.some(a => a.stale);
  const link = (p: (typeof PAGES)[number]) => (
    <a key={p.path} href={p.path} onClick={e => { e.preventDefault(); navigate(p.path); }}
      aria-current={page === p.path ? 'page' : undefined}
      className={`flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium ${
        page === p.path ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-paper hover:text-ink'}`}>
      <p.icon className="size-4" />{p.label}
    </a>
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 px-5">
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-white"><ChartNoAxesColumn className="size-4" /></span>
        <span className="text-[15px] font-semibold tracking-tight text-ink">FamilyCFO</span>
      </div>
      <nav className="flex-1 px-3 pt-2">
        <div className="space-y-0.5">{PAGES.filter(p => p.path !== '/integrations').map(link)}</div>
        <div className="mx-2 my-3 border-t border-line" />
        <div className="space-y-0.5">{PAGES.filter(p => p.path === '/integrations').map(link)}</div>
      </nav>
      {synced && (
        <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-faint">
          <span className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-warn' : 'bg-up'}`} />
          Synced {asOf(synced)}
        </div>
      )}
    </div>
  );
}

export function Layout({ page, navigate, summary, currency, setCurrency, toReview, onReview, onAddIntegration, children }: {
  page: Page; navigate: (p: Page) => void; summary?: Summary; currency: Currency; setCurrency: (c: Currency) => void;
  toReview: number; onReview: () => void; onAddIntegration: () => void; children: ReactNode;
}) {
  const scrape = useScrape();
  const [drawer, setDrawer] = useState(false);
  const go = (p: Page) => { setDrawer(false); navigate(p); };
  const title = PAGES.find(p => p.path === page)?.label;
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar page={page} navigate={go} summary={summary} />
        </div>
      </aside>
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 border-line bg-surface p-0 lg:hidden">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <Sidebar page={page} navigate={go} summary={summary} />
        </SheetContent>
      </Sheet>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur">
          <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
            <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu"
              className="-ml-2 flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface lg:hidden">
              <Menu className="size-5" />
            </button>
            <h1 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h1>
            {toReview > 0 && (
              <button type="button" onClick={onReview}
                className="min-h-9 rounded-lg bg-warn/15 px-2.5 text-xs font-medium text-warn hover:bg-warn/25">
                {toReview} to review
              </button>
            )}
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              <Segmented label="Currency" value={currency} onChange={setCurrency} disabled={v => v === 'USD' && !summary?.usdRate}
                options={[{ value: 'ILS', label: '₪' }, { value: 'USD', label: '$' }]} />
              {page === '/integrations' && (
                <button type="button" onClick={onAddIntegration} aria-label="Add integration" className={primaryButton}>
                  <Plus className="size-3.5" /><span className="max-sm:hidden">Add integration</span>
                </button>
              )}
              <AddReport />
              <button type="button" onClick={scrape.start} disabled={scrape.running} aria-label="Refresh" className={button}>
                <RefreshCw className={`size-3.5 ${scrape.running ? 'animate-spin' : ''}`} /><span className="max-sm:hidden">Refresh</span>
              </button>
            </div>
          </div>
          <ScrapeStrip scrape={scrape} />
        </header>
        <main className="mx-auto max-w-[1280px] p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
