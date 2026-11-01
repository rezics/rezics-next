'use client';

import { Command, CommandItem, CommandList } from '@rezics/ui/shadcn/command';
import { Extension, type Editor, type Extensions, type NodeViewRendererProps } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { RichTextEditorLabels } from './editor-labels.ts';

export type MentionAccount = { accountId: string; handle: string; name?: string };
export type MentionSource = (handle: string, signal: AbortSignal) => Promise<MentionAccount | null>;
export type MentionRange = { from: number; to: number; query: string };
type State = { range: MentionRange | null; dismissed: number | null; continued: boolean };
const key = new PluginKey<State>('accountMention');
export type MentionHandlers = {
  update: (range: MentionRange | null, rect: DOMRect | null, continued: boolean) => void;
  key: (event: KeyboardEvent) => boolean;
};
export type MentionRetirement = { visit: number; retire: () => void };
export const idleMentionHandlers: MentionHandlers = { update: () => undefined, key: () => false };

function mentionQuery(state: EditorState): MentionRange | null {
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
            init: () => ({ range: null, dismissed: null, continued: false }),
            apply(tr, previous, _old, state) {
              const range = enabled.current && editor.isEditable ? mentionQuery(state) : null;
              if (!range) return { range: null, dismissed: null, continued: false };
              if (tr.getMeta(key)?.exit || previous.dismissed === range.from)
                return { range: null, dismissed: range.from, continued: false };
              const previousRange = previous.range;
              const continued =
                previousRange !== null &&
                previousRange.query === range.query &&
                tr.mapping.map(previousRange.from, 1) === range.from &&
                tr.mapping.map(previousRange.to, -1) === range.to;
              return { range, dismissed: null, continued };
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
              const nextState = key.getState(view.state);
              const prior = key.getState(previous)?.range;
              const next = nextState?.range ?? null;
              if (!next && !prior) return;
              let rect: DOMRect | null = null;
              if (next) {
                const coords = view.coordsAtPos(next.to);
                rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
              }
              handlers.current.update(next, rect, nextState?.continued ?? false);
            },
            destroy: () => handlers.current.update(null, null, false),
          }),
        }),
      ];
    },
  });
}

/** Handles are local display state; the document stores only the account id. */
export function withMentionView(
  extensions: Extensions,
  handles: RefObject<Map<string, string>>,
  usage: RefObject<Map<string, number>>,
): Extensions {
  return extensions.map((extension) =>
    extension.name !== 'mention'
      ? extension
      : extension.extend({
          addNodeView:
            () =>
            ({ node }: NodeViewRendererProps) => {
              const dom = document.createElement('span');
              let accountId = String(node.attrs.accountId);
              const retain = (id: string) => usage.current.set(id, (usage.current.get(id) ?? 0) + 1);
              const release = (id: string) => {
                const count = usage.current.get(id) ?? 0;
                if (count <= 1) {
                  usage.current.delete(id);
                  handles.current.delete(id);
                } else {
                  usage.current.set(id, count - 1);
                }
              };
              const render = (id: string) => {
                dom.dataset.mentionAccountId = id;
                dom.textContent = `@${handles.current.get(id) ?? ''}`;
              };
              retain(accountId);
              render(accountId);
              return {
                dom,
                update: (next: ProseMirrorNode) => {
                  if (next.type !== node.type) return false;
                  const nextAccountId = String(next.attrs.accountId);
                  if (accountId !== nextAccountId) {
                    release(accountId);
                    accountId = nextAccountId;
                    retain(accountId);
                  }
                  render(accountId);
                  return true;
                },
                destroy: () => release(accountId),
              };
            },
        }),
  );
}

type Open = { range: MentionRange; rect: DOMRect | null; visit: number };
type LookupAttempt = {
  visit: number;
  range: MentionRange;
  controller: AbortController;
  source: MentionSource;
  timer: ReturnType<typeof setTimeout> | null;
};

function sameRange(left: MentionRange | null | undefined, right: MentionRange | null | undefined): boolean {
  return Boolean(left && right && left.from === right.from && left.to === right.to && left.query === right.query);
}

export function MentionMenu({
  editor,
  source,
  handlers,
  handles,
  labels,
  visit,
  isCurrent,
  registerRetirement,
}: {
  editor: Editor;
  source: MentionSource;
  handlers: RefObject<MentionHandlers>;
  handles: RefObject<Map<string, string>>;
  labels: RichTextEditorLabels;
  visit: number;
  isCurrent: () => boolean;
  registerRetirement: (retirement: MentionRetirement) => () => void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [account, setAccount] = useState<MentionAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number }>({ left: 8, top: 8 });
  const list = useRef<HTMLDivElement>(null);
  const pending = useRef<LookupAttempt | null>(null);
  const latest = useRef({ open, account, loading, source, attempt: pending.current });
  latest.current = { open, account, loading, source, attempt: pending.current };

  const cancel = useCallback(() => {
    const attempt = pending.current;
    pending.current = null;
    if (!attempt) return;
    if (attempt.timer !== null) clearTimeout(attempt.timer);
    attempt.controller.abort();
  }, []);

  const retire = useCallback(() => {
    cancel();
    latest.current.open = null;
    latest.current.account = null;
    latest.current.loading = false;
    latest.current.attempt = null;
    setOpen(null);
    setAccount(null);
    setLoading(false);
  }, [cancel]);

  function attemptIsCurrent(attempt: LookupAttempt): boolean {
    if (
      !isCurrent() ||
      attempt.visit !== visit ||
      pending.current !== attempt ||
      attempt.controller.signal.aborted ||
      editor.isDestroyed ||
      !editor.isEditable
    )
      return false;
    return (
      sameRange(latest.current.open?.range, attempt.range) &&
      sameRange(key.getState(editor.state)?.range, attempt.range)
    );
  }

  function choose(attempt: LookupAttempt | null, account: MentionAccount | null) {
    const current = key.getState(editor.state)?.range;
    if (
      !attempt ||
      !account ||
      !current ||
      latest.current.account !== account ||
      !attemptIsCurrent(attempt) ||
      !sameRange(current, attempt.range)
    )
      return;

    const previousHandle = handles.current.get(account.accountId);
    handles.current.set(account.accountId, account.handle);
    const inserted = editor
      .chain()
      .insertContentAt({ from: current.from, to: current.to }, [
        { type: 'mention', attrs: { accountId: account.accountId } },
        { type: 'text', text: ' ' },
      ])
      .run();

    if (!inserted) {
      if (previousHandle === undefined) handles.current.delete(account.accountId);
      else handles.current.set(account.accountId, previousHandle);
      return;
    }
    if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return;
    cancel();
    latest.current.open = null;
    latest.current.account = null;
    latest.current.loading = false;
    latest.current.attempt = null;
    setOpen(null);
    setAccount(null);
    setLoading(false);
    editor.view.focus();
  }

  const currentHandlers: MentionHandlers = {
    update(range, rect, continued) {
      if (!isCurrent()) return;
      const previous = latest.current.open;
      const attempt = pending.current;
      const sameQuery = Boolean(previous && range && previous.range.query === range.query && previous.visit === visit);
      const mappedContinuation = Boolean(
        continued && sameQuery && attempt && attempt.visit === visit && attempt.range.query === range?.query,
      );
      if (range && sameQuery && (sameRange(previous?.range, range) || mappedContinuation)) {
        if (attempt && mappedContinuation) attempt.range = range;
        const next = { range, rect, visit };
        latest.current.open = next;
        if (previous?.rect?.top !== rect?.top || previous?.rect?.left !== rect?.left) setOpen(next);
        return;
      }

      cancel();
      const next = range ? { range, rect, visit } : null;
      latest.current.open = next;
      latest.current.account = null;
      latest.current.loading = !!range?.query;
      latest.current.attempt = null;
      setOpen(next);
      setAccount(null);
      setLoading(!!range?.query);
      if (!range?.query) return;

      // Capture the supplied source when this query is admitted. Callback allocation changes do not cancel it.
      const admittedSource = latest.current.source;
      const nextAttempt: LookupAttempt = {
        visit,
        range,
        source: admittedSource,
        controller: new AbortController(),
        timer: null,
      };
      pending.current = nextAttempt;
      latest.current.attempt = nextAttempt;
      nextAttempt.timer = setTimeout(() => {
        nextAttempt.timer = null;
        if (!attemptIsCurrent(nextAttempt)) return;
        void (async () => {
          try {
            const found = await nextAttempt.source(nextAttempt.range.query, nextAttempt.controller.signal);
            if (!attemptIsCurrent(nextAttempt)) return;
            latest.current.account = found;
            setAccount(found);
          } catch {
            // A failed optional lookup leaves the text available for ordinary editing.
          } finally {
            if (attemptIsCurrent(nextAttempt)) {
              latest.current.loading = false;
              setLoading(false);
            }
          }
        })();
      }, 200);
    },
    key(event) {
      if (!isCurrent()) return false;
      const attempt = latest.current.attempt;
      if (!latest.current.account || !attempt || !attemptIsCurrent(attempt)) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return true;
      if (event.key === 'Enter' || event.key === 'Tab') {
        choose(attempt, latest.current.account);
        return true;
      }
      return false;
    },
  };
  handlers.current = currentHandlers;
  const latestHandlers = useRef(currentHandlers);
  latestHandlers.current = currentHandlers;

  useLayoutEffect(() => registerRetirement({ visit, retire }), [registerRetirement, retire, visit]);
  useLayoutEffect(() => {
    handlers.current = latestHandlers.current;
    return () => {
      cancel();
      if (handlers.current === latestHandlers.current) handlers.current = idleMentionHandlers;
    };
  }, [cancel, handlers, visit]);
  useLayoutEffect(() => {
    if (!isCurrent()) return;
    const range = key.getState(editor.state)?.range ?? null;
    let rect: DOMRect | null = null;
    if (range) {
      try {
        const coords = editor.view.coordsAtPos(range.to);
        rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
      } catch {
        rect = null;
      }
    }
    handlers.current.update(range, rect, false);
  }, [editor, handlers, isCurrent, visit]);
  useLayoutEffect(() => {
    if (!isCurrent() || open?.visit !== visit || !open?.rect) return;
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
    const left = Math.max(8, Math.min(open.rect.left, width - 264));
    setPlace(
      bottom - open.rect.bottom >= 120
        ? { left, top: open.rect.bottom + 4 }
        : { left, bottom: window.innerHeight - open.rect.top + 4 },
    );
  }, [isCurrent, open, visit]);
  useLayoutEffect(() => {
    if (!isCurrent() || open?.visit !== visit || !open.range.query || !account) return;
    const dom = editor.view.dom;
    const listbox = list.current?.querySelector<HTMLElement>('[role="listbox"]');
    const option = list.current?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])');
    const owner = String(visit);
    const role = dom.getAttribute('role');
    const multiline = dom.getAttribute('aria-multiline');
    const previous = new Map<string, string | null>();
    for (const name of ['aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant'])
      previous.set(name, dom.getAttribute(name));
    dom.setAttribute('data-mention-aria-owner', owner);
    dom.removeAttribute('aria-multiline');
    dom.setAttribute('role', 'combobox');
    dom.setAttribute('aria-autocomplete', 'list');
    dom.setAttribute('aria-expanded', 'true');
    if (listbox) dom.setAttribute('aria-controls', listbox.id);
    if (option) dom.setAttribute('aria-activedescendant', option.id);
    return () => {
      if (dom.getAttribute('data-mention-aria-owner') !== owner) return;
      dom.removeAttribute('data-mention-aria-owner');
      if (role === null) dom.removeAttribute('role');
      else dom.setAttribute('role', role);
      if (multiline !== null) dom.setAttribute('aria-multiline', multiline);
      for (const [name, value] of previous) {
        if (value === null) dom.removeAttribute(name);
        else dom.setAttribute(name, value);
      }
    };
  }, [account, editor, isCurrent, loading, open, visit]);
  if (!isCurrent() || open?.visit !== visit || !open?.range.query || (!account && !loading)) return null;
  const shownAttempt = latest.current.attempt;
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
            <CommandItem value={account.accountId} onSelect={() => choose(shownAttempt, account)}>
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
