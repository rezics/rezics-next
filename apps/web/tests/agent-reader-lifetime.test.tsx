import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';

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
        }
        const gate = !isAgentReader ? nextSessionGate : undefined;
        if (gate) {
          nextSessionGate = undefined;
          gate.entered.resolve(undefined);
          await gate.release.promise;
        }
        currentRequest = requestFor(isAgentReader ? bffReader : sessionReader);
        return handler({ data });
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
    if (
      key === 'cover' &&
      typeof entry === 'object' &&
      entry !== null &&
      'media' in entry &&
      'variants' in entry
    )
      (entry as { withheld?: 'suitability' }).withheld = 'suitability';
    markCoversWithheld(entry);
  }
}

function result(suitability: 'blur' | 'show'): PreferenceResult {
  return {
    status: 200,
    data: { spoilerLevel: 0, suitability, version: 1 },
    headers: new Headers(),
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Authored UNRUN: one mounted reader and public-profile consumer regression spanning both account paths.
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
  ] = await Promise.all([
      import('react-dom/client'),
      import('@tanstack/react-query'),
      import('../src/session/query'),
      import('../src/features/pages/agent-queries'),
      import('../src/features/pages/agent-reader'),
      import('../src/features/pages/subject'),
      import('../src/stories/pages/accounts-public-profile/fixtures'),
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
            messages: subjectModule.subjectPageMessages,
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
  const render = (props: { handle?: string; locale?: string; path?: import('../src/features/pages/agent-reader').AgentReaderPath }) =>
    root.render(
      createElement(
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
          messages: subjectModule.subjectPageMessages,
        }),
      ),
    );
  const isWithheld = () => host.querySelector('[data-slot="cover"][data-state="withheld"]') !== null;
  const expectSafeReader = () => {
    expect(host.querySelector('[data-slot="cover"]')).not.toBeNull();
    expect(isWithheld()).toBe(true);
  };
  const expectAdmittedReader = () => {
    expect(host.querySelector('[data-slot="cover"]')).not.toBeNull();
    expect(isWithheld()).toBe(false);
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
  } finally {
    await act(async () => root.unmount());
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
