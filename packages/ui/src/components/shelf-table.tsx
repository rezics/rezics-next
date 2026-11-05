import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
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
  /** Compact identifying context, separate from the title link and personal columns. */
  titleContext?: ReactNode;
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
                    <>
                      {row.href ? (
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
                        <span>{row.title}</span>
                      )}
                      {row.titleContext}
                    </>
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

type PickerConfiguration = {
  schema: string;
  visit: object;
  columns: ShelfColumn[];
  onColumnsChange: (columns: ShelfColumn[]) => void;
};
type PickerGesture =
  | {
      mode: 'drag';
      schema: string;
      visit: object;
      columnId: ShelfColumnId;
      columns: ShelfColumn[];
      onColumnsChange: (columns: ShelfColumn[]) => void;
      source: HTMLLIElement;
      dragToken: string;
    }
  | {
      mode: 'touch';
      schema: string;
      visit: object;
      columnId: ShelfColumnId;
      columns: ShelfColumn[];
      onColumnsChange: (columns: ShelfColumn[]) => void;
      source: HTMLSpanElement;
      pointerId: number;
      startedAt: number;
    };

const shelfColumnDragType = 'application/x-rezics-shelf-column';

function columnSchema(columns: ShelfColumn[]) {
  return JSON.stringify(columns.map(({ id, visible }) => [id, visible]));
}

function reorderColumns(columns: ShelfColumn[], fromId: string, toId: string) {
  const from = columns.findIndex((column) => column.id === fromId);
  const to = columns.findIndex((column) => column.id === toId);
  if (from < 0 || to < 0 || from === to || columns[from]?.visible !== columns[to]?.visible) return null;
  const next = [...columns];
  const [item] = next.splice(from, 1);
  if (!item) return null;
  next.splice(to, 0, item);
  return next;
}

function columnAtPoint(root: HTMLDivElement, x: number, y: number) {
  const item = root.ownerDocument.elementFromPoint(x, y)?.closest<HTMLElement>('[data-column-id]');
  if (!item || !root.isConnected || !root.contains(item) || item.closest('[data-shelf-column-picker]') !== root)
    return null;
  return item.dataset.columnId ?? null;
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
  const schema = columnSchema(columns);
  const configuration = useRef<PickerConfiguration>({
    schema,
    visit: {},
    columns,
    onColumnsChange,
  });
  const [visit, setVisit] = useState(() => configuration.current.visit);
  const gesture = useRef<PickerGesture | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      gesture.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const current = configuration.current;
    if (current.schema !== schema) {
      const nextVisit = {};
      configuration.current = { schema, visit: nextVisit, columns, onColumnsChange };
      gesture.current = null;
      setVisit(nextVisit);
      return;
    }
    current.columns = columns;
    current.onColumnsChange = onColumnsChange;
    const active = gesture.current;
    if (active?.visit === current.visit) {
      active.columns = columns;
      active.onColumnsChange = onColumnsChange;
    }
  }, [schema, columns, onColumnsChange]);

  const currentConfiguration = () => {
    const current = configuration.current;
    if (!mounted.current || visit !== current.visit || schema !== current.schema) return null;
    return current;
  };

  const isCurrentGesture = (active: PickerGesture, current: PickerConfiguration) =>
    active.visit === current.visit && active.schema === current.schema;

  const changeColumns = (next: ShelfColumn[]) => {
    const current = currentConfiguration();
    if (!current) return;
    gesture.current = null;
    current.onColumnsChange(next);
  };

  const move = (fromId: string, toId: string) => {
    const current = currentConfiguration();
    if (!current) return;
    const next = reorderColumns(current.columns, fromId, toId);
    if (next) changeColumns(next);
  };

  const startTouch = (event: ReactPointerEvent<HTMLSpanElement>, columnId: ShelfColumnId) => {
    const current = currentConfiguration();
    if (!current || event.pointerType !== 'touch') return;
    const active: PickerGesture = {
      mode: 'touch',
      schema: current.schema,
      visit: current.visit,
      columnId,
      columns: current.columns,
      onColumnsChange: current.onColumnsChange,
      source: event.currentTarget,
      pointerId: event.pointerId,
      startedAt: event.timeStamp,
    };
    gesture.current = active;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      if (gesture.current === active) gesture.current = null;
    }
  };

  const endTouch = (event: ReactPointerEvent<HTMLSpanElement>, drop: boolean) => {
    const current = currentConfiguration();
    const active = gesture.current;
    if (
      !current ||
      !active ||
      active.mode !== 'touch' ||
      event.pointerType !== 'touch' ||
      active.pointerId !== event.pointerId ||
      active.source !== event.currentTarget ||
      event.timeStamp < active.startedAt ||
      !isCurrentGesture(active, current)
    )
      return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId) === false) {
      if (gesture.current === active) gesture.current = null;
      return;
    }
    gesture.current = null;
    if (!drop) return;
    const targetId = root.current && columnAtPoint(root.current, event.clientX, event.clientY);
    if (!targetId) return;
    const next = reorderColumns(active.columns, active.columnId, targetId);
    if (next) active.onColumnsChange(next);
  };

  const startDrag = (event: ReactDragEvent<HTMLLIElement>, columnId: ShelfColumnId) => {
    const current = currentConfiguration();
    if (!current) return;
    const dragToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(shelfColumnDragType, dragToken);
    gesture.current = {
      mode: 'drag',
      schema: current.schema,
      visit: current.visit,
      columnId,
      columns: current.columns,
      onColumnsChange: current.onColumnsChange,
      source: event.currentTarget,
      dragToken,
    };
  };

  const endDrag = (event: ReactDragEvent<HTMLLIElement>, columnId: ShelfColumnId) => {
    const current = currentConfiguration();
    const active = gesture.current;
    if (
      current &&
      active?.mode === 'drag' &&
      active.source === event.currentTarget &&
      active.columnId === columnId &&
      event.dataTransfer.getData(shelfColumnDragType) === active.dragToken &&
      isCurrentGesture(active, current) &&
      gesture.current === active
    )
      gesture.current = null;
  };

  const dropOn = (event: ReactDragEvent<HTMLLIElement>, targetId: ShelfColumnId) => {
    event.preventDefault();
    const current = currentConfiguration();
    const active = gesture.current;
    if (
      !current ||
      !active ||
      active.mode !== 'drag' ||
      event.dataTransfer.getData(shelfColumnDragType) !== active.dragToken ||
      !isCurrentGesture(active, current)
    )
      return;
    gesture.current = null;
    const next = reorderColumns(active.columns, active.columnId, targetId);
    if (next) active.onColumnsChange(next);
  };

  return (
    <div ref={root} data-shelf-column-picker className="min-w-0 space-y-4">
      {[true, false].map((visible) => (
        <section key={String(visible)}>
          <h3 className="mb-2 min-w-0 max-w-full whitespace-normal break-words text-sm font-semibold">
            {visible ? labels.visible : labels.hidden}
          </h3>
          <ul className="min-w-0 space-y-1">
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
                    onDragStart={(event) => startDrag(event, column.id)}
                    onDragEnd={(event) => endDrag(event, column.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropOn(event, column.id)}
                    className="flex min-w-0 flex-wrap items-center gap-1 rounded border p-1"
                  >
                    <span
                      className="min-w-0 flex-1 touch-none whitespace-normal break-words px-2 text-sm"
                      onPointerDown={(event) => startTouch(event, column.id)}
                      onPointerUp={(event) => endTouch(event, true)}
                      onPointerCancel={(event) => endTouch(event, false)}
                      onLostPointerCapture={(event) => endTouch(event, false)}
                    >
                      {column.label}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-w-0 max-w-full whitespace-normal break-words text-left"
                      onClick={() => {
                        const current = currentConfiguration();
                        if (!current) return;
                        changeColumns(
                          current.columns.map((c) => (c.id === column.id ? { ...c, visible: !visible } : c)),
                        );
                      }}
                    >
                      {visible ? labels.hide : labels.show}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${labels.moveUp} ${column.label}`}
                      disabled={position === 0}
                      onClick={() => move(column.id, peers[position - 1]!.id)}
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${labels.moveDown} ${column.label}`}
                      disabled={position === peers.length - 1}
                      onClick={() => move(column.id, peers[position + 1]!.id)}
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
