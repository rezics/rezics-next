'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@rezics/ui/shadcn/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@rezics/ui/shadcn/tooltip';
import type { Editor } from '@tiptap/core';
import { Blocks, Bold, ChevronDown, Code, Eraser, Italic, Link, Redo2, Strikethrough, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../utils.ts';
import {
  availableInsertCommands,
  undoCommand,
  redoCommand,
  useCommandState,
  type EditorCommand,
} from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { returnFocus } from './editor-selection-menu.tsx';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';

const icons = {
  bold: Bold,
  italic: Italic,
  link: Link,
  code: Code,
  strike: Strikethrough,
  clearFormatting: Eraser,
  blocks: Blocks,
  undo: Undo2,
  redo: Redo2,
  hideKeyboard: ChevronDown,
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

/** Controls keep a thumb-sized target even when a visible label follows the icon. */
const barButton = 'min-h-11 min-w-11 shrink-0 focus-visible:text-primary [&_svg:not([class*=size-])]:size-5';

/**
 * Formatting at the document entry point, docked above the keyboard on coarse pointers. Pointer controls preserve
 * the editor selection; the block picker is a bottom sheet.
 */
export function EditorTouchBar({
  editor,
  labels,
  onLink,
  onImage,
  upload,
  visible,
  docked,
  persistent,
  onFocusChange,
  onSheetOpenChange,
  isCurrent,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  onLink: () => void;
  onImage: () => void;
  upload: boolean;
  visible: boolean;
  docked: boolean;
  persistent: boolean;
  onFocusChange: (focused: boolean) => void;
  onSheetOpenChange: (open: boolean) => void;
  isCurrent: () => boolean;
}) {
  const state = useCommandState(editor);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [tabStop, setTabStop] = useState('blocks');
  const bar = useRef<HTMLDivElement>(null);
  const showBar = visible && (persistent || docked || state.empty || blocksOpen);
  const inset = useKeyboardInset(showBar && docked);
  const blockCommands = useMemo(() => availableInsertCommands(editor, upload), [editor, upload]);
  const formatOrder = ['bold', 'italic', 'link', 'strike', 'code', 'clearFormatting'];
  const formatCommands = state.marks
    .map(({ command }) => command)
    .sort((left, right) => formatOrder.indexOf(left.id) - formatOrder.indexOf(right.id));
  const availableTabStops = [
    ...(blockCommands.length ? ['blocks'] : []),
    ...formatCommands.map((command) => command.id),
    ...(state.canUndo ? ['undo'] : []),
    ...(state.canRedo ? ['redo'] : []),
    ...(docked ? ['hideKeyboard'] : []),
  ];
  const activeTabStop = availableTabStops.includes(tabStop) ? tabStop : availableTabStops[0];
  const selectionRevision = useRef(0);
  const [renderedSelectionRevision, setRenderedSelectionRevision] = useState(0);
  const menuIsCurrent = () => isCurrent() && selectionRevision.current === renderedSelectionRevision;

  const scrollCaret = useCallback(() => {
    if (!showBar || !docked || !isCurrent()) return;
    requestAnimationFrame(() => {
      if (isCurrent()) scrollSelectionAboveBar(editor, bar.current);
    });
  }, [docked, editor, isCurrent, showBar]);

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
    if (showBar && docked) {
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
  }, [docked, editor, isCurrent, scrollCaret, showBar]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!menuIsCurrent()) return;
    if (!event.currentTarget.contains(event.target as Node)) return;
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
        label={labels[command.label]}
        icon={Icon ? <Icon aria-hidden="true" /> : null}
        action={() => runCommand(command)}
        {...(command.active ? { pressed: active } : {})}
        disabled={disabled}
        tabIndex={activeTabStop === command.id ? 0 : -1}
        onFocus={() => { if (isCurrent()) setTabStop(command.id); }}
        className={cn(barButton, command.id === 'undo' || command.id === 'redo' ? 'size-11' : 'gap-1.5 px-2.5')}
      >
        {command.active ? <span className="text-xs sm:text-sm">{labels[command.label]}</span> : null}
      </ActionButton>
    );
  }

  function runCommand(command: EditorCommand) {
    if (!menuIsCurrent() || editor.isDestroyed || !editor.isEditable) return;
    command.run(editor, onLink, onImage);
    if (isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
  }

  function chooseBlock(command: EditorCommand) {
    if (!menuIsCurrent()) return;
    runCommand(command);
    if (!isCurrent()) return;
    setBlocksOpen(false);
    onSheetOpenChange(false);
  }

  const sheetFocus = returnFocus(editor, isCurrent);

  if (!isCurrent()) return null;

  return (
    <TooltipProvider delay={600}>
      {showBar ? (
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
            'flex min-h-[3.25rem] items-center gap-1 bg-popover px-2 text-popover-foreground',
            docked
              ? 'fixed inset-x-0 z-40 border-t border-border/60'
              : 'relative mb-2 min-w-0 rounded-xl border border-border/60',
            docked && inset === 0 && 'pb-[env(safe-area-inset-bottom)]',
          )}
        >
          <div
            className={cn(
              'flex min-w-0 flex-1 items-center gap-0.5 py-1',
              docked ? 'overflow-x-auto overscroll-x-contain' : 'flex-wrap',
            )}
          >
            {blockCommands.length
              ? barControl(
                  'blocks',
                  labels.blocks,
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(barButton, 'gap-1.5 px-2.5', blocksOpen && 'bg-primary/10 text-primary')}
                    aria-label={labels.blocks}
                    aria-haspopup="dialog"
                    aria-expanded={blocksOpen}
                    tabIndex={activeTabStop === 'blocks' ? 0 : -1}
                    onFocus={() => {
                      if (isCurrent()) setTabStop('blocks');
                    }}
                    {...focusPreservingPointer}
                    onClick={() => {
                      if (!menuIsCurrent()) return;
                      setBlocksOpen(true);
                      onSheetOpenChange(true);
                    }}
                  >
                    <Blocks aria-hidden="true" />
                    <span className="text-xs sm:text-sm">{labels.blocks}</span>
                  </Button>,
                )
              : null}
            {formatCommands.map((command) => commandButton(command))}
            {commandButton(undoCommand, !state.canUndo)}
            {commandButton(redoCommand, !state.canRedo)}
          </div>
          {docked
            ? barControl(
                'hideKeyboard',
                labels.hideKeyboard,
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(barButton, 'size-11')}
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
      ) : null}
      <Sheet
        open={blocksOpen}
        onOpenChange={(open) => {
          if (!isCurrent()) return;
          setBlocksOpen(open);
          onSheetOpenChange(open);
        }}
      >
        <SheetContent side="bottom" showCloseButton={false} finalFocus={sheetFocus}>
          <SheetHeader className="flex-row items-center justify-between gap-2 p-4 pb-2">
            <SheetTitle>{labels.blocks}</SheetTitle>
            <SheetClose render={<Button variant="ghost" />}>{labels.cancel}</SheetClose>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-2 p-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:grid-cols-3">
            {blockCommands.map((command) => {
              const active = command.active?.(editor) ?? false;
              return (
                <Button
                  key={command.id}
                  type="button"
                  variant="ghost"
                  className={cn('min-h-11 justify-start px-3 text-start', active && 'bg-primary/10 text-primary')}
                  aria-pressed={command.active ? active : undefined}
                  {...focusPreservingPointer}
                  onClick={() => chooseBlock(command)}
                >
                  {labels[command.label]}
                </Button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}
