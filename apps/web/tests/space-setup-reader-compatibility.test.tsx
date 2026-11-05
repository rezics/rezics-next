import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, createElement, type ReactNode } from 'react';
import type { KernelClient } from '@rezics/client';
import type { SetupFailure, SetupSnapshot } from '../src/community/space-setup';
import type { SpaceSetupInitialAdmission } from '../src/community/space-setup-lifetime';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const id = (number: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(number).padStart(12, '0')}`;
const sessionId = 'A'.repeat(43);
const subject = id(1);
const replacementSubject = id(2);
const spaceId = id(3);
const realmId = id(4);
const contextId = id(5);
const schemeId = id(6);
const conceptId = id(7);
const csrf = 'A'.repeat(22);
let session = { subject, csrfToken: null as string | null, accessToken: 'server-only-bearer' };
let activeRequest = makeRequest();
let sessionPreparations = 0;
let failSpaceCreate = 0;
let failNextSpaceRead = false;
let currentSpace: Record<string, unknown> | null = null;
let contextDirectoryDeferred: { promise: Promise<unknown>; resolve(value: unknown): void } | null = null;
const preparedAuthorizations: string[] = [];
const spaceWrites: { body: unknown; key: string | null }[] = [];
const spaceReads: string[] = [];
const contextExactReads: string[] = [];
const contextDirectoryReads: { query: Record<string, unknown>; authorization: string }[] = [];
const schemeReads: { body: Record<string, unknown>; authorization: string }[] = [];
const conceptReads: { query: Record<string, unknown>; authorization: string }[] = [];

function makeRequest(method: 'GET' | 'POST' = 'GET', extra: Record<string, string> = {}) {
  const headers = new Headers({ cookie: `__Host-rezics_session=${sessionId}` });
  if (method === 'POST') headers.set('origin', 'https://site.test');
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Request('https://site.test/en/realms/new', { method, headers });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const sessionStore = {
  async credential() {
    sessionPreparations++;
    return {
      status: 'active',
      accessToken: session.accessToken,
      subject: session.subject,
      csrfToken: session.csrfToken,
    };
  },
  async credentialIfFresh() {
    sessionPreparations++;
    return {
      status: 'active',
      accessToken: session.accessToken,
      subject: session.subject,
      csrfToken: session.csrfToken,
    };
  },
  async signedIn() {
    return { signedIn: true, csrfToken: session.csrfToken };
  },
};
const sessionNamespace = {
  idFromName: () => 'session-id',
  get: () => sessionStore,
};
const env = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://api.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'site',
  WEBSITE_CLIENT_KEY: 'configured-test-key',
  SESSIONS: sessionNamespace,
};

function response<T>(data: T, status = 200) {
  return { data, error: null, status };
}
function failure(status: number) {
  return { data: null, error: new Error(`status ${status}`), status };
}

function makeKernelClient() {
  const spaces = Object.assign(
    () => ({
      get: async (options: { headers: { authorization: string } }) => {
        preparedAuthorizations.push(options.headers.authorization);
        spaceReads.push(options.headers.authorization);
        if (failNextSpaceRead) {
          failNextSpaceRead = false;
          return failure(503);
        }
        return currentSpace ? response({ space: currentSpace }) : failure(404);
      },
      address: {
        put: async () => response({ space: currentSpace ?? {} }, 200),
      },
    }),
    {
      post: async (body: unknown, options: { headers: Record<string, string> }) => {
        spaceWrites.push({ body, key: options.headers['idempotency-key'] ?? null });
        if (failSpaceCreate > 0) {
          failSpaceCreate--;
          return failure(503);
        }
        currentSpace = {
          spaceId,
          headRevisionId: id(8),
          title: (body as { title: string }).title,
          summary: (body as { summary: string }).summary,
          address: null,
          realmId: null,
        };
        return response({ space: currentSpace }, 201);
      },
    },
  );
  const realms = Object.assign(
    () => ({
      get: async (options: { headers: { authorization: string } }) => {
        preparedAuthorizations.push(options.headers.authorization);
        return response({
          realm: {
            realmId,
            headRevisionId: id(9),
            title: 'Saved Realm',
            summary: '',
            visibility: 'public',
            contextId,
            boardSchemeId: schemeId,
          },
        });
      },
      patch: async () => failure(503),
      boardScheme: { put: async () => failure(503) },
      boards: { post: async () => failure(503) },
    }),
    {
      post: async () => failure(503),
    },
  );
  const contexts = Object.assign(
    (input: { id: string }) => ({
      get: async (options: { headers: { authorization: string } }) => {
        preparedAuthorizations.push(options.headers.authorization);
        contextExactReads.push(input.id);
        return response({
          context: {
            id: input.id,
            kind: 'community',
            labels: { en: 'Reading Context' },
            state: 'active',
            deletedAt: null,
            purgeAfter: null,
            settings: null,
            defaults: {},
          },
        });
      },
    }),
    {
      get: async (options: { query: Record<string, unknown>; headers: { authorization: string } }) => {
        preparedAuthorizations.push(options.headers.authorization);
        contextDirectoryReads.push({ query: options.query, authorization: options.headers.authorization });
        if (contextDirectoryDeferred) return contextDirectoryDeferred.promise;
        return response({
          contexts: [
            {
              id: contextId,
              kind: 'community',
              labels: { en: 'Reading Context' },
              state: 'active',
              deletedAt: null,
              purgeAfter: null,
            },
          ],
          next: options.query.cursor ? null : 'context-next',
        });
      },
    },
  );
  const subjects = Object.assign(
    (input: { id: string }) => ({
      get: async (options: { headers: { authorization: string } }) => {
        preparedAuthorizations.push(options.headers.authorization);
        return response({
          subject: { id: input.id, type: 'skos:Concept', labels: { en: 'Exact Concept' } },
          summary: null,
        });
      },
      links: {
        get: async (options: { query: Record<string, unknown>; headers: { authorization: string } }) => {
          preparedAuthorizations.push(options.headers.authorization);
          conceptReads.push({ query: options.query, authorization: options.headers.authorization });
          return response({
            links: [
              {
                property: 'skos:inScheme',
                type: 'skos:Concept',
                subject: conceptId,
                label: 'Drawing',
                summary: { type: 'skos:Concept', id: conceptId, label: { value: 'Drawing' } },
              },
            ],
            next: options.query.cursor ? null : 'concept-next',
            freshness: { as_of: '2026-11-02T00:00:00Z', stale: false },
          });
        },
      },
    }),
    {
      $search: {
        post: async (body: Record<string, unknown>, options: { headers: { authorization: string } }) => {
          preparedAuthorizations.push(options.headers.authorization);
          schemeReads.push({ body, authorization: options.headers.authorization });
          return response({
            subjects: [
              {
                id: schemeId,
                type: 'skos:ConceptScheme',
                labels: { en: 'Art Scheme' },
                base: { title: { value: 'Art Scheme' } },
                summary: null,
              },
            ],
            next: body.cursor ? null : 'scheme-next',
            as_of: '2026-11-02T00:00:00Z',
          });
        },
      },
    },
  );
  return {
    spaces,
    realms,
    contexts,
    subjects,
    viewerActions: {
      post: async (body: { resources: readonly { id: string }[] }, options: { headers: { authorization: string } }) => {
        preparedAuthorizations.push(options.headers.authorization);
        return response({
          resources: body.resources.map(({ id: resourceId }) => ({
            id: resourceId,
            viewerActions: [
              { operations: ['space_address.change', 'realm.update', 'realm.board_scheme', 'board.create'] },
            ],
          })),
        });
      },
    },
  } as unknown as KernelClient;
}

let kernel = makeKernelClient();
const storyStart = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => ({
  ...storyStart,
  createServerFn: () => {
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(fn: (input: unknown) => unknown) {
        validate = fn;
        return chain;
      },
      handler(fn: (args: { data: unknown }) => unknown) {
        return async (input: { data: unknown; headers?: HeadersInit }) => {
          const headers = input.headers ? new Headers(input.headers) : new Headers();
          const hasCsrf = headers.has('X-CSRF-Token');
          activeRequest = makeRequest(hasCsrf ? 'POST' : 'GET', Object.fromEntries(headers.entries()));
          const data = validate ? validate(input.data) : input.data;
          return await fn({ data });
        };
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...storyStart,
  getRequest: () => activeRequest,
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({ env }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => kernel, requestLocale: () => 'en' }));
mock.module('../src/kernel/languages', () => ({ requestLanguages: () => ['en'] }));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, dehydrate, hydrate } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const actions = await import('../src/community/space-actions');
const { Route } = await import('../src/routes/realms/new');
const { SpaceSetupEntry, SpaceSetupPage } = await import('../src/community/space-setup-page');
const { spaceSetupSessionSource } = await import('../src/community/space-setup-lifetime');
const { m } = await import('../src/paraglide/messages.js');

const routeLoader = Route.options.loader as unknown as (input: {
  context: { queryClient: InstanceType<typeof QueryClient> };
  deps: { spaceId?: string };
}) => Promise<{ initial: SetupSnapshot | SetupFailure; admission: SpaceSetupInitialAdmission }>;
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let browserClient: InstanceType<typeof QueryClient> | undefined;

function signedInRecord(csrfToken = session.csrfToken) {
  return { state: 'signed-in', subject: session.subject, csrfToken };
}

function reset() {
  session = { subject, csrfToken: null, accessToken: 'server-only-bearer' };
  activeRequest = makeRequest();
  sessionPreparations = 0;
  failSpaceCreate = 0;
  failNextSpaceRead = false;
  currentSpace = {
    spaceId,
    headRevisionId: id(10),
    title: 'Saved Space',
    summary: '',
    address: 'saved-space',
    realmId,
  };
  contextDirectoryDeferred = null;
  preparedAuthorizations.length = 0;
  spaceWrites.length = 0;
  spaceReads.length = 0;
  contextExactReads.length = 0;
  contextDirectoryReads.length = 0;
  schemeReads.length = 0;
  conceptReads.length = 0;
  kernel = makeKernelClient();
}

async function tick(milliseconds = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

async function mountApp(client: InstanceType<typeof QueryClient>, content: ReactNode, strict = true) {
  browserClient = client;
  const route = createRootRoute({ component: () => content });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/realms/new'] }),
  });
  await router.load();
  root = createRoot(host);
  await act(async () => {
    root!.render(
      strict ? (
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </StrictMode>
      ) : (
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function unmountApp() {
  if (root) {
    await act(async () => {
      root!.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  root = undefined;
  browserClient?.clear();
  browserClient = undefined;
}

function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      input instanceof window.HTMLInputElement
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function loaderData(queryClient: InstanceType<typeof QueryClient>, deps: { spaceId?: string }) {
  activeRequest = makeRequest();
  return routeLoader({ context: { queryClient }, deps });
}

afterEach(unmountApp);
beforeEach(reset);
afterAll(async () => {
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('production route admission survives JSON and independent QueryClient hydration while read-only pages continue through bounded choices', async () => {
  session = { subject, csrfToken: null, accessToken: 'server-only-bearer' };
  const serverClient = new QueryClient();
  const originalSession = signedInRecord(null);
  serverClient.setQueryData(sessionQuery.queryKey, originalSession);

  const loader = await loaderData(serverClient, { spaceId });
  expect(loader.initial.kind).toBe('ready');
  if (loader.initial.kind !== 'ready') throw new Error('Expected the original Space read');
  expect(loader.initial.reader).toEqual({ kind: 'session', subject });
  expect(loader.admission).toMatchObject({
    state: 'signed-in',
    subject,
    csrfAvailable: false,
    queryStatus: 'success',
    observationScope: 'query-client-local',
  });
  expect(sessionPreparations).toBe(1);
  expect(spaceReads).toHaveLength(1);
  expect(preparedAuthorizations[0]).toBe('Bearer server-only-bearer');

  const loaderJson = JSON.stringify(loader);
  expect(loaderJson).not.toContain('server-only-bearer');
  expect(loaderJson).not.toContain(csrf);
  const transferred = JSON.parse(loaderJson) as typeof loader;
  const browserClient = new QueryClient();
  hydrate(browserClient, JSON.parse(JSON.stringify(dehydrate(serverClient))));

  await mountApp(
    browserClient,
    <>
      <SpaceSetupPage initial={transferred.initial} admission={transferred.admission} spaceId={spaceId} />
      <SpaceSetupEntry spaceId={spaceId} />
    </>,
  );
  await tick(20);
  expect(host.textContent).toContain('Saved Space');
  expect(host.textContent).toContain('Saved Realm');
  expect(host.textContent).toContain(m.space_setup_entry());
  expect(contextExactReads).toContain(contextId);
  expect([...host.querySelectorAll<HTMLInputElement>('input')].some((input) => input.disabled)).toBe(true);
  expect(spaceWrites).toHaveLength(0);

  await click(m.space_setup_realm());
  const contextSearch = host.querySelector<HTMLInputElement>('input[type="search"]');
  expect(contextSearch).not.toBeNull();
  await act(async () => {
    contextSearch!.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(contextDirectoryReads).toHaveLength(1);
  expect(contextDirectoryReads[0]!.query.limit).toBe(20);
  await click(m.setup_context_next());
  expect(contextDirectoryReads).toHaveLength(2);
  expect(contextDirectoryReads[1]!.query.cursor).toBe('context-next');

  await click(m.space_setup_scheme());
  await tick(280);
  expect(schemeReads).toHaveLength(1);
  expect(schemeReads[0]!.body.limit).toBe(20);
  await click(m.space_setup_board_choice_next());
  expect(schemeReads).toHaveLength(2);
  expect(schemeReads[1]!.body.cursor).toBe('scheme-next');

  await click(m.space_setup_board());
  await tick(280);
  expect(conceptReads).toHaveLength(1);
  expect(conceptReads[0]!.query.limit).toBe(20);
  await click(m.space_setup_board_choice_next());
  expect(conceptReads).toHaveLength(2);
  expect(conceptReads[1]!.query.cursor).toBe('concept-next');
  expect(spaceWrites).toHaveLength(0);
});

test('actual-reader mismatch and explicit credentials stay unbound through the production route and choice wrappers', async () => {
  const expectedClient = new QueryClient();
  expectedClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject, csrfToken: null });
  session = { subject: replacementSubject, csrfToken: null, accessToken: 'different-server-bearer' };
  currentSpace = {
    spaceId,
    headRevisionId: id(10),
    title: 'Different reader Space',
    summary: '',
    address: 'different-reader',
    realmId,
  };
  const mismatched = await loaderData(expectedClient, { spaceId });
  expect(mismatched.initial.reader).toEqual({ kind: 'session', subject: replacementSubject });
  expect(mismatched.admission.subject).toBe(subject);
  expect(JSON.stringify(mismatched)).not.toContain('different-server-bearer');
  await mountApp(
    expectedClient,
    <SpaceSetupPage initial={mismatched.initial} admission={mismatched.admission} spaceId={spaceId} />,
  );
  expect(host.textContent).not.toContain('Different reader Space');
  await unmountApp();

  const matchingClient = new QueryClient();
  matchingClient.setQueryData(sessionQuery.queryKey, signedInRecord(null));
  const matching = await loaderData(matchingClient, { spaceId });
  if (matching.initial.kind !== 'ready') throw new Error('Expected the matching Space read');
  const missingOrigin = { ...matching.initial };
  delete missingOrigin.reader;
  await mountApp(
    matchingClient,
    <SpaceSetupPage initial={missingOrigin} admission={matching.admission} spaceId={spaceId} />,
  );
  expect(host.textContent).not.toContain('Saved Space');
  await unmountApp();

  const credentialsBeforeExplicitRead = sessionPreparations;
  const explicit = await actions.readSpaceSetup({
    data: { spaceId },
    headers: { authorization: 'Bearer explicit-reader' },
  });
  expect(explicit.reader).toEqual({ kind: 'unbound' });
  expect(sessionPreparations).toBe(credentialsBeforeExplicitRead);
  expect(preparedAuthorizations.at(-1)).toBe('Bearer explicit-reader');

  activeRequest = makeRequest();
  const choice = await actions.resolveSpaceSetupChoice({ data: { kind: 'context', id: contextId } });
  expect(choice.reader).toEqual({ kind: 'session', subject: replacementSubject });
  const directory = await actions.searchSpaceSetupContexts({ data: { query: '', cursor: 'context-next' } });
  expect(directory.reader).toEqual({ kind: 'session', subject: replacementSubject });
  expect(contextDirectoryReads.at(-1)?.query.cursor).toBe('context-next');
  const board = await actions.readSpaceSetupBoardChoices({
    data: { kind: 'concept', query: '', schemeId, cursor: 'concept-next', locale: 'en' },
  });
  expect(board.reader).toEqual({ kind: 'session', subject: replacementSubject });
  expect(conceptReads.at(-1)?.query.cursor).toBe('concept-next');
});

test('session observation retires pending Context work on equal replacement, error, removal and observed ABA while fetch events and replay stay healthy', async () => {
  const serverClient = new QueryClient();
  const initialRecord = signedInRecord(null);
  serverClient.setQueryData(sessionQuery.queryKey, initialRecord);
  const loader = await loaderData(serverClient, { spaceId });
  const browser = new QueryClient();
  hydrate(browser, JSON.parse(JSON.stringify(dehydrate(serverClient))));
  const transferred = JSON.parse(JSON.stringify(loader)) as typeof loader;
  const pending = deferred<unknown>();
  contextDirectoryDeferred = pending;
  await mountApp(
    browser,
    <SpaceSetupPage initial={transferred.initial} admission={transferred.admission} spaceId={spaceId} />,
  );

  const source = spaceSetupSessionSource(browser);
  const query = browser.getQueryCache().find({ queryKey: sessionQuery.queryKey })!;
  const initialRevision = source.snapshot();
  await tick();
  expect(source.snapshot()).toBe(initialRevision);
  query.setState({ fetchStatus: 'fetching' });
  query.setState({ fetchStatus: 'idle' });
  expect(source.snapshot()).toBe(initialRevision);

  await click(m.space_setup_realm());
  const search = host.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search).not.toBeNull();
  await act(async () => {
    search!.focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(contextDirectoryReads).toHaveLength(1);
  browser.setQueryData(sessionQuery.queryKey, initialRecord);
  const replacedRevision = source.snapshot();
  expect(replacedRevision).toBeGreaterThan(initialRevision);
  pending.resolve(
    response({
      contexts: [
        {
          id: contextId,
          kind: 'community',
          labels: { en: 'Retired Context result' },
          state: 'active',
          deletedAt: null,
          purgeAfter: null,
        },
      ],
      next: null,
    }),
  );
  await tick();
  expect(host.textContent).not.toContain('Retired Context result');
  expect(contextDirectoryReads).toHaveLength(1);

  query.setState({
    status: 'error',
    error: new Error('retained session read failed'),
    errorUpdatedAt: Date.now(),
    errorUpdateCount: 1,
  });
  const errorRevision = source.snapshot();
  expect(errorRevision).toBeGreaterThan(replacedRevision);
  expect(source.observation().status).toBe('error');
  expect(source.read()).toEqual(initialRecord);

  browser.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
  const removedRevision = source.snapshot();
  expect(removedRevision).toBeGreaterThan(errorRevision);
  expect(source.observation().status).toBe('missing');

  browser.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const awayRevision = source.snapshot();
  browser.setQueryData(sessionQuery.queryKey, initialRecord);
  expect(source.snapshot()).toBeGreaterThan(awayRevision);
  expect(source.snapshot()).toBeGreaterThan(removedRevision);
  expect(contextDirectoryReads).toHaveLength(1);
});

test('an accepted creation keeps its immutable uncertain retry and returned identity when the bounded follow-up read fails', async () => {
  session = { subject, csrfToken: csrf, accessToken: 'server-only-bearer' };
  currentSpace = null;
  failSpaceCreate = 1;
  const serverClient = new QueryClient();
  serverClient.setQueryData(sessionQuery.queryKey, signedInRecord(csrf));
  const loader = await loaderData(serverClient, {});
  const loaderJson = JSON.stringify(loader);
  expect(loaderJson).not.toContain(csrf);
  expect(loaderJson).not.toContain('server-only-bearer');
  const transferred = JSON.parse(loaderJson) as typeof loader;
  const browser = new QueryClient();
  hydrate(browser, JSON.parse(JSON.stringify(dehydrate(serverClient))));
  await mountApp(browser, <SpaceSetupPage initial={transferred.initial} admission={transferred.admission} />);

  const title = host.querySelector<HTMLInputElement>('input');
  expect(title).not.toBeNull();
  await edit(title!, 'Connected creation title');
  const form = host.querySelector('form');
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(spaceWrites).toHaveLength(1);
  const first = spaceWrites[0]!;
  expect(first.key).not.toBeNull();
  expect(host.textContent).toContain(m.space_setup_retry());

  failNextSpaceRead = true;
  await click(m.space_setup_retry());
  expect(spaceWrites).toHaveLength(2);
  expect(spaceWrites[1]).toEqual(first);
  expect(host.textContent).toContain('Connected creation title');
  expect(host.textContent).toContain(m.space_setup_unavailable());
  expect(spaceReads).toHaveLength(1);
});

test('a queued Context read and a late response cannot publish after caller retirement or final unmount', async () => {
  const serverClient = new QueryClient();
  serverClient.setQueryData(sessionQuery.queryKey, signedInRecord(null));
  const loader = await loaderData(serverClient, { spaceId });
  const transferred = JSON.parse(JSON.stringify(loader)) as typeof loader;
  const browser = new QueryClient();
  hydrate(browser, JSON.parse(JSON.stringify(dehydrate(serverClient))));
  const pending = deferred<unknown>();
  contextDirectoryDeferred = pending;
  await mountApp(
    browser,
    <SpaceSetupPage initial={transferred.initial} admission={transferred.admission} spaceId={spaceId} />,
  );
  await click(m.space_setup_realm());
  const search = host.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search).not.toBeNull();
  await act(async () => {
    search!.focus();
    browser.setQueryData(sessionQuery.queryKey, signedInRecord(null));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(contextDirectoryReads).toHaveLength(0);
  expect(host.textContent).not.toContain('Saved Realm');
  await unmountApp();

  contextDirectoryDeferred = pending;
  const anotherServerClient = new QueryClient();
  anotherServerClient.setQueryData(sessionQuery.queryKey, signedInRecord(null));
  const anotherLoader = await loaderData(anotherServerClient, { spaceId });
  const anotherBrowser = new QueryClient();
  hydrate(anotherBrowser, JSON.parse(JSON.stringify(dehydrate(anotherServerClient))));
  await mountApp(
    anotherBrowser,
    <SpaceSetupPage
      initial={JSON.parse(JSON.stringify(anotherLoader.initial))}
      admission={JSON.parse(JSON.stringify(anotherLoader.admission))}
      spaceId={spaceId}
    />,
  );
  await click(m.space_setup_realm());
  const secondSearch = host.querySelector<HTMLInputElement>('input[type="search"]');
  expect(secondSearch).not.toBeNull();
  await act(async () => {
    secondSearch!.focus();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(contextDirectoryReads).toHaveLength(1);
  await unmountApp();
  pending.resolve(
    response({
      contexts: [
        {
          id: contextId,
          kind: 'community',
          labels: { en: 'Unmounted Context result' },
          state: 'active',
          deletedAt: null,
          purgeAfter: null,
        },
      ],
      next: null,
    }),
  );
  await tick();
  expect(host.textContent).not.toContain('Unmounted Context result');
});
