'use client';

import { Extension, type Editor as TiptapEditor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '../utils.ts';
import { availableCommands, insertCommands, type EditorCommand } from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';

interface SlashRange {
  from: number;
  to: number;
  query: string;
}

interface SlashState {
  active: boolean;
  dismissed: boolean;
  from: number;
  to: number;
  query: string;
}

const inactive: SlashState = { active: false, dismissed: false, from: 0, to: 0, query: '' };

/** Shared with the menu so a key can delete the slash that the latest render has not stored yet. */
export const slashPluginKey = new PluginKey<SlashState>('slashMenu');

/** What the plugin calls once React has rendered the menu. A ref keeps the extension stable. */
export interface SlashHandlers {
  filter: (query: string) => EditorCommand[];
  start: (query: string, range: SlashRange, rect: DOMRect | null) => void;
  update: (query: string, range: SlashRange, rect: DOMRect | null) => void;
  exit: () => void;
  key: (event: KeyboardEvent) => boolean;
}

export const idleSlashHandlers: SlashHandlers = {
  filter: () => [],
  start: () => undefined,
  update: () => undefined,
  exit: () => undefined,
  key: () => false,
};

function insideCode(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'codeBlock') return true;
  }
  return false;
}

/** `/` at the start of an empty block, or after a space. A slash inside a word matches nothing. */
export function slashQuery(state: EditorState): SlashRange | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock || insideCode(state)) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const matched = /(?:^|\s)(\/[^\s/]*)$/.exec(before);
  const token = matched?.[1];
  if (!token) return null;
  const slashIndex = before.length - token.length;
  if (slashIndex === 0) {
    const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, undefined, '\ufffc');
    if (after.length > 0) return null;
  }
  return { from: $from.start() + slashIndex, to: $from.pos, query: token.slice(1) };
}

/** Typing `/` opens the block menu. Escape keeps the typed text until that slash is deleted. */
export function slashExtension(handlers: RefObject<SlashHandlers>) {
  return Extension.create({
    name: 'slashMenu',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin<SlashState>({
          key: slashPluginKey,
          state: {
            init: () => inactive,
            apply(transaction, previous, _old, state) {
              if (!editor.isEditable) return inactive;
              const match = slashQuery(state);
              if (transaction.getMeta(slashPluginKey)?.exit) {
                return match
                  ? { active: false, dismissed: true, from: match.from, to: match.to, query: match.query }
                  : inactive;
              }
              if (!match) return inactive;
              if (previous.dismissed && previous.from === match.from) {
                return { active: false, dismissed: true, from: match.from, to: match.to, query: match.query };
              }
              return { active: true, dismissed: false, from: match.from, to: match.to, query: match.query };
            },
          },
          props: {
            handleKeyDown(view, event) {
              const current = slashPluginKey.getState(view.state);
              if (!current?.active || event.isComposing) return false;
              if (event.key === 'Escape') {
                view.dispatch(view.state.tr.setMeta(slashPluginKey, { exit: true }).setMeta('addToHistory', false));
                return true;
              }
              return handlers.current.key(event);
            },
          },
          view: () => ({
            update: (view, previous) => {
              const next = slashPluginKey.getState(view.state);
              const prior = slashPluginKey.getState(previous);
              if (!next?.active) {
                if (prior?.active) handlers.current.exit();
                return;
              }
              let rect: DOMRect | null = null;
              try {
                const coords = view.coordsAtPos(next.to);
                rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
              } catch {
                rect = null;
              }
              const range = { from: next.from, to: next.to, query: next.query };
              if (prior?.active) handlers.current.update(next.query, range, rect);
              else handlers.current.start(next.query, range, rect);
            },
          }),
        }),
      ];
    },
  });
}

/** The label and keywords are a fixed set, scanned once per keystroke while the menu is open. */
export function matchCommands(
  commands: readonly EditorCommand[],
  labels: RichTextEditorLabels,
  query: string,
): EditorCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const rank = (command: EditorCommand) => {
    const words = [labels[command.label], ...(command.keywords ?? [])].map((word) => word.toLowerCase());
    if (words.some((word) => word.startsWith(needle))) return 0;
    if (words.some((word) => word.includes(needle))) return 1;
    return 2;
  };
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter((entry) => entry.rank < 2)
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.command);
}

interface OpenMenu {
  query: string;
  range: SlashRange;
  rect: DOMRect | null;
}

/** Lists insert commands for the slash before the caret. Focus stays in the editor. */
export const SlashMenu = memo(function SlashMenu({
  editor,
  labels,
  upload,
  handlers,
  onLink,
  onImage,
}: {
  editor: TiptapEditor;
  labels: RichTextEditorLabels;
  upload: boolean;
  handlers: RefObject<SlashHandlers>;
  onLink: () => void;
  onImage: () => void;
}) {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const commands = availableCommands(insertCommands, editor).filter((command) => command.id !== 'image' || upload);
  const items = open ? matchCommands(commands, labels, open.query) : [];
  const activeIndex = items.length ? index % items.length : 0;
  const active = items[activeIndex];
  const latest = useRef({ open, index, commands, labels, onLink, onImage });
  latest.current = { open, index, commands, labels, onLink, onImage };

  function choose(command: EditorCommand) {
    const plugin = slashPluginKey.getState(editor.state);
    if (!plugin?.active) return;
    editor.chain().focus().deleteRange({ from: plugin.from, to: plugin.to }).run();
    command.run(editor, latest.current.onLink, latest.current.onImage);
  }

  const publish = (query: string, range: SlashRange, rect: DOMRect | null, reset: boolean) => {
    const previous = latest.current.open;
    const next = { query, range, rect };
    latest.current.open = next;
    if (reset) {
      latest.current.index = 0;
      setIndex(0);
    }
    if (
      !previous ||
      previous.query !== query ||
      previous.range.from !== range.from ||
      previous.range.to !== range.to ||
      previous.rect?.top !== rect?.top ||
      previous.rect?.left !== rect?.left
    ) {
      setOpen(next);
    }
  };
  handlers.current = {
    filter: (query) => matchCommands(latest.current.commands, latest.current.labels, query),
    start: (query, range, rect) => publish(query, range, rect, true),
    update: (query, range, rect) =>
      publish(query, range, rect, !latest.current.open || latest.current.open.query !== query),
    exit: () => {
      latest.current.open = null;
      setOpen(null);
    },
    key: (event) => {
      const current = latest.current;
      if (!current.open) return false;
      const choices = matchCommands(current.commands, current.labels, current.open.query);
      if (!choices.length) return false;
      const selected = current.index % choices.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const next =
          event.key === 'ArrowDown'
            ? (selected + 1) % choices.length
            : (selected - 1 + choices.length) % choices.length;
        current.index = next;
        setIndex(next);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const command = choices[selected];
        if (command) choose(command);
        return true;
      }
      return false;
    },
  };

  useLayoutEffect(() => {
    if (!open?.rect) {
      setPlace(null);
      return;
    }
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const height = viewport?.height ?? window.innerHeight;
    const width = viewport?.width ?? window.innerWidth;
    const below = top + height - open.rect.bottom;
    const above = open.rect.top - top;
    const left = Math.max(8, Math.min(open.rect.left, width - 264));
    setPlace(
      below >= 240 || below >= above
        ? { left, top: open.rect.bottom + 4 }
        : { left, bottom: window.innerHeight - open.rect.top + 4 },
    );
  }, [open]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    const dom = editor.view.dom;
    if (!open) return;
    dom.setAttribute('aria-controls', listId);
    dom.setAttribute('aria-expanded', 'true');
    if (active) dom.setAttribute('aria-activedescendant', `${listId}-${active.id}`);
    else dom.removeAttribute('aria-activedescendant');
    return () => {
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-expanded');
      dom.removeAttribute('aria-activedescendant');
    };
  }, [editor, open, active, listId]);

  if (!open) return null;
  const position = place?.bottom === undefined ? { left: place?.left ?? 8, top: place?.top ?? 8 } : place;
  return (
    <div
      ref={list}
      id={listId}
      role="listbox"
      aria-label={labels.insertBlock}
      data-slot="editor-slash-menu"
      onMouseDown={(event) => event.preventDefault()}
      style={{ position: 'fixed', ...position }}
      className="z-50 max-h-72 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      {items.length ? (
        items.map((command, position) => (
          <div
            key={command.id}
            id={`${listId}-${command.id}`}
            role="option"
            aria-selected={position === activeIndex}
            className={cn(
              'flex min-h-9 cursor-default items-center rounded-lg px-2 text-sm',
              position === activeIndex && 'bg-accent text-accent-foreground',
            )}
            onMouseMove={() => {
              if (position !== activeIndex) setIndex(position);
            }}
            onClick={() => choose(command)}
          >
            {labels[command.label]}
          </div>
        ))
      ) : (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">{labels.slashEmpty}</p>
      )}
    </div>
  );
});
