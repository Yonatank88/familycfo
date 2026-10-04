import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table';
import { api, type Holding, type Range } from './api';
import { OTHER, TYPE_COLORS, TYPE_LABELS } from './colors';
import { day, money, pct, quantity, signedMoney, signedPct, type Currency } from './format';
import { Card, Name, Parts, RangeToggle, SortHead, Tag } from './ui';
import { cn } from '@/lib/utils';

const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-up' : 'text-down');
const LEFT = new Set(['name', 'source', 'owner', 'type']);
/** columns that give way on narrower screens */
const HIDE: Record<string, string> = { owner: 'max-xl:hidden', quantity: 'max-xl:hidden', source: 'max-lg:hidden', type: 'max-lg:hidden', change: 'max-md:hidden' };

export default function Investments({ range, setRange, currency, convert }: {
  range: Range; setRange: (r: Range) => void; currency: Currency; convert: (n: number) => number;
}) {
  const { data } = useQuery({ queryKey: ['investments', range], queryFn: () => api.investments(range), placeholderData: p => p });
  const [sorting, setSorting] = useState<SortingState>([{ id: 'value', desc: true }]);
  const value = (h: Holding) => (h.valueIls == null ? money(h.value, h.currency) : money(convert(h.valueIls), currency));

  const columns = useMemo<ColumnDef<Holding>[]>(() => [
    { id: 'name', accessorFn: h => h.label, header: ({ column }) => <SortHead label="Name" column={column} align="left" />,
      cell: ({ row: { original: h } }) => (
        <>
          <div className="font-medium text-ink"><Name text={h.label} /></div>
          {h.name !== h.symbol && !h.label.includes(h.name) && <div className="max-w-64 truncate text-xs text-faint"><bdi>{h.name}</bdi></div>}
        </>
      ) },
    { id: 'source', accessorFn: h => h.sourceLabel, header: ({ column }) => <SortHead label="Source" column={column} align="left" />,
      cell: ({ row: { original: h } }) => <span className="text-muted"><bdi>{h.sourceLabel}</bdi></span> },
    { id: 'owner', accessorFn: h => h.owner ?? '', header: ({ column }) => <SortHead label="Owner" column={column} align="left" />,
      cell: ({ row: { original: h } }) => <span className="text-xs text-faint"><bdi>{h.owner}</bdi></span> },
    { id: 'type', accessorFn: h => TYPE_LABELS[h.type] ?? h.type, header: ({ column }) => <SortHead label="Type" column={column} align="left" />,
      cell: ({ row: { original: h } }) => <Tag color={TYPE_COLORS[h.type] ?? OTHER}>{TYPE_LABELS[h.type] ?? h.type}</Tag> },
    { id: 'quantity', accessorFn: h => h.quantity, header: ({ column }) => <SortHead label="Quantity" column={column} />,
      cell: ({ row: { original: h } }) => <span className="text-muted">{quantity(h.quantity)}</span> },
    { id: 'value', accessorFn: h => h.valueIls ?? -Infinity, header: ({ column }) => <SortHead label="Value" column={column} />,
      cell: ({ row: { original: h } }) => <span className={h.fxMissing ? 'text-warn' : 'text-ink'}>{value(h)}</span> },
    { id: 'opened', accessorFn: h => h.openedAt ?? '', header: ({ column }) => <SortHead label="Opened" column={column} />,
      cell: ({ row: { original: h } }) => <span className="text-muted">{h.openedAt ? day(h.openedAt) : '—'}</span> },
    { id: 'gain', accessorFn: h => h.gainPct ?? -Infinity, header: ({ column }) => <SortHead label="Gain" column={column} />,
      cell: ({ row: { original: h } }) => (h.gainIls == null ? <span className="text-faint">—</span> : (
        <span className={tone(h.gainIls)}><div>{signedMoney(convert(h.gainIls), currency)}</div><div className="text-xs">{signedPct(h.gainPct)}</div></span>
      )) },
    { id: 'change', accessorFn: h => h.changePct ?? -Infinity, header: ({ column }) => <SortHead label="Change" column={column} />,
      cell: ({ row: { original: h } }) => <span className={tone(h.changePct)}>{h.changePct == null ? '' : signedPct(h.changePct)}</span> },
  ], [convert, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  const table = useReactTable({ data: data?.holdings ?? [], columns, state: { sorting }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  if (!data) return null;
  const t = data.totals;
  const th = 'px-2 sm:px-3 py-1 text-[11px] font-medium text-faint first:pl-5 last:pr-5';
  const td = 'px-2 sm:px-3 py-2 first:pl-5 last:pr-5 whitespace-nowrap tabular-nums';

  return (
    <Card title="Investments" flush action={<RangeToggle value={range} onChange={setRange} />}>
      <div className="grid grid-cols-2 gap-3 px-5 pb-5 pt-2 text-center">
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-muted">Value</span>
          <span className="text-lg font-semibold tabular-nums text-ink sm:text-[22px]">{money(convert(t.valueIls), currency)}</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-muted">Gain</span>
          <span className={cn('text-lg font-semibold tabular-nums sm:text-[22px]', tone(t.gainIls))}>{t.gainIls == null ? '—' : signedMoney(convert(t.gainIls), currency)}</span>
          {t.gainPct != null && (
            <span className="text-xs tabular-nums text-muted">
              <span className={tone(t.gainPct)}>{signedPct(t.gainPct)}</span> · {pct(t.coveredPct)} of value
            </span>
          )}
        </div>
      </div>

      {/* sm and up: the table */}
      <div className="border-t border-line max-sm:hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              {table.getHeaderGroups()[0].headers.map(h => (
                <th key={h.id} className={cn(th, LEFT.has(h.id) ? 'text-left' : 'text-right', HIDE[h.id])}>{flexRender(h.column.columnDef.header, h.getContext())}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {table.getRowModel().rows.map(r => (
              <tr key={r.id} className="hover:bg-paper">
                {r.getVisibleCells().map(c => (
                  <td key={c.id} className={cn(td, LEFT.has(c.column.id) ? 'text-left' : 'text-right', c.column.id === 'name' && 'whitespace-normal', HIDE[c.column.id])}>
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* below sm: two-line rows */}
      <ul className="divide-y divide-line border-t border-line sm:hidden">
        {table.getRowModel().rows.map(({ original: h }) => (
          <li key={h.id} className="flex min-h-12 items-center gap-3 px-5 py-2">
            <div className="min-w-0 flex-1">
              <div className="break-words text-sm font-medium text-ink"><Name text={h.label} /></div>
              <div className="truncate text-xs text-faint"><Parts parts={[h.sourceLabel, h.owner, h.openedAt ? day(h.openedAt) : null]} /></div>
            </div>
            <div className="shrink-0 text-right tabular-nums">
              <div className={cn('text-sm', h.fxMissing ? 'text-warn' : 'text-ink')}>{value(h)}</div>
              <div className={cn('text-xs', tone(h.gainIls))}>{h.gainIls == null ? '—' : `${signedMoney(convert(h.gainIls), currency)} · ${signedPct(h.gainPct)}`}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
