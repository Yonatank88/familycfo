import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Range } from './api';
import type { Currency } from './format';
import Dashboard from './Dashboard';
import { Layout, PAGES, type Page } from './Layout';
import { ReportPanel, useReports } from './reports';

const pageOf = (): Page => (PAGES.find(p => p.path === window.location.pathname)?.path ?? '/');

export default function App() {
  const [page, setPage] = useState<Page>(pageOf);
  const [range, setRange] = useState<Range>('1Y');
  const [currency, setCurrency] = useState<Currency>('ILS');
  const [openReport, setOpenReport] = useState<number | null>(null);
  useEffect(() => {
    const onPop = () => setPage(pageOf());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (p: Page) => {
    if (p !== page) window.history.pushState(null, '', p);
    setPage(p);
    window.scrollTo(0, 0);
  };

  const summary = useQuery({ queryKey: ['summary', range], queryFn: () => api.summary(range), placeholderData: p => p });
  const reports = useReports();
  const usdNow = summary.data?.usdRate ?? null;
  const convert = (n: number) => (currency === 'USD' && usdNow ? n / usdNow : n);

  return (
    <Layout page={page} navigate={navigate} summary={summary.data} currency={currency} setCurrency={setCurrency} convert={convert}>
      {summary.error && <p className="pb-4 text-sm text-down">{(summary.error as Error).message}</p>}
      <Dashboard summary={summary.data} range={range} setRange={setRange} currency={currency} convert={convert}
        reports={reports} onOpenReport={setOpenReport} />
      {openReport != null && <ReportPanel id={openReport} onClose={() => setOpenReport(null)} />}
    </Layout>
  );
}
