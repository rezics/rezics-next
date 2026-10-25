'use client';

import type { Editor } from '@tiptap/core';
import { Blocks, Bold, ChevronDown, Code, Italic, Link, Redo2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import {
  availableInsertCommands,
  touchBarFormatCommands,
  undoCommand,
  redoCommand,
  useCommandState,
  type EditorCommand,
} from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { Sheet, SheetBody, SheetContent, SheetHeader } from './sheet.tsx';

const icons = {
  bold: Bold,
  italic: Italic,
  link: Link,
  code: Code,
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

/** A keyboard resting row that preserves the editor selection while pointer controls are used. */
export function EditorTouchBar({
  editor,
  labels,
  onLink,
  onImage,
  upload,
  visible,
  onSheetOpenChange,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  onLink: () => void;
  onImage: () => void;
  upload: boolean;
  visible: boolean;
  onSheetOpenChange: (open: boolean) => void;
}) {
  const state = useCommandState(editor);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [tabStop, setTabStop] = useState('bold');
  const bar = useRef<HTMLDivElement>(null);
  const inset = useKeyboardInset(visible);
  const blockCommands = useMemo(() => availableInsertCommands(editor, upload), [editor, upload]);

  const scrollCaret = useCallback(() => {
    if (!visible) return;
    requestAnimationFrame(() => scrollSelectionAboveBar(editor, bar.current));
  }, [editor, visible]);

  useLayoutEffect(scrollCaret, [scrollCaret, inset]);

  useEffect(() => {
    if (!visible) return;
    const update = () => scrollCaret();
    editor.on('focus', update);
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      editor.off('focus', update);
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [editor, scrollCaret, visible]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
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

  function commandButton(command: EditorCommand, disabled = false) {
    const Icon = icons[command.id as keyof typeof icons];
    const active = command.active?.(editor) ?? false;
    return (
      <Button
        key={command.id}
        type="button"
        size="icon-xl"
        variant={active ? 'soft' : 'ghost'}
        className="min-h-11 min-w-11 shrink-0 focus-visible:text-primary"
        aria-label={labels[command.label]}
        aria-pressed={command.active ? active : undefined}
        disabled={disabled}
        tabIndex={tabStop === command.id ? 0 : -1}
        onFocus={() => setTabStop(command.id)}
        {...focusPreservingPointer}
        onClick={() => command.run(editor, onLink, onImage)}
      >
        {Icon ? <Icon aria-hidden="true" /> : null}
      </Button>
    );
  }

  function chooseBlock(command: EditorCommand) {
    command.run(editor, onLink, onImage);
    setBlocksOpen(false);
    onSheetOpenChange(false);
  }

  return (
    <>
      {visible ? (
        <div
          ref={bar}
          role="toolbar"
          aria-label={labels.toolbar}
          aria-orientation="horizontal"
          data-slot="editor-touch-bar"
          style={{ bottom: inset }}
          onKeyDown={moveFocus}
          className={cn(
            'fixed inset-x-0 z-40 flex min-h-[3.25rem] items-center gap-1 border-t border-border/60 bg-popover px-2 text-popover-foreground',
            inset === 0 && 'pb-[env(safe-area-inset-bottom)]',
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain py-1">
            {touchBarFormatCommands
              .filter((command) => state.marks.some((item) => item.command.id === command.id))
              .map((command) => commandButton(command))}
            <Button
              type="button"
              size="icon-xl"
              variant={blocksOpen ? 'soft' : 'ghost'}
              className="min-h-11 min-w-11 shrink-0 focus-visible:text-primary"
              aria-label={labels.blocks}
              aria-haspopup="dialog"
              aria-expanded={blocksOpen}
              tabIndex={tabStop === 'blocks' ? 0 : -1}
              onFocus={() => setTabStop('blocks')}
              {...focusPreservingPointer}
              onClick={() => {
                setBlocksOpen(true);
                onSheetOpenChange(true);
              }}
            >
              <Blocks aria-hidden="true" />
            </Button>
            {commandButton(undoCommand, !state.canUndo)}
            {commandButton(redoCommand, !state.canRedo)}
          </div>
          <Button
            type="button"
            size="icon-xl"
            variant="ghost"
            className="min-h-11 min-w-11 shrink-0 focus-visible:text-primary"
            aria-label={labels.hideKeyboard}
            title={labels.hideKeyboard}
            tabIndex={tabStop === 'hideKeyboard' ? 0 : -1}
            onFocus={() => setTabStop('hideKeyboard')}
            {...focusPreservingPointer}
            onClick={() => editor.commands.blur()}
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <Sheet
        open={blocksOpen}
        onOpenChange={({ open }) => {
          setBlocksOpen(open);
          onSheetOpenChange(open);
        }}
        finalFocusEl={() => editor.view.dom as HTMLElement}
      >
        <SheetContent placement="bottom" aria-label={labels.blocks}>
          <SheetHeader title={labels.blocks} />
          <SheetBody>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={labels.blocks}>
              {blockCommands.map((command) => {
                const active = command.active?.(editor) ?? false;
                return (
                  <Button
                    key={command.id}
                    type="button"
                    variant={active ? 'soft' : 'ghost'}
                    className="min-h-11 justify-start"
                    aria-pressed={command.active ? active : undefined}
                    {...focusPreservingPointer}
                    onClick={() => chooseBlock(command)}
                  >
                    {labels[command.label]}
                  </Button>
                );
              })}
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
