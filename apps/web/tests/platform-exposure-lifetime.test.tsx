import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import type { QueryClient as QueryClientType } from '@tanstack/react-query';
import * as startApi from '../.storybook/react-start';
import type { ExposureReaderEnvelope, Outcome, Page } from '../src/platform/exposure/data';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const loaderReads: unknown[] = [];
const readCalls: { query: Record<string, unknown>; result: Deferred<ExposureReaderEnvelope> }[] = [];
const changeCalls: {
  operation: Extract<Outcome, { status: 'recorded' | 'uncertain' }>['operation'];
  query: Record<string, unknown>;
  csrfToken: string;
  result: Deferred<Outcome>;
}[] = [];
let loaderEnvelope: ExposureReaderEnvelope;
let refreshLoader = false;

mock.module('@tanstack/react-start', () => startApi);
mock.module('@tanstack/react-start/server', () => startApi);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/platform/exposure/actions', () => ({
  readPlatformExposureBound: ({ data = {} }: { data?: Record<string, unknown> }) => {
    if (loaderReads.length === 0 || refreshLoader) {
      refreshLoader = false;
      loaderReads.push(data);
      return Promise.resolve(loaderEnvelope);
    }
    const result = deferred<ExposureReaderEnvelope>();
    readCalls.push({ query: structuredClone(data), result });
    return result.promise;
  },
  changePlatformExposure: ({
    data,
    headers,
  }: {
    data: {
      operation: Extract<Outcome, { status: 'recorded' | 'uncertain' }>['operation'];
      query: Record<string, unknown>;
    };
    headers: Record<string, string>;
  }) => {
    const result = deferred<Outcome>();
    changeCalls.push({
      operation: data.operation,
      query: structuredClone(data.query),
      csrfToken: headers['X-CSRF-Token']!,
      result,
    });
    return result.promise;
  },
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/platform/exposure' });
window.document.documentElement.lang = 'en';
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
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  location: window.location,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { Route } = await import('../src/routes/platform/exposure');
const { m } = await import('../src/paraglide/messages.js');

const subjectA = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const subjectB = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const rowTime = '2026-11-01T00:00:00.123456Z';

function readyPage(group: string, next: string | null = null): Page {
  return {
    status: 'ready',
    discovery: { status: 'available', groups: [group] },
    current: {
      status: 'available',
      viewer: { accountId: subjectA, clientId: 'exposure-management' },
      actions: { open: true, close: true },
      exposureGroups: [{ group, open: false, at: rowTime }],
      next,
    },
  };
}

function envelope(subject: string, group: string, next: string | null = null): ExposureReaderEnvelope {
  return { page: readyPage(group, next), sessionSubject: subject };
}

function openEnvelope(subject: string, group: string): ExposureReaderEnvelope {
  const page = readyPage(group);
  if (page.status !== 'ready' || page.current.status !== 'available') throw new Error('Expected a ready fixture');
  return {
    sessionSubject: subject,
    page: {
      ...page,
      current: {
        ...page.current,
        exposureGroups: page.current.exposureGroups.map((row) => ({ ...row, open: true })),
      },
    },
  };
}

function signedIn(subject: string, csrfToken: string | null) {
  return { state: 'signed-in' as const, subject, csrfToken };
}

function setInitial(subject: string, group: string, next: string | null = null) {
  loaderEnvelope = envelope(subject, group, next);
  loaderReads.length = 0;
  readCalls.length = 0;
  changeCalls.length = 0;
  refreshLoader = false;
}

function createClient(session: ReturnType<typeof signedIn> | { state: 'signed-out'; subject: null; csrfToken: null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  return client;
}

async function replaceSession(client: QueryClientType, session: unknown) {
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, session as never);
    await Promise.resolve();
  });
}

function createApp(client: InstanceType<typeof QueryClient>, router: ReturnType<typeof createRouter>) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(StrictMode, null, createElement(RouterProvider, { router })),
  );
}

function makeRouter(client: InstanceType<typeof QueryClient>) {
  const root = createRootRouteWithContext<{ queryClient: InstanceType<typeof QueryClient> }>()({ component: Outlet });
  const exposureRoute = Route.update({
    id: '/platform/exposure',
    path: '/platform/exposure',
    getParentRoute: () => root,
  } as never);
  return createRouter({
    routeTree: root.addChildren([exposureRoute]),
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ['/platform/exposure'] }),
  });
}

function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function actionButton(container: HTMLElement, action: 'open' | 'close', group = 'collections') {
  const result = [...container.querySelectorAll('button')].find((item) => {
    const label = item.getAttribute('aria-label')?.toLowerCase() ?? '';
    return label.includes(group) && label.includes(action);
  });
  if (!result) throw new Error(`Missing ${action} action for ${group}`);
  return result;
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function resolveRead(index: number, value: ExposureReaderEnvelope) {
  const call = readCalls[index]!;
  await act(async () => {
    call.result.resolve(value);
    await call.result.promise;
    await Promise.resolve();
  });
}

async function resolveChange(index: number, value: Outcome) {
  const call = changeCalls[index]!;
  await act(async () => {
    call.result.resolve(value);
    await call.result.promise;
    await Promise.resolve();
  });
}

test('production route and page retire reader-bound work without losing same-owner rows or original command custody', async () => {
  setInitial(subjectA, 'collections');
  const originalClient = createClient(signedIn(subjectA, null));
  const router = makeRouter(originalClient);
  await router.load();
  expect(loaderReads).toEqual([{}]);

  let providerClient = originalClient;
  const app = () => createApp(providerClient, router);
  const serverHtml = renderToString(app());
  expect(serverHtml).toContain('collections');
  const serverHost = window.document.createElement('div');
  serverHost.innerHTML = serverHtml;
  expect(actionButton(serverHost, 'open').disabled).toBe(true);

  const container = window.document.createElement('main');
  window.document.body.append(container);
  let root = createRoot(container);
  await act(async () => root.render(app()));
  expect(container.textContent).toContain('collections');
  expect(container.textContent).toContain(m.exposure_state_closed());
  expect(actionButton(container, 'open').disabled).toBe(true);

  // Ordinary query notifications and route IO closure allocation do not retire the connected reader.
  await act(async () => {
    await originalClient.invalidateQueries({ queryKey: sessionQuery.queryKey, exact: true, refetchType: 'none' });
    root.render(app());
  });
  expect(container.textContent).toContain('collections');
  expect(actionButton(container, 'open').disabled).toBe(true);

  // Replacing the route's initial loader result replaces its Page even without a new component mount.
  await replaceSession(originalClient, signedIn(subjectA, null));
  loaderEnvelope = openEnvelope(subjectA, 'collections');
  refreshLoader = true;
  await act(async () => {
    await router.invalidate();
    await Promise.resolve();
  });
  expect(container.textContent).toContain(m.exposure_state_open());

  // Even an equal successful session replacement retires the outstanding read ticket.
  await click(button(container, m.exposure_reload()));
  expect(readCalls).toHaveLength(1);
  await replaceSession(originalClient, signedIn(subjectA, null));
  await resolveRead(0, envelope(subjectA, 'search'));
  expect(container.textContent).toContain('collections');
  expect(container.textContent).not.toContain('search');
  expect(actionButton(container, 'open').disabled).toBe(true);
  expect(changeCalls).toHaveLength(0);

  // A healthy same-subject read remains useful when the session has no CSRF token.
  await replaceSession(originalClient, signedIn(subjectA, 'csrf-one'));
  expect(actionButton(container, 'open').disabled).toBe(false);

  // Confirm freezes the first CSRF token and operation. Reload keeps its uncertain custody;
  // explicit retry resends the exact same operation and token.
  await click(actionButton(container, 'open'));
  await click(button(container, m.exposure_confirm()));
  expect(changeCalls).toHaveLength(1);
  expect(changeCalls[0]!.csrfToken).toBe('csrf-one');
  const originalIntent = changeCalls[0]!.operation;
  await resolveChange(0, {
    status: 'uncertain',
    operation: originalIntent,
    current: readyPage('collections', 'retry-cursor'),
  });
  expect(container.textContent).toContain(m.exposure_uncertain());

  // Same-owner paging keeps the unresolved intent and the original readback query for retry.
  await click(button(container, m.exposure_next_page()));
  expect(readCalls).toHaveLength(2);
  expect(readCalls[1]!.query).toEqual({ cursor: 'retry-cursor', limit: 20 });
  await resolveRead(1, envelope(subjectA, 'collections'));
  expect(container.textContent).toContain(m.exposure_retry());

  await click(button(container, m.exposure_reload()));
  expect(readCalls).toHaveLength(3);
  await resolveRead(2, envelope(subjectA, 'collections'));
  expect(container.textContent).toContain(m.exposure_retry());
  await click(button(container, m.exposure_retry()));
  expect(changeCalls).toHaveLength(2);
  expect(changeCalls[1]!.operation).toBe(originalIntent);
  expect(changeCalls[1]!.query).toEqual(changeCalls[0]!.query);
  expect(changeCalls[1]!.csrfToken).toBe('csrf-one');

  // A same-subject committed replacement keeps healthy rows but retires the old retry.
  // A new command gets the new token; the old catch cannot release its busy state.
  await replaceSession(originalClient, signedIn(subjectA, 'csrf-two'));
  expect(container.textContent).toContain('collections');
  expect(container.textContent).not.toContain(m.exposure_retry());
  await click(actionButton(container, 'close'));
  await click(button(container, m.exposure_confirm()));
  expect(changeCalls).toHaveLength(3);
  expect(changeCalls[2]!.csrfToken).toBe('csrf-two');
  changeCalls[1]!.result.reject(new Error('retired response lost'));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(button(container, m.exposure_confirm()).disabled).toBe(true);
  await resolveChange(2, { status: 'not-sent', current: readyPage('collections') });

  // A recorded response from a retired owner stays historical and cannot replace a fresh reader's page.
  await click(actionButton(container, 'open'));
  await click(button(container, m.exposure_confirm()));
  expect(changeCalls).toHaveLength(4);

  // Subject changes, sign-out, retained-data error and removal all hide old private rows.
  await replaceSession(originalClient, signedIn(subjectB, 'csrf-b'));
  expect(container.textContent).not.toContain('collections');
  await click(button(container, m.exposure_reload()));
  expect(readCalls).toHaveLength(4);
  await resolveRead(3, envelope(subjectB, 'search'));
  expect(container.textContent).toContain('search');
  await resolveChange(3, {
    status: 'recorded',
    operation: changeCalls[3]!.operation,
    receipt: { group: 'collections', open: true, changed: true },
    current: readyPage('late'),
  });
  expect(container.textContent).toContain('search');
  expect(container.textContent).not.toContain('late');
  expect(container.textContent).not.toContain(m.exposure_recorded());

  await replaceSession(originalClient, signedIn(subjectA, 'csrf-a2'));
  expect(container.textContent).not.toContain('search');
  await click(button(container, m.exposure_reload()));
  await resolveRead(4, envelope(subjectA, 'collections'));
  expect(container.textContent).toContain('collections');

  await replaceSession(originalClient, { state: 'signed-out', subject: null, csrfToken: null });
  expect(container.textContent).not.toContain('collections');
  await replaceSession(originalClient, signedIn(subjectA, 'csrf-a3'));
  await click(button(container, m.exposure_reload()));
  await resolveRead(5, envelope(subjectA, 'collections'));
  expect(container.textContent).toContain('collections');

  const cachedSession = originalClient.getQueryData(sessionQuery.queryKey);
  await act(async () => {
    await originalClient
      .fetchQuery({
        queryKey: sessionQuery.queryKey,
        queryFn: async () => {
          throw new Error('retained session data is not a current observation');
        },
        staleTime: 0,
        retry: false,
      })
      .catch(() => undefined);
  });
  expect(originalClient.getQueryData(sessionQuery.queryKey)).toBe(cachedSession);
  expect(container.textContent).not.toContain('collections');
  await replaceSession(originalClient, signedIn(subjectA, 'csrf-a4'));
  await click(button(container, m.exposure_reload()));
  await resolveRead(6, envelope(subjectA, 'collections'));

  await act(async () => {
    originalClient.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain('collections');
  await replaceSession(originalClient, signedIn(subjectA, 'csrf-a5'));
  await click(button(container, m.exposure_reload()));
  await resolveRead(7, envelope(subjectA, 'collections'));

  // Replacing the provider changes the session source even when the loader envelope is unchanged.
  const replacementClient = createClient(signedIn(subjectB, 'csrf-provider'));
  providerClient = replacementClient;
  await act(async () => root.render(app()));
  expect(container.textContent).not.toContain('collections');
  await click(button(container, m.exposure_reload()));
  await resolveRead(8, envelope(subjectB, 'search'));
  expect(container.textContent).toContain('search');

  // A late rejection from a read whose page unmounted cannot publish into a later route visit.
  await click(button(container, m.exposure_reload()));
  expect(readCalls).toHaveLength(10);
  const lateRead = readCalls[9]!;
  await act(async () => root.unmount());
  await Promise.resolve();
  lateRead.result.reject(new Error('late unmounted read'));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  root = createRoot(container);
  await act(async () => root.render(app()));
  expect(container.textContent).not.toContain('late');
  expect(container.textContent).not.toContain('search');
  expect(container.textContent).toContain(m.exposure_current_unavailable());

  await act(async () => root.unmount());
});

test('an expired continuation can restart the same visit at its first-page limit', async () => {
  setInitial(subjectA, 'collections', 'expired-cursor');
  const client = createClient(signedIn(subjectA, null));
  const router = makeRouter(client);
  await router.load();
  const container = window.document.createElement('main');
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createApp(client, router)));

  await click(button(container, m.exposure_next_page()));
  expect(readCalls[0]!.query).toEqual({ cursor: 'expired-cursor', limit: 20 });
  await resolveRead(0, {
    page: { status: 'invalid-cursor', discovery: { status: 'available', groups: ['collections'] } },
    sessionSubject: subjectA,
  });
  expect(container.textContent).toContain(m.exposure_invalid_cursor());
  await click(button(container, m.exposure_first_page()));
  expect(readCalls[1]!.query).toEqual({ limit: 20 });
  await resolveRead(1, envelope(subjectA, 'collections'));
  expect(container.textContent).toContain(m.exposure_current_page());
  expect(container.textContent).not.toContain(m.exposure_invalid_cursor());

  await act(async () => root.unmount());
  container.remove();
});

afterAll(async () => {
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
