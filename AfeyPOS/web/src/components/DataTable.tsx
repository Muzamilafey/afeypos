import type { ReactNode } from 'react';
import { Button, EmptyState, Loading, ErrorBox, cx } from './ui';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T extends { _id?: string; id?: string }>({ columns, rows, loading, error, empty = 'Nothing here yet', onRowClick, page, total, limit, onPage }: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  error?: unknown;
  empty?: string;
  onRowClick?: (row: T) => void;
  page?: number;
  total?: number;
  limit?: number;
  onPage?: (p: number) => void;
}) {
  if (loading) return <Loading />;
  if (error) return <div className="p-4"><ErrorBox error={error} /></div>;
  if (!rows?.length) return <EmptyState title={empty} />;
  const pages = total && limit ? Math.max(1, Math.ceil(total / limit)) : 1;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-ink-100 dark:divide-ink-800">
          <thead className="bg-ink-50 dark:bg-ink-900/60">
            <tr>{columns.map((c) => <th key={c.key} className={cx('th', c.className)}>{c.header}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {rows.map((r, i) => (
              <tr key={r._id ?? r.id ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cx(onRowClick && 'cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/50')}>
                {columns.map((c) => <td key={c.key} className={cx('td', c.className)}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onPage && pages > 1 && (
        <div className="flex items-center justify-between border-t border-ink-100 px-3 py-2 text-sm dark:border-ink-800">
          <span className="text-ink-500">Page {page} of {pages} · {total} records</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={(page ?? 1) <= 1} onClick={() => onPage((page ?? 1) - 1)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={(page ?? 1) >= pages} onClick={() => onPage((page ?? 1) + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}
