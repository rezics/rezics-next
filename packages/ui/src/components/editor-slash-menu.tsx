'use client';

import { Extension, type Editor as TiptapEditor, type Range } from '@tiptap/core';
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../utils.ts';
import { availableCommands, formatShortcut, insertCommands, type CommandIO, type EditorCommand } from './editor-commands.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';

/** What the extension calls into once React has rendered the menu. A ref keeps the extension stable across renders. */
export interface SlashHandlers {
  filter: (query: string) => EditorCommand[];
  start: (props: SuggestionProps<EditorCommand>) => void;
  update: (props: SuggestionProps<EditorCommand>) => void;
  exit: () => void;
  key: (event: KeyboardEvent) => boolean;
}

export const idleSlashHandlers: SlashHandlers = { filter: () => [], start: () => {}, update: () => {}, exit: () => {}, key: () => false };

/** Typing `/` after a space or at the start of a line opens the block menu. Code blocks keep their slashes. */
export function slashExtension(handlers: RefObject<SlashHandlers>) {
  return Extension.create({
    name: 'slashMenu',
    addProseMirrorPlugins() {
      return [Suggestion<EditorCommand>({
        editor: this.editor, char: '/',
        allow: ({ editor }) => !editor.isActive('codeBlock'),
        items: ({ query }) => handlers.current.filter(query),
        render: () => ({
          onStart: props => handlers.current.start(props),
          onUpdate: props => handlers.current.update(props),
          onExit: () => handlers.current.exit(),
          onKeyDown: ({ event }: SuggestionKeyDownProps) => handlers.current.key(event),
        }),
      })];
    },
  });
}

interface Open { items: EditorCommand[]; range: Range; rect: DOMRect | null }

/** Lists the commands whose label or keywords contain the query, those that start with it first. */
export function matchCommands(commands: readonly EditorCommand[], labels: RichTextEditorLabels, query: string): EditorCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const rank = (command: EditorCommand) => {
    const words = [labels[command.label], command.id, ...(command.keywords ?? [])].map(word => word.toLowerCase());
    return words.some(word => word.startsWith(needle)) ? 0 : words.some(word => word.includes(needle)) ? 1 : 2;
  };
  return commands.map(command => ({ command, rank: rank(command) })).filter(entry => entry.rank < 2).sort((a, b) => a.rank - b.rank).map(entry => entry.command);
}

export function SlashMenu({ editor, labels, blocks, io, handlers }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; blocks: boolean; io: CommandIO; handlers: RefObject<SlashHandlers>;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [index, setIndex] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const latest = useRef({ open, index, io });
  latest.current = { open, index, io };
  const commands = availableCommands(insertCommands, blocks);

  function choose(command: EditorCommand) {
    const current = latest.current.open;
    if (!current) return;
    editor.chain().focus().deleteRange(current.range).run();
    command.run(editor, latest.current.io);
  }
  const show = (props: SuggestionProps<EditorCommand>) => { setIndex(0); setOpen({ items: props.items, range: props.range, rect: props.clientRect?.() ?? null }); };
  handlers.current = {
    filter: query => matchCommands(commands, labels, query),
    start: show,
    update: show,
    exit: () => setOpen(null),
    key: event => {
      const { open: current, index: active } = latest.current;
      if (!current || !current.items.length) return false;
      if (event.key === 'ArrowDown') { setIndex((active + 1) % current.items.length); return true; }
      if (event.key === 'ArrowUp') { setIndex((active - 1 + current.items.length) % current.items.length); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { choose(current.items[active]!); return true; }
      return false;
    },
  };

  // Below the caret when there is room, above it otherwise; the visual viewport excludes an on-screen keyboard.
  useLayoutEffect(() => {
    if (!open?.rect) { setPlace(null); return; }
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0, height = viewport?.height ?? window.innerHeight, width = viewport?.width ?? window.innerWidth;
    const below = top + height - open.rect.bottom, above = open.rect.top - top;
    const left = Math.max(8, Math.min(open.rect.left, width - 264));
    setPlace(below >= 240 || below >= above ? { left, top: open.rect.bottom + 4 } : { left, bottom: window.innerHeight - open.rect.top + 4 });
  }, [open]);

  const active = open?.items[index];
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index, open]);
  useEffect(() => {
    const dom = editor.view.dom;
    if (!open) return;
    dom.setAttribute('aria-controls', listId);
    dom.setAttribute('aria-expanded', 'true');
    if (active) dom.setAttribute('aria-activedescendant', `${listId}-${active.id}`);
    return () => { dom.removeAttribute('aria-controls'); dom.removeAttribute('aria-expanded'); dom.removeAttribute('aria-activedescendant'); };
  }, [editor, open, active, listId]);

  if (!open) return null;
  return <div ref={list} id={listId} role="listbox" aria-label={labels.insertBlock} data-slot="editor-slash-menu" onMouseDown={event => event.preventDefault()}
    style={place ? { position: 'fixed', ...place } : { position: 'fixed', visibility: 'hidden' }}
    className="z-50 max-h-72 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border/60 bg-popover p-1.5 text-popover-foreground shadow-(--aura-shadow-float)">
    {open.items.length ? open.items.map((command, position) => {
      const shortcut = formatShortcut(command.shortcut);
      return <div key={command.id} id={`${listId}-${command.id}`} role="option" aria-selected={position === index}
        className={cn('flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-sm', position === index && 'bg-accent text-accent-foreground')}
        onMouseMove={() => { if (position !== index) setIndex(position); }} onClick={() => choose(command)}>
        <command.icon aria-hidden="true" className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{labels[command.label]}</span>
        {shortcut ? <span className="hidden text-xs text-muted-foreground sm:inline">{shortcut}</span> : null}
      </div>;
    }) : <p className="px-2 py-1.5 text-sm text-muted-foreground">{labels.slashEmpty}</p>}
  </div>;
}
