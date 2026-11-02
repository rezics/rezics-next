import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, createElement, type ReactNode } from 'react';
import { queryOptions } from '@tanstack/react-query';
import type { TypeListQueryResult } from '../src/features/pages/type-list-query';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

type Admission = { state: string; expectedReader?: string | null; incarnation: string; mode: string };
type Read = { locale: string; node: string; page: string; cursor?: string; admission: Admission };
const firstRead = deferred<TypeListQueryResult>();
const reads: Read[] = [];
let sessionReads = 0;
const sessionQuery = queryOptions({
  queryKey: ['session', 'configured-list-test'] as const,
  queryFn: async () => {
    sessionReads++;
    return { state: 'signed-in' as const, subject: 'reader-b', csrfToken: 'csrf' };
  },
  staleTime: Infinity,
  retry: false,
});

function staleReady(input: Read): TypeListQueryResult {
  const target = JSON.parse(input.page) as { subject: string; realm: string };
  return {
    kind: 'ready',
    node: input.node,
    target,
    page: {} as never,
    admission: {
      request: {
        locale: input.locale,
        node: input.node,
        page: input.page,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        state: input.admission.state,
        expectedReader: 'reader-a',
        incarnation: input.admission.incarnation,
        mode: input.admission.mode,
        target,
        realm: target.realm,
      },
      reader: 'reader-a',
      context: null,
    },
  } as TypeListQueryResult;
}

mock.module('../src/session/query', () => ({
  AnonymousSessionContext: createContext(false),
  sessionQuery,
  useSession: () => ({ state: 'unknown' as const, csrfToken: null }),
}));
mock.module('../src/features/pages/type-list-query', () => ({
  typeListQuery: (locale: string, node: string, page: string, cursor: string | undefined, admission: Admission) =>
    queryOptions({
      queryKey: [
        'configured-list-test',
        locale,
        node,
        page,
        cursor ?? null,
        admission.expectedReader,
        admission.incarnation,
      ],
      queryFn: () => {
        const input = { locale, node, page, ...(cursor !== undefined ? { cursor } : {}), admission };
        reads.push(input);
        return reads.length === 1 ? firstRead.promise : Promise.resolve(staleReady(input));
      },
      retry: false,
      refetchOnMount: false,
    }),
}));
mock.module('../src/features/pages/data', () => ({ PageData: ({ children }: { children: ReactNode }) => children }));
mock.module('../src/features/pages/type-list', () => ({
  TypeList: () => createElement('p', null, 'PRIVATE STALE ROWS'),
}));

test('configured list shows pending and recoverable admission states, then retries once with the current reader', async () => {
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
  const page = JSON.stringify({
    subject: '0192f3a0-6c1e-7b2a-9d4e-000000000101',
    realm: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
  });

  async function until(predicate: () => boolean) {
    for (let turn = 0; turn < 100 && !predicate(); turn++)
      await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(predicate()).toBe(true);
  }

  try {
    client.setQueryData(sessionModule.sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'reader-a',
      csrfToken: 'csrf',
    });
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ConfiguredList, { list: 'books', page, cursor: 'cursor:next', locale: 'en' }),
        ),
      ),
    );
    await until(() => reads.length === 1);
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBeTruthy();
    firstRead.resolve({ kind: 'admission-mismatch', node: 'books', admission: { request: {} } } as TypeListQueryResult);
    await until(() => !!host.querySelector('button'));
    expect(host.textContent).not.toContain('PRIVATE STALE ROWS');
    await act(async () => {
      (host.querySelector('button') as HTMLButtonElement).click();
      (host.querySelector('button') as HTMLButtonElement).click();
    });
    await until(() => sessionReads === 1 && reads.length === 2 && !!host.querySelector('button'));
    expect(reads).toHaveLength(2);
    expect(reads.map(({ locale, node, page: target, cursor }) => [locale, node, target, cursor])).toEqual([
      ['en', 'books', page, 'cursor:next'],
      ['en', 'books', page, 'cursor:next'],
    ]);
    expect(reads[1]?.admission.expectedReader).toBe('reader-b');
    expect(host.textContent).not.toContain('PRIVATE STALE ROWS');
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
