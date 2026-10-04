import { useQuery } from '@tanstack/react-query';
import { Line, LineChart, YAxis } from 'recharts';
import { api, type Fund, type Range } from './api';
import { day, money, signedMoney, signedPct, type Currency } from './format';
import { Card, Name, Parts, RangeToggle, SubTag, Tip } from './ui';
import { cn } from '@/lib/utils';

const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');

/** The fund's report points as a small line (a single point is a dot). */
function Sparkline({ points }: { points: Fund['points'] }) {
  const data = points.filter(p => p.valueIls != null);
  if (!data.length) return null;
  return (
    <LineChart width={88} height={28} data={data} margin={{ top: 3, right: 3, bottom: 3, left: 3 }} className="inline-block">
      <YAxis hide domain={['dataMin', 'dataMax']} />
      <Line dataKey="valueIls" type="monotone" stroke="var(--c4)" strokeWidth={1.5} isAnimationActive={false}
        dot={data.length === 1 ? { r: 2.5, strokeWidth: 0, fill: 'var(--c4)' } : false} />
    </LineChart>
  );
}

function Growth({ f, currency, convert, align = 'right' }: { f: Fund; currency: Currency; convert: (n: number) => number; align?: 'left' | 'right' }) {
  if (f.growthPct == null && f.growthIls == null) return <span className="text-faint">—</span>;
  if (f.stated) {
    return (
      <span className={cn('inline-flex items-center gap-1.5', align === 'right' && 'flex-row-reverse')}>
        <span className={tone(f.growthPct)}>{signedPct(f.growthPct)}</span><SubTag>Stated {f.stated}</SubTag>
      </span>
    );
  }
  return (
    <Tip content={f.growthFrom && f.growthTo ? `${day(f.growthFrom)} → ${day(f.growthTo)}` : null}>
      <span tabIndex={0} className={tone(f.growthIls ?? f.growthPct)}>
        {f.growthIls != null && <div>{signedMoney(convert(f.growthIls), currency)}</div>}
        <div className="text-xs">{signedPct(f.growthPct)}</div>
      </span>
    </Tip>
  );
}

const ret = (n: number | null | undefined) => <span className={tone(n)}>{n == null ? '—' : signedPct(n)}</span>;

export default function Funds({ range, setRange, currency, convert }: {
  range: Range; setRange: (r: Range) => void; currency: Currency; convert: (n: number) => number;
}) {
  const { data } = useQuery({ queryKey: ['funds', range], queryFn: () => api.funds(range), placeholderData: p => p });
  if (!data) return null;
  const value = (f: Fund) => (f.valueIls == null ? money(f.value, f.currency) : money(convert(f.valueIls), currency));
  const th = 'px-2 sm:px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-faint first:pl-5 last:pr-5 text-right';
  const td = 'px-2 sm:px-3 py-2.5 first:pl-5 last:pr-5 whitespace-nowrap text-right tabular-nums';

  return (
    <Card title="Funds" flush action={<RangeToggle value={range} onChange={setRange} />}>
      {!data.funds.length && <p className="px-5 pb-3 text-sm text-faint">No funds</p>}
      {data.funds.length > 0 && (
        <>
          {/* md and up: the table */}
          <div className="border-t border-line max-md:hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={cn(th, 'h-9 text-left')}>Name</th>
                  <th className={th}>Value</th>
                  <th className={cn(th, 'max-lg:hidden')}>Liquid from</th>
                  <th className={th}>Growth</th>
                  <th className={cn(th, 'max-xl:hidden')}>YTD</th>
                  <th className={cn(th, 'max-xl:hidden')}>12M</th>
                  <th className={cn(th, 'max-xl:hidden')}>36M</th>
                  <th className={th}><span className="sr-only">Points</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.funds.map(f => (
                  <tr key={f.source} className="hover:bg-paper">
                    <td className={cn(td, 'whitespace-normal text-left')}>
                      <div className="flex flex-wrap items-center gap-x-2 font-medium text-ink"><Name text={f.name} />{f.subType && <SubTag>{f.subType}</SubTag>}</div>
                      <div className="text-xs text-faint"><Parts parts={[f.provider, f.owner]} /></div>
                    </td>
                    <td className={td}>
                      <div className="text-ink">{value(f)}</div>
                      <div className="text-xs text-faint">{f.asOf ? day(f.asOf) : ''}</div>
                    </td>
                    <td className={cn(td, 'text-muted max-lg:hidden')}>{f.liquidityDate ? day(f.liquidityDate) : '—'}</td>
                    <td className={td}><Growth f={f} currency={currency} convert={convert} /></td>
                    <td className={cn(td, 'max-xl:hidden')}>{ret(f.returns?.ytd)}</td>
                    <td className={cn(td, 'max-xl:hidden')}>{ret(f.returns?.m12)}</td>
                    <td className={cn(td, 'max-xl:hidden')}>{ret(f.returns?.m36)}</td>
                    <td className={cn(td, 'w-[104px] py-1')}><Sparkline points={f.points} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* below md: one row per fund */}
          <ul className="divide-y divide-line border-t border-line md:hidden">
            {data.funds.map(f => (
              <li key={f.source} className="flex items-center gap-3 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="break-words text-sm font-medium text-ink"><Name text={f.name} /></div>
                  <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
                    {f.subType && <SubTag>{f.subType}</SubTag>}
                    <Parts parts={[f.provider, f.owner]} />
                  </div>
                  {f.liquidityDate && <div className="text-xs text-faint">Liquid {day(f.liquidityDate)}</div>}
                </div>
                <div className="flex shrink-0 flex-col items-end text-right text-sm tabular-nums">
                  <div className="text-ink">{value(f)}</div>
                  <div className="text-xs"><Growth f={f} currency={currency} convert={convert} /></div>
                  <Sparkline points={f.points} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
