import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/zh-Hant/boards/reading' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { createKernelClient } = await import('@rezics/client');
const { loadBoardPageWithAuthors } = await import('../src/identity/page-loaders');
const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
const { continuationBoardId, continuationCursor } = await import('../src/kernel/fake/board-continuation');
const { BoardFeed } = await import('../src/threads/board-feed');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { threadLocation } = await import('../src/threads/thread-href');
const calls: string[] = [];
const client = createKernelClient('https://kernel.test', { fetch: createStoryRecordedKernelFetch() });
const page = await loadBoardPageWithAuthors(client, { id: continuationBoardId, cursor: continuationCursor });
const thread = page.threads.threads[0]!;
type Props = ComponentProps<typeof BoardFeed>;
let router: ReturnType<typeof createRouter>;
let props: Props, update: (next: Props) => void, root: ReturnType<typeof createRoot>;
const writes: ReturnType<typeof Promise.withResolvers<void>>[] = [];
Object.defineProperty(window.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: (url: string) => {
      calls.push(url);
      const pending = Promise.withResolvers<void>();
      writes.push(pending);
      return pending.promise;
    },
  },
});
const host = document.createElement('main');
document.body.append(host);
const settle = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
function button(text: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]')].find(
    (node) => node.textContent === text || node.getAttribute('aria-label') === text,
  );
  expect(node).toBeDefined();
  return node!;
}
async function copy() {
  await act(async () => button(m.thread_content_more_actions()).click());
  await act(async () => {
    const item = button(m.thread_content_copy_link());
    item.focus();
    item.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}
async function replace(patch: Partial<Props>) {
  props = { ...props, ...patch };
  await act(async () => update(props));
}
beforeEach(async () => {
  calls.length = writes.length = 0;
  setLocale('zh-Hant', { reload: false });
  props = {
    boardId: page.board.id,
    sort: 'active',
    page: { ...page.threads, threads: [thread], next: null },
    authors: page.authors,
    now: '2026-11-01T00:00:00Z',
  };
  function Feed() {
    const [value, setValue] = useState(props);
    update = setValue;
    return <BoardFeed {...value} />;
  }
  const route = createRootRoute({ component: Feed });
  router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});
afterAll(() => {
  setLocale('en', { reload: false });
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('denied clipboard offers the exact selected URL on the board; Close and a successful retry tell the truth', async () => {
  const location = window.location.href;
  const url = new URL(threadLocation('zh-Hant', { id: thread.id, title: thread.title }), location).href;
  await copy();
  await act(async () => writes[0]!.reject(new DOMException('Denied', 'NotAllowedError')));
  await act(settle);
  const input = host.querySelector('input')!;
  expect(input.value).toBe(url);
  expect(input.readOnly).toBe(true);
  expect(host.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(m.board_feed_copy_url());
  expect(document.activeElement).toBe(input);
  expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe(url);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(m.board_feed_copy_failed());
  expect(window.location.href).toBe(location);
  expect(host.querySelectorAll('[data-slot="board-feed-card"]')).toHaveLength(1);
  await act(async () => button(m.board_feed_copy_close()).click());
  expect(host.querySelector('input, [role="status"]')).toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe(m.thread_content_more_actions());
  await copy();
  await act(async () => writes[1]!.reject(new Error('Denied again')));
  await copy();
  await act(async () => writes[2]!.resolve());
  expect(host.querySelector('input')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(m.board_feed_link_copied());
  expect(calls).toEqual([url, url, url]);
});

test('replaced destinations, boards, erased rows and removed rows retire pending copy results and fallback', async () => {
  await copy();
  const changed = { ...thread, title: 'Replacement title' };
  await replace({ page: { ...props.page, threads: [changed] } });
  await act(async () => writes[0]!.reject(new Error('Late denial')));
  expect(host.querySelector('input, [role="status"]')).toBeNull();
  await copy();
  await replace({ boardId: 'another-board' });
  await act(async () => writes[1]!.resolve());
  expect(host.querySelector('input, [role="status"]')).toBeNull();
  await copy();
  await replace({ page: { ...props.page, threads: [{ ...changed, availability: 'erased' }] } });
  await act(async () => writes[2]!.reject(new Error('Late denial')));
  expect(host.querySelector('input, [role="status"]')).toBeNull();
  await copy();
  await act(async () => writes[3]!.reject(new Error('Denied')));
  expect(host.querySelector('input')?.value).toBe(
    new URL(threadLocation('zh-Hant', { id: thread.id, title: null }), window.location.origin).href,
  );
  expect(host.textContent).not.toContain(changed.title);
  await replace({ page: { ...props.page, threads: [] } });
  expect(host.querySelector('input, [role="status"]')).toBeNull();
});

test('a committed Next continuation focuses the empty-page boundary once without stealing later focus', async () => {
  await replace({ page: { ...props.page, threads: [], next: 'signed:next/+opaque=' } });
  const boundary = host.querySelector<HTMLHeadingElement>('h2')!;
  expect(host.querySelector('nav a')?.textContent).toBe(m.threads_next_page());
  await act(async () => router.navigate({ to: '/', state: { __boardNextPage: true } as never }));
  expect(document.activeElement).toBe(boundary);
  const sort = host.querySelector<HTMLAnchorElement>('nav a')!;
  sort.focus();
  await replace({ page: { ...props.page, threads: [], next: null } });
  expect(document.activeElement).toBe(sort);
});
