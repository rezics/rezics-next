'use client';

// Adapted from src/components/Bubble/RichTextBubbleTable.tsx; see the adjacent provenance and MIT notice.
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { isInTable } from '@tiptap/pm/tables';
import { Button } from '@rezics/ui/shadcn/button';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Columns3,
  Rows3,
  Merge,
  Split,
  PanelTop,
  PanelLeft,
  Table,
  ChevronDown,
  Trash2,
} from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import type { RichTextEditorLabels } from '../../editor-labels.ts';
import {
  runTableCommand,
  tableCommandGroups,
  tableCommands,
  type TableCommandName,
} from '../../editor-table-commands.ts';
import { ActionButton } from './action-button.tsx';
import { tableLabelsForLanguage } from './table-labels.ts';
import { editorCommandsForPresentation } from '../../editor-command-preferences.ts';
import { bubbleOptions, returnFocus } from '../../editor-menu-helpers.ts';

const icons = {
  addColumnBefore: ArrowLeft,
  addColumnAfter: ArrowRight,
  deleteColumn: Columns3,
  addRowBefore: ArrowUp,
  addRowAfter: ArrowDown,
  deleteRow: Rows3,
  mergeCells: Merge,
  splitCell: Split,
  toggleHeaderRow: PanelTop,
  toggleHeaderColumn: PanelLeft,
  toggleHeaderCell: Table,
  selectRow: Rows3,
  selectColumn: Columns3,
  selectTable: Table,
  alignCellLeft: ArrowLeft,
  alignCellCenter: Table,
  alignCellRight: ArrowRight,
  alignCellDefault: Table,
  moveRowUp: ArrowUp,
  moveRowDown: ArrowDown,
  moveColumnLeft: ArrowLeft,
  moveColumnRight: ArrowRight,
  deleteTable: Trash2,
};

/** Complete upstream table groups, supplied by this editor's schema, selection, labels and visit. */
export function TableControls({
  editor,
  labels,
  labelOverrides,
  container,
  isCurrent,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  labelOverrides?: Partial<RichTextEditorLabels> | undefined;
  container?: RefObject<HTMLDivElement | null>;
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
      return {
        active,
        can,
        tableId,
        presented: editorCommandsForPresentation(
          tableCommandGroups.flat().map((id) => ({ id })),
          current,
        ),
      };
    },
  });
  const root = useRef<HTMLDivElement>(null);
  const revision = useRef(0);
  const [renderedRevision, setRenderedRevision] = useState(0);
  useLayoutEffect(() => {
    const retire = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged && !transaction.selectionSet) return;
      revision.current += 1;
      setRenderedRevision(revision.current);
    };
    editor.on('transaction', retire);
    return () => {
      editor.off('transaction', retire);
    };
  }, [editor]);
  const [language, setLanguage] = useState<string>();
  useLayoutEffect(() => {
    // The document's language can differ from the surrounding interface language.
    const inherited = root.current?.closest('[lang]')?.getAttribute('lang');
    if (inherited) setLanguage(inherited);
  }, [labels, state.active]);
  const localized = tableLabelsForLanguage(language);
  const [tabStop, setTabStop] = useState<TableCommandName>('addColumnBefore');
  const ordered = state.presented.map(({ id }) => id);
  const groups = tableCommandGroups
    .map((group) => ordered.filter((name) => group.some((member) => member === name)))
    .filter((group) => group.length > 0);
  const enabled = groups.flat().filter((name) => state.can[name]);
  const activeTabStop = enabled.includes(tabStop) ? tabStop : enabled[0];
  const label = (name: TableCommandName) => labelOverrides?.[name] ?? localized[name];
  const run = (name: TableCommandName) => {
    if (!isCurrent() || revision.current !== renderedRevision) return false;
    const handled = runTableCommand(editor, name, isCurrent);
    if (handled) returnFocus(editor, isCurrent)();
    return handled;
  };
  const entries: MenuEntry[] = groups.flatMap((group, index) => [
    ...(index ? [{ type: 'separator' as const }] : []),
    ...group.map((name): MenuEntry => ({
      type: name.startsWith('delete') ? 'destructive' : 'item',
      label: label(name),
      disabled: !state.can[name],
      onSelect: () => run(name),
    })),
  ]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (
      !isCurrent() ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      editor.view.composing ||
      !event.currentTarget.contains(event.target as Node)
    )
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!editor.isDestroyed && editor.isEditable) editor.view.focus();
      return;
    }
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')].filter(
      (button) => button.getClientRects().length > 0,
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (step ?? 0) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  if (!isCurrent() || !state.active || state.presented.length === 0) return null;

  const toolbar = (
    <div
      ref={root}
      role="toolbar"
      aria-label={labels.table}
      aria-orientation="horizontal"
      data-slot="editor-table-controls"
      className="flex min-w-0 max-w-[min(42rem,calc(100vw-1rem))] items-center gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
      onKeyDown={moveFocus}
    >
      <div className="min-w-0 max-w-full flex-1 md:hidden">
        <Menu
          key={`${state.tableId}:${renderedRevision}`}
          title={labels.table}
          entries={entries}
          trigger={
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-h-7 w-full min-w-0 justify-start whitespace-normal"
              aria-label={labels.table}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Table aria-hidden="true" />
              <span className="min-w-0 flex-1 text-start break-words">{labels.table}</span>
              <ChevronDown aria-hidden="true" />
            </Button>
          }
        />
      </div>
      <div className="hidden min-w-0 max-w-full flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain md:flex">
        {groups.map((group, index) => (
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
                  onFocus={() => {
                    if (isCurrent()) setTabStop(name);
                  }}
                  className={name.startsWith('delete') ? 'text-destructive' : undefined}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
  return (
    <TooltipProvider delay={600}>
      {container ? (
        <BubbleMenu
          editor={editor}
          pluginKey="rezicsTableControls"
          appendTo={() => container.current!}
          updateDelay={0}
          options={{ ...bubbleOptions, placement: 'bottom' }}
          shouldShow={({ editor: current, state: live }) => isCurrent() && current.isEditable && isInTable(live)}
        >
          {toolbar}
        </BubbleMenu>
      ) : toolbar}
    </TooltipProvider>
  );
}
