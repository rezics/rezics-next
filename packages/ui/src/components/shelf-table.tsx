import { useRef, type MouseEvent, type ReactNode } from 'react';
import { Button } from '../shadcn/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table.tsx';
import { Cover, coverRatio, type CoverProps } from './cover.tsx';
import type { ShelfSelectionProps } from './shelf-list.tsx';
import { Checkbox } from '../shadcn/checkbox.tsx';
import { Field } from '../shadcn/field.tsx';

export type ShelfColumnId =
  | 'cover'
  | 'title'
  | 'creator'
  | 'type'
  | 'status'
  | 'progress'
  | 'rating'
  | 'added'
  | 'started'
  | 'finished'
  | 'lastActivity';
export interface ShelfColumn {
  id: ShelfColumnId;
  label: string;
  visible: boolean;
  sortable?: boolean;
}
export const defaultShelfColumns: ShelfColumn[] = (
  [
    'cover',
    'title',
    'creator',
    'type',
    'status',
    'progress',
    'rating',
    'added',
    'started',
    'finished',
    'lastActivity',
  ] as const
).map((id) => ({
  id,
  label: '',
  visible: ['cover', 'title', 'type', 'status', 'progress', 'rating', 'lastActivity'].includes(id),
  sortable: id !== 'cover',
}));
export interface ShelfTableRow extends ShelfSelectionProps {
  id: string;
  href: string;
  title: string;
  titleLang?: string;
  cover: Omit<CoverProps, 'size'>;
  selectLabel?: string;
  creator?: ReactNode;
  type?: ReactNode;
  status?: ReactNode;
  progress?: ReactNode;
  rating?: ReactNode;
  added?: ReactNode;
  started?: ReactNode;
  finished?: ReactNode;
  lastActivity?: ReactNode;
}
type Direction = 'asc' | 'desc';
/** An editable shelf table built on shadcn table; shadcn has no shelf-specific table. */
export function ShelfTable({
  rows,
  columns,
  sort,
  onSort,
}: {
  rows: ShelfTableRow[];
  columns: ShelfColumn[];
  sort?: { field: ShelfColumnId; direction: Direction };
  onSort: (field: ShelfColumnId, direction: Direction) => void;
}) {
  const visible = columns.filter((column) => column.visible);
  const hasSelection = rows.some((row) => row.selectable);
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          {hasSelection && (
            <TableHead>
              <span className="sr-only">{rows.find((row) => row.selectable)?.selectLabel}</span>
            </TableHead>
          )}
          {visible.map((column) => (
            <TableHead
              key={column.id}
              aria-sort={
                sort?.field === column.id ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
              }
            >
              {column.sortable ? (
                <button
                  type="button"
                  className="hover:underline focus-visible:outline-ring"
                  onClick={() =>
                    onSort(column.id, sort?.field === column.id && sort.direction === 'asc' ? 'desc' : 'asc')
                  }
                >
                  {column.label}
                </button>
              ) : (
                column.label
              )}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const select = (event: MouseEvent) => {
            row.onSelectedChange?.(!row.selected);
            row.onSelect?.(event);
          };
          return (
            <TableRow
              key={row.id}
              data-state={row.selected ? 'selected' : undefined}
              onClick={
                row.selectable
                  ? (event) => {
                      if (
                        !(event.target as Element).closest(
                          'a, button, input, select, textarea, [role="checkbox"], [role="menuitem"]',
                        )
                      )
                        select(event);
                    }
                  : undefined
              }
            >
              {hasSelection && (
                <TableCell>
                  {row.selectable && (
                    <Field orientation="horizontal" className="w-auto">
                      <Checkbox
                        aria-label={row.selectLabel}
                        checked={!!row.selected}
                        onCheckedChange={(checked) => row.onSelectedChange?.(checked === true)}
                        onClick={(event) => row.onSelect?.(event)}
                      />
                    </Field>
                  )}
                </TableCell>
              )}
              {visible.map(({ id }) => (
                <TableCell key={id}>
                  {id === 'cover' ? (
                    <div
                      className="w-10 overflow-hidden rounded"
                      style={{ aspectRatio: coverRatio(row.cover.subject.types).replace(':', ' / ') }}
                    >
                      <Cover {...row.cover} size="fill" ratio={coverRatio(row.cover.subject.types)} decorative />
                    </div>
                  ) : id === 'title' ? (
                    <a
                      className="font-medium hover:underline"
                      href={row.href}
                      lang={row.titleLang}
                      onClick={
                        row.selectable
                          ? (event) => {
                              event.preventDefault();
                              select(event);
                            }
                          : undefined
                      }
                    >
                      {row.title}
                    </a>
                  ) : (
                    row[id]
                  )}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
/** Column visibility and ordering controls; shadcn has no shelf column picker. */
export function ShelfColumnPicker({
  columns,
  onColumnsChange,
  labels,
}: {
  columns: ShelfColumn[];
  onColumnsChange: (columns: ShelfColumn[]) => void;
  labels: { visible: string; hidden: string; show: string; hide: string; moveUp: string; moveDown: string };
}) {
  const dragging = useRef<ShelfColumnId | null>(null);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= columns.length || from === to) return;
    const next = [...columns];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    onColumnsChange(next);
  };
  return (
    <div className="space-y-4">
      {[true, false].map((visible) => (
        <section key={String(visible)}>
          <h3 className="mb-2 text-sm font-semibold">{visible ? labels.visible : labels.hidden}</h3>
          <ul className="space-y-1">
            {columns
              .filter((column) => column.visible === visible)
              .map((column) => {
                const index = columns.indexOf(column);
                const peers = columns.filter((c) => c.visible === visible);
                const position = peers.indexOf(column);
                return (
                  <li
                    key={column.id}
                    data-column-id={column.id}
                    draggable
                    onDragStart={() => {
                      dragging.current = column.id;
                    }}
                    onDragEnd={() => {
                      dragging.current = null;
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = columns.findIndex((c) => c.id === dragging.current);
                      if (from >= 0 && columns[from]?.visible === visible) move(from, index);
                      dragging.current = null;
                    }}
                    className="flex items-center gap-1 rounded border p-1"
                  >
                    <span
                      className="min-w-0 flex-1 touch-none px-2 text-sm"
                      onPointerDown={(event) => {
                        if (event.pointerType === 'touch') {
                          dragging.current = column.id;
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }
                      }}
                      onPointerUp={(event) => {
                        if (event.pointerType !== 'touch') return;
                        const target = document
                          .elementFromPoint(event.clientX, event.clientY)
                          ?.closest<HTMLElement>('[data-column-id]');
                        const from = columns.findIndex((c) => c.id === dragging.current);
                        const to = columns.findIndex((c) => c.id === target?.dataset.columnId);
                        if (from >= 0 && to >= 0 && columns[from]?.visible === columns[to]?.visible) move(from, to);
                        dragging.current = null;
                      }}
                      onPointerCancel={() => {
                        dragging.current = null;
                      }}
                    >
                      {column.label}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onColumnsChange(columns.map((c) => (c.id === column.id ? { ...c, visible: !visible } : c)))
                      }
                    >
                      {visible ? labels.hide : labels.show}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${labels.moveUp} ${column.label}`}
                      disabled={position === 0}
                      onClick={() => move(index, columns.indexOf(peers[position - 1]!))}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${labels.moveDown} ${column.label}`}
                      disabled={position === peers.length - 1}
                      onClick={() => move(index, columns.indexOf(peers[position + 1]!))}
                    >
                      ↓
                    </Button>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
