import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

type DirectoryResult = { state: 'ready'; boards: never[]; next: null } | { state: 'unavailable' };
type DirectoryRequest = { purpose: 'discussion' | 'reviews'; cursor?: string; limit: number };
const calls: DirectoryRequest[] = [];
let readDirectory: () => Promise<DirectoryResult> = async () => ({ state: 'unavailable' });
mock.module('../src/threads/board-directory-read', () => ({
  boardDirectoryQuery: (request: DirectoryRequest) => ({
    queryKey: ['board-directory', request],
    queryFn: () => {
      calls.push(request);
      return readDirectory();
    },
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchOnMount: false,
  }),
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/boards/' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { Route } = await import('../src/routes/boards/index');
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
const boardRoute = Route.update({ id: '/boards/', path: '/boards/', getParentRoute: () => rootRoute } as never);
const awayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/away',
  component: () => createElement('p', null, 'Away'),
});
const routeTree = rootRoute.addChildren([boardRoute, awayRoute]);
const cursor = 'signed:current/+opaque=';
const subject = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const entries = `/boards/?${new URLSearchParams({ purpose: 'reviews', cursor, subject, subjectTitle: 'Original' })}`;
const originalLocale = getLocale();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [entries] }),
  });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))),
  );
  return {
    host,
    router,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

async function retryByKeyboard(host: HTMLElement) {
  const button = host.querySelector('button')!;
  button.focus();
  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 })));
  return button;
}

test('the route refetch restores keyboard position on success or keeps the retry destination on failure', async () => {
  await setLocale('en', { reload: false });
  calls.length = 0;
  readDirectory = async () => ({ state: 'unavailable' });
  const view = await mount();
  try {
    const initialRetry = view.host.querySelector('button')!;
    expect(document.activeElement).not.toBe(initialRetry);
    let failure = deferred<DirectoryResult>();
    readDirectory = () => failure.promise;
    await retryByKeyboard(view.host);
    expect(view.host.querySelector('button')).toBeNull();
    expect(view.host.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => failure.resolve({ state: 'unavailable' }));
    expect(document.activeElement).toBe(view.host.querySelector('button'));
    let success = deferred<DirectoryResult>();
    readDirectory = () => success.promise;
    await retryByKeyboard(view.host);
    await act(async () => success.resolve({ state: 'ready', boards: [], next: null }));
    expect(document.activeElement).toBe(view.host.querySelector('section[aria-busy="false"]'));
    expect(calls).toHaveLength(3);
    expect(calls.every((request) => request.purpose === 'reviews' && request.cursor === cursor)).toBe(true);
  } finally {
    await view.close();
  }
});

test('focus, pointer use, request identity changes and navigation cancel a pending handoff', async () => {
  await setLocale('en', { reload: false });
  for (const cancel of ['focus', 'pointer', 'identity', 'navigation'] as const) {
    calls.length = 0;
    readDirectory = async () => ({ state: 'unavailable' });
    const view = await mount();
    const outside = window.document.createElement('button');
    window.document.body.append(outside);
    const pending = deferred<DirectoryResult>();
    readDirectory = () => pending.promise;
    try {
      await retryByKeyboard(view.host);
      if (cancel === 'focus') await act(async () => outside.focus());
      if (cancel === 'pointer')
        await act(async () => outside.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
      if (cancel === 'identity')
        await act(async () =>
          view.router.navigate({
            to: '/boards',
            search: { purpose: 'reviews', cursor, subject, subjectTitle: 'Changed' },
          }),
        );
      if (cancel === 'navigation') await act(async () => view.router.navigate({ to: '/away' }));
      await act(async () => pending.resolve({ state: 'unavailable' }));
      expect(document.activeElement).not.toBe(view.host.querySelector('button'));
      if (cancel === 'focus') expect(document.activeElement).toBe(outside);
      if (cancel === 'navigation') expect(view.host.textContent).toBe('Away');
    } finally {
      outside.remove();
      await view.close();
    }
  }
});

afterAll(async () => {
  await setLocale(originalLocale, { reload: false });
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
