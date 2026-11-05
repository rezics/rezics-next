import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, createElement } from 'react';
import { queryOptions } from '@tanstack/react-query';
import {
  configuredListRetryAdmission,
  configuredListRetryWaiting,
} from '../src/features/pages/configured-list-retry-admission';
import type { TypeListAdmissionInput, TypeListQueryResult } from '../src/features/pages/type-list-query';

type Read = {
  locale: string;
  node: string;
  page: string;
  cursor?: string;
  admission: TypeListAdmissionInput;
};

const reads: Read[] = [];
let sessionReads = 0;
let sessionValue = { state: 'signed-in' as const, subject: 'reader-a', csrfToken: 'csrf-a' };
const sessionQuery = queryOptions({
  queryKey: ['session', 'configured-list-native-retry'] as const,
  queryFn: async () => {
    sessionReads++;
    return sessionValue;
  },
  staleTime: Infinity,
  retry: false,
});

function unavailable(input: Read, retryAt?: number): TypeListQueryResult {
  const target = JSON.parse(input.page) as { subject: string; realm: string };
  return {
    kind: 'unavailable',
    admission: {
      request: {
        locale: input.locale,
        node: input.node,
        page: input.page,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        state: input.admission.state,
        ...(input.admission.expectedReader !== undefined ? { expectedReader: input.admission.expectedReader } : {}),
        incarnation: input.admission.incarnation,
        mode: input.admission.mode,
        target,
        realm: target.realm,
      },
    },
    ...(retryAt !== undefined ? { retryAt } : {}),
  };
}

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
    admission: TypeListAdmissionInput,
  ) =>
    queryOptions({
      queryKey: ['configured-native-retry', locale, node, page, cursor ?? null, admission.incarnation],
      queryFn: async () => {
        const input = { locale, node, page, ...(cursor !== undefined ? { cursor } : {}), admission };
        reads.push(input);
        const retryAt = reads.length === 1 ? Date.now() + 80 : reads.length === 2 ? Date.now() + 600 : undefined;
        return unavailable(input, retryAt);
      },
      retry: false,
      refetchOnMount: false,
    }),
}));

async function installDom() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/search/list' });
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
  return {
    window,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      window.happyDOM.abort();
    },
  };
}

async function until(predicate: () => boolean) {
  for (let turn = 0; turn < 120 && !predicate(); turn++)
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  expect(predicate()).toBe(true);
}

test('native Retry-After becomes one absolute minimum-delay admission', () => {
  expect(configuredListRetryAdmission(429, { 'Retry-After': '2' }, 1_000)).toEqual({ retryAt: 3_000 });
  expect(configuredListRetryAdmission(200, { 'Retry-After': '2' }, 1_000)).toBeUndefined();
  expect(configuredListRetryWaiting(3_000, 2_999)).toBe(true);
  expect(configuredListRetryWaiting(3_000, 3_000)).toBe(false);
});

test('outer refusal waits for an explicit same-owner retry and replacement retires its deadline', async () => {
  const dom = await installDom();
  const [{ createRoot }, { QueryClient, QueryClientProvider }, { ConfiguredList }] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('../src/features/pages/type-list-page'),
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const page = JSON.stringify({
    subject: '0192f3a0-6c1e-7b2a-9d4e-000000000101',
    realm: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
  });

  try {
    reads.length = 0;
    sessionReads = 0;
    sessionValue = { state: 'signed-in', subject: 'reader-a', csrfToken: 'csrf-a' };
    client.setQueryData(sessionQuery.queryKey, sessionValue);
    const render = (list: string) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(ConfiguredList, { list, page, cursor: 'cursor:next', locale: 'en' }),
      );
    await act(async () => root.render(render('books')));
    await until(() => reads.length === 1 && !!host.querySelector('button'));
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      (host.querySelector('button') as HTMLButtonElement).click();
      (host.querySelector('button') as HTMLButtonElement).click();
    });
    expect(reads).toHaveLength(1);
    expect(sessionReads).toBe(0);
    await until(() => !(host.querySelector('button') as HTMLButtonElement).disabled);
    expect(reads).toHaveLength(1);
    expect(sessionReads).toBe(0);

    await act(async () => {
      (host.querySelector('button') as HTMLButtonElement).click();
      (host.querySelector('button') as HTMLButtonElement).click();
    });
    await until(() => reads.length === 2 && !!host.querySelector('button'));
    expect(sessionReads).toBe(1);
    expect(reads[1]).toMatchObject({ locale: 'en', node: 'books', page, cursor: 'cursor:next' });
    expect(reads[1]?.admission.expectedReader).toBe('reader-a');
    expect(reads[1]?.admission.incarnation).not.toBe(reads[0]?.admission.incarnation);

    await act(async () => root.render(render('albums')));
    await until(() => reads.length === 3 && !!host.querySelector('button'));
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 620)));
    expect(reads).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.restore();
  }
});

test('a failed TypeList leaf waits on its own hint and restores its exact cursor without fetching on expiry', async () => {
  const dom = await installDom();
  const [{ createRoot }, { TypeList, TypeListContext }, { OverviewContext }] = await Promise.all([
    import('react-dom/client'),
    import('../src/features/pages/type-list'),
    import('../src/features/pages/overview'),
  ]);
  const host = dom.window.document.createElement('div');
  dom.window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const target = { subject: '0192f3a0-6c1e-7b2a-9d4e-000000000101', realm: '0192f3a0-6c1e-7b2a-9d4e-000000000201' };
  const value = {
    locale: 'en',
    sections: new Map([
      ['selected', { ok: false, status: 429, retryAt: Date.now() + 80 }],
      ['sibling', { ok: false, status: 429, retryAt: Date.now() + 5_000 }],
    ]),
  };
  const before = reads.length;

  try {
    await act(async () =>
      root.render(
        createElement(
          OverviewContext.Provider,
          { value: value as never },
          createElement(
            TypeListContext.Provider,
            { value: { target, full: 'selected', cursor: 'cursor:leaf' } },
            createElement(TypeList, { id: 'selected', title: { en: 'Selected' } }),
          ),
        ),
      ),
    );
    expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    await until(() => !!host.querySelector('a[href]'));
    expect(host.querySelector('a[href]')?.getAttribute('href')).toContain('cursor=cursor%3Aleaf');
    expect(
      new URL(host.querySelector('a[href]')!.getAttribute('href')!, 'https://rezics.test').searchParams.get('list'),
    ).toBe('selected');
    expect(reads).toHaveLength(before);
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
});
