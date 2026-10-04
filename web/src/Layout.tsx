import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Account, type ScrapeState, type Summary } from './api';
import { asOf, money, type Currency } from './format';
import { AddReport } from './reports';
import { ChevronDown, CloseIcon, LayoutIcon, LogoIcon, MenuIcon, Pills, PlugIcon, RefreshIcon, button, primaryButton } from './ui';

export type Page = '/' | '/integrations';
export const PAGES: { path: Page; label: string; icon: typeof LayoutIcon }[] = [
  { path: '/', label: 'Dashboard', icon: LayoutIcon },
  { path: '/integrations', label: 'Integrations', icon: PlugIcon },
];

function useScrape() {
  const qc = useQueryClient();
  const [state, setState] = useState<ScrapeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = state?.status === 'running' || state?.status === 'pipeline';

  useEffect(() => { api.scrape().then(setState).catch(() => {}); }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api.scrape().then(s => {
        setState(s);
        if (s.status === 'done' || s.status === 'failed') qc.invalidateQueries();
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [running, qc]);

  return {
    state, running, error,
    start: () => { setError(null); api.startScrape().then(setState).catch(e => setError((e as Error).message)); },
    otp: (code: string) => api.submitOtp(code).then(() => api.scrape().then(setState)).catch(e => setError((e as Error).message)),
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
            className="w-24 rounded-lg border border-line bg-surface px-2.5 py-1 outline-none focus:border-accent" />
          <button type="submit" className={primaryButton}>Send</button>
        </form>
      )}
      {error && <span className="text-down">{error}</span>}
    </div>
  );
}

const GROUPS: { key: string; label: string; match: (a: Account) => boolean }[] = [
  { key: 'bank', label: 'Bank', match: a => a.kind === 'bank' },
  { key: 'cards', label: 'Cards', match: a => a.kind === 'card' },
  { key: 'investments', label: 'Investments', match: a => a.kind === 'investment' && !a.source.startsWith('report:') },
  { key: 'savings', label: 'Savings', match: a => a.source.startsWith('report:') },
];

function AccountGroups({ accounts, currency, convert }: { accounts: Account[]; currency: Currency; convert: (n: number) => number }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <div className="space-y-1">
      {GROUPS.map(g => {
        const rows = accounts.filter(g.match);
        if (!rows.length) return null;
        const total = rows.reduce((s, a) => s + (a.valueIls ?? 0), 0);
        const open = !closed[g.key];
        return (
          <div key={g.key}>
            <button type="button" onClick={() => setClosed({ ...closed, [g.key]: open })}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-muted hover:bg-paper">
              <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
              <span className="flex-1">{g.label}</span>
              <span className="tabular-nums text-faint">{money(convert(total), currency)}</span>
            </button>
            {open && (
              <ul className="pb-1">
                {rows.map(a => (
                  <li key={a.id} className="flex items-center gap-2 py-1 pl-7 pr-2 text-[13px]">
                    <span className="truncate text-ink" title={`${a.sourceLabel} · ${asOf(a.asOf)}`}><bdi>{a.label}</bdi></span>
                    {a.stale && <span title={`Last successful sync: ${asOf(a.lastSuccessAt)}`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
                    <span className={`ml-auto shrink-0 tabular-nums ${a.fxMissing ? 'text-warn' : 'text-muted'}`}>
                      {a.valueIls == null ? '—' : money(convert(a.valueIls), currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Sidebar({ page, navigate, summary, currency, convert }: {
  page: Page; navigate: (p: Page) => void; summary?: Summary; currency: Currency; convert: (n: number) => number;
}) {
  const accounts = summary?.accounts ?? [];
  const synced = accounts.map(a => a.lastSuccessAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const stale = accounts.some(a => a.stale);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 px-5">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white"><LogoIcon className="h-4 w-4" /></span>
        <span className="text-[15px] font-semibold tracking-tight text-ink">FamilyCFO</span>
      </div>
      <nav className="space-y-0.5 px-3 pt-2">
        {PAGES.map(p => (
          <a key={p.path} href={p.path} onClick={e => { e.preventDefault(); navigate(p.path); }}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium ${
              page === p.path ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-paper hover:text-ink'}`}>
            <p.icon className="h-4 w-4" />{p.label}
          </a>
        ))}
      </nav>
      <div className="mx-5 my-4 border-t border-line" />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <AccountGroups accounts={accounts} currency={currency} convert={convert} />
      </div>
      {synced && (
        <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-faint">
          <span className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-warn' : 'bg-up'}`} />
          Synced {asOf(synced)}
        </div>
      )}
    </div>
  );
}

export function Layout({ page, navigate, summary, currency, setCurrency, convert, children }: {
  page: Page; navigate: (p: Page) => void; summary?: Summary; currency: Currency; setCurrency: (c: Currency) => void;
  convert: (n: number) => number; children: ReactNode;
}) {
  const scrape = useScrape();
  const [drawer, setDrawer] = useState(false);
  const go = (p: Page) => { setDrawer(false); navigate(p); };
  const title = PAGES.find(p => p.path === page)?.label;
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar page={page} navigate={go} summary={summary} currency={currency} convert={convert} />
        </div>
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 bg-ink/20 lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="relative h-full w-72 max-w-[85vw] bg-surface shadow-xl" onClick={e => e.stopPropagation()}>
            <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu"
              className="absolute right-3 top-3.5 rounded-lg p-1.5 text-muted hover:bg-paper"><CloseIcon className="h-4 w-4" /></button>
            <Sidebar page={page} navigate={go} summary={summary} currency={currency} convert={convert} />
          </aside>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-line bg-paper/85 backdrop-blur">
          <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
            <button type="button" onClick={() => setDrawer(true)} aria-label="Menu" className="-ml-1.5 rounded-lg p-1.5 text-muted hover:bg-surface lg:hidden">
              <MenuIcon className="h-5 w-5" />
            </button>
            <h1 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h1>
            <div className="ml-auto flex items-center gap-2">
              <Pills value={currency} onChange={setCurrency} disabled={v => v === 'USD' && !summary?.usdRate}
                options={[{ value: 'ILS', label: '₪' }, { value: 'USD', label: '$' }]} />
              <AddReport />
              <button type="button" onClick={scrape.start} disabled={scrape.running} className={button}>
                <RefreshIcon className={`h-3.5 w-3.5 ${scrape.running ? 'animate-spin' : ''}`} /><span className="max-sm:hidden">Refresh</span>
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
