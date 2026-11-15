'use client';

// Adapted from src/extensions/Table/components/CreateTablePopover.tsx; adjacent README.md and LICENSE identify the source.
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { cn } from '@rezics/ui/utils';
import type { RichTextEditorLabels } from '../../editor-labels.ts';
import { returnFocus } from '../../editor-menu-helpers.ts';
import {
  insertSizedTable,
  mapTableInsertTarget,
  type TableInsertTarget,
  type TableSizeOptions,
} from '../../editor-table-commands.ts';
import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';
import { productControlLabels } from './control-labels.ts';

const gridSize = 10;
const cells = Array.from({ length: gridSize }, (_, index) => index + 1);

/** Upstream pointer capture/grid selection, with equivalent keyboard and explicit numeric entry. */
function TableSizePicker({
  labels,
  onCreate,
  onCancel,
}: {
  labels: RichTextEditorLabels;
  onCreate: (options: TableSizeOptions) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [rows, setRows] = useState('2');
  const [cols, setCols] = useState('2');
  const [withHeaderRow, setWithHeaderRow] = useState(true);
  const selected = useRef({ rows: 2, cols: 2 });
  const activePointer = useRef<number | null>(null);
  const size = { rows: Number(rows), cols: Number(cols) };
  const valid = [size.rows, size.cols].every((value) => Number.isInteger(value) && value >= 1 && value <= gridSize);
  const rowLabel = labels.tableRows ?? productControlLabels.tableRows;
  const columnLabel = labels.tableColumns ?? productControlLabels.tableColumns;
  const selectSize = (nextRows: number, nextCols: number) => {
    const next = { rows: Math.max(1, Math.min(gridSize, nextRows)), cols: Math.max(1, Math.min(gridSize, nextCols)) };
    selected.current = next;
    setRows(String(next.rows));
    setCols(String(next.cols));
  };
  const selectPointer = (event: PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    const cell = element?.closest<HTMLElement>('[data-table-grid-cell]');
    if (!cell || !event.currentTarget.contains(cell)) return false;
    selectSize(Number(cell.dataset.rows), Number(cell.dataset.cols));
    return true;
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    activePointer.current = null;
  };

  return (
    <form
      className="grid min-w-0 gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (valid) onCreate({ ...size, withHeaderRow });
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) event.stopPropagation();
      }}
    >
      <div
        role="grid"
        tabIndex={0}
        aria-label={labels.tableSize ?? productControlLabels.tableSize}
        aria-rowcount={gridSize}
        aria-colcount={gridSize}
        aria-multiselectable="true"
        aria-describedby={`${id}-size`}
        aria-activedescendant={valid ? `${id}-${rows}-${cols}` : undefined}
        className="mx-auto grid w-fit max-w-full touch-none gap-1 rounded-md p-1 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
          const current = valid ? size : selected.current;
          const moves: Record<string, [number, number]> = {
            ArrowDown: [1, 0],
            ArrowUp: [-1, 0],
            ArrowRight: [0, rtl ? -1 : 1],
            ArrowLeft: [0, rtl ? 1 : -1],
          };
          const move = moves[event.key];
          if (move) selectSize(current.rows + move[0], current.cols + move[1]);
          else if (event.key === 'Home') selectSize(event.ctrlKey ? 1 : current.rows, 1);
          else if (event.key === 'End') selectSize(event.ctrlKey ? gridSize : current.rows, gridSize);
          else if (event.key === 'Enter' || event.key === ' ') onCreate({ ...current, withHeaderRow });
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || !selectPointer(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          activePointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (activePointer.current !== null && activePointer.current !== event.pointerId) return;
          if (activePointer.current !== null || event.pointerType === 'mouse') selectPointer(event);
        }}
        onPointerUp={(event) => {
          if (activePointer.current !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          const inside = selectPointer(event);
          release(event);
          if (inside) onCreate({ ...selected.current, withHeaderRow });
        }}
        onPointerCancel={(event) => {
          if (activePointer.current === event.pointerId) release(event);
        }}
        onLostPointerCapture={() => {
          activePointer.current = null;
        }}
      >
        {cells.map((row) => (
          <div role="row" key={row} className="flex gap-1">
            {cells.map((col) => (
              <div
                role="gridcell"
                id={`${id}-${row}-${col}`}
                key={col}
                data-table-grid-cell
                data-rows={row}
                data-cols={col}
                aria-label={`${rowLabel}: ${row}, ${columnLabel}: ${col}`}
                aria-selected={valid && row <= size.rows && col <= size.cols}
                className={cn(
                  'size-5 rounded-xs border border-[var(--control)]',
                  valid && row <= size.rows && col <= size.cols && 'bg-primary/25 border-primary',
                )}
              />
            ))}
          </div>
        ))}
      </div>
      <p id={`${id}-size`} role="status" className="min-w-0 text-center text-sm leading-snug break-words tabular-nums">
        {rowLabel}: {rows || '—'} · {columnLabel}: {cols || '—'}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field className="min-w-0">
          <FieldLabel htmlFor={`${id}-rows`} className="max-w-full min-w-0 whitespace-normal leading-snug break-words">
            {rowLabel}
          </FieldLabel>
          <Input
            id={`${id}-rows`}
            type="number"
            inputMode="numeric"
            min={1}
            max={gridSize}
            step={1}
            required
            value={rows}
            onChange={(event) => setRows(event.target.value)}
          />
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor={`${id}-cols`} className="max-w-full min-w-0 whitespace-normal leading-snug break-words">
            {columnLabel}
          </FieldLabel>
          <Input
            id={`${id}-cols`}
            type="number"
            inputMode="numeric"
            min={1}
            max={gridSize}
            step={1}
            required
            value={cols}
            onChange={(event) => setCols(event.target.value)}
          />
        </Field>
      </div>
      <Field orientation="horizontal" className="min-w-0 items-start">
        <Checkbox
          id={`${id}-header`}
          checked={withHeaderRow}
          onCheckedChange={(value) => setWithHeaderRow(value === true)}
        />
        <FieldLabel
          htmlFor={`${id}-header`}
          className="min-w-0 flex-1 whitespace-normal leading-snug break-words"
        >
          {labels.tableHeader ?? productControlLabels.tableHeader}
        </FieldLabel>
      </Field>
      <div className="flex min-w-0 flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal" onClick={onCancel}>
          {labels.cancel}
        </Button>
        <Button type="submit" disabled={!valid} className="h-auto min-h-11 min-w-0 max-w-full whitespace-normal">
          {labels.insertTable ?? productControlLabels.insertTable}
        </Button>
      </div>
    </form>
  );
}

/** The size draft belongs to this open chooser; the document, mapped selection and history belong to the editor. */
export function TableInsert({
  editor,
  labels,
  target,
  isCurrent,
  onClose,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  target: TableInsertTarget;
  isCurrent: () => boolean;
  onClose: () => void;
}) {
  const saved = useRef<TableInsertTarget | null>(target);
  const mounted = useRef(false);
  const latest = useRef({ isCurrent, onClose });
  latest.current = { isCurrent, onClose };
  useLayoutEffect(() => {
    mounted.current = true;
    const update = ({ transaction }: { transaction: Transaction }) => {
      if (!saved.current) return;
      try {
        saved.current = mapTableInsertTarget(saved.current, transaction, editor);
      } catch {
        saved.current = null;
      }
      if (!saved.current) latest.current.onClose();
    };
    editor.on('transaction', update);
    return () => {
      mounted.current = false;
      editor.off('transaction', update);
    };
  }, [editor]);
  const current = () => mounted.current && latest.current.isCurrent() && !editor.isDestroyed && editor.isEditable;
  const cancel = () => {
    if (!current() || !saved.current) return;
    saved.current = null;
    onClose();
    returnFocus(editor, isCurrent)();
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      title={labels.insertTable ?? productControlLabels.insertTable}
      description={labels.tableSize ?? productControlLabels.tableSize}
      closeLabel={labels.cancel}
      finalFocus={() => false}
    >
      <TableSizePicker
        labels={labels}
        onCancel={cancel}
        onCreate={(options) => {
          const admitted = saved.current;
          if (!current() || !admitted) return;
          saved.current = null;
          if (insertSizedTable(editor, admitted, options, current)) {
            onClose();
            returnFocus(editor, isCurrent)();
          } else saved.current = admitted;
        }}
      />
    </ResponsiveDialog>
  );
}
