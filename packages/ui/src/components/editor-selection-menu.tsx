'use client';

import { Button } from '@rezics/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@rezics/ui/shadcn/dropdown-menu';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useCommandState } from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { LinkField, type LinkVisitRange } from './editor-link.tsx';
import { ActionButton } from './editor-upstream/reactjs-tiptap-editor/action-button.tsx';

/** Placement belongs to the selection controls, outside the document surface. */
export const bubbleOptions = { placement: 'top' as const, offset: 8, flip: true, shift: { padding: 8 }, inline: true };

/** Pressed marks read as ink blue, the tone that carries colored actions. */
export const pressedTone = 'aria-pressed:bg-primary/10 aria-pressed:text-primary';

/** Focus goes back to the editor on Tiptap's next frame, which restores its own selection. */
export const returnFocus =
  (editor: Editor, isCurrent: () => boolean = () => true) =>
  () => {
    if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return false;
    requestAnimationFrame(() => {
      if (isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
    });
    return false;
  };

/**
 * Upstream action controls keep one tab stop and arrow-key travel in the existing selection layer.
 * The editor's range owner still controls links and frame-deferred focus restoration.
 */
export function SelectionMenu({
  editor,
  labels,
  linkRange,
  onLink,
  onLinkClose,
  container,
  visible = true,
  isCurrent,
  isRangeCurrent,
  onLinkUrlChange,
  focusEditor,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  linkRange: LinkVisitRange | null;
  onLink: () => void;
  onLinkClose: () => void;
  container: RefObject<HTMLDivElement | null>;
  visible?: boolean;
  isCurrent: () => boolean;
  isRangeCurrent: (range: LinkVisitRange) => boolean;
  onLinkUrlChange: (range: LinkVisitRange, url: string) => void;
  focusEditor: () => void;
}) {
  const state = useCommandState(editor);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [tabStop, setTabStop] = useState('bold');
  // The block menu lives in a portal, outside the bubble, so the bubble must not hide while it holds focus.
  const holdsFocus = useRef(false);
  const selectionRevision = useRef(0);
  const [renderedSelectionRevision, setRenderedSelectionRevision] = useState(0);
  const menuIsCurrent = () => isCurrent() && selectionRevision.current === renderedSelectionRevision;
  const availableTabStops = [
    ...state.marks.map(({ command }) => command.id),
    ...(state.blocks.length ? ['turnInto'] : []),
  ];
  const activeTabStop = availableTabStops.includes(tabStop) ? tabStop : availableTabStops[0];
  useLayoutEffect(() => {
    const close = () => {
      if (!isCurrent()) return;
      selectionRevision.current += 1;
      setRenderedSelectionRevision(selectionRevision.current);
      setBlocksOpen(false);
      holdsFocus.current = false;
    };
    editor.on('selectionUpdate', close);
    return () => {
      editor.off('selectionUpdate', close);
    };
  }, [editor, isCurrent]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!menuIsCurrent()) return;
    const target = event.target as HTMLElement;
    // Menu items render in a portal, but their events still bubble through this tree.
    if (!event.currentTarget.contains(target) || target.closest('input')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (blocksOpen) {
        holdsFocus.current = false;
        setBlocksOpen(false);
      } else focusEditor();
      return;
    }
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[event.key];
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
  function runCommand(command: (typeof state.marks)[number]['command'] | (typeof state.blocks)[number]['command']) {
    if (!menuIsCurrent() || editor.isDestroyed || !editor.isEditable) return;
    command.run(editor, onLink, () => undefined);
    if (isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
  }
  if (!isCurrent() || state.empty) return null;
  return (
    <TooltipProvider delay={600}>
    <BubbleMenu
      editor={editor}
      pluginKey="rezicsSelectionMenu"
      updateDelay={0}
      options={bubbleOptions}
      appendTo={() => container.current!}
      shouldShow={({ editor: current, state: live, view, element }) =>
        visible &&
        isCurrent() &&
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
          <LinkField
            key={linkRange.id}
            editor={editor}
            labels={labels}
            range={linkRange}
            onClose={onLinkClose}
            isCurrent={menuIsCurrent}
            isRangeCurrent={isRangeCurrent}
            onUrlChange={onLinkUrlChange}
            focusEditor={focusEditor}
          />
        ) : (
          <>
            {state.marks.map(({ command, active }) => (
              <ActionButton
                key={command.id}
                label={labels[command.label]}
                {...(command.active ? { pressed: active } : {})}
                action={() => runCommand(command)}
                tabIndex={activeTabStop === command.id ? 0 : -1}
                onFocus={() => { if (menuIsCurrent()) setTabStop(command.id); }}
              >
                {labels[command.label]}
              </ActionButton>
            ))}
            {state.blocks.length ? (
              <DropdownMenu
                modal={false}
                open={blocksOpen}
                onOpenChange={(open) => {
                  if (!menuIsCurrent()) return;
                  holdsFocus.current = open || holdsFocus.current;
                  setBlocksOpen(open);
                }}
                onOpenChangeComplete={(open) => {
                  if (menuIsCurrent() && !open) holdsFocus.current = false;
                }}
              >
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      tabIndex={activeTabStop === 'turnInto' ? 0 : -1}
                      onFocus={() => {
                        if (menuIsCurrent()) setTabStop('turnInto');
                      }}
                    />
                  }
                >
                  {labels.turnInto}
                  <ChevronDown aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  aria-label={labels.turnInto}
                  className="w-auto min-w-44"
                  finalFocus={returnFocus(editor, isCurrent)}
                >
                  <DropdownMenuRadioGroup value={state.blocks.find((block) => block.active)?.command.id}>
                    {state.blocks.map(({ command }) => (
                      <DropdownMenuRadioItem
                        key={command.id}
                        value={command.id}
                        closeOnClick
                        onClick={() => runCommand(command)}
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
    </TooltipProvider>
  );
}
