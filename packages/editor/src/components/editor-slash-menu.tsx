'use client';

import { Command, CommandList } from '@rezics/ui/shadcn/command';
import { Extension, type Editor as TiptapEditor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { memo, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  availableCommands,
  blockCommands,
  runEditorCommand,
  slashCommands,
  type EditorCommand,
} from './editor-commands.ts';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { CommandListItems, filterCommandGroups } from './editor-upstream/reactjs-tiptap-editor/command-list.tsx';
import { canInsertSizedTable } from './editor-table-commands.ts';

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
              if (!current?.active || event.isComposing || view.composing || event.keyCode === 229) return false;
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
  return filterCommandGroups(commands, labels, query).flatMap((group) => group.commands);
}

interface OpenMenu {
  id: number;
  query: string;
  range: SlashRange;
  rect: DOMRect | null;
  visit: number;
}

interface MenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
}

function menuPlacement(rect: DOMRect, menu: HTMLElement | null, minimumHeight: number): MenuPlacement {
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = Math.max(0, viewport?.width ?? window.innerWidth);
  const viewportHeight = Math.max(0, viewport?.height ?? window.innerHeight);
  const horizontalInset = Math.min(8, viewportWidth / 2);
  const verticalInset = Math.min(8, viewportHeight / 2);
  const maxWidth = Math.max(0, viewportWidth - horizontalInset * 2);
  const width = Math.min(256, maxWidth);
  const left = Math.min(
    viewportLeft + viewportWidth - horizontalInset - width,
    Math.max(viewportLeft + horizontalInset, rect.left),
  );
  const maxMenuHeight = Math.max(0, viewportHeight - verticalInset * 2);
  const measuredHeight = menu?.getBoundingClientRect().height ?? 0;
  const naturalHeight = Math.min(measuredHeight || minimumHeight, maxMenuHeight);
  const availableBelow = Math.max(0, viewportTop + viewportHeight - verticalInset - rect.bottom - 4);
  const availableAbove = Math.max(0, rect.top - 4 - (viewportTop + verticalInset));
  const threshold = Math.min(minimumHeight, naturalHeight);
  const below = availableBelow >= threshold || availableBelow >= availableAbove;
  const maxHeight = Math.min(maxMenuHeight, below ? availableBelow : availableAbove);
  const renderedHeight = Math.min(naturalHeight, maxHeight);
  const minTop = viewportTop + verticalInset;
  const maxTop = Math.max(minTop, viewportTop + viewportHeight - verticalInset - renderedHeight);
  const desiredTop = below ? rect.bottom + 4 : rect.top - renderedHeight - 4;
  const top = Math.min(maxTop, Math.max(minTop, desiredTop));
  return { left, top, maxHeight, maxWidth };
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
  onTable,
  visit,
  isCurrent,
}: {
  editor: TiptapEditor;
  labels: RichTextEditorLabels;
  upload: boolean;
  handlers: RefObject<SlashHandlers>;
  onLink: () => void;
  onImage: () => void;
  onTable?: (range: SlashRange) => void;
  visit: number;
  isCurrent: () => boolean;
}) {
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const nextOpenId = useRef(0);
  const commands = availableCommands(
    [...blockCommands.filter((command) => command.id === 'paragraph'), ...slashCommands],
    editor,
  ).filter(
    (command) =>
      (command.id !== 'image' || upload) && (command.id !== 'table' || (onTable && canInsertSizedTable(editor))),
  );
  const items = open ? matchCommands(commands, labels, open.query) : [];
  const activeIndex = items.length ? index % items.length : 0;
  const active = items[activeIndex];
  const latest = useRef({ open, index, commands, labels, onLink, onImage, onTable });
  latest.current = { open, index, commands, labels, onLink, onImage, onTable };

  function choose(command: EditorCommand, admitted: OpenMenu | null) {
    if (
      !isCurrent() ||
      editor.isDestroyed ||
      !editor.isEditable ||
      editor.view.composing ||
      !admitted ||
      admitted.visit !== visit
    )
      return;
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
    if (command.id === 'table') {
      latest.current.onTable?.(admitted.range);
      editor.view.dispatch(editor.state.tr.setMeta(slashPluginKey, { exit: true }).setMeta('addToHistory', false));
      return;
    }
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
      if (!isCurrent() || event.isComposing || event.keyCode === 229 || editor.view.composing) return false;
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

  const openId = open?.id;
  const openFrom = open?.range.from;
  const openTo = open?.range.to;
  const openQuery = open?.range.query;
  const openVisit = open?.visit;
  const openRectLeft = open?.rect?.left;
  const openRectTop = open?.rect?.top;
  useLayoutEffect(() => {
    if (
      !isCurrent() ||
      openId === undefined ||
      openFrom === undefined ||
      openTo === undefined ||
      openQuery === undefined ||
      openVisit !== visit
    )
      return;

    const updatePlacement = () => {
      const current = latest.current.open;
      const plugin = slashPluginKey.getState(editor.state);
      if (
        !isCurrent() ||
        !current ||
        current.id !== openId ||
        current.visit !== visit ||
        current.range.from !== openFrom ||
        current.range.to !== openTo ||
        current.range.query !== openQuery ||
        !plugin?.active ||
        plugin.from !== openFrom ||
        plugin.to !== openTo ||
        plugin.query !== openQuery ||
        editor.isDestroyed
      )
        return;

      try {
        const coords = editor.view.coordsAtPos(openTo);
        const rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
        const next = menuPlacement(rect, list.current, 240);
        setPlace((previous) =>
          previous &&
          previous.left === next.left &&
          previous.top === next.top &&
          previous.maxHeight === next.maxHeight &&
          previous.maxWidth === next.maxWidth
            ? previous
            : next,
        );
      } catch {
        // Keep the last usable position if the editor cannot measure this range.
      }
    };

    const viewport = window.visualViewport;
    updatePlacement();
    window.addEventListener('scroll', updatePlacement, true);
    window.addEventListener('resize', updatePlacement);
    viewport?.addEventListener('scroll', updatePlacement);
    viewport?.addEventListener('resize', updatePlacement);
    return () => {
      window.removeEventListener('scroll', updatePlacement, true);
      window.removeEventListener('resize', updatePlacement);
      viewport?.removeEventListener('scroll', updatePlacement);
      viewport?.removeEventListener('resize', updatePlacement);
    };
  }, [editor, isCurrent, openFrom, openId, openQuery, openRectLeft, openRectTop, openTo, openVisit, visit]);

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
    option?.scrollIntoView({ block: 'nearest' });
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
  return (
    <div
      ref={list}
      data-slot="editor-slash-menu"
      onMouseDown={(event) => event.preventDefault()}
      style={{
        position: 'fixed',
        left: place?.left ?? 8,
        top: place?.top ?? 8,
        maxHeight: place?.maxHeight,
        maxWidth: place?.maxWidth,
      }}
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
        <CommandList label={labels.insertBlock} style={{ maxHeight: place?.maxHeight }}>
          {items.length ? (
            <CommandListItems commands={items} labels={labels} onSelect={(command) => choose(command, open)} />
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">{labels.slashEmpty}</p>
          )}
        </CommandList>
      </Command>
    </div>
  );
});
