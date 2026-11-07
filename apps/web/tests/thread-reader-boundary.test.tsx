import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import {
  browserObservation,
  readerSessionSource,
  ReaderNavigationContext,
  useReaderNavigationHost,
  useReaderAddress,
  useReaderVisit,
} from '../src/reader/lifetime/index';
import type { ReaderNavigation } from '../src/reader/lifetime/contract';
import { useSlowModeVisit, type SlowModeVisit } from '../src/threads/slow-mode/caller';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/thread/title' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('the session capability sees equal replacement and account ABA synchronously without fetching', () => {
  const client = new QueryClient();
  const alice = { state: 'signed-in', subject: 'alice', csrfToken: 'original' };
  client.setQueryData(['session'], alice);
  const source = readerSessionSource(client);
  const stop = source.subscribe(() => {});
  const original = browserObservation(client).getSnapshot();
  const revision = source.snapshot();
  client.setQueryData(['session'], alice);
  expect(source.snapshot()).toBeGreaterThan(revision);
  expect(browserObservation(client).getSnapshot()).not.toBe(original);
  client.setQueryData(['session'], { ...alice, subject: 'bob' });
  client.setQueryData(['session'], alice);
  expect(browserObservation(client).getSnapshot()).not.toBe(original);
  expect(source.read()).toEqual(alice);
  expect(client.isFetching()).toBe(0);
  stop();
  expect(browserObservation(client).getSnapshot().state).toBe('inactive');
  client.clear();
});

test('an isolated QueryClient mount needs no Router and aborts the old slow-mode caller in the replacement stack', async () => {
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'original' });
  const host = document.createElement('div');
  const root = createRoot(host);
  let current: SlowModeVisit | null = null;
  function Control() {
    current = useSlowModeVisit('board');
    return <span>{current?.subject}</span>;
  }
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Control />
        </QueryClientProvider>,
      ),
    );
    const original = current as SlowModeVisit | null;
    expect(original?.current()).toBe(true);
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'replacement' });
      expect(original?.controller.signal.aborted).toBe(true);
      client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'original' });
      expect(original?.current()).toBe(false);
    });
    expect(current).not.toBe(original);
    expect(client.isFetching()).toBe(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

test('host navigation retires a captured visit before render and never restores its focus authority after ABA', async () => {
  let address = '/en/threads/thread/title';
  let locale = 'en';
  const listeners = new Set<() => void>();
  const navigation: ReaderNavigation = {
    address: () => address,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const readLocale = () => locale;
  const visits: ReturnType<typeof useReaderVisit>[] = [];
  function Reader() {
    visits.push(useReaderVisit('thread', locale, readLocale));
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        <ReaderNavigationContext.Provider value={navigation}>
          <Reader />
        </ReaderNavigationContext.Provider>,
      ),
    );
  try {
    await render();
    const original = visits.at(-1)!;
    await act(async () => {
      address = '/en/threads/other/title';
      for (const notify of listeners) notify();
      address = '/en/threads/thread/title';
      for (const notify of listeners) notify();
      expect(original.current()).toBe(false);
    });
    locale = 'fr';
    await render();
    expect(visits.at(-1)!.current()).toBe(true);
    expect(original.current()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    expect(listeners.size).toBe(0);
  }
});

for (const hosted of [false, true])
  test(`${hosted ? 'the installed navigation host' : 'the optional Router fallback'} retires visits and cursor reads before a replacement render`, async () => {
    const path = '/en/threads/thread/title';
    const routeTree = createRootRoute({ component: hosted ? Host : Reader });
    routeTree.addChildren([createRoute({ getParentRoute: () => routeTree, path: '$' })]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await router.load();
    const readLocale = () => 'en';
    let visit!: ReturnType<typeof useReaderVisit>;
    let address!: ReturnType<typeof useReaderAddress>;
    function Reader() {
      visit = useReaderVisit('thread', 'en', readLocale);
      address = useReaderAddress(path, undefined, 'en', readLocale);
      return null;
    }
    function Host() {
      const navigation = useReaderNavigationHost();
      return (
        <ReaderNavigationContext value={navigation}>
          <Reader />
        </ReaderNavigationContext>
      );
    }
    const root = createRoot(document.createElement('div'));
    let stop = () => {};
    try {
      await act(async () => root.render(<RouterProvider router={router} />));
      const originalVisit = visit;
      const originalAddress = address;
      expect(originalVisit.current()).toBe(true);
      expect(originalAddress.isCurrent()).toBe(true);
      let departures = 0;
      stop = router.subscribe('onBeforeNavigate', () => {
        departures++;
        // The fallback subscriptions run in the departure stack, before React can replace the reader.
        expect(originalVisit.current()).toBe(false);
        expect(originalAddress.isCurrent()).toBe(false);
      });
      await act(async () => {
        await router.navigate({ to: `${path}?cursor=next` });
      });
      expect(address.cursor).toBe('next');
      expect(address.isCurrent()).toBe(true);
      await act(async () => {
        await router.navigate({ to: path });
      });
      expect(departures).toBe(2);
      expect(address.cursor).toBeNull();
      expect(originalAddress.isCurrent()).toBe(false);
      expect(originalVisit.current()).toBe(false);
    } finally {
      stop();
      await act(async () => root.unmount());
      router.history.destroy();
    }
  });
