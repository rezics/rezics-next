import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import preferenceRecording from '../src/kernel/recorded/settings-preferences.json';

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

const alice = 'reader-a';
const bob = 'reader-b';
const ids = new Map([
  [alice, 'a'.repeat(43)],
  [bob, 'b'.repeat(43)],
]);
const readers = new Map([...ids].map(([reader, id]) => [id, reader]));
let sessionReader: string | null = null;
let bffReader: string | null = null;
let currentRequest = new Request('https://rezics.test/en/@alice');
let nextSessionGate: { entered: Deferred<void>; release: Deferred<void> } | undefined;
let failNextAgentAction = false;
let failNextSessionAction = false;
let nextAgentActionGate: { entered: Deferred<void>; release: Deferred<unknown> } | undefined;

type PreferenceResult = {
  status: number;
  data?: unknown;
  error?: unknown;
  headers: Headers;
};

const nativeReads: Array<{
  accountId: string;
  authorization?: string;
  work: Deferred<PreferenceResult>;
}> = [];
const readerEnvelopes: Array<Record<string, unknown>> = [];

function requestFor(reader: string | null): Request {
  const id = reader ? ids.get(reader) : undefined;
  return new Request('https://rezics.test/en/_server/agent-reader', {
    headers: id ? { cookie: `__Host-rezics_session=${id}` } : undefined,
  });
}

const env = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://api.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'website',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      signedIn: async () => {
        const subject = readers.get(id);
        return { signedIn: Boolean(subject), ...(subject ? { subject } : {}), csrfToken: null };
      },
      credential: async () => {
        const subject = readers.get(id);
        return subject
          ? { status: 'active' as const, subject, accessToken: `${subject}-access-token`, csrfToken: null }
          : { status: 'absent' as const };
      },
    }),
  },
};

function createServerFn() {
  let validate: ((input: unknown) => unknown) | undefined;
  const chain = {
    validator(next: (input: unknown) => unknown) {
      validate = next;
      return chain;
    },
    handler(handler: (input: { data?: unknown }) => unknown) {
      return async (input: { data?: unknown } = {}) => {
        const data = validate ? validate(input.data) : input.data;
        const isAgentReader = !!data && typeof data === 'object' && 'expectedReader' in data;
        if (isAgentReader) {
          readerEnvelopes.push(data as Record<string, unknown>);
          if (failNextAgentAction) {
            failNextAgentAction = false;
            return Promise.reject(new Error('Reader BFF unavailable'));
          }
        } else if (failNextSessionAction) {
          failNextSessionAction = false;
          return Promise.reject(new Error('Session unavailable'));
        }
        const gate = !isAgentReader ? nextSessionGate : undefined;
        if (gate) {
          nextSessionGate = undefined;
          gate.entered.resolve(undefined);
          await gate.release.promise;
        }
        currentRequest = requestFor(isAgentReader ? bffReader : sessionReader);
        const response = await handler({ data });
        if (isAgentReader && nextAgentActionGate) {
          const actionGate = nextAgentActionGate;
          nextAgentActionGate = undefined;
          actionGate.entered.resolve(undefined);
          return actionGate.release.promise;
        }
        return response;
      };
    },
  };
  return chain;
}

mock.module('@tanstack/react-start', () => ({ ...start, createServerFn }));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({ env }));
// The only native boundary is the existing own-account preferences GET. Session preparation,
// its same-request account provenance, the query, and the mounted observer remain real.
mock.module('../src/kernel/client', () => ({
  requestLocale: () => 'en',
  acceptLanguage: (locale: string) => locale,
  preparePrivatePage: () => {},
  hasKernelOrigin: () => false,
  configuredKernelOrigin: () => undefined,
  kernelClient: () => ({
    accounts: ({ accountId }: { accountId: string }) => ({
      preferences: {
        get: (options?: { headers?: { authorization?: string } }) => {
          const work = deferred<PreferenceResult>();
          nativeReads.push({ accountId, authorization: options?.headers?.authorization, work });
          return work.promise;
        },
      },
    }),
  }),
}));

function installWindow(window: InstanceType<typeof import('happy-dom').Window>) {
  const values = {
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
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function markCoversWithheld(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) markCoversWithheld(entry);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'cover' && typeof entry === 'object' && entry !== null && 'media' in entry && 'variants' in entry)
      (entry as { withheld?: 'suitability' }).withheld = 'suitability';
    markCoversWithheld(entry);
  }
}

function result(suitability: 'blur' | 'show'): PreferenceResult {
  return {
    status: 200,
    data: {
      ...structuredClone(preferenceRecording),
      spoilerLevel: 0,
      suitability,
      reading: { ...preferenceRecording.reading, effective: { spoilerLevel: 0, suitability } },
    },
    headers: new Headers(),
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// One mounted reader and public-profile consumer regression spanning both account paths.
test('public account readers retire old admissions across sign-out, replacement, route changes and ABA', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/@alice' });
  const restoreGlobals = installWindow(window);
  const [
    { createRoot },
    { QueryClient, QueryClientProvider },
    sessionModule,
    queryModule,
    readerModule,
    subjectModule,
    fixtures,
    routeSupport,
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('../src/session/query'),
    import('../src/features/pages/agent-queries'),
    import('../src/features/pages/agent-reader'),
    import('../src/features/pages/subject'),
    import('../src/stories/pages/accounts-public-profile/fixtures'),
    import('../src/features/pages/route-support'),
  ]);

  const page = fixtures.profilePage({ verified: true });
  markCoversWithheld(page.reads);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const serverClient = new QueryClient();
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });
    const serverMarkup = await import('react-dom/server').then(({ renderToString }) =>
      renderToString(
        createElement(
          QueryClientProvider,
          { client: serverClient },
          createElement(PublicReaderConsumer, {
            page,
            handle: 'alice',
            locale: 'en',
            path: { kind: 'overview' },
            useSession: sessionModule.useSession,
            useAgentReaderScope: readerModule.useAgentReaderScope,
            useAgentReaderResult: readerModule.useAgentReaderResult,
            agentReaderQuery: queryModule.agentReaderQuery,
            SubjectPage: subjectModule.SubjectPage,
            messages: routeSupport.subjectPageMessages,
          }),
        ),
      ),
    );
    expect(serverMarkup).toContain('data-slot="cover"');
    expect(serverMarkup).toContain('data-state="withheld"');
    expect(nativeReads).toHaveLength(0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const secondHost = window.document.createElement('div');
  window.document.body.append(secondHost);
  const secondRoot = createRoot(secondHost as unknown as HTMLElement);
  let secondRootMounted = true;
  type RenderProps = {
    handle?: string;
    locale?: string;
    path?: import('../src/features/pages/agent-reader').AgentReaderPath;
  };
  const renderInto = (targetRoot: typeof root, props: RenderProps, strict = false) => {
    const tree = createElement(
      QueryClientProvider,
      { client },
      createElement(PublicReaderConsumer, {
        page,
        handle: props.handle ?? 'alice',
        locale: props.locale ?? 'en',
        path: props.path ?? { kind: 'overview' },
        useSession: sessionModule.useSession,
        useAgentReaderScope: readerModule.useAgentReaderScope,
        useAgentReaderResult: readerModule.useAgentReaderResult,
        agentReaderQuery: queryModule.agentReaderQuery,
        SubjectPage: subjectModule.SubjectPage,
        messages: routeSupport.subjectPageMessages,
      }),
    );
    targetRoot.render(strict ? createElement(StrictMode, null, tree) : tree);
  };
  const render = (props: RenderProps) => renderInto(root, props);
  const isWithheld = (target: HTMLElement = host) =>
    target.querySelector('[data-slot="cover"][data-state="withheld"]') !== null;
  const expectSafeReader = (target: HTMLElement = host) => {
    expect(target.querySelector('[data-slot="cover"]')).not.toBeNull();
    expect(isWithheld(target)).toBe(true);
  };
  const expectAdmittedReader = (target: HTMLElement = host) => {
    expect(target.querySelector('[data-slot="cover"]')).not.toBeNull();
    expect(isWithheld(target)).toBe(false);
  };
  const setSession = async (subject: string | null) => {
    await act(async () => {
      client.setQueryData(sessionModule.sessionQuery.queryKey, {
        state: subject ? 'signed-in' : 'signed-out',
        subject,
        csrfToken: null,
      });
    });
  };
  const nextRead = async (count: number) => {
    for (let attempt = 0; attempt < 30 && nativeReads.length < count; attempt++) await settle();
    expect(nativeReads).toHaveLength(count);
    return nativeReads[count - 1]!;
  };
  const privateQueries = () => client.getQueryCache().findAll({ queryKey: ['agent-reader'] });
  const routeKey = (path: import('../src/features/pages/agent-reader').AgentReaderPath) =>
    JSON.stringify([path.kind, path.kind === 'view' ? path.view : null]);
  const privateKeyForRoute = (route: string) => privateQueries().find((query) => query.queryKey[3] === route)?.queryKey;

  const initialSession = { entered: deferred<void>(), release: deferred<void>() };
  nextSessionGate = initialSession;
  sessionReader = null;
  bffReader = null;
  try {
    await act(async () => render({}));
    await initialSession.entered.promise;
    expectSafeReader();
    expect(nativeReads).toHaveLength(0);
    initialSession.release.resolve();
    await settle();
    expectSafeReader();

    bffReader = alice;
    await setSession(alice);
    const signedOutSuccess = await nextRead(1);
    expect(signedOutSuccess.accountId).toBe(alice);
    expect(signedOutSuccess.authorization).toBe(`Bearer ${alice}-access-token`);
    expect(readerEnvelopes.at(-1)).toMatchObject({ expectedReader: alice });
    expectSafeReader();
    await setSession(null);
    expectSafeReader();
    signedOutSuccess.work.resolve(result('show'));
    await settle();
    expectSafeReader();

    bffReader = alice;
    await setSession(alice);
    const signedOutFailure = await nextRead(2);
    await setSession(null);
    expectSafeReader();
    signedOutFailure.work.resolve({ status: 503, error: { code: 'unavailable' }, headers: new Headers() });
    await settle();
    expectSafeReader();

    bffReader = alice;
    await setSession(alice);
    const replacedAlice = await nextRead(3);
    bffReader = bob;
    await setSession(bob);
    expectSafeReader();
    const currentBob = await nextRead(4);
    replacedAlice.work.resolve(result('show'));
    await settle();
    expectSafeReader();
    currentBob.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();

    bffReader = alice;
    await setSession(alice);
    const abaFirstAlice = await nextRead(5);
    bffReader = bob;
    await setSession(bob);
    expectSafeReader();
    const abaBobFailure = await nextRead(6);
    abaFirstAlice.work.resolve(result('show'));
    await settle();
    expectSafeReader();
    bffReader = alice;
    await setSession(alice);
    expectSafeReader();
    const abaCurrentAlice = await nextRead(7);
    abaBobFailure.work.resolve({ status: 503, error: { code: 'unavailable' }, headers: new Headers() });
    await settle();
    expectSafeReader();
    abaCurrentAlice.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();

    bffReader = bob;
    await act(async () => render({ path: { kind: 'view', view: 'posts' } }));
    expectSafeReader();
    const mismatchedView = await nextRead(8);
    expect(mismatchedView.accountId).toBe(bob);
    mismatchedView.work.resolve(result('show'));
    await settle();
    expectSafeReader();
    expect(readerEnvelopes.at(-1)).toMatchObject({ expectedReader: alice });

    failNextAgentAction = true;
    bffReader = alice;
    await act(async () => render({ path: { kind: 'view', view: 'reviews' } }));
    expectSafeReader();
    await settle();
    expect(nativeReads).toHaveLength(8);
    expectSafeReader();

    await act(async () => render({ path: { kind: 'view', view: 'collections' } }));
    expectSafeReader();
    const freshAfterError = await nextRead(9);
    expect(freshAfterError.accountId).toBe(alice);
    freshAfterError.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();

    await act(async () => render({ locale: 'fr', path: { kind: 'view', view: 'collections' } }));
    expectSafeReader();
    const freshLocale = await nextRead(10);
    freshLocale.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();

    await act(async () => render({ handle: 'alice-next', locale: 'fr', path: { kind: 'overview' } }));
    expectSafeReader();
    const freshHandle = await nextRead(11);
    freshHandle.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();

    await act(async () => render({ handle: 'alice-next', locale: 'fr', path: { kind: 'view', view: 'realms' } }));
    expectSafeReader();
    await settle();
    expect(nativeReads).toHaveLength(11);

    bffReader = alice;
    await act(async () => render({ path: { kind: 'overview' } }));
    const admittedOverview = await nextRead(12);
    admittedOverview.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();
    const retiredOverviewKey = privateKeyForRoute(routeKey({ kind: 'overview' }));
    expect(retiredOverviewKey).toBeDefined();

    const postsPath = { kind: 'view' as const, view: 'posts' };
    await act(async () => renderInto(secondRoot, { path: postsPath }, true));
    const delayedView = await nextRead(13);
    const retiredViewKey = privateKeyForRoute(routeKey(postsPath));
    expect(retiredViewKey).toBeDefined();
    expectAdmittedReader();
    expectSafeReader(secondHost);

    const retainedSession = client.getQueryData(sessionModule.sessionQuery.queryKey);
    failNextSessionAction = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: sessionModule.sessionQuery.queryKey, exact: true });
    });
    expect(client.getQueryState(sessionModule.sessionQuery.queryKey)?.status).toBe('error');
    expect(client.getQueryData(sessionModule.sessionQuery.queryKey)).toEqual(retainedSession);
    expectSafeReader();
    expectSafeReader(secondHost);
    await act(async () => {
      delayedView.work.resolve(result('show'));
      await Promise.resolve();
    });
    await settle();
    expectSafeReader();
    expectSafeReader(secondHost);
    expect(client.getQueryCache().find({ queryKey: retiredViewKey!, exact: true })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: retiredOverviewKey!, exact: true })).toBeUndefined();
    expect(nativeReads).toHaveLength(13);

    await setSession(alice);
    const recoveredOverview = await nextRead(14);
    const recoveredView = await nextRead(15);
    expect(recoveredOverview.accountId).toBe(alice);
    expect(recoveredView.accountId).toBe(alice);
    recoveredOverview.work.resolve(result('show'));
    recoveredView.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();
    expectAdmittedReader(secondHost);

    const reviewsPath = { kind: 'view' as const, view: 'reviews' };
    const delayedRemovalAction = { entered: deferred<void>(), release: deferred<unknown>() };
    nextAgentActionGate = delayedRemovalAction;
    await act(async () => renderInto(secondRoot, { path: reviewsPath }, true));
    const delayedRemoval = await nextRead(16);
    delayedRemoval.work.resolve(result('show'));
    await delayedRemovalAction.entered.promise;
    const removedViewKey = privateKeyForRoute(routeKey(reviewsPath));
    expect(removedViewKey).toBeDefined();
    expectAdmittedReader();
    expectSafeReader(secondHost);
    let observedSessionRemoval = false;
    const stopWatchingSession = client.getQueryCache().subscribe((event) => {
      if (event.type === 'removed' && event.query.queryKey.length === 1 && event.query.queryKey[0] === 'session')
        observedSessionRemoval = true;
    });
    await act(async () => {
      client.removeQueries({ queryKey: sessionModule.sessionQuery.queryKey, exact: true });
      client.setQueryData(sessionModule.sessionQuery.queryKey, {
        state: 'signed-in',
        subject: alice,
        csrfToken: null,
      });
    });
    stopWatchingSession();
    expect(observedSessionRemoval).toBe(true);
    expectSafeReader();
    expectSafeReader(secondHost);
    const recreatedOverview = await nextRead(17);
    const recreatedView = await nextRead(18);
    expect(recreatedOverview.accountId).toBe(alice);
    expect(recreatedView.accountId).toBe(alice);
    await act(async () => {
      delayedRemovalAction.release.reject(new Error('Retired preference action failed'));
      await Promise.resolve();
    });
    await settle();
    expectSafeReader();
    expectSafeReader(secondHost);
    expect(client.getQueryCache().find({ queryKey: removedViewKey!, exact: true })).toBeUndefined();
    expect(nativeReads).toHaveLength(18);
    recreatedOverview.work.resolve(result('show'));
    recreatedView.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();
    expectAdmittedReader(secondHost);

    await act(async () => renderInto(secondRoot, { path: postsPath }, true));
    const delayedAba = await nextRead(19);
    const abaRoute = routeKey(postsPath);
    const abaOldKey = privateKeyForRoute(abaRoute);
    expect(abaOldKey).toBeDefined();
    await act(async () => {
      client.setQueryData(sessionModule.sessionQuery.queryKey, {
        state: 'signed-in',
        subject: alice,
        csrfToken: null,
      });
      client.setQueryData(sessionModule.sessionQuery.queryKey, {
        state: 'signed-in',
        subject: bob,
        csrfToken: null,
      });
      client.setQueryData(sessionModule.sessionQuery.queryKey, {
        state: 'signed-in',
        subject: alice,
        csrfToken: null,
      });
      delayedAba.work.resolve(result('show'));
      await Promise.resolve();
    });
    expectSafeReader();
    expectSafeReader(secondHost);
    await settle();
    expect(client.getQueryCache().find({ queryKey: abaOldKey!, exact: true })).toBeUndefined();
    const currentAbaOverview = await nextRead(20);
    const currentAbaView = await nextRead(21);
    expect(currentAbaOverview.accountId).toBe(alice);
    expect(currentAbaView.accountId).toBe(alice);
    expectSafeReader();
    expectSafeReader(secondHost);
    currentAbaOverview.work.resolve(result('show'));
    currentAbaView.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();
    expectAdmittedReader(secondHost);

    const overviewRoute = routeKey({ kind: 'overview' });
    const currentOverviewKey = privateKeyForRoute(overviewRoute);
    const currentViewKey = privateKeyForRoute(abaRoute);
    expect(currentOverviewKey).toBeDefined();
    expect(currentViewKey).toBeDefined();
    await act(async () => {
      secondRoot.unmount();
      secondRootMounted = false;
    });
    await settle();
    expect(client.getQueryCache().find({ queryKey: currentViewKey!, exact: true })).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: currentOverviewKey!, exact: true })).toBeDefined();
    expectAdmittedReader();
    // All mounted readers and session consumers use the shared observer's single cache subscription.
    expect((client.getQueryCache() as unknown as { listeners: Set<unknown> }).listeners.size).toBe(1);
    await setSession(alice); // Equal successful replacement is a new incarnation.
    expectSafeReader();
    const equalReplacement = await nextRead(22);
    equalReplacement.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();
    await act(async () => {
      client.setQueryData(sessionModule.sessionQuery.queryKey, {
        state: 'signed-in',
        subject: alice,
        csrfToken: 'replacement-credential',
      });
    });
    expectSafeReader();
    const credentialReplacement = await nextRead(23);
    credentialReplacement.work.resolve(result('show'));
    await settle();
    expectAdmittedReader();
    await act(async () => client.removeQueries({ queryKey: privateKeyForRoute(overviewRoute)!, exact: true }));
    await settle();
    expectSafeReader();
    expect(nativeReads).toHaveLength(23);
  } finally {
    await act(async () => {
      root.unmount();
      if (secondRootMounted) secondRoot.unmount();
      failNextAgentAction = false;
      failNextSessionAction = false;
      nextAgentActionGate = undefined;
    });
    await settle();
    client.clear();
    serverClient.clear();
    restoreGlobals();
  }
});

function PublicReaderConsumer({
  page,
  handle,
  locale,
  path,
  useSession,
  useAgentReaderScope,
  useAgentReaderResult,
  agentReaderQuery,
  SubjectPage,
  messages,
}: {
  page: import('../src/features/pages/subject').SubjectPageData;
  handle: string;
  locale: string;
  path: import('../src/features/pages/agent-reader').AgentReaderPath;
  useSession: typeof import('../src/session/query').useSession;
  useAgentReaderScope: typeof import('../src/features/pages/agent-reader').useAgentReaderScope;
  useAgentReaderResult: typeof import('../src/features/pages/agent-reader').useAgentReaderResult;
  agentReaderQuery: typeof import('../src/features/pages/agent-queries').agentReaderQuery;
  SubjectPage: typeof import('../src/features/pages/subject').SubjectPage;
  messages: typeof import('../src/features/pages/route-support').subjectPageMessages;
}) {
  const session = useSession();
  const scope = useAgentReaderScope({ handle, locale, path, enabled: true, session });
  const query = useQuery(agentReaderQuery(handle, locale, scope));
  const reader = useAgentReaderResult(scope, query.data, query.status);
  return createElement(SubjectPage, {
    page,
    locale,
    messages: messages(),
    reader,
    renderJsonLd: false,
  });
}

/** Both focused files use the same prepared-session/native transport boundary. */
export const readerTestRuntime = {
  installWindow,
  settle,
  markCoversWithheld,
  result,
  nativeReads,
  setReader(reader: string | null) {
    sessionReader = reader;
    bffReader = reader;
  },
  reset() {
    nativeReads.length = 0;
    readerEnvelopes.length = 0;
  },
};
