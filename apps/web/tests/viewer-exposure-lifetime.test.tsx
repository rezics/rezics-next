import { afterAll, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { act, createElement, Fragment, StrictMode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as storyStart from '../.storybook/react-start';

let currentRequest = new Request('https://site.test/en');
const sessionEnv: Record<string, unknown> = {};
const serverFunctionContext = new AsyncLocalStorage<boolean>();

const testStart = {
  ...storyStart,
  createServerFn(...args: Parameters<typeof storyStart.createServerFn>) {
    const base = storyStart.createServerFn(...args);
    const chain = {
      validator(next: Parameters<typeof base.validator>[0]) {
        base.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const invoke = ((...input: never[]) => serverFunctionContext.run(true, () => handler(...input))) as T;
        return base.handler(invoke);
      },
    };
    return chain;
  },
  createIsomorphicFn() {
    let serverHandler: (...args: unknown[]) => unknown = () => undefined;
    let clientHandler: (...args: unknown[]) => unknown = serverHandler;
    const invoke = (...args: unknown[]) =>
      (typeof window === 'undefined' || serverFunctionContext.getStore() === true ? serverHandler : clientHandler)(
        ...args,
      );
    const chain = {
      server(handler: (...args: unknown[]) => unknown) {
        serverHandler = handler;
        return chain;
      },
      client(handler: (...args: unknown[]) => unknown) {
        clientHandler = handler;
        return invoke;
      },
    };
    return chain;
  },
};

mock.module('@tanstack/react-start', () => testStart);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({
  get env() {
    return sessionEnv;
  },
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { Exposure, operationIsAdmitted, prepareExposure, useOperation } = await import('../src/kernel/exposure');
const { sessionQuery } = await import('../src/session/query');

const admitted = [
  'collections',
  'personal_library',
  'reading_progress',
  'library_entry.restore',
  'library_label.list',
  'commerce_sale.list',
];
const publicGroups = ['collections'];
const sessionIds = { A: 'A'.repeat(43), B: 'B'.repeat(43) };

function session(subject: 'A' | 'B', csrfToken: string | null) {
  return { state: 'signed-in' as const, subject, csrfToken };
}

function signedOut() {
  return { state: 'signed-out' as const, subject: null, csrfToken: null };
}

function requestFor(subject: 'A' | 'B') {
  currentRequest = new Request('https://site.test/en/library', {
    headers: { cookie: `__Host-rezics_session=${sessionIds[subject]}` },
  });
}

function Controls({ name }: { name: string }) {
  const restore = useOperation('library_entry.restore');
  return createElement(
    'section',
    { 'data-reader': name },
    createElement(Exposure, {
      operation: 'collection.create',
      children: createElement('button', { 'data-public': name }, 'Public collection'),
    }),
    createElement(Exposure, {
      operation: 'progress_session.create',
      children: createElement('button', { 'data-private': name }, 'Record progress'),
    }),
    createElement(Exposure, {
      operation: 'library_pin.put',
      children: createElement('button', { 'data-pin': name }, 'Pin collection'),
    }),
    createElement(Exposure, {
      operation: 'library_entry.restore',
      children: createElement('button', { 'data-restore': name }, 'Restore entry'),
    }),
    createElement(Exposure, {
      operation: 'library_label.list',
      children: createElement('button', { 'data-label': name }, 'List labels'),
    }),
    createElement(Exposure, {
      operation: 'commerce_sale.list',
      children: createElement('button', { 'data-sale': name }, 'List sales'),
    }),
    createElement('output', { 'data-restore-state': name }, String(restore)),
  );
}

function ReaderSet({ count }: { count: number }) {
  return createElement(
    Fragment,
    null,
    ...Array.from({ length: count }, (_, index) => createElement(Controls, { key: index, name: `reader-${index}` })),
  );
}

type NativeRead = {
  authorization: string | null;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};

afterAll(() => mock.restore());

// UNRUN: exercises the mounted useOperation/Exposure composition against its real session and viewer BFFs.
// Only the browser/native transport endpoints are represented by local fixtures.
test('viewer exposure retires each mounted reader observation without leaking or multiplying private reads', async () => {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  let window: InstanceType<(typeof import('happy-dom'))['Window']> | undefined;
  let root: import('react-dom/client').Root | undefined;
  let secondRoot: import('react-dom/client').Root | undefined;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const credentials = new Map([
    [sessionIds.A, { subject: 'A', csrfToken: null, accessToken: 'native-A' }],
    [sessionIds.B, { subject: 'B', csrfToken: 'csrf-B', accessToken: 'native-B' }],
  ]);
  let credentialReads = 0;
  let immediateNative = true;
  const nativeReads: NativeRead[] = [];
  Object.assign(sessionEnv, {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    KERNEL_ORIGIN: 'https://kernel.test',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        credential: async () => {
          credentialReads++;
          const credential = credentials.get(id);
          return credential ? { status: 'active', ...credential } : { status: 'absent' };
        },
        credentialIfFresh: async () => ({ status: 'unavailable' as const }),
        signedIn: async () => {
          const credential = credentials.get(id);
          return credential
            ? { signedIn: true, subject: credential.subject, csrfToken: credential.csrfToken }
            : { signedIn: false };
        },
      }),
    },
  });

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/v1/platform/exposure');
      const authorization = request.headers.get('authorization');
      if (immediateNative) {
        expect(authorization).toBeNull();
        return Promise.resolve(Response.json({ admitted: publicGroups }));
      }
      return new Promise<Response>((resolve, reject) => {
        nativeReads.push({ authorization, resolve, reject });
      });
    }) as typeof fetch,
  });

  try {
    if (originalWindow) Reflect.deleteProperty(globalThis, 'window');
    const { Window } = await import('happy-dom');

    // Public preparation remains session-free and supplies the current public exposure result.
    client.setQueryData(['exposure', 'anonymous'], { state: 'ready', admitted: publicGroups });
    await prepareExposure(client);
    expect(credentialReads).toBe(0);
    expect(nativeReads).toHaveLength(0);
    expect(await client.getQueryData(['exposure', 'anonymous'])).toEqual({ state: 'ready', admitted: publicGroups });

    const preview = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(Controls, { name: 'preview' })),
    );
    expect(preview).not.toContain('data-private="preview"');
    expect(preview).not.toContain('data-public="preview"');
    expect(credentialReads).toBe(0);
    expect(nativeReads).toHaveLength(0);

    const ssr = renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(Controls, { name: 'ssr' })),
    );
    expect(ssr).not.toContain('data-public="ssr"');
    expect(ssr).not.toContain('data-private="ssr"');
    expect(credentialReads).toBe(0);
    expect(nativeReads).toHaveLength(0);
    expect(operationIsAdmitted('library_pin.put', ['personal_library'])).toBe(true);
    expect(operationIsAdmitted('library_entry.restore', ['personal_library'])).toBe(false);
    expect(operationIsAdmitted('library_entry.restore', ['library_entry.restore'])).toBe(true);
    expect(operationIsAdmitted('library_label.list', ['library_label.list'])).toBe(true);
    expect(operationIsAdmitted('commerce_sale.list', ['commerce_sale.list'])).toBe(true);

    window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
    const domGlobals = {
      window,
      document: window.document,
      navigator: window.navigator,
      HTMLElement: window.HTMLElement,
      HTMLInputElement: window.HTMLInputElement,
      HTMLButtonElement: window.HTMLButtonElement,
      Element: window.Element,
      Node: window.Node,
      Document: window.Document,
      DocumentFragment: window.DocumentFragment,
      MutationObserver: window.MutationObserver,
      ResizeObserver: window.ResizeObserver,
      FormData: window.FormData,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      matchMedia: window.matchMedia.bind(window),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(domGlobals)) {
      previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }

    const host = window.document.createElement('div');
    window.document.body.append(host);
    requestFor('A');
    client.setQueryData(sessionQuery.queryKey, session('A', 'csrf-A'));
    client.setQueryData(['exposure', 'anonymous'], { state: 'ready', admitted: publicGroups });
    const { createRoot } = await import('react-dom/client');
    root = createRoot(host as unknown as HTMLElement);
    const render = (target: import('react-dom/client').Root, count: number, strict = false) =>
      target.render(
        createElement(
          QueryClientProvider,
          { client },
          strict
            ? createElement(StrictMode, null, createElement(ReaderSet, { count }))
            : createElement(ReaderSet, { count }),
        ),
      );
    const flush = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const until = async (predicate: () => boolean) => {
      for (let index = 0; index < 160 && !predicate(); index++) await flush();
      expect(predicate()).toBe(true);
    };
    const privateControls = () => host.querySelectorAll('[data-private]');
    const publicControls = () => host.querySelectorAll('[data-public]');
    const resolveRead = async (index: number) => {
      await act(async () => {
        nativeReads[index]!.resolve(Response.json({ admitted }));
        await Promise.resolve();
      });
    };

    immediateNative = false;
    await act(async () => render(root!, 2));
    await until(() => nativeReads.length === 1);
    expect(credentialReads).toBe(1);
    expect(nativeReads.map(({ authorization }) => authorization)).toEqual(['Bearer native-A']);
    expect(privateControls()).toHaveLength(0);
    await resolveRead(0);
    await until(() => privateControls().length === 2);
    expect(host.querySelectorAll('[data-pin]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-restore]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-label]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-sale]')).toHaveLength(2);
    expect(nativeReads).toHaveLength(1);

    // The expected reader only refuses a mismatch; the BFF's actual prepared request supplies identity.
    requestFor('B');
    const credentialReadsBeforeMismatch = credentialReads;
    await act(async () => client.setQueryData(sessionQuery.queryKey, session('A', 'csrf-A2')));
    await until(() => credentialReads > credentialReadsBeforeMismatch);
    await flush();
    expect(nativeReads).toHaveLength(1);
    expect(privateControls()).toHaveLength(0);

    // A reader with a successful subject and no CSRF token still gets one fresh read.
    requestFor('A');
    await act(async () => client.setQueryData(sessionQuery.queryKey, session('A', null)));
    await until(() => nativeReads.length === 2);
    expect(nativeReads[1]!.authorization).toBe('Bearer native-A');
    await resolveRead(1);
    await until(() => privateControls().length === 2);

    // Query error retires cached controls even though React Query still has the prior data value.
    await act(async () => {
      client
        .getQueryCache()
        .find({ queryKey: sessionQuery.queryKey, exact: true })
        ?.setState({
          status: 'error',
          error: new Error('session read failed'),
          errorUpdatedAt: Date.now(),
        });
    });
    expect(privateControls()).toHaveLength(0);
    expect(publicControls()).toHaveLength(0);

    requestFor('A');
    await act(async () => client.setQueryData(sessionQuery.queryKey, session('A', null)));
    await until(() => nativeReads.length === 3);
    await resolveRead(2);
    await until(() => privateControls().length === 2);

    // An old success cannot publish into B's observation or make its fresh read unnecessary.
    requestFor('A');
    await act(async () => client.setQueryData(sessionQuery.queryKey, session('A', 'csrf-A3')));
    await until(() => nativeReads.length === 4);
    requestFor('B');
    await act(async () => client.setQueryData(sessionQuery.queryKey, session('B', 'csrf-B')));
    await until(() => nativeReads.length === 5);
    await resolveRead(3);
    expect(privateControls()).toHaveLength(0);
    await resolveRead(4);
    await until(() => privateControls().length === 2);

    // Observing A then B in one React act still retires B's old cache; the new B incarnation reads once.
    requestFor('B');
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, session('A', 'csrf-A4'));
      client.setQueryData(sessionQuery.queryKey, session('B', 'csrf-B'));
    });
    await until(() => nativeReads.length === 6);
    expect(privateControls()).toHaveLength(0);
    await resolveRead(5);
    await until(() => privateControls().length === 2);

    // Sign-out closes private controls immediately; a late old failure cannot close the public owner.
    requestFor('B');
    await act(async () => client.setQueryData(sessionQuery.queryKey, session('B', 'csrf-B2')));
    await until(() => nativeReads.length === 7);
    await act(async () => client.setQueryData(sessionQuery.queryKey, signedOut()));
    expect(privateControls()).toHaveLength(0);
    expect(publicControls()).toHaveLength(2);
    await act(async () => {
      nativeReads[6]!.reject(new Error('retired exposure failed'));
      await Promise.resolve();
    });
    await flush();
    expect(publicControls()).toHaveLength(2);
    expect(privateControls()).toHaveLength(0);

    // Removal is an unknown admission, even with a cached anonymous grant.
    await act(async () => client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true }));
    expect(publicControls()).toHaveLength(0);
    expect(privateControls()).toHaveLength(0);

    // Unmount retires the mounted incarnation. A StrictMode remount must fetch fresh and publish that result.
    await act(async () => root!.unmount());
    root = undefined;
    requestFor('B');
    client.setQueryData(sessionQuery.queryKey, session('B', 'csrf-B3'));
    const secondHost = window.document.createElement('div');
    window.document.body.append(secondHost);
    secondRoot = createRoot(secondHost as unknown as HTMLElement);
    const beforeRemountReads = nativeReads.length;
    await act(async () => render(secondRoot!, 2, true));
    await until(() => nativeReads.length > beforeRemountReads);
    expect(secondHost.querySelectorAll('[data-private]')).toHaveLength(0);
    for (let index = beforeRemountReads; index < nativeReads.length; index++) await resolveRead(index);
    await until(() => secondHost.querySelectorAll('[data-private]').length === 2);
    expect(nativeReads.length - beforeRemountReads).toBeLessThanOrEqual(2);
    expect(
      nativeReads.slice(beforeRemountReads).every(({ authorization }) => authorization === 'Bearer native-B'),
    ).toBe(true);
  } finally {
    if (secondRoot) await act(async () => secondRoot!.unmount());
    if (root) await act(async () => root!.unmount());
    client.clear();
    await window?.happyDOM.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
    for (const key of Object.keys(sessionEnv)) delete sessionEnv[key];
  }
});
