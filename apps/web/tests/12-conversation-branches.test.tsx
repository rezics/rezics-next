import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useRef, useState, type ComponentProps } from 'react';
import { fromPlainText } from '@rezics/document';
import * as start from '../.storybook/react-start';
import { conversationPageModel, conversationRowHidden } from '../src/threads/conversation-page-model';
import recording from '../src/kernel/recorded/thread.json';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/threads/one/reading?cursor=opaque%2Fcursor' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  location: browser.location,
  HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLFormElement: browser.HTMLFormElement,
  Element: browser.Element,
  Node: browser.Node,
  Document: browser.Document,
  DocumentFragment: browser.DocumentFragment,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  matchMedia: browser.matchMedia.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { ConversationBranches } = await import('../src/threads/conversation-branches');
const { ReplyContext, ReplyButton, ReplyParentReader } = await import('../src/threads/reply-context');
const { ThreadReplyComposer } = await import('../src/threads/reply-context-composer');
const { m } = await import('../src/paraglide/messages.js');
const { threadLocation } = await import('../src/threads/thread-href');
const { getLocale } = await import('../src/paraglide/runtime.js');
const thread = { id: recording.thread.id, title: recording.thread.title };
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const post = (n: number, parent: number | null) => ({
  ...recording.thread.firstPost,
  id: id(n),
  threadId: thread.id,
  availability: 'available' as const,
  parentId: parent === null ? null : id(parent),
  body: fromPlainText(`Supplied post ${n}`, 'blocks'),
  mediaIds: [],
});
const posts = [post(1, null), post(2, 1), post(3, null), post(4, 2), post(5, 900)];
const model = conversationPageModel(thread.id, posts);
const parents = new Map(posts.map((item) => [item.id, item]));
const host = browser.document.createElement('main') as unknown as HTMLElement;
browser.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let scope = {};
function Harness({ hash = '', reader }: { hash?: string; reader?: InstanceType<typeof ReplyParentReader> }) {
  const listRef = useRef<HTMLOListElement>(null);
  const [target, setTarget] = useState({ parentId: null as string | null, focusRequest: 0 });
  return (
    <>
      <ConversationBranches
        model={model}
        thread={thread}
        scope={scope}
        current
        isCurrent={() => true}
        hash={hash}
        listRef={listRef}
        renderPost={(row) => (
          <li id={row.anchorId} tabIndex={-1}>
            <ReplyContext parentId={row.parentId} parents={parents} reader={reader} />
            <textarea aria-label={`Local draft ${row.index}`} defaultValue="" />
            <ReplyButton
              disabled={false}
              onReply={() => setTarget((old) => ({ parentId: row.id, focusRequest: old.focusRequest + 1 }))}
            />
          </li>
        )}
      />
      <ThreadReplyComposer
        {...target}
        parents={parents}
        pending={false}
        containerId={thread.id}
        initialKey={id(700)}
        onPendingChange={() => {}}
        onCancel={() => setTarget({ parentId: null, focusRequest: 0 })}
        onSubmit={async () => ({ ok: false, reason: 'unavailable' })}
        onSuccess={() => {}}
      />
    </>
  );
}
const paint = async (props: ComponentProps<typeof Harness> = {}) => {
  root ??= createRoot(host);
  await act(async () => root!.render(<Harness {...props} />));
};
const row = (index: number) => host.querySelector<HTMLElement>(`[data-conversation-row="${index}"]`)!;
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!;
const click = (element: HTMLElement) => act(async () => element.click());
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  scope = {};
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('follow, exact Reply selection, local collapse and keyboard return retain order, cursor and mounted writing', async () => {
  await paint();
  const ordered = [...host.querySelectorAll('[data-conversation-row]')];
  const draft = row(3).querySelector('textarea')!;
  draft.value = 'Unsent inline writing';
  const composer =
    host.querySelector<HTMLElement>(`[role="textbox"][aria-label="${m.thread_reply_label()}"]`) ??
    host.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${m.thread_reply_label()}"]`)!;
  expect(composer).toBeTruthy();
  if ('value' in composer) (composer as HTMLTextAreaElement).value = 'Unsent reply';
  else {
    composer.textContent = 'Unsent reply';
    composer.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
  }
  await click(button(row(3), m.thread_reply_to_post()));
  const composerContext = [...host.querySelectorAll('[data-slot="reply-context"]')].at(-1)!;
  expect(composerContext.querySelector('a')?.getAttribute('href')).toBe(`#post-${id(4)}`);
  const follow = row(3).querySelector<HTMLAnchorElement>(`a[href="#post-${id(2)}"]`)!;
  follow.focus();
  await click(follow);
  expect(browser.document.activeElement?.id).toBe(`post-${id(2)}`);
  expect(browser.location.search).toBe('?cursor=opaque%2Fcursor');
  await click(button(row(1), m.thread_branch_collapse({ count: 1 })));
  expect(row(3).hidden).toBe(true);
  expect(row(2).hidden).toBe(false);
  expect(row(3).querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('Unsent inline writing');
  const back = button(host, m.thread_branch_return({ position: 4 }));
  await click(back);
  expect(row(3).hidden).toBe(false);
  expect(browser.document.activeElement).toBe(follow);
  expect([...host.querySelectorAll('[data-conversation-row]')]).toEqual(ordered);
  expect(host.contains(composer)).toBe(true);
  const collapse = button(row(0), m.thread_branch_collapse({ count: 2 }));
  await act(async () =>
    collapse.dispatchEvent(
      new browser.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }) as unknown as KeyboardEvent,
    ),
  );
  expect(collapse.getAttribute('aria-expanded')).toBe('false');
  expect(row(1).hidden).toBe(true);
  expect(row(3).hidden).toBe(true);
  expect(row(2).hidden).toBe(false);
  await act(async () =>
    collapse.dispatchEvent(
      new browser.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }) as unknown as KeyboardEvent,
    ),
  );
  expect(row(1).hidden).toBe(false);
  expect(row(3).hidden).toBe(false);
  expect(browser.location.search).toBe('?cursor=opaque%2Fcursor');
});

test('external deep links reveal collapsed rows, modified parent clicks remain native, and source replacement clears return state in place', async () => {
  await paint();
  const draft = row(3).querySelector('textarea')!;
  draft.value = 'Still mounted';
  await click(button(row(0), m.thread_branch_collapse({ count: 2 })));
  await paint({ hash: `#post-${id(4)}` });
  expect(row(3).hidden).toBe(false);
  const link = row(3).querySelector<HTMLAnchorElement>(`a[href="#post-${id(2)}"]`)!;
  await act(async () =>
    link.dispatchEvent(
      new browser.MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true }) as unknown as MouseEvent,
    ),
  );
  expect(host.textContent).not.toContain(m.thread_branch_return({ position: 4 }));
  await click(link);
  expect(host.textContent).toContain(m.thread_branch_return({ position: 4 }));
  scope = {};
  await paint();
  expect(host.textContent).not.toContain(m.thread_branch_return({ position: 4 }));
  expect(row(3).querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('Still mounted');
});

test('absent parents keep exact localized navigation and explicit shared reads; retired or unrelated results stay unavailable', async () => {
  let calls = 0;
  let current = true;
  let finish!: (value: { state: 'available'; id: string; threadId: string; excerpt: string; licence: string }) => void;
  const reader = new ReplyParentReader(
    thread.id,
    () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => current,
  );
  await paint({ reader });
  expect(calls).toBe(0);
  const exact = row(4).querySelector<HTMLAnchorElement>(`a[href*="post=${id(900)}"]`)!;
  expect(exact.getAttribute('href')).toBe(threadLocation(getLocale(), thread, undefined, id(900)));
  await click(button(row(4), m.thread_reply_parent_view()));
  const pending = reader.load(id(900));
  expect(reader.load(id(900))).toBe(pending);
  expect(calls).toBe(1);
  await click(button(row(4), m.thread_reply_parent_close()));
  await click(button(row(4), m.thread_reply_parent_view()));
  expect(calls).toBe(1);
  await act(async () => {
    finish({ state: 'available', id: id(900), threadId: id(999), excerpt: 'Foreign secret', licence: 'MIT' });
    await pending;
  });
  expect(row(4).textContent).not.toContain('Foreign secret');
  expect(row(4).textContent).toContain(m.thread_reply_parent_unavailable());
  const late = reader.load(id(900));
  await act(async () => {
    await Promise.resolve();
    current = false;
    reader.current();
    finish({ state: 'available', id: id(900), threadId: thread.id, excerpt: 'Retired secret', licence: 'MIT' });
    await late;
  });
  expect(row(4).textContent).not.toContain('Retired secret');
  expect(reader.get(id(900))).toEqual({ open: false, result: { state: 'idle' } });
});

for (const size of [1, 10, 100])
  test(`${size} supplied rows retain native order with linear indexing and at most eight ancestors`, () => {
    const supplied = Array.from({ length: size }, (_, index) => post(index + 1, index === 0 ? 900 : index));
    const page = conversationPageModel(thread.id, supplied);
    expect(page.rows.map((item) => item.id)).toEqual(supplied.map((item) => item.id));
    expect(page.metrics.indexVisits).toBe(size);
    expect(page.metrics.edgeVisits).toBe(size);
    expect(page.metrics.cycleVisits).toBe(size);
    expect(page.metrics.ancestorVisits).toBeLessThanOrEqual(8 * size);
    expect(page.rows.every((item) => item.ancestors.length <= 8)).toBe(true);
    expect(page.rows[0]!.stop).toBe('missing');
    if (size >= 10) {
      expect(page.rows.at(-1)!.stop).toBe('bound');
      expect(page.rows.at(-1)!.continuation).not.toBeNull();
    }
    // No reader is supplied to this projection, and every address stays within the supplied data.
    expect(page.byId.size).toBe(size);
  });

test('long cycles, self-parent, duplicate IDs, foreign and withheld parents never absorb unrelated rows', () => {
  const cycle = Array.from({ length: 20 }, (_, index) => post(index + 1, index === 19 ? 1 : index + 2));
  const malformed = [
    ...cycle,
    post(21, 21),
    post(22, null),
    post(22, 1),
    post(23, 22),
    { ...post(24, null), threadId: id(999) },
    post(25, 24),
    { ...post(26, 1), availability: 'withheld' as const },
    post(27, 26),
    post(28, null),
  ];
  const page = conversationPageModel(thread.id, malformed);
  expect(page.rows).toHaveLength(malformed.length);
  expect(page.rows.slice(0, 21).every((item) => item.stop === 'cycle' && item.ancestors.length === 0)).toBe(true);
  expect(page.byId.has(id(22))).toBe(false);
  expect(page.byId.has(id(24))).toBe(false);
  expect(new Set(page.rows.map((item) => item.anchorId)).size).toBe(malformed.length);
  expect(page.byId.get(id(23))!.stop).toBe('duplicate');
  expect(page.byId.get(id(25))!.stop).toBe('unrelated');
  expect(page.byId.get(id(27))!.ancestors).toEqual([26]);
  expect(page.byId.get(id(27))!.stop).toBe('unavailable');
  expect(conversationRowHidden(page.rows.at(-1)!, new Set(page.rows.slice(0, -1).map((item) => item.index)))).toBe(
    false,
  );
});
