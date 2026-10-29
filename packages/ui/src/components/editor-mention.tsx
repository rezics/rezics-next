'use client';

import { Command, CommandItem, CommandList } from '@rezics/ui/shadcn/command';
import { Extension, type Editor, type Extensions, type NodeViewRendererProps } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { RichTextEditorLabels } from './editor-labels.ts';

export type MentionAccount = { accountId: string; handle: string; name?: string };
export type MentionSource = (handle: string, signal: AbortSignal) => Promise<MentionAccount | null>;
type Range = { from: number; to: number; query: string };
type State = { range: Range | null; dismissed: number | null };
const key = new PluginKey<State>('accountMention');
export type MentionHandlers = {
  update: (range: Range | null, rect: DOMRect | null) => void;
  key: (event: KeyboardEvent) => boolean;
};
export const idleMentionHandlers: MentionHandlers = { update: () => undefined, key: () => false };

function mentionQuery(state: EditorState): Range | null {
  const { selection } = state;
  if (!selection.empty || !selection.$from.parent.isTextblock) return null;
  const { $from } = selection;
  if ($from.marks().some((mark) => mark.type.name === 'code')) return null;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === 'codeBlock') return null;
  }
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
  const match = /(?:^|\s|[([{])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})?$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  return { from: $from.pos - query.length - 1, to: $from.pos, query };
}

/** Only plain handle tokens outside code activate the source. Escape preserves the original text. */
export function mentionExtension(handlers: RefObject<MentionHandlers>, enabled: RefObject<boolean>) {
  return Extension.create({
    name: 'accountMention',
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin<State>({
          key,
          state: {
            init: () => ({ range: null, dismissed: null }),
            apply(tr, previous, _old, state) {
              const range = enabled.current && editor.isEditable ? mentionQuery(state) : null;
              if (!range) return { range: null, dismissed: null };
              if (tr.getMeta(key)?.exit || previous.dismissed === range.from)
                return { range: null, dismissed: range.from };
              return { range, dismissed: null };
            },
          },
          props: {
            handleKeyDown(view, event) {
              if (!key.getState(view.state)?.range || event.isComposing) return false;
              if (event.key === 'Escape') {
                view.dispatch(view.state.tr.setMeta(key, { exit: true }).setMeta('addToHistory', false));
                return true;
              }
              return handlers.current.key(event);
            },
          },
          view: () => ({
            update(view, previous) {
              const next = key.getState(view.state)?.range ?? null;
              const prior = key.getState(previous)?.range;
              if (!next && !prior) return;
              let rect: DOMRect | null = null;
              if (next) {
                const coords = view.coordsAtPos(next.to);
                rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
              }
              handlers.current.update(next, rect);
            },
            destroy: () => handlers.current.update(null, null),
          }),
        }),
      ];
    },
  });
}

/** Handles are local display state; the document stores only the account id. */
export function withMentionView(extensions: Extensions, handles: RefObject<Map<string, string>>): Extensions {
  return extensions.map((extension) =>
    extension.name !== 'mention'
      ? extension
      : extension.extend({
          addNodeView:
            () =>
            ({ node }: NodeViewRendererProps) => {
              const dom = document.createElement('span');
              dom.dataset.mentionAccountId = node.attrs.accountId;
              dom.textContent = `@${handles.current.get(node.attrs.accountId) ?? ''}`;
              return { dom };
            },
        }),
  );
}

type Open = { range: Range; rect: DOMRect | null };
export function MentionMenu({
  editor,
  source,
  handlers,
  handles,
  labels,
}: {
  editor: Editor;
  source: MentionSource;
  handlers: RefObject<MentionHandlers>;
  handles: RefObject<Map<string, string>>;
  labels: RichTextEditorLabels;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [account, setAccount] = useState<MentionAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number }>({ left: 8, top: 8 });
  const list = useRef<HTMLDivElement>(null);
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; controller?: AbortController }>({});
  const latest = useRef({ open, account, source });
  latest.current = { open, account, source };
  function cancel() {
    clearTimeout(pending.current.timer);
    pending.current.controller?.abort();
    pending.current = {};
  }
  function choose() {
    const current = key.getState(editor.state)?.range;
    const { open, account } = latest.current;
    if (!current || !open || !account || current.from !== open.range.from || current.query !== open.range.query) return;
    handles.current.set(account.accountId, account.handle);
    editor
      .chain()
      .focus()
      .insertContentAt({ from: current.from, to: current.to }, [
        { type: 'mention', attrs: { accountId: account.accountId } },
        { type: 'text', text: ' ' },
      ])
      .run();
  }
  handlers.current = {
    update(range, rect) {
      const prior = latest.current.open?.range;
      if (range && prior && range.from === prior.from && range.to === prior.to && range.query === prior.query) return;
      cancel();
      const next = range ? { range, rect } : null;
      latest.current.open = next;
      latest.current.account = null;
      setOpen(next);
      setAccount(null);
      setLoading(!!range?.query);
      if (!range?.query) return;
      const controller = new AbortController();
      pending.current = {
        controller,
        timer: setTimeout(async () => {
          try {
            const found = await latest.current.source(range.query, controller.signal);
            if (controller.signal.aborted) return;
            latest.current.account = found;
            setAccount(found);
          } catch {
            // A failed optional lookup leaves the text available for ordinary editing.
          } finally {
            if (!controller.signal.aborted) setLoading(false);
          }
        }, 200),
      };
    },
    key(event) {
      if (!latest.current.account) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return true;
      if (event.key === 'Enter' || event.key === 'Tab') {
        choose();
        return true;
      }
      return false;
    },
  };
  useEffect(
    () => () => {
      cancel();
      handlers.current = idleMentionHandlers;
    },
    [handlers],
  );
  useLayoutEffect(() => {
    if (!open?.rect) return;
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
    const left = Math.max(8, Math.min(open.rect.left, width - 264));
    setPlace(
      bottom - open.rect.bottom >= 120
        ? { left, top: open.rect.bottom + 4 }
        : { left, bottom: window.innerHeight - open.rect.top + 4 },
    );
  }, [open]);
  useLayoutEffect(() => {
    if (!open?.range.query || !account) return;
    const dom = editor.view.dom;
    const listbox = list.current?.querySelector<HTMLElement>('[role="listbox"]');
    const option = list.current?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
    const multiline = dom.getAttribute('aria-multiline');
    dom.removeAttribute('aria-multiline');
    dom.setAttribute('role', 'combobox');
    dom.setAttribute('aria-autocomplete', 'list');
    dom.setAttribute('aria-expanded', 'true');
    if (listbox) dom.setAttribute('aria-controls', listbox.id);
    if (option) dom.setAttribute('aria-activedescendant', option.id);
    return () => {
      dom.setAttribute('role', 'textbox');
      if (multiline !== null) dom.setAttribute('aria-multiline', multiline);
      for (const attr of ['aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant'])
        dom.removeAttribute(attr);
    };
  }, [editor, open, account, loading]);
  if (!open?.range.query || (!account && !loading)) return null;
  return (
    <div
      ref={list}
      data-slot="editor-mention"
      onMouseDown={(event) => event.preventDefault()}
      style={{ position: 'fixed', ...place }}
      className="z-50 w-64 max-w-[calc(100vw-1rem)]"
    >
      {account ? (
        <Command
          shouldFilter={false}
          label={labels.mentionAccounts}
          value={account?.accountId ?? ''}
          className="rounded-2xl p-1 shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        >
          <CommandList label={labels.mentionAccounts}>
            <CommandItem value={account.accountId} onSelect={choose}>
              <span className="min-w-0 break-all">
                @{account.handle}
                {account.name ? (
                  <>
                    {' '}
                    <span className="text-muted-foreground">{account.name}</span>
                  </>
                ) : null}
              </span>
            </CommandItem>
          </CommandList>
        </Command>
      ) : (
        <p
          role="status"
          className="rounded-2xl bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
        >
          {labels.mentionLoading}
        </p>
      )}
    </div>
  );
}
