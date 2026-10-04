import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { api, type Summary } from './api';
import { money, type Currency } from './format';
import type { Page } from './Layout';

/** The previous calendar month of "YYYY-MM". */
const prevMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

/** An in-app link (pushState navigation). */
function Link({ to, navigate, className, children }: { to: Page; navigate: (p: Page) => void; className?: string; children: ReactNode }) {
  return <a href={to} onClick={e => { e.preventDefault(); navigate(to); }} className={className}>{children}</a>;
}

/** One dashboard card: its title and total open its page; `children` sit below. */
function Tile({ title, to, value, navigate, children }: {
  title: string; to: Page; value: string; navigate: (p: Page) => void; children?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(20,33,61,0.04)]">
      <Link to={to} navigate={navigate} className="group block rounded-2xl px-5 pb-5 pt-4 hover:bg-paper/60">
        <h2 className="flex items-center justify-between text-[15px] font-semibold tracking-tight text-ink">
          {title}<ChevronRight className="size-4 text-faint group-hover:text-accent" />
        </h2>
        <div className="mt-3 text-[28px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{value}</div>
      </Link>
      {children}
    </section>
  );
}

export default function Dashboard({ summary: s, currency, convert, navigate }: {
  summary?: Summary; currency: Currency; convert: (n: number) => number; navigate: (p: Page) => void;
}) {
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: api.expenses });
  if (!s) return null;

  const total = (keep: (type: string) => boolean) => s.holdings.filter(h => keep(h.type)).reduce((a, h) => a + (h.valueIls ?? 0), 0);
  const current = expenses.data?.currentMonth;
  const spent = (m: string | undefined) => (m ? expenses.data?.months.find(x => x.month === m)?.total ?? 0 : null);
  const thisMonth = spent(current);
  const lastMonth = current ? spent(prevMonth(current)) : null;
  const fmt = (n: number | null) => (n == null ? '—' : money(convert(n), currency));

  return (
    <div className="grid gap-5 md:grid-cols-3">
      <Tile title="Bank" to="/bank" value={fmt(s.bank)} navigate={navigate}>
        <div className="mx-5 border-t border-line" />
        <Link to="/expenses" navigate={navigate} className="group grid grid-cols-2 gap-3 rounded-b-2xl px-5 pb-4 pt-3 hover:bg-paper/60">
          <div>
            <div className="text-xs text-muted">Expenses this month</div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums text-ink group-hover:text-accent">{fmt(thisMonth)}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Last month</div>
            <div className="mt-0.5 text-lg font-medium tabular-nums text-muted">{fmt(lastMonth)}</div>
          </div>
        </Link>
      </Tile>
      <Tile title="Investments" to="/investments" value={fmt(total(t => t !== 'funds'))} navigate={navigate} />
      <Tile title="Funds" to="/funds" value={fmt(total(t => t === 'funds'))} navigate={navigate} />
    </div>
  );
}
