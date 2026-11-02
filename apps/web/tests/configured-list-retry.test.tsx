import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, createElement, type ReactNode } from 'react';
import { queryOptions } from '@tanstack/react-query';
import { createConfiguredListRetryController, type ConfiguredListRetryOwner } from '../src/features/pages/configured-list-retry';
import type { TypeListQueryResult } from '../src/features/pages/type-list-query';

type Admission = { state: string; expectedReader?: string | null; incarnation: string; mode: string };
const reads: Array<Admission & { locale: string; node: string; page: string; cursor?: string }> = [];
let sessionValue = { state: 'signed-in' as const, subject: 'reader-a', csrfToken: 'csrf-a' };
const sessionQuery = queryOptions({
  queryKey: ['session', 'configured-list-retry-test'] as const,
  queryFn: async () => sessionValue,
  staleTime: Infinity,
  retry: false,
});

mock.module('../src/session/query', () => ({
  AnonymousSessionContext: createContext(false),
  sessionQuery,
  useSession: () => ({ state: 'unknown' as const, csrfToken: null }),
}));
mock.module('../src/features/pages/type-list-query', () => ({
  typeListQuery: (
    locale: string,
    node: string,
    page: string,
    cursor: string | undefined,
    admission: Admission,
  ) =>
    queryOptions({
      queryKey: ['configured-list-retry-test', locale, node, page, cursor ?? null, admission.incarnation],
      queryFn: async () => {
        reads.push({ ...admission, locale, node, page, ...(cursor !== undefined ? { cursor } : {}) });
        throw new Error('native list unavailable');
      },
      retry: false,
      refetchOnMount: false,
    }),
}));
mock.module('../src/features/pages/data', () => ({ PageData: ({ children }: { children: ReactNode }) => children }));
mock.module('../src/features/pages/type-list', () => ({ TypeList: () => createElement('p', null, 'PRIVATE ROWS') }));

test('retry hands off to a current same-session incarnation and retires on owner replacement or unmount', async () => {
  const controller = createConfiguredListRetryController();
  controller.attach();
  let firstCurrent = true;
  const firstRead = mock(async () => {});
  const currentRead = mock(async () => {});
  const first: ConfiguredListRetryOwner = {
    routeKey: 'realm-list',
    sessionKey: 'reader-a',
    queryKey: 'list/old-incarnation',
    isCurrent: () => firstCurrent,
    read: firstRead,
  };
  controller.select(first);
  const attempt = controller.begin()!;
  expect(controller.begin()).toBeNull();
  const pending = controller.waitForCurrentOwner(attempt);
  firstCurrent = false;
  const current = { ...first, queryKey: 'list/current-incarnation', isCurrent: () => true, read: currentRead };
  controller.select(current);
  const selected = await pending;
  expect(selected).toBe(current);
  expect(controller.markRead(attempt, selected!)).toBe(true);
  await selected!.read();
  expect(currentRead).toHaveBeenCalledTimes(1);
  expect(firstRead).not.toHaveBeenCalled();
  controller.finish(attempt);

  const replacedAttempt = controller.begin()!;
  const replaced = controller.waitForCurrentOwner(replacedAttempt);
  controller.select({ ...current, sessionKey: 'reader-b' });
  expect(await replaced).toBeNull();
  expect(controller.isCurrent(replacedAttempt)).toBe(false);

  controller.select(current);
  const unmountedAttempt = controller.begin()!;
  const unmounted = controller.waitForCurrentOwner(unmountedAttempt);
  controller.detach();
  expect(await unmounted).toBeNull();
});

test('Manual Retry of a failed selected-Realm configured list performs a current admitted list read after a healthy session refresh, including when session identity is unchanged', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/list' });
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

  const [{ createRoot }, { QueryClient, QueryClientProvider }, sessionModule, { ConfiguredList }] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('../src/session/query'),
    import('../src/features/pages/type-list-page'),
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const page = JSON.stringify({ subject: '0192f3a0-6c1e-7b2a-9d4e-000000000101', realm: '0192f3a0-6c1e-7b2a-9d4e-000000000201' });

  async function until(predicate: () => boolean) {
    for (let turn = 0; turn < 100 && !predicate(); turn++)
      await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(predicate()).toBe(true);
  }

  try {
    reads.length = 0;
    sessionValue = { state: 'signed-in', subject: 'reader-a', csrfToken: 'csrf-a' };
    client.setQueryData(sessionModule.sessionQuery.queryKey, sessionValue);
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ConfiguredList, { list: 'books', page, cursor: 'cursor:next', locale: 'en' }),
        ),
      ),
    );
    await until(() => reads.length === 1 && !!host.querySelector('button'));
    const initialIncarnation = reads[0]?.incarnation;
    await act(async () => {
      (host.querySelector('button') as HTMLButtonElement).click();
      (host.querySelector('button') as HTMLButtonElement).click();
    });
    await until(() => reads.length === 2 && !!host.querySelector('button'));
    expect(reads).toHaveLength(2);
    expect(reads[1]).toMatchObject({ locale: 'en', node: 'books', page, cursor: 'cursor:next', state: 'signed-in', mode: 'current' });
    expect(reads[1]?.expectedReader).toBe('reader-a');
    expect(reads[1]?.incarnation).not.toBe(initialIncarnation);
    expect(host.textContent).not.toContain('PRIVATE ROWS');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
