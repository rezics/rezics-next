import { mock } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import * as start from '../../.storybook/react-start';
import type { MineFollow, MineFollowingPage } from '../../src/library/mine-following';
import type { FollowingSpaceReader } from '../../src/library/following-reading/inspection';

export const spaceId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
export function follow(targetType: MineFollow['targetType'], targetId = spaceId): MineFollow {
  return {
    targetId,
    targetType,
    state: 'following',
    reason: 'explicit',
    idempotencyKey: crypto.randomUUID(),
    target: { id: targetId, type: targetType, types: [targetType], label: `${targetType} title`, cover: null },
  };
}
export const page = (...follows: MineFollow[]): MineFollowingPage => ({ signedIn: true, follows, next: null });
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real page/control composition, controlled reader IO; no claim of native or browser acceptance. */
export async function mountFollowing(initial: MineFollowingPage, readSpace?: FollowingSpaceReader) {
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/following', width: 390 });
  window.document.documentElement.lang = 'en';
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of [
    'HTMLElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'NodeFilter',
    'Document',
    'ShadowRoot',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'Event',
    'KeyboardEvent',
    'FocusEvent',
    'MouseEvent',
    'PointerEvent',
    'CSS',
  ])
    globals[name] = Reflect.get(window, name);
  for (const name of ['scrollTo', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[name] = Reflect.get(window, name).bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { MineFollowingPageView } = await import('../../src/library/mine-following-page');
  const { sessionQuery } = await import('../../src/session/query');
  const { setLocale } = await import('../../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'current-csrf' });
  let replace!: (next: MineFollowingPage) => void;
  let refreshes = 0;
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/following',
    validateSearch: (search: Record<string, unknown>) => ({
      cursor: typeof search.cursor === 'string' ? search.cursor : undefined,
    }),
    component: () => {
      const [current, update] = useState(initial);
      replace = update;
      return (
        <MineFollowingPageView
          page={current}
          cursor={route.useSearch().cursor}
          readSpace={readSpace}
          onRefresh={() => refreshes++}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/library/following'] }),
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const settle = async (action: () => unknown = () => {}) => {
    await act(async () => {
      await action();
      await new Promise((done) => setTimeout(done, 5));
    });
  };
  const admit = async (admitted = ['personal_library', 'collections']) =>
    settle(() =>
      client.setQueriesData(
        { predicate: ({ queryKey }) => queryKey[0] === 'exposure' && queryKey[1] === 'viewer' },
        { subject: client.getQueryData(sessionQuery.queryKey)?.subject, admitted },
      ),
    );
  await router.load();
  await settle(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await admit();
  return {
    host,
    window,
    client,
    settle,
    admit,
    router,
    get refreshes() {
      return refreshes;
    },
    replace: (next: MineFollowingPage) => settle(() => replace(next)),
    account: (subject: string | null) =>
      settle(() =>
        client.setQueryData(
          sessionQuery.queryKey,
          subject ? { state: 'signed-in', subject, csrfToken: 'other-csrf' } : { state: 'signed-out', csrfToken: null },
        ),
      ),
    inspect: async (id: string) => {
      const row = [...host.querySelectorAll<HTMLElement>('li[data-slot="list-row"]')].find(
        (row) =>
          row.querySelector('h3')?.textContent === initial.follows.find((item) => item.targetId === id)?.target?.label,
      );
      const button = row?.querySelector<HTMLButtonElement>('button[aria-label^="Inspect "]');
      if (!button) throw new Error(`Missing inspect control ${id}`);
      await settle(() => button.click());
      return button;
    },
    async dispose() {
      await settle(() => root.unmount());
      client.clear();
      host.remove();
      await window.happyDOM.close();
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
      mock.restore();
    },
  };
}
