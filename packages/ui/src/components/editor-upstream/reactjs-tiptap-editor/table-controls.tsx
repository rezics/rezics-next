'use client';

// Adapted from src/components/Bubble/RichTextBubbleTable.tsx; see the adjacent provenance and MIT notice.
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { isInTable } from '@tiptap/pm/tables';
import { Button } from '@rezics/ui/shadcn/button';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import {
  ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Columns3, Rows3, Merge, Split,
  PanelTop, PanelLeft, Table, ChevronDown, Trash2,
} from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Menu, type MenuEntry } from '../../menu.tsx';
import type { RichTextEditorLabels } from '../../editor-labels.ts';
import {
  runTableCommand, tableCommandGroups, tableCommands, type TableCommandName,
} from '../../editor-table-commands.ts';
import { ActionButton } from './action-button.tsx';
import { tableLabelsForLanguage } from './table-labels.ts';

const icons = {
  addColumnBefore: ArrowLeft, addColumnAfter: ArrowRight, deleteColumn: Columns3,
  addRowBefore: ArrowUp, addRowAfter: ArrowDown, deleteRow: Rows3,
  mergeCells: Merge, splitCell: Split, toggleHeaderRow: PanelTop, toggleHeaderColumn: PanelLeft,
  deleteTable: Trash2,
};

/** Complete upstream table groups, supplied by this editor's schema, selection, labels and visit. */
export function TableControls({ editor, labels, labelOverrides, isCurrent }: {
  editor: Editor;
  labels: RichTextEditorLabels;
  labelOverrides?: Partial<RichTextEditorLabels> | undefined;
  isCurrent: () => boolean;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const active = current.isEditable && Boolean(current.schema.nodes.table) && isInTable(current.state);
      const can = Object.fromEntries(
        Object.entries(tableCommands).map(([name, command]) => [name, active && command(current.state)]),
      ) as Record<TableCommandName, boolean>;
      const { $from } = current.state.selection;
      let tableId: string | null = null;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === 'table') {
          tableId = $from.node(depth).attrs.id;
          break;
        }
      }
      return { active, can, tableId };
    },
  });
  const root = useRef<HTMLDivElement>(null);
  const [language, setLanguage] = useState<string>();
  useLayoutEffect(() => {
    // The document's language can differ from the surrounding interface language.
    const inherited = root.current?.closest('[lang]')?.getAttribute('lang');
    if (inherited) setLanguage(inherited);
  }, [labels, state.active]);
  const localized = tableLabelsForLanguage(language);
  const [tabStop, setTabStop] = useState<TableCommandName>('addColumnBefore');
  const enabled = tableCommandGroups.flat().filter((name) => state.can[name]);
  const activeTabStop = enabled.includes(tabStop) ? tabStop : enabled[0];
  const label = (name: TableCommandName) => labelOverrides?.[name] ?? localized[name];
  const run = (name: TableCommandName) => runTableCommand(editor, name, isCurrent);
  const entries: MenuEntry[] = tableCommandGroups.flatMap((group, index) => [
    ...(index ? [{ type: 'separator' as const }] : []),
    ...group.map((name): MenuEntry => ({
      type: name.startsWith('delete') ? 'destructive' : 'item',
      label: label(name),
      disabled: !state.can[name],
      onSelect: () => run(name),
    })),
  ]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!isCurrent() || !event.currentTarget.contains(event.target as Node)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!editor.isDestroyed && editor.isEditable) editor.view.focus();
      return;
    }
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
      .filter((button) => button.getClientRects().length > 0);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (step ?? 0) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  if (!isCurrent() || !state.active) return null;

  return (
    <TooltipProvider delay={600}>
      <div
        ref={root}
        role="toolbar"
        aria-label={labels.table}
        aria-orientation="horizontal"
        data-slot="editor-table-controls"
        className="mb-2 flex min-w-0 items-center gap-1 rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground"
        onKeyDown={moveFocus}
      >
        <Menu
          key={state.tableId}
          title={labels.table}
          entries={entries}
          trigger={
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 gap-2 md:hidden"
              aria-label={labels.table}
              onPointerDown={(event) => event.preventDefault()}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Table aria-hidden="true" />
              {labels.table}
              <ChevronDown aria-hidden="true" />
            </Button>
          }
        />
        <div className="hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain md:flex">
          {tableCommandGroups.map((group, index) => (
            <Fragment key={group[0]}>
              {index ? <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" /> : null}
              {group.map((name) => {
                const Icon = icons[name];
                return (
                  <ActionButton
                    key={name}
                    label={label(name)}
                    icon={<Icon aria-hidden="true" />}
                    disabled={!state.can[name]}
                    action={() => run(name)}
                    tabIndex={activeTabStop === name ? 0 : -1}
                    onFocus={() => { if (isCurrent()) setTabStop(name); }}
                    className={name.startsWith('delete') ? 'text-destructive' : undefined}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
