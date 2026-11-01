'use client';

import { Command, CommandItem, CommandList } from '@rezics/ui/shadcn/command';
import { Extension, type Editor as TiptapEditor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { memo, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { availableCommands, runEditorCommand, slashCommands, type EditorCommand } from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';

export interface SlashRange {
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
  id: number;
  query: string;
  range: SlashRange;
  rect: DOMRect | null;
  visit: number;
}

/**
 * Lists insert and inline commands for the slash before the caret. Focus stays in the editor, so the list is a
 * `command` whose highlighted item the editor drives from its own key handler, with no search field of its own.
 */
export const SlashMenu = memo(function SlashMenu({
  editor,
  labels,
  upload,
  handlers,
  onLink,
  onImage,
  visit,
  isCurrent,
}: {
  editor: TiptapEditor;
  labels: RichTextEditorLabels;
  upload: boolean;
  handlers: RefObject<SlashHandlers>;
  onLink: () => void;
  onImage: () => void;
  visit: number;
  isCurrent: () => boolean;
}) {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const nextOpenId = useRef(0);
  const commands = availableCommands(slashCommands, editor).filter((command) => command.id !== 'image' || upload);
  const items = open ? matchCommands(commands, labels, open.query) : [];
  const activeIndex = items.length ? index % items.length : 0;
  const active = items[activeIndex];
  const latest = useRef({ open, index, commands, labels, onLink, onImage });
  latest.current = { open, index, commands, labels, onLink, onImage };

  function choose(command: EditorCommand, admitted: OpenMenu | null) {
    if (!isCurrent() || editor.isDestroyed || !editor.isEditable || !admitted || admitted.visit !== visit) return;
    if (latest.current.open?.id !== admitted.id) return;
    const plugin = slashPluginKey.getState(editor.state);
    if (
      !plugin?.active ||
      plugin.from !== admitted.range.from ||
      plugin.to !== admitted.range.to ||
      plugin.query !== admitted.range.query ||
      !latest.current.commands.some((current) => current === command)
    )
      return;
    editor.chain().deleteRange({ from: plugin.from, to: plugin.to }).run();
    if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return;
    runEditorCommand(command, editor, latest.current.onLink, latest.current.onImage, isCurrent);
  }

  const publish = (query: string, range: SlashRange, rect: DOMRect | null, reset: boolean) => {
    if (!isCurrent()) return;
    const previous = latest.current.open;
    const sameAdmission = Boolean(
      previous &&
      previous.visit === visit &&
      previous.query === query &&
      previous.range.from === range.from &&
      previous.range.to === range.to,
    );
    const next = { id: sameAdmission ? previous!.id : ++nextOpenId.current, query, range, rect, visit };
    latest.current.open = next;
    if (reset) {
      latest.current.index = 0;
      setIndex(0);
    }
    if (
      !previous ||
      previous.query !== query ||
      previous.visit !== visit ||
      previous.range.from !== range.from ||
      previous.range.to !== range.to ||
      previous.rect?.top !== rect?.top ||
      previous.rect?.left !== rect?.left
    ) {
      setOpen(next);
    }
  };
  const currentHandlers: SlashHandlers = {
    filter: (query) => (isCurrent() ? matchCommands(latest.current.commands, latest.current.labels, query) : []),
    start: (query, range, rect) => publish(query, range, rect, true),
    update: (query, range, rect) =>
      publish(query, range, rect, !latest.current.open || latest.current.open.query !== query),
    exit: () => {
      if (!isCurrent() || latest.current.open?.visit !== visit) return;
      latest.current.open = null;
      setOpen(null);
    },
    key: (event) => {
      if (!isCurrent()) return false;
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
        if (command) choose(command, current.open);
        return true;
      }
      return false;
    },
  };
  handlers.current = currentHandlers;
  const latestHandlers = useRef(currentHandlers);
  latestHandlers.current = currentHandlers;

  useLayoutEffect(() => {
    if (!isCurrent()) return;
    const current = slashPluginKey.getState(editor.state);
    if (!current?.active) return;
    let rect: DOMRect | null = null;
    try {
      const coords = editor.view.coordsAtPos(current.to);
      rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
    } catch {
      rect = null;
    }
    handlers.current.start(current.query, { from: current.from, to: current.to, query: current.query }, rect);
  }, [editor, handlers, isCurrent, visit]);

  useLayoutEffect(() => {
    handlers.current = latestHandlers.current;
    return () => {
      if (handlers.current === latestHandlers.current) handlers.current = idleSlashHandlers;
    };
  }, [handlers, visit]);

  useLayoutEffect(() => {
    if (!isCurrent() || !open || open.visit !== visit) return;
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
  }, [isCurrent, open, visit]);

  // The list names its options, so the editor points at whichever one carries the highlight.
  useLayoutEffect(() => {
    const dom = editor.view.dom;
    if (!isCurrent() || !open || open.visit !== visit) return;
    const option = list.current?.querySelector<HTMLElement>(`[role="option"][data-value="${active?.id}"]`);
    const listbox = list.current?.querySelector<HTMLElement>('[role="listbox"]');
    const owner = String(visit);
    const previous = new Map<string, string | null>();
    for (const name of ['aria-controls', 'aria-expanded', 'aria-activedescendant'])
      previous.set(name, dom.getAttribute(name));
    dom.setAttribute('data-slash-aria-owner', owner);
    if (listbox) dom.setAttribute('aria-controls', listbox.id);
    dom.setAttribute('aria-expanded', 'true');
    if (option?.id) dom.setAttribute('aria-activedescendant', option.id);
    else dom.removeAttribute('aria-activedescendant');
    return () => {
      if (dom.getAttribute('data-slash-aria-owner') !== owner) return;
      dom.removeAttribute('data-slash-aria-owner');
      for (const [name, value] of previous) {
        if (value === null) dom.removeAttribute(name);
        else dom.setAttribute(name, value);
      }
    };
  }, [editor, isCurrent, open, active, items.length, visit]);

  if (!isCurrent() || !open || open.visit !== visit) return null;
  const position = place?.bottom === undefined ? { left: place?.left ?? 8, top: place?.top ?? 8 } : place;
  return (
    <div
      ref={list}
      data-slot="editor-slash-menu"
      onMouseDown={(event) => event.preventDefault()}
      style={{ position: 'fixed', ...position }}
      className="z-50 w-64 max-w-[calc(100vw-1rem)]"
    >
      <Command
        shouldFilter={false}
        loop
        label={labels.insertBlock}
        value={active?.id ?? ''}
        onValueChange={(id) => {
          const next = items.findIndex((command) => command.id === id);
          if (next >= 0 && next !== activeIndex) {
            latest.current.index = next;
            setIndex(next);
          }
        }}
        className="rounded-2xl p-1 shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
      >
        <CommandList label={labels.insertBlock}>
          {items.length ? (
            items.map((command) => (
              <CommandItem key={command.id} value={command.id} onSelect={() => choose(command, open)}>
                {labels[command.label]}
              </CommandItem>
            ))
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">{labels.slashEmpty}</p>
          )}
        </CommandList>
      </Command>
    </div>
  );
});
