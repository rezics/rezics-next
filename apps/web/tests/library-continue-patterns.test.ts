import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment, type ReactNode } from 'react';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/continue' });
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
const { ContinueExample, continueExamples } = await import('../src/stories/library-continue/example');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });

const namedControl = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('a,button')].find((node) => (node.textContent ?? '').includes(name));

async function mount(navigation = false, state: Parameters<typeof ContinueExample>[0]['state']) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], { state: 'signed-in', subject: 'mira', csrfToken: 'story-csrf-token-1234567890' });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () =>
        createElement(AppShell, null, createElement(ContinueExample, { state, navigation })),
    }),
    history: createMemoryHistory({ initialEntries: ['/en/library/continue'] }),
  });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: cache }, createElement(RouterProvider, { router })));
  });
  return {
    host,
    cache,
    async close() {
      await act(async () => root.unmount());
      host.remove();
      cache.clear();
    },
  };
}

test('supplied Continue retry stays inside the shared shell main and does not empty the region', async () => {
  const frame = await mount(false, { state: 'unavailable', status: 503 });
  try {
    const mains = frame.host.querySelectorAll('main');
    expect(mains).toHaveLength(1);
    const main = mains[0]!;
    expect(main.id).toBe('main-content');
    expect(main.textContent).toContain(m.library_continue_unavailable());
    expect(namedControl(main, m.library_follow_retry())).toBeDefined();
    await act(async () => {
      namedControl(main, m.library_follow_retry())!.click();
    });
    const title = m.home_continue_label({ title: continueExamples[0]!.label });
    expect(namedControl(main, title)).toBeDefined();
    expect(namedControl(main, title)?.getAttribute('href')).toBe(
      `/en/library/progress/${encodeURIComponent(continueExamples[0]!.progress!.sessionId)}`,
    );
    expect(main.textContent).not.toContain(m.library_continue_empty());
  } finally {
    await frame.close();
  }
});

test('Library navigation appears once in the Continue region and the shell does not add a page heading', async () => {
  const frame = await mount(true, { state: 'unavailable', reason: 'missing-binding' });
  try {
    const main = frame.host.querySelector('main')!;
    expect(frame.host.querySelectorAll('[data-library-navigation]')).toHaveLength(1);
    expect(main.querySelectorAll('[data-library-navigation]')).toHaveLength(1);
    expect([...main.querySelectorAll('h1')].some((node) => node.textContent === m.library_continue())).toBe(false);
    expect(main.textContent).toContain(m.library_continue_unavailable());
  } finally {
    await frame.close();
  }
});
