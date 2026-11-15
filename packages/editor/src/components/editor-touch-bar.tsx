'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@rezics/ui/shadcn/tooltip';
import type { Editor } from '@tiptap/core';
import {
  List,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Plus,
  Bold,
  ChevronDown,
  Code,
  Italic,
  Link,
  Redo2,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@rezics/ui/utils';
import {
  availableCommands,
  blockCommands as schemaBlockCommands,
  insertCommands,
  undoCommand,
  redoCommand,
  useCommandState,
  type EditorCommand,
} from './editor-commands.ts';
import { editorCommandLabel, type RichTextEditorLabels } from './editor-labels.ts';
import { BlockMenu } from './editor-upstream/reactjs-tiptap-editor/block-menu.tsx';
import { canInsertSizedTable } from './editor-table-commands.ts';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';
import { productControlLabels } from './editor-upstream/reactjs-tiptap-editor/control-labels.ts';
import type { EditorPreset } from './editor-workbench.tsx';

const icons = {
  bold: Bold,
  italic: Italic,
  link: Link,
  code: Code,
  bulletList: List,
  orderedList: ListOrdered,
  taskList: ListTodo,
  undo: Undo2,
  redo: Redo2,
} as const;

const focusPreservingPointer = {
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => event.preventDefault(),
  onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
};

function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      setInset(0);
      return;
    }

    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [active]);

  return inset;
}

function scrollSelectionAboveBar(editor: Editor, bar: HTMLElement | null) {
  if (!bar || editor.isDestroyed) return;

  let selectionBottom: number;
  try {
    selectionBottom = Math.max(
      editor.view.coordsAtPos(editor.state.selection.from).bottom,
      editor.view.coordsAtPos(editor.state.selection.to).bottom,
    );
  } catch {
    return;
  }

  const barTop = bar.getBoundingClientRect().top;
  const overflow = selectionBottom + 8 - barTop;
  if (overflow <= 0) return;

  let ancestor = editor.view.dom.parentElement;
  while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
    const style = window.getComputedStyle(ancestor);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);
    if (scrollable && ancestor.scrollHeight > ancestor.clientHeight) {
      ancestor.scrollBy({ top: overflow, behavior: 'auto' });
      return;
    }
    ancestor = ancestor.parentElement;
  }

  window.scrollBy({ top: overflow, behavior: 'auto' });
}

/**
 * Formatting at the document entry point, docked above the keyboard on coarse pointers. Pointer controls preserve
 * the editor selection; the adopted block groups use the public responsive Menu. Actions use official button sizes.
 */
export function EditorTouchBar({
  editor,
  labels,
  onLink,
  onImage,
  onTable,
  upload,
  docked,
  touch,
  preset,
  onFocusChange,
  onSheetOpenChange,
  isCurrent,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  onLink: () => void;
  onImage: () => void;
  onTable?: () => void;
  upload: boolean;
  docked: boolean;
  touch: boolean;
  preset: EditorPreset;
  onFocusChange: (focused: boolean) => void;
  onSheetOpenChange: (open: boolean) => void;
  isCurrent: () => boolean;
}) {
  const state = useCommandState(editor);
  const defaultTabStop = preset === 'compact' ? 'bold' : 'blocks';
  const [tabStop, setTabStop] = useState(defaultTabStop);
  const bar = useRef<HTMLDivElement>(null);
  const inset = useKeyboardInset(docked);
  const selectedBlock = state.blocks.find(({ active }) => active)?.command;
  const blockLabel = selectedBlock ? editorCommandLabel(labels, selectedBlock.label) : labels.blocks;
  const insertLabel = labels.blockInsert ?? productControlLabels.blockInsert;
  const insertion = availableCommands(
    insertCommands.filter((command) => ['image', 'table', 'horizontalRule'].includes(command.id)),
    editor,
  ).filter(
    (command) =>
      (command.id !== 'image' || upload) && (command.id !== 'table' || (onTable && canInsertSizedTable(editor))),
  );
  const styles = state.blocks.map(({ command }) => command);
  const blockCommands = touch ? [...styles, ...insertion] : styles;
  const showInsert = !touch && insertion.length > 0;
  const formatCommands = state.marks
    .map(({ command }) => command)
    .filter(({ id }) => ['bold', 'italic', 'link', 'code'].includes(id));
  const compact = preset === 'compact';
  const listCommands = availableCommands(schemaBlockCommands, editor).filter(({ id }) =>
    id === 'bulletList' ||
    (!compact && id === 'orderedList') ||
    (preset === 'knowledge' && id === 'taskList'),
  );
  const availableTabStops = [
    ...(!compact && state.canUndo ? ['undo'] : []),
    ...(!compact && state.canRedo ? ['redo'] : []),
    ...(!compact && blockCommands.length ? ['blocks'] : []),
    ...formatCommands.map((command) => command.id),
    ...listCommands.map((command) => command.id),
    ...(compact && blockCommands.length ? ['blocks'] : []),
    ...(showInsert ? ['insert'] : []),
    ...(docked ? ['hideKeyboard'] : []),
  ];
  const defaultEntry = availableTabStops.includes(defaultTabStop) ? defaultTabStop : availableTabStops[0];
  const activeTabStop = availableTabStops.includes(tabStop) ? tabStop : defaultEntry;
  const selectionRevision = useRef(0);
  const [renderedSelectionRevision, setRenderedSelectionRevision] = useState(0);
  const menuIsCurrent = () => isCurrent() && selectionRevision.current === renderedSelectionRevision;

  const scrollCaret = useCallback(() => {
    if (!docked || !isCurrent()) return;
    requestAnimationFrame(() => {
      if (isCurrent()) scrollSelectionAboveBar(editor, bar.current);
    });
  }, [docked, editor, isCurrent]);

  useLayoutEffect(scrollCaret, [scrollCaret, inset]);

  useEffect(() => {
    const update = () => scrollCaret();
    const selectionUpdate = () => {
      if (!isCurrent()) return;
      selectionRevision.current += 1;
      setRenderedSelectionRevision(selectionRevision.current);
      update();
    };
    editor.on('focus', update);
    editor.on('selectionUpdate', selectionUpdate);
    editor.on('transaction', update);
    const viewport = window.visualViewport;
    if (docked) {
      viewport?.addEventListener('resize', update);
      viewport?.addEventListener('scroll', update);
    }
    return () => {
      editor.off('focus', update);
      editor.off('selectionUpdate', selectionUpdate);
      editor.off('transaction', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [docked, editor, isCurrent, scrollCaret]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!menuIsCurrent() || event.nativeEvent.isComposing || event.keyCode === 229 || editor.view.composing) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (
      (event.target as HTMLElement).closest('[data-editor-block-trigger]') &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    )
      return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
      return;
    }
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const activeButton = document.activeElement?.closest('button');
    const index = buttons.indexOf(activeButton as HTMLButtonElement);
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

  function barControl(id: string, label: string, control: React.ReactElement) {
    return (
      <Tooltip key={id}>
        <TooltipTrigger render={control} />
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }

  function commandButton(command: EditorCommand, disabled = false) {
    const Icon = icons[command.id as keyof typeof icons];
    const active = command.active?.(editor) ?? false;
    return (
      <ActionButton
        key={command.id}
        label={editorCommandLabel(labels, command.label)}
        icon={Icon ? <Icon aria-hidden="true" /> : null}
        action={() => runCommand(command)}
        {...(command.active ? { pressed: active } : {})}
        disabled={disabled}
        tabIndex={activeTabStop === command.id ? 0 : -1}
        onFocus={() => {
          if (isCurrent()) setTabStop(command.id);
        }}
      />
    );
  }

  function runCommand(command: EditorCommand) {
    if (!menuIsCurrent() || editor.isDestroyed || !editor.isEditable || editor.view.composing) return;
    if (command.id === 'table') {
      onTable?.();
      return;
    }
    command.run(editor, onLink, onImage);
    if (isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
  }

  if (!isCurrent()) return null;

  function blockPicker(kind: 'blocks' | 'insert') {
    const insert = kind === 'insert';
    const title = insert ? insertLabel : labels.blocks;
    const Icon = insert ? Plus : Pilcrow;
    return (
      <BlockMenu
        editor={editor}
        labels={labels}
        title={title}
        commands={insert ? insertion : blockCommands}
        selectedBlock={insert ? undefined : selectedBlock?.id}
        isCurrent={menuIsCurrent}
        onSelect={runCommand}
        onOpenChange={(open) => {
          if (isCurrent()) onSheetOpenChange(open);
        }}
        trigger={
          <Button
            type="button"
            variant="ghost"
            aria-label={insert || title === blockLabel ? title : `${title}: ${blockLabel}`}
            data-editor-block-trigger
            tabIndex={activeTabStop === kind ? 0 : -1}
            className="min-w-0 shrink-0"
            onFocus={() => {
              if (isCurrent()) setTabStop(kind);
            }}
            {...focusPreservingPointer}
          >
            <Icon data-icon="inline-start" aria-hidden="true" />
            <span className="max-w-24 truncate">{insert ? title : blockLabel}</span>
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        }
      />
    );
  }

  return (
    <TooltipProvider delay={600}>
      <div className="mb-2 min-h-10">
        <div
          ref={bar}
          role="toolbar"
          aria-label={labels.toolbar}
          aria-orientation="horizontal"
          data-slot="editor-touch-bar"
          style={docked ? { bottom: inset } : undefined}
          onKeyDown={moveFocus}
          onFocusCapture={() => onFocusChange(true)}
          onBlurCapture={(event) => {
            if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node))
              onFocusChange(false);
          }}
          className={cn(
            'flex min-h-10 items-center bg-popover px-1.5 text-popover-foreground',
            docked ? 'fixed inset-x-0 z-40 border-t border-border' : 'rounded-lg border border-border',
            docked && inset === 0 && 'pb-[env(safe-area-inset-bottom)]',
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain py-1">
            {compact ? null : (
              <div className="flex shrink-0 items-center gap-0.5 border-e pe-1">
                {commandButton(undoCommand, !state.canUndo)}
                {commandButton(redoCommand, !state.canRedo)}
              </div>
            )}
            {!compact && blockCommands.length ? blockPicker('blocks') : null}
            <div className={cn('flex shrink-0 items-center gap-0.5', !compact && 'border-s ps-1')}>
              {formatCommands.map((command) => commandButton(command))}
            </div>
            {listCommands.length ? (
              <div className="flex shrink-0 items-center gap-0.5 border-s ps-1">
                {listCommands.map((command) => commandButton(command))}
              </div>
            ) : null}
            {compact && blockCommands.length ? blockPicker('blocks') : null}
            {showInsert ? blockPicker('insert') : null}
          </div>
          {docked
            ? barControl(
                'hideKeyboard',
                labels.hideKeyboard,
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={labels.hideKeyboard}
                  tabIndex={activeTabStop === 'hideKeyboard' ? 0 : -1}
                  onFocus={() => {
                    if (isCurrent()) setTabStop('hideKeyboard');
                  }}
                  {...focusPreservingPointer}
                  onClick={() => {
                    if (menuIsCurrent() && isCurrent() && !editor.isDestroyed) editor.commands.blur();
                  }}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>,
              )
            : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
