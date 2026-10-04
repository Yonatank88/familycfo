import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Range } from './api';
import type { Currency } from './format';
import Bank from './Bank';
import Dashboard from './Dashboard';
import Funds from './Funds';
import Investments from './Investments';
import IntegrationEditor, { type EditorMode } from './IntegrationEditor';
import Integrations from './Integrations';
import Expenses from './Expenses';
import { Layout, ROUTES, type Page } from './Layout';
import { ReportPanel, ReportUpload, useReports } from './reports';

const pageOf = (): Page => {
  // the old Expenses address now lives under Bank
  if (window.location.pathname === '/expenses') window.history.replaceState(null, '', '/bank/expenses');
  return ROUTES.find(p => p === window.location.pathname) ?? '/';
};

export default function App() {
  const [page, setPage] = useState<Page>(pageOf);
  const [range, setRange] = useState<Range>('1Y');
  const [currency, setCurrency] = useState<Currency>('ILS');
  const [openReport, setOpenReport] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorMode | null>(null);
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
  const toReview = reports.filter(r => r.status === 'needs_review');
  const usdNow = summary.data?.usdRate ?? null;
  const convert = (n: number) => (currency === 'USD' && usdNow ? n / usdNow : n);

  return (
    <ReportUpload>
      <Layout page={page} navigate={navigate} summary={summary.data} currency={currency} setCurrency={setCurrency}
        toReview={toReview.length} onReview={() => toReview[0] && setOpenReport(toReview[0].id)} onAddIntegration={() => setEditor({ kind: 'add' })}>
        {summary.error && <p className="pb-4 text-sm text-down">{(summary.error as Error).message}</p>}
        {page === '/integrations'
          ? <Integrations currency={currency} convert={convert} reports={reports} onOpenReport={setOpenReport} onEdit={key => setEditor({ kind: 'edit', key })} />
          : page === '/bank'
            ? <Bank range={range} setRange={setRange} currency={currency} convert={convert} />
            : page === '/bank/expenses'
              ? <Expenses range={range} setRange={setRange} currency={currency} convert={convert} />
            : page === '/investments'
              ? <Investments range={range} setRange={setRange} currency={currency} convert={convert} />
              : page === '/funds'
                ? <Funds range={range} setRange={setRange} currency={currency} convert={convert} />
                : <Dashboard summary={summary.data} currency={currency} convert={convert} navigate={navigate} />}
        {openReport != null && <ReportPanel id={openReport} onClose={() => setOpenReport(null)} />}
        {editor && <IntegrationEditor mode={editor} onClose={() => setEditor(null)} />}
      </Layout>
    </ReportUpload>
  );
}
