import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment, type ReactNode } from 'react';
import recording from '../src/kernel/recorded/library-published-log.json';
import { m } from '../src/paraglide/messages.js';

// Focused composition: visible public log and its confirmation inside AppShell main.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: `https://site.test/en/logs/${recording.publishedLog.id}` });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  useOperation: () => true,
}));
mock.module('../src/session/query', () => ({
  useSession: () => ({ state: 'signed-in', subject: 'mira', csrfToken: 'story-csrf-token-1234567890' }),
  sessionQuery: { queryKey: ['session'] },
  AnonymousSessionContext: { Provider: ({ children }: { children: ReactNode }) => children },
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { AppShell } = await import('../src/shell/shell');
const { PublishedLogPageView } = await import('../src/library/log-page');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });

const log = {
  id: recording.publishedLog.id,
  sessionState: recording.publishedLog.sessionState,
  startedAt: recording.publishedLog.startedAt,
  completedAt: recording.publishedLog.completedAt,
  note: recording.publishedLog.note,
  publishedAt: recording.publishedLog.publishedAt,
  subject: recording.publishedLog.subject,
  account: {
    handle: recording.publishedLog.account.handle,
    displayName: recording.publishedLog.account.displayName,
  },
};
const namedButton = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find((node) => node.textContent === name);

test('the public-log action pattern shows the retained note and owner confirmation inside the shared shell main', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], { state: 'signed-in', subject: 'mira', csrfToken: 'story-csrf-token-1234567890' });
  const path = `/en/logs/${recording.publishedLog.id}`;
  const router = createRouter({
    routeTree: createRootRoute({
      component: () =>
        createElement(AppShell, null, createElement(PublishedLogPageView, { log, isOwner: true, revision: 1 })),
    }),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: cache }, createElement(RouterProvider, { router })));
    });
    const mains = host.querySelectorAll('main');
    expect(mains).toHaveLength(1);
    const main = mains[0]!;
    expect(main.id).toBe('main-content');
    expect(main.textContent).toContain(recording.publishedLog.note);
    expect(host.querySelector('nav')).not.toBeNull();
    expect(namedButton(main, m.library_logs_delete())).toBeDefined();
    expect(namedButton(host.querySelector('nav')!, m.library_logs_delete())).toBeUndefined();
    await act(async () => {
      namedButton(main, m.library_logs_delete())!.click();
    });
    expect(namedButton(main, m.library_logs_confirm_delete())).toBeDefined();
    expect(namedButton(host.querySelector('nav')!, m.library_logs_confirm_delete())).toBeUndefined();
    expect(main.textContent).toContain(recording.publishedLog.note);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    cache.clear();
  }
});
