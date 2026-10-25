'use client';

import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button } from './button.tsx';
import { useCommandState } from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { LinkField, type LinkRange } from './editor-link.tsx';

/** Placement belongs to the selection controls, outside the document surface. */
export const bubbleOptions = { placement: 'top' as const, offset: 8, flip: true, shift: { padding: 8 }, inline: true };

export function SelectionMenu({
  editor,
  labels,
  linkRange,
  onLink,
  onLinkClose,
  container,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  linkRange: LinkRange | null;
  onLink: () => void;
  onLinkClose: () => void;
  container: RefObject<HTMLDivElement | null>;
}) {
  const state = useCommandState(editor);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const [tabStop, setTabStop] = useState('bold');
  const blockMenu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = () => setBlocksOpen(false);
    editor.on('selectionUpdate', close);
    return () => {
      editor.off('selectionUpdate', close);
    };
  }, [editor]);
  useEffect(() => {
    if (blocksOpen) blockMenu.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [blocksOpen]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('input')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setBlocksOpen(false);
      editor.commands.focus();
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    const scope = blocksOpen ? blockMenu.current : event.currentTarget;
    const buttons = [...(scope?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
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
        current.isEditable && !live.selection.empty && (view.hasFocus() || element.contains(document.activeElement))
      }
    >
      <div
        role="toolbar"
        aria-label={labels.formatting}
        data-slot="editor-selection-menu"
        className="relative flex max-w-[calc(100vw-1rem)] flex-wrap gap-1 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        onKeyDown={moveFocus}
      >
        {linkRange ? (
          <LinkField editor={editor} labels={labels} range={linkRange} onClose={onLinkClose} />
        ) : (
          <>
            {state.marks.map(({ command, active }) => (
              <Button
                key={command.id}
                size="sm"
                variant={active ? 'soft' : 'ghost'}
                tabIndex={tabStop === command.id ? 0 : -1}
                aria-pressed={command.active ? active : undefined}
                onFocus={() => setTabStop(command.id)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => command.run(editor, onLink)}
              >
                {labels[command.label]}
              </Button>
            ))}
            {state.blocks.length ? (
              <Button
                ref={trigger}
                size="sm"
                variant="ghost"
                aria-haspopup="menu"
                aria-expanded={blocksOpen}
                tabIndex={tabStop === 'turnInto' ? 0 : -1}
                onFocus={() => setTabStop('turnInto')}
                onClick={() => setBlocksOpen((open) => !open)}
              >
                {labels.turnInto}
              </Button>
            ) : null}
            {blocksOpen ? (
              <div
                ref={blockMenu}
                role="menu"
                aria-label={labels.turnInto}
                className="absolute start-0 top-full z-10 mt-1 grid min-w-44 rounded-xl border border-border bg-popover p-1 shadow-lg"
              >
                {state.blocks.map(({ command, active }) => (
                  <Button
                    key={command.id}
                    role="menuitemradio"
                    aria-checked={active}
                    tabIndex={-1}
                    variant={active ? 'soft' : 'ghost'}
                    size="sm"
                    onClick={() => {
                      setBlocksOpen(false);
                      command.run(editor, onLink);
                    }}
                  >
                    {labels[command.label]}
                  </Button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
