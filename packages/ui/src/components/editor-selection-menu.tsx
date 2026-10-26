'use client';

import { Button } from '@rezics/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@rezics/ui/shadcn/dropdown-menu';
import { Toggle } from '@rezics/ui/shadcn/toggle';
import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useCommandState } from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { LinkField, type LinkRange } from './editor-link.tsx';

/** Placement belongs to the selection controls, outside the document surface. */
export const bubbleOptions = { placement: 'top' as const, offset: 8, flip: true, shift: { padding: 8 }, inline: true };

/** Pressed marks read as ink blue, the tone that carries colored actions. */
export const pressedTone = 'aria-pressed:bg-primary/10 aria-pressed:text-primary';

/** Focus goes back to the editor on Tiptap's next frame, which restores its own selection. */
export const returnFocus = (editor: Editor) => () => {
  editor.commands.focus();
  return false;
};

/**
 * Formatting for the selected text. shadcn has no toolbar, so the bar is a `toolbar` role over `toggle` and `button`
 * with one tab stop and arrow-key travel; Tiptap's bubble menu places it above the selection.
 */
export function SelectionMenu({
  editor,
  labels,
  linkRange,
  onLink,
  onLinkClose,
  container,
  visible = true,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  linkRange: LinkRange | null;
  onLink: () => void;
  onLinkClose: () => void;
  container: RefObject<HTMLDivElement | null>;
  visible?: boolean;
}) {
  const state = useCommandState(editor);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [tabStop, setTabStop] = useState('bold');
  // The block menu lives in a portal, outside the bubble, so the bubble must not hide while it holds focus.
  const holdsFocus = useRef(false);
  useEffect(() => {
    const close = () => setBlocksOpen(false);
    editor.on('selectionUpdate', close);
    return () => {
      editor.off('selectionUpdate', close);
    };
  }, [editor]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    // Menu items render in a portal, but their events still bubble through this tree.
    if (!event.currentTarget.contains(target) || target.closest('input')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      editor.commands.focus();
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    // Up and down open the menu on its own button.
    if (target.closest('[data-slot="dropdown-menu-trigger"]') && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
      return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (step ?? 0) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
  if (state.empty) return null;
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="rezicsSelectionMenu"
      updateDelay={0}
      options={bubbleOptions}
      appendTo={() => container.current!}
      shouldShow={({ editor: current, state: live, view, element }) =>
        visible &&
        current.isEditable &&
        !live.selection.empty &&
        (view.hasFocus() || element.contains(document.activeElement) || holdsFocus.current)
      }
    >
      <div
        role="toolbar"
        aria-label={labels.formatting}
        data-slot="editor-selection-menu"
        className="relative flex max-w-[calc(100vw-1rem)] flex-wrap gap-1 rounded-2xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        onKeyDown={moveFocus}
      >
        {linkRange ? (
          <LinkField editor={editor} labels={labels} range={linkRange} onClose={onLinkClose} />
        ) : (
          <>
            {state.marks.map(({ command, active }) => {
              const common = {
                tabIndex: tabStop === command.id ? 0 : -1,
                onFocus: () => setTabStop(command.id),
                onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
              };
              return command.active ? (
                <Toggle
                  key={command.id}
                  pressed={active}
                  onPressedChange={() => command.run(editor, onLink)}
                  className={pressedTone}
                  {...common}
                >
                  {labels[command.label]}
                </Toggle>
              ) : (
                <Button key={command.id} variant="ghost" onClick={() => command.run(editor, onLink)} {...common}>
                  {labels[command.label]}
                </Button>
              );
            })}
            {state.blocks.length ? (
              <DropdownMenu
                modal={false}
                open={blocksOpen}
                onOpenChange={(open) => {
                  holdsFocus.current = open || holdsFocus.current;
                  setBlocksOpen(open);
                }}
                onOpenChangeComplete={(open) => {
                  if (!open) holdsFocus.current = false;
                }}
              >
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      tabIndex={tabStop === 'turnInto' ? 0 : -1}
                      onFocus={() => setTabStop('turnInto')}
                    />
                  }
                >
                  {labels.turnInto}
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  aria-label={labels.turnInto}
                  className="w-auto min-w-44"
                  finalFocus={returnFocus(editor)}
                >
                  <DropdownMenuRadioGroup value={state.blocks.find((block) => block.active)?.command.id}>
                    {state.blocks.map(({ command }) => (
                      <DropdownMenuRadioItem
                        key={command.id}
                        value={command.id}
                        closeOnClick
                        onClick={() => command.run(editor, onLink)}
                      >
                        {labels[command.label]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
