import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { Component, act, createElement, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import { createKernelClient } from '@rezics/client';
import type { CompositionDocument, SelectedContext } from '@rezics/composition';
import type { TypeListTarget } from '../src/features/pages/type-list-model';
import type { TypeListQueryResult } from '../src/features/pages/type-list-query';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const readerSessionIds = new Map([
  ['reader-a', 'a'.repeat(43)],
  ['reader-b', 'b'.repeat(43)],
]);
const sessionReaders = new Map([...readerSessionIds].map(([reader, id]) => [id, reader]));
const privateHeaders = new Headers();
let currentRequest = new Request('https://rezics.test/en/search/list');
let responseNode = '';
const nativeReads: Array<{
  body: { target: TypeListTarget; languages: string[]; continuation?: { node: string; cursor: string } };
  authorization?: string;
  signal: AbortSignal;
  node: string;
  work: Deferred<unknown>;
}> = [];

const env = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://api.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      credential: async () => {
        const subject = sessionReaders.get(id);
        return subject
          ? { status: 'active' as const, accessToken: `${subject}-token`, subject, csrfToken: 'test-csrf-token' }
          : { status: 'absent' as const };
      },
    }),
  },
};

function requestFor(reader: string): Request {
  const id = readerSessionIds.get(reader);
  if (!id) throw new Error(`Missing test session for ${reader}`);
  return new Request('https://rezics.test/en/search/list', {
    headers: { cookie: `__Host-rezics_session=${id}` },
  });
}

mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    const chain = start.createServerFn();
    const handler = chain.handler;
    chain.handler = ((fn: Parameters<typeof handler>[0]) => {
      const invoke = handler(fn);
      return (input: { signal?: AbortSignal }) => {
        // Model the server-function HTTP request, carrying the caller's signal to the BFF.
        currentRequest = new Request(currentRequest, { signal: input.signal });
        return invoke(input as never);
      };
    }) as typeof handler;
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => privateHeaders.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env }));
// The only controlled boundary is the delayed native page response; server validation, session preparation,
// query keys, render admission and mounted reader lifetime stay real.
mock.module('../src/kernel/client', () => ({
  kernelClient: () =>
    createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as (typeof nativeReads)[number]['body'];
        const work = deferred<unknown>();
        nativeReads.push({
          body,
          authorization: request.headers.get('authorization') ?? undefined,
          signal: request.signal,
          node: body.continuation?.node ?? responseNode,
          work,
        });
        const reply = (await work.promise) as { status: number; data: unknown };
        return Response.json(reply.data, { status: reply.status });
      },
    }),
}));

class ErrorBoundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? createElement('p', { role: 'alert' }, 'Render failed') : this.props.children;
  }
}

test('configured full lists retire private reads across reader, target, node, cursor and ABA while public SSR stays current', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/search/list' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
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

  const [{ createRoot }, { QueryClient, QueryClientProvider }, sessionModule, pageModule, composition] =
    await Promise.all([
      import('react-dom/client'),
      import('@tanstack/react-query'),
      import('../src/session/query'),
      import('../src/features/pages/type-list-page'),
      import('@rezics/composition'),
    ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const errors: unknown[] = [];
  const session = (subject: string) => ({ state: 'signed-in' as const, subject, csrfToken: 'test-csrf-token' });
  const subjectA = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
  const subjectB = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
  const realmA = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
  const realmB = '0192f3a0-6c1e-7b2a-9d4e-000000000202';
  const targetA = JSON.stringify({ subject: subjectA, realm: realmA });
  const targetB = JSON.stringify({ subject: subjectB, realm: realmB });
  const cursorA = 'opaque:A%3D%3D';
  const cursorB = 'opaque:B%2F%2B';
  const cursorA2 = 'opaque:A-next%3D%3D';
  const publicTarget = JSON.stringify({ route: '/public-books' });
  const titles = {
    de: 'Bücher',
    en: 'Books',
    es: 'Libros',
    fr: 'Livres',
    ja: '本',
    ko: '책',
    'zh-Hans': '书籍',
    'zh-Hant': '書籍',
  };

  function pageResponse(read: (typeof nativeReads)[number], label: string) {
    const node = read.node;
    const target = read.body.target;
    const context: SelectedContext | undefined =
      'subject' in target && target.realm
        ? {
            id: `context-${target.realm}`,
            population: { kind: 'realm', id: target.realm, title: 'Test Realm' },
          }
        : undefined;
    const document: CompositionDocument = {
      root: { props: {} },
      content: [
        {
          type: 'TypeList',
          props: { id: node, types: ['schema:Book'], sort: 'name', limit: 24, title: titles },
        },
      ],
    };
    const continuation = read.body.continuation;
    const plan = composition.planReads(composition.platformRegistry, document, {
      subject: 'subject' in target ? target.subject : null,
      ...(context ? { context } : {}),
      ...(continuation ? { continuation } : {}),
    });
    const key = plan.nodes[node];
    if (!key) throw new Error(`Missing planned TypeList read for ${node}`);
    return {
      status: 200,
      data: {
        subject: 'subject' in target ? target.subject : null,
        profile: 'sha256:configured-list-test',
        template: { scope: 'route', key: 'configured-list-test' },
        ...(context ? { context } : {}),
        document,
        reads: {
          [key]: {
            status: 200,
            body: {
              subjects: [
                {
                  id:
                    label === 'Public SSR'
                      ? '0192f3a0-6c1e-7b2a-9d4e-000000000301'
                      : '0192f3a0-6c1e-7b2a-9d4e-000000000302',
                  type: 'schema:Book',
                  labels: { en: label },
                  summary: null,
                },
              ],
              next: null,
              as_of: '2026-11-02T00:00:00.000Z',
            },
          },
        },
        ...(continuation ? { continuation } : {}),
      },
    };
  }

  let config: {
    list: string;
    page: string;
    cursor?: string;
    locale: string;
    initialData?: TypeListQueryResult;
  } = { list: 'books-a', page: targetA, cursor: cursorA, locale: 'en' };
  responseNode = config.list;
  client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-a'));
  currentRequest = requestFor('reader-a');

  function Surface() {
    return createElement(
      ErrorBoundary,
      { onError: (error) => errors.push(error) },
      createElement(pageModule.ConfiguredList, config),
    );
  }

  async function render() {
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Surface))));
  }
  async function flush() {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  async function until(predicate: () => boolean, label: string) {
    for (let turn = 0; turn < 200; turn++) {
      if (predicate()) return;
      await flush();
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  try {
    await render();
    await until(() => nativeReads.length === 1, 'first Realm read');
    expect(nativeReads[0]!.authorization).toBe('Bearer reader-a-token');
    expect(nativeReads[0]!.body.target).toEqual({ subject: subjectA, realm: realmA });
    expect(nativeReads[0]!.body.continuation).toEqual({ node: 'books-a', cursor: cursorA });

    currentRequest = requestFor('reader-b');
    responseNode = 'books-b';
    config = { list: 'books-b', page: targetB, cursor: cursorB, locale: 'en' };
    await act(async () => {
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-b'));
      root.render(createElement(QueryClientProvider, { client }, createElement(Surface)));
    });
    await until(() => nativeReads.length === 2, 'replacement Realm read');
    expect(nativeReads[0]!.signal.aborted).toBe(true);
    expect(nativeReads[1]!.signal.aborted).toBe(false);
    expect(nativeReads[1]!.authorization).toBe('Bearer reader-b-token');
    expect(nativeReads[1]!.body.target).toEqual({ subject: subjectB, realm: realmB });
    expect(nativeReads[1]!.body.continuation).toEqual({ node: 'books-b', cursor: cursorB });

    currentRequest = requestFor('reader-a');
    responseNode = 'books-a';
    config = { list: 'books-a', page: targetA, cursor: cursorA, locale: 'en' };
    await act(async () => {
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-a'));
      root.render(createElement(QueryClientProvider, { client }, createElement(Surface)));
    });
    await until(() => nativeReads.length === 3, 'fresh A admission after ABA');
    expect(nativeReads[1]!.signal.aborted).toBe(true);
    expect(nativeReads[2]!.authorization).toBe('Bearer reader-a-token');
    expect(nativeReads[2]!.body.continuation).toEqual({ node: 'books-a', cursor: cursorA });

    await act(async () => {
      nativeReads[0]!.work.resolve(pageResponse(nativeReads[0]!, 'Retired A rows'));
      nativeReads[1]!.work.reject(new Error('Retired B failure'));
    });
    await flush();
    expect(host.textContent).not.toContain('Retired A rows');
    expect(host.textContent).not.toContain('Retired B failure');
    expect(errors).toHaveLength(0);

    responseNode = 'books-a-next';
    config = { list: 'books-a-next', page: targetA, cursor: cursorA2, locale: 'en' };
    await render();
    await until(() => nativeReads.length === 4, 'replacement node and cursor read');
    expect(nativeReads[3]!.authorization).toBe('Bearer reader-a-token');
    expect(nativeReads[3]!.body.target).toEqual({ subject: subjectA, realm: realmA });
    expect(nativeReads[3]!.body.continuation).toEqual({ node: 'books-a-next', cursor: cursorA2 });

    config = { list: 'books-a-next', page: targetA, cursor: cursorA2, locale: 'ja' };
    await render();
    await until(() => nativeReads.length === 5, 'replacement locale read');
    expect(nativeReads[4]!.authorization).toBe('Bearer reader-a-token');
    expect(nativeReads[4]!.body.languages[0]).toBe('ja');

    await act(async () => {
      nativeReads[2]!.work.resolve({ status: 308, data: { redirect: { to: 'retired-account' } } });
      nativeReads[3]!.work.resolve(pageResponse(nativeReads[3]!, 'Retired locale rows'));
    });
    await flush();
    expect(host.textContent).not.toContain('Render failed');
    expect(host.textContent).not.toContain('Retired locale rows');
    expect(errors).toHaveLength(0);

    await act(async () => {
      nativeReads[4]!.work.resolve(pageResponse(nativeReads[4]!, 'Current A rows'));
    });
    await until(() => host.textContent?.includes('Current A rows') ?? false, 'current reader rows');
    expect(host.textContent).not.toContain('Retired A rows');

    currentRequest = requestFor('reader-b');
    responseNode = 'public-books';
    const publicAdmission = { state: 'public' as const, incarnation: 'public', mode: 'public' as const };
    const publicList = await import('../src/features/pages/type-list-query');
    const publicPromise = client.fetchQuery(
      publicList.typeListQuery('en', 'public-books', publicTarget, undefined, publicAdmission),
    );
    await until(() => nativeReads.length === 6, 'anonymous public SSR list read');
    expect(nativeReads[5]!.authorization).toBeUndefined();
    expect(nativeReads[5]!.body.target).toEqual({ route: '/public-books' });
    expect(nativeReads[5]!.body.continuation).toBeUndefined();
    expect(privateHeaders.get('cache-control')).toBe('private, no-store');
    await act(async () => nativeReads[5]!.work.resolve(pageResponse(nativeReads[5]!, 'Public SSR')));
    const publicData = await publicPromise;
    responseNode = 'public-books';
    config = { list: 'public-books', page: publicTarget, locale: 'en', initialData: publicData };
    await render();
    await until(() => host.textContent?.includes('Public SSR') ?? false, 'public SSR rows');

    await act(async () => {
      currentRequest = requestFor('reader-b');
      client.setQueryData(sessionModule.sessionQuery.queryKey, session('reader-b'));
      root.render(createElement(QueryClientProvider, { client }, createElement(Surface)));
    });
    expect(nativeReads).toHaveLength(6);
    expect(host.textContent).toContain('Public SSR');
    expect(errors).toHaveLength(0);

    // Public visits also retire, and returning to the exact address starts fresh native work.
    config = { ...config, cursor: 'public-next' };
    await render();
    await until(() => nativeReads.length === 7, 'public continuation');
    await act(async () => root.render(null));
    expect(nativeReads[6]!.signal.aborted).toBe(true);
    await render();
    await until(() => nativeReads.length === 8, 'fresh public return');
    expect(nativeReads[7]!.signal.aborted).toBe(false);
    await act(async () => nativeReads[6]!.work.resolve({ status: 308, data: { redirect: { to: 'obsolete' } } }));
    await act(async () => nativeReads[7]!.work.resolve(pageResponse(nativeReads[7]!, 'Fresh public rows')));
    await until(() => host.textContent?.includes('Fresh public rows') ?? false, 'fresh public rows');
    expect(errors).toHaveLength(0);
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
