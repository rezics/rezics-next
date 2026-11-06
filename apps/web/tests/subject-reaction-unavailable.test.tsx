import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, Suspense, type ComponentProps } from 'react';
import type { KernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import recordedSubject from '../src/kernel/recorded/zone-subject-page.json';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { SessionEnv } from '../src/session/client';
import type { SubjectReactionKind } from '../src/features/pages/subject-reactions';
import type { ZoneSubjectPersonalTransport } from '../src/zones/zone-shell';

// Exercise the production Subject and Zone owners with gated native reads and writes.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({
  url: 'https://site.test/en/zones/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
});
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
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

type SessionIdentity = { signedIn: boolean; subject?: string; csrfToken?: string };
type NativeReactionRead = { status: number; data?: unknown };
type NativeReadCall = { id: string; authorization: string | undefined };
type NativeWriteCall = {
  id: string;
  method: 'put' | 'delete';
  kind: SubjectReactionKind | null;
  authorization: string | undefined;
};
type SessionCredential = {
  status: 'active';
  subject: string;
  csrfToken: string;
  accessToken: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const ownReadQueue: Array<() => Promise<NativeReactionRead>> = [];
const ownReads: NativeReadCall[] = [];
const countReads: string[] = [];
const nativeWrites: NativeWriteCall[] = [];
type NativeWriteResult = { status: number; error?: { value: unknown } };
const nativeWriteQueue: Array<() => Promise<NativeWriteResult>> = [];
const preferenceReads: string[] = [];
const libraryEntryReads: string[] = [];
const followReads: string[] = [];
let preparedReader = 'reader-one';
let preparedCsrf = 'story-csrf-token';
let browserSessionPending: ReturnType<typeof deferred<SessionIdentity>> | null = null;
let browserSessionReadCount = 0;
let holdPersonalCalls = new Set<number>();

const sessionStore = {
  signedIn: () => {
    browserSessionReadCount++;
    return (
      browserSessionPending?.promise ??
      Promise.resolve({ signedIn: true, subject: preparedReader, csrfToken: preparedCsrf })
    );
  },
  credential: async (): Promise<SessionCredential> => ({
    status: 'active',
    subject: preparedReader,
    csrfToken: preparedCsrf,
    accessToken: `token-${preparedReader}`,
  }),
  credentialIfFresh: async (): Promise<SessionCredential> => ({
    status: 'active',
    subject: preparedReader,
    csrfToken: preparedCsrf,
    accessToken: `token-${preparedReader}`,
  }),
};
const sessionNamespace = {
  idFromName: (name: string) => name,
  get: (_id: string) => sessionStore,
};
const workerEnv = {
  AUTH_ISSUER: 'https://auth.site.test',
  API_RESOURCE: 'https://kernel.site.test',
  WEBSITE_SCOPES: 'openid profile',
  WEBSITE_CLIENT_ID: 'web-client',
  WEBSITE_CLIENT_KEY: '{}',
  KERNEL_ORIGIN: 'https://kernel.site.test',
  SESSIONS: sessionNamespace,
};

const libraryGroups = ['personal_library', 'collections'] as const;
const fakeKernelClient = {
  subjects: ({ id }: { id: string }) => ({
    reaction: {
      get: async (options: { headers?: { authorization?: string } }) => {
        ownReads.push({ id, authorization: options.headers?.authorization });
        const next = ownReadQueue.shift();
        return next ? next() : { status: 200, data: { kind: null } };
      },
      put: async (input: { kind: SubjectReactionKind }, options: { headers?: { authorization?: string } }) => {
        nativeWrites.push({ id, method: 'put', kind: input.kind, authorization: options.headers?.authorization });
        const next = nativeWriteQueue.shift();
        return next ? next() : { status: 200, data: { kind: input.kind } };
      },
      delete: async (_input: undefined, options: { headers?: { authorization?: string } }) => {
        nativeWrites.push({ id, method: 'delete', kind: null, authorization: options.headers?.authorization });
        const next = nativeWriteQueue.shift();
        return next ? next() : { status: 204 };
      },
    },
    reactions: {
      get: async () => {
        countReads.push(id);
        return {
          status: 200,
          data: {
            counts: [
              { kind: 'like', count: 2 },
              { kind: 'love', count: 1 },
              { kind: 'insightful', count: 3 },
            ],
            watermark: null,
          },
        };
      },
    },
    collections: {
      get: async () => ({ status: 200, data: { collections: [], next: null } }),
    },
  }),
  accounts: ({ accountId }: { accountId: string }) => ({
    preferences: {
      get: async () => {
        preferenceReads.push(accountId);
        return { status: 200, data: { spoilerLevel: 2, suitability: 'show', version: 4 } };
      },
    },
  }),
  libraryEntries: ({ subjectId }: { subjectId: string }) => ({
    get: async () => {
      libraryEntryReads.push(subjectId);
      return { status: 404, data: null };
    },
  }),
  libraryLabelAssignments: {
    get: async () => ({ status: 200, data: { assignments: [] } }),
  },
  follows: ({ targetId }: { targetId: string }) => ({
    get: async () => {
      followReads.push(targetId);
      return { status: 404, data: null };
    },
  }),
  platform: {
    exposure: {
      get: async () => ({ status: 200, data: { admitted: [...libraryGroups] } }),
    },
  },
};

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    const request = start.getRequest();
    const headers = new Headers(request.headers);
    const cookie = request.headers.get('cookie');
    // These server handlers copy Requests as well as cloning them. Use native headers in Bun;
    // Storybook's browser-only Cookie getter cannot survive a Request constructor copy.
    if (cookie) headers.set('cookie', cookie);
    return new Request(request, { headers });
  },
}));
mock.module('cloudflare:workers', () => ({ env: workerEnv }));
const kernel = await import('../src/kernel/client');
mock.module('../src/kernel/client', () => ({
  ...kernel,
  kernelClient: () => fakeKernelClient,
  // The browser shim selects the client branch; server-side release reads still need their configured origin.
  configuredKernelOrigin: () => workerEnv.KERNEL_ORIGIN,
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { loadSubjectReactions, readOwnReaction } = await import('../src/features/pages/subject-reactions');
const { ZoneSubjectPage, loadZoneSubjectPersonal } = await import('../src/zones/zone-shell');
const { SubjectOverview } = await import('../src/routes/subjects/$id_.$slug');
const { subjectFrameQuery, subjectRelationsQuery, subjectRatingQuery } =
  await import('../src/features/pages/subject-queries');
const { subjectPageType, pageRelationProperties } = await import('../src/features/pages/subject');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let replacementClient: InstanceType<typeof QueryClient> | undefined;
type PersonalResult = Awaited<ReturnType<typeof loadZoneSubjectPersonal>>;
type PersonalCall = {
  input: Parameters<ZoneSubjectPersonalTransport>[0];
  result?: PersonalResult;
  actual: Promise<PersonalResult>;
  response: Promise<PersonalResult>;
  gate?: ReturnType<typeof deferred<void>>;
};
let personalCalls: PersonalCall[] = [];
let mountedFollowReads = 0;
let rootMounted = false;
const previousLocale = getLocale;
const previousFetch = globalThis.fetch;

function queueNativeRead(result: NativeReactionRead | Error | ReturnType<typeof deferred<NativeReactionRead>>) {
  if (result instanceof Error) {
    ownReadQueue.push(() => Promise.reject(result));
  } else if ('promise' in result) {
    ownReadQueue.push(() => result.promise);
  } else {
    ownReadQueue.push(() => Promise.resolve(result));
  }
}

function directRequest() {
  return new Request('https://site.test/en/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
}

function zoneOutcome(id: string) {
  const common = structuredClone(recordedSubject) as unknown as {
    subject: string;
    reads: Record<string, { status: number; body: unknown }>;
    profile: string;
    template: unknown;
    document: unknown;
    views: string[];
  };
  common.subject = id;
  const body = common.reads.r0!.body as {
    subject: { id: string; statements: Record<string, Array<Record<string, unknown>>> };
  };
  body.subject.id = id;
  const genre = body.subject.statements['schema:genre']?.[0];
  if (genre) {
    genre.property = { id: 'schema:genre', data_type: 'string' };
    genre.value = { type: 'value', content: 'ZONE-PREFERENCE-WITNESS' };
    genre.qualifiers = [
      {
        property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
        value: { type: 'value', content: { amount: '+2', unit: '1' } },
      },
    ];
  }
  const zonePage = {
    ...structuredClone(recordedSubject),
    subject: id,
    reads: common.reads,
    zone: {
      id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11',
      revision: '1',
      labels: { en: 'Field Notes' },
      visibility: 'public',
      appearance: {},
      navigation: [],
    },
  };
  return {
    kind: 'page' as const,
    page: zonePage,
    common: { page: common, overview: common, view: 'overview' as const },
  } as unknown as Parameters<typeof ZoneSubjectPage>[0]['outcome'];
}

function personalTransport(input: Parameters<ZoneSubjectPersonalTransport>[0]) {
  const number = personalCalls.length + 1;
  const gate = holdPersonalCalls.has(number) ? deferred<void>() : undefined;
  const call: PersonalCall = {
    input,
    actual: Promise.resolve(undefined as unknown as PersonalResult),
    response: Promise.resolve(undefined as unknown as PersonalResult),
    ...(gate ? { gate } : {}),
  };
  call.actual = loadZoneSubjectPersonal(input).then((value) => {
    call.result = value;
    return value;
  });
  call.response = call.actual.then((value) => (gate ? gate.promise.then(() => value) : value));
  personalCalls.push(call);
  return call.response;
}

function tree(
  outcome: Parameters<typeof ZoneSubjectPage>[0]['outcome'],
  queryClient = client,
  view: 'overview' | 'editions' = 'overview',
) {
  const content = (
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>
        <ZoneSubjectPage outcome={outcome} locale="en" view={view} personalTransport={personalTransport} />
      </RouterContextProvider>
    </QueryClientProvider>
  );
  return <StrictMode>{content}</StrictMode>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  // Native completion precedes the React consumer's commit; inspect only after flushing that commit.
  await act(async () => {
    await tick();
  });
  while (!check() && Date.now() < deadline)
    await act(async () => {
      await tick();
    });
  expect({
    ready: check(),
    writes: nativeWrites.map((write) => write.kind),
    own: client.getQueryCache().findAll({ queryKey: ['subject-own-reaction'] }).map((query) => ({
      status: query.state.status,
      value: (query.state.data as { value?: unknown } | undefined)?.value,
    })),
    chips: chips().map((button) => ({
      text: button.textContent,
      pressed: button.getAttribute('aria-pressed'),
      disabled: button.disabled,
    })),
  }).toMatchObject({ ready: true });
}
async function paint(
  outcome: Parameters<typeof ZoneSubjectPage>[0]['outcome'],
  queryClient = client,
  view: 'overview' | 'editions' = 'overview',
) {
  await act(async () => {
    root.render(tree(outcome, queryClient, view));
    await tick();
  });
}
async function flush(work: () => void) {
  await act(async () => {
    work();
    await tick();
  });
}
function chips() {
  return [...host.querySelectorAll<HTMLButtonElement>('[data-slot="reaction-chip"]')];
}
function chip(kind: SubjectReactionKind) {
  const label =
    kind === 'like'
      ? m.reaction_like()
      : kind === 'love'
        ? m.reaction_love()
        : kind === 'laugh'
          ? m.reaction_laugh()
          : kind === 'insightful'
            ? m.reaction_insightful()
            : m.reaction_sad();
  const found = chips().find((button) => button.getAttribute('aria-label')?.startsWith(`${label} `));
  expect(found).toBeDefined();
  return found!;
}
async function clickKind(kind: SubjectReactionKind) {
  await act(async () => {
    if (kind === 'like' || kind === 'insightful') chip(kind).click();
    else {
      const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === m.reaction_react(),
      );
      expect(trigger).toBeDefined();
      trigger!.click();
      const choice = [...window.document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) =>
          button.textContent?.trim() ===
          (kind === 'love' ? m.reaction_love() : kind === 'laugh' ? m.reaction_laugh() : m.reaction_sad()),
      );
      expect(choice).toBeDefined();
      choice!.click();
    }
    await tick();
  });
}
function libraryEntryButton() {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${m.library_subject_entry()}"]`);
}
function storySession(subject = preparedReader): SessionIdentity {
  return { signedIn: true, subject, csrfToken: preparedCsrf };
}
function sessionData(subject = preparedReader) {
  return { state: 'signed-in' as const, subject, csrfToken: preparedCsrf };
}

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({
    initialEntries: ['/en/zones/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01'],
  }),
});

beforeEach(async () => {
  ownReadQueue.length = 0;
  ownReads.length = 0;
  countReads.length = 0;
  nativeWrites.length = 0;
  nativeWriteQueue.length = 0;
  preferenceReads.length = 0;
  libraryEntryReads.length = 0;
  followReads.length = 0;
  personalCalls = [];
  mountedFollowReads = 0;
  holdPersonalCalls = new Set();
  preparedReader = 'reader-one';
  preparedCsrf = 'story-csrf-token';
  browserSessionPending = null;
  browserSessionReadCount = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacementClient = undefined;
  root = createRoot(host);
  rootMounted = true;
  start.setStoryRequestContext({
    visitor: 'Signed In',
    url: 'https://site.test/en/zones/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01',
  });
  overwriteGetLocale(() => 'en');
  const release = definitions as unknown as { digest: string; release: unknown };
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: release.digest });
    if (url.pathname === `/v1/definitions/releases/${encodeURIComponent(release.digest)}`)
      return Response.json(release);
    return previousFetch(input, init);
  };
  await router.load();
});

afterEach(async () => {
  if (rootMounted) {
    await act(async () => root.unmount());
    rootMounted = false;
  }
  browserSessionPending?.resolve(storySession());
  for (const call of personalCalls) call.gate?.resolve();
  for (const next of ownReadQueue.splice(0)) void next().catch(() => {});
  await tick();
  client.clear();
  replacementClient?.clear();
  host.replaceChildren();
  browserSessionPending = null;
});

afterAll(async () => {
  globalThis.fetch = previousFetch;
  overwriteGetLocale(previousLocale);
  await window.happyDOM.close();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('failed own-reaction reads stay unavailable while the actual Zone personal payload and fresh recovery remain independent', async () => {
  const { kernelClient } = await import('../src/kernel/client');
  const native = kernelClient('en') as unknown as KernelClient;
  const sessionEnv = workerEnv as unknown as Partial<SessionEnv>;
  const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
  const availableFailures: Array<NativeReactionRead | Error> = [
    { status: 503 },
    { status: 403 },
    { status: 308, data: { redirect: { from: subjectId, to: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06' } } },
    new Error('native reaction read rejected'),
    { status: 200 },
    { status: 200, data: {} },
    { status: 200, data: { kind: 'upvote' } },
    { status: 200, data: { kind: 3 } },
    { status: 200, data: null },
  ];
  for (const failure of availableFailures) {
    queueNativeRead(failure);
    expect(await readOwnReaction(native, directRequest(), sessionEnv, subjectId, 'reader-one')).toBeNull();
  }

  const readsBeforeMismatch = ownReads.length;
  preparedReader = 'reader-two';
  expect(await readOwnReaction(native, directRequest(), sessionEnv, subjectId, 'reader-one')).toBeNull();
  expect(ownReads).toHaveLength(readsBeforeMismatch);
  preparedReader = 'reader-one';
  expect(
    await readOwnReaction(
      native,
      new Request('https://site.test/en/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01'),
      sessionEnv,
      subjectId,
      'reader-one',
    ),
  ).toBeNull();
  expect(ownReads).toHaveLength(readsBeforeMismatch);

  queueNativeRead({ status: 503 });
  const publicWithUnavailableOwn = await loadSubjectReactions(
    native,
    directRequest(),
    sessionEnv,
    subjectId,
    'reader-one',
  );
  expect(publicWithUnavailableOwn).toMatchObject({ counts: { like: 2 }, value: null });
  expect(publicWithUnavailableOwn).not.toHaveProperty('reader');
  expect(countReads).toContain(subjectId);

  queueNativeRead({ status: 200, data: { kind: null } });
  expect(await readOwnReaction(native, directRequest(), sessionEnv, subjectId, 'reader-one')).toEqual({
    reader: 'reader-one',
    value: null,
  });
  queueNativeRead({ status: 200, data: { kind: 'love' } });
  expect(await readOwnReaction(native, directRequest(), sessionEnv, subjectId, 'reader-one')).toEqual({
    reader: 'reader-one',
    value: 'love',
  });

  const ownReadsBeforeMount = ownReads.length;
  const countReadsBeforeMount = countReads.length;
  client.setQueryData(sessionQuery.queryKey, sessionData());
  queueNativeRead({ status: 503 });
  holdPersonalCalls = new Set([1, 2, 5]);
  const firstOutcome = zoneOutcome(subjectId);
  await paint(firstOutcome);
  await until(
    () => personalCalls.length === 1 && personalCalls[0]!.result !== undefined,
  );

  const firstPersonal = personalCalls[0]!.result!;
  expect(personalCalls[0]!.input.data).toEqual({
    id: subjectId,
    locale: 'en',
    overview: true,
    subjectType: 'schema:Book',
  });
  expect(firstPersonal.reader).toEqual({ spoilerLevel: 2, suitability: 'show' });
  expect(firstPersonal.library?.provenance).toMatchObject({ viewer: 'reader-one', subjectId });
  expect(firstPersonal.library?.entryAvailable).toBe(true);
  expect(firstPersonal.library?.stateOptions?.length).toBeGreaterThan(0);
  expect(firstPersonal.reactions).toMatchObject({ counts: { like: 2 }, value: null });
  expect(personalCalls).toHaveLength(1);
  expect(countReads.length - countReadsBeforeMount).toBe(1);

  await until(() => ownReads.length === ownReadsBeforeMount + 1);
  const firstPrivateRead = ownReads.at(-1)!;
  expect(firstPrivateRead.id).toBe(subjectId);
  expect(firstPrivateRead.authorization).toBe('Bearer token-reader-one');
  personalCalls[0]!.gate!.resolve();
  await until(() => chips().length > 0 && host.textContent?.includes('ZONE-PREFERENCE-WITNESS') === true);

  expect(chips().every((button) => button.disabled)).toBe(true);
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(chip('like').textContent).toContain('2');
  expect(nativeWrites).toHaveLength(0);

  await until(() => libraryEntryButton() !== null && followButton()?.disabled === false);
  expect(libraryEntryButton()?.disabled).toBe(false);
  const followControl = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === m.library_follow(),
  );
  expect(followControl).toBeDefined();
  expect(followControl!.disabled).toBe(false);
  const moreActions = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === m.report_more(),
  );
  expect(moreActions).toBeDefined();
  await flush(() => moreActions!.click());
  expect(
    [...window.document.querySelectorAll('[role="menuitem"], button')].some(
      (item) => item.textContent?.trim() === m.report_action(),
    ),
  ).toBe(true);
  expect(preferenceReads).toContain('reader-one');
  expect(libraryEntryReads).toContain(subjectId);

  queueNativeRead({ status: 200, data: { kind: null } });
  await flush(() => client.setQueryData(sessionQuery.queryKey, sessionData()));
  await until(() => ownReads.length === ownReadsBeforeMount + 2 && chips().some((button) => !button.disabled));
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(personalCalls).toHaveLength(1);
  expect(countReads.length - countReadsBeforeMount).toBe(1);

  await clickKind('like');
  await until(() => nativeWrites.length === 1 && chip('like').getAttribute('aria-pressed') === 'true');
  expect(nativeWrites[0]).toMatchObject({
    id: subjectId,
    method: 'put',
    kind: 'like',
    authorization: 'Bearer token-reader-one',
  });
  await clickKind('like');
  await until(
    () => nativeWrites.length === 2 && chips().every((button) => button.getAttribute('aria-pressed') !== 'true'),
  );
  expect(nativeWrites[1]).toMatchObject({
    id: subjectId,
    method: 'delete',
    kind: null,
    authorization: 'Bearer token-reader-one',
  });

  const secondId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
  const oldSecondOwnRead = deferred<NativeReactionRead>();
  queueNativeRead(oldSecondOwnRead);
  const secondOutcome = zoneOutcome(secondId);
  await paint(secondOutcome);
  await until(
    () =>
      personalCalls.length === 2 &&
      personalCalls[1]!.result !== undefined &&
      ownReads.length === ownReadsBeforeMount + 3,
  );
  expect(personalCalls[1]!.input.data.id).toBe(secondId);
  expect(personalCalls[1]!.gate).toBeDefined();
  const oldSecondPersonal = personalCalls[1]!.result!;
  expect(oldSecondPersonal.library?.provenance?.subjectId).toBe(secondId);

  const thirdId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e07';
  queueNativeRead({ status: 200, data: { kind: null } });
  await paint(zoneOutcome(thirdId));
  await until(
    () =>
      personalCalls.length === 3 &&
      personalCalls[2]!.result !== undefined &&
      ownReads.length === ownReadsBeforeMount + 4,
  );
  expect(host.textContent).toContain('ZONE-PREFERENCE-WITNESS');
  personalCalls[1]!.gate!.resolve();
  await flush(() => oldSecondOwnRead.resolve({ status: 503 }));
  await tick();
  expect(libraryEntryButton()?.getAttribute('aria-label')).toBe(m.library_subject_entry());
  expect(libraryEntryReads.at(-1)).toBe(thirdId);
  expect(countReads.at(-1)).toBe(thirdId);
  expect(chip('like').textContent).toContain('2');
  expect(personalCalls).toHaveLength(3);
  expect(countReads.length - countReadsBeforeMount).toBe(3);

  const fourthId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e08';
  const oldProviderRead = deferred<NativeReactionRead>();
  queueNativeRead(oldProviderRead);
  const fourthOutcome = zoneOutcome(fourthId);
  await paint(fourthOutcome);
  await until(
    () =>
      personalCalls.length === 4 &&
      personalCalls[3]!.result !== undefined &&
      ownReads.length === ownReadsBeforeMount + 5,
  );
  const oldProviderClient = client;
  replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacementClient.setQueryData(sessionQuery.queryKey, sessionData());
  queueNativeRead({ status: 200, data: { kind: null } });
  await paint(fourthOutcome, replacementClient);
  await until(
    () =>
      ownReads.length === ownReadsBeforeMount + 6 && chips().length > 0 && chips().some((button) => !button.disabled),
  );
  const combinedCountBeforeOldResponse = personalCalls.length;
  expect(combinedCountBeforeOldResponse).toBe(4);
  oldProviderRead.resolve({ status: 200, data: { kind: 'love' } });
  await tick();
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(personalCalls).toHaveLength(combinedCountBeforeOldResponse);
  expect(oldProviderClient.getQueryData(sessionQuery.queryKey)).toMatchObject(sessionData());

  const finalId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e09';
  const afterUnmount = deferred<NativeReactionRead>();
  queueNativeRead(afterUnmount);
  await paint(zoneOutcome(finalId), replacementClient);
  await until(() => personalCalls.length === 5 && ownReads.length === ownReadsBeforeMount + 7);
  const callsAtUnmount = personalCalls.length;
  await act(async () => root.unmount());
  rootMounted = false;
  afterUnmount.reject(new Error('late old private read rejected'));
  personalCalls[4]!.gate?.resolve();
  await tick();
  expect(host.querySelector('[data-slot="reactions"]')).toBeNull();
  expect(personalCalls).toHaveLength(callsAtUnmount);
});

// Both production consumers use the real session Query, own-query registry and shared queue.
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
async function paintOrdinary(id = subjectId, queryClient = client) {
  const outcome = zoneOutcome(id);
  const page = outcome.common!.page!;
  const type = subjectPageType(page);
  // Recorded public loader payload, without substituting the admission, own query or UI under test.
  queryClient.setQueryData(subjectFrameQuery(type ?? '', 'en').queryKey, {});
  queryClient.setQueryData(subjectRelationsQuery(pageRelationProperties(page), 'en').queryKey, {});
  queryClient.setQueryData(subjectRatingQuery(id, 'en').queryKey, null);
  const data = {
    page,
    tabs: [],
    reader: null,
    frame: {},
    relations: {},
    ratings: null,
    verification: { sitekey: '', scriptUrl: '' },
  } as unknown as ComponentProps<typeof SubjectOverview>['data'];
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <RouterContextProvider router={router}>
            <Suspense fallback={<p>Loading</p>}>
              <SubjectOverview data={data} search={{}} />
            </Suspense>
          </RouterContextProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    await tick();
  });
}

async function equalSuccess(source: 'manual' | 'fetch', afterCommit: () => void) {
  const previous = client.getQueryData(sessionQuery.queryKey);
  expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('success');
  const successes: unknown[] = [];
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.query.queryKey.length !== 1 ||
      event.query.queryKey[0] !== 'session' ||
      event.type !== 'updated' ||
      event.action.type !== 'success'
    )
      return;
    successes.push(event.query.state.data);
    // Settle/click inside the actual cache event, before a React commit or held promise continuation.
    afterCommit();
  });
  await act(async () => {
    if (source === 'manual') client.setQueryData(sessionQuery.queryKey, { ...sessionData() });
    else await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    await tick();
  });
  unsubscribe();
  expect(successes).toHaveLength(1);
  expect(successes[0]).toBe(previous);
  expect(successes[0]).toEqual(sessionData());
}

function noSelection() {
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
}
function independentZonePayload(combined: number, counts: number, follows = mountedFollowReads) {
  expect(personalCalls).toHaveLength(combined);
  expect(countReads).toHaveLength(counts);
  expect(preferenceReads).toEqual(Array.from({ length: combined }, () => 'reader-one'));
  expect(libraryEntryReads).toEqual(Array.from({ length: combined }, () => subjectId));
  expect(followReads).toEqual(Array.from({ length: follows }, () => subjectId));
  expect(host.textContent).toContain('ZONE-PREFERENCE-WITNESS');
  expect(chip('like').textContent).toContain('2');
}
function independentZone(combined: number, counts: number, follows = mountedFollowReads) {
  independentZonePayload(combined, counts, follows);
  expect(libraryEntryButton()?.disabled).toBe(false);
  expect(followButton()?.disabled).toBe(false);
  const report = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === m.report_more(),
  );
  expect(report?.disabled).toBe(false);
}

function followButton() {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === m.library_follow(),
  );
}
async function settleZoneActions() {
  await until(() => libraryEntryButton() !== null && followButton()?.disabled === false);
  // StrictMode can issue an initial read before retiring its first mounted admission.
  mountedFollowReads = followReads.length;
  expect(mountedFollowReads).toBeGreaterThan(0);
}

for (const source of ['manual', 'fetch'] as const)
  test(`production Zone keeps a held combined payload independent of ${source} equal success and stale private completion`, async () => {
    client.setQueryData(sessionQuery.queryKey, sessionData());
    holdPersonalCalls = new Set([1]);
    const oldOwn = deferred<NativeReactionRead>();
    const freshOwn = deferred<NativeReactionRead>();
    queueNativeRead(oldOwn);
    queueNativeRead(freshOwn);
    await paint(zoneOutcome(subjectId));
    await until(() => ownReads.length === 1 && personalCalls[0]?.result !== undefined);
    const oldKey = client
      .getQueryCache()
      .findAll({ queryKey: ['subject-own-reaction'] })
      .find((query) => query.state.fetchStatus === 'fetching')!.queryKey;
    await equalSuccess(source, () => {
      oldOwn.resolve({ status: 200, data: { kind: 'love' } });
      personalCalls[0]!.gate!.resolve();
    });
    await until(() => ownReads.length === 2);
    await settleZoneActions();
    expect(client.getQueryData(oldKey)).toBeUndefined();
    expect(chips().every((button) => button.disabled)).toBe(true);
    noSelection();
    independentZone(1, 1);
    expect(nativeWrites).toHaveLength(0);
    await flush(() => freshOwn.resolve({ status: 200, data: { kind: null } }));
    await until(() => chips().some((button) => !button.disabled));
    await clickKind('like');
    await until(() => nativeWrites.length === 1 && chip('like').getAttribute('aria-pressed') === 'true');
    await clickKind('like');
    await until(() => nativeWrites.length === 2 && chip('like').getAttribute('aria-pressed') !== 'true');
    expect(nativeWrites.map((write) => [write.method, write.kind, write.authorization])).toEqual([
      ['put', 'like', 'Bearer token-reader-one'],
      ['delete', null, 'Bearer token-reader-one'],
    ]);
    expect(ownReads).toHaveLength(2);
    independentZone(1, 1);
  });

for (const surface of ['ordinary Subject', 'production Zone'] as const)
  for (const source of ['manual', 'fetch'] as const)
    for (const outcome of ['success', 'refusal', 'lost-response'] as const)
      test(`${surface} ${source} equal success retires a dispatched ${outcome} and queued choice until fresh private recovery`, async () => {
        client.setQueryData(sessionQuery.queryKey, sessionData());
        queueNativeRead({ status: 200, data: { kind: null } });
        if (surface === 'production Zone') await paint(zoneOutcome(subjectId));
        else await paintOrdinary();
        await until(() => ownReads.length === 1 && chips().some((button) => !button.disabled));
        if (surface === 'production Zone') await settleZoneActions();
        const oldOwnQuery = client
          .getQueryCache()
          .findAll({ queryKey: ['subject-own-reaction'] })
          .find((query) => query.state.status === 'success')!;
        const priorOwn = oldOwnQuery.state.data;
        const write = deferred<NativeWriteResult>();
        nativeWriteQueue.push(() => write.promise);
        await clickKind('like');
        await clickKind('insightful');
        expect(nativeWrites).toHaveLength(1);
        const oldButton = chip('like');
        oldButton.focus();
        const countsBefore = countReads.length;
        const freshOwn = deferred<NativeReactionRead>();
        queueNativeRead(freshOwn);
        await equalSuccess(source, () => {
          oldButton.click();
          if (outcome === 'lost-response') write.reject(new Error('Response lost'));
          else write.resolve(outcome === 'success' ? { status: 200 } : { status: 403, error: { value: {} } });
        });
        await until(() => ownReads.length === 2);
        expect(nativeWrites).toHaveLength(1);
        expect(oldOwnQuery.state.data).toBe(priorOwn);
        expect(chips().every((button) => button.disabled)).toBe(true);
        noSelection();
        expect(host.textContent).not.toContain(m.reaction_forbidden());
        expect(oldButton.isConnected).toBe(false);
        expect(window.document.activeElement).not.toBe(oldButton);
        expect(countReads).toHaveLength(countsBefore);
        if (surface === 'production Zone') {
          await until(() => followButton()?.disabled === false);
          independentZone(1, 1);
        }
        // The fresh response comes through the real prepared native read, never from a copied cache value.
        await flush(() => freshOwn.resolve({ status: 200, data: { kind: null } }));
        await until(() => chips().some((button) => !button.disabled));
        await clickKind('like');
        await until(() => nativeWrites.length === 2 && chip('like').getAttribute('aria-pressed') === 'true');
        await clickKind('like');
        await until(() => nativeWrites.length === 3 && chip('like').getAttribute('aria-pressed') !== 'true');
        expect(nativeWrites.map((write) => write.kind)).toEqual(['like', 'like', null]);
        expect(
          nativeWrites.every((write) => write.id === subjectId && write.authorization === 'Bearer token-reader-one'),
        ).toBe(true);
        expect(ownReads).toHaveLength(2);
        if (surface === 'production Zone') {
          await until(() => followButton()?.disabled === false);
          independentZone(1, 1);
        } else expect(countReads).toHaveLength(countsBefore + 2); // Only the two useful current mutation refreshes.
      });

for (const source of ['manual', 'fetch'] as const)
  test(`ordinary Subject ignores a held old own response after ${source} equal success`, async () => {
    client.setQueryData(sessionQuery.queryKey, sessionData());
    const oldOwn = deferred<NativeReactionRead>();
    const freshOwn = deferred<NativeReactionRead>();
    queueNativeRead(oldOwn);
    queueNativeRead(freshOwn);
    await paintOrdinary();
    await until(() => ownReads.length === 1 && chips().length > 0);
    const initialCountReads = countReads.length;
    await equalSuccess(source, () => oldOwn.resolve({ status: 200, data: { kind: 'love' } }));
    await until(() => ownReads.length === 2);
    noSelection();
    expect(chips().every((button) => button.disabled)).toBe(true);
    expect(nativeWrites).toHaveLength(0);
    expect(countReads).toHaveLength(initialCountReads);
    await flush(() => freshOwn.resolve({ status: 200, data: { kind: null } }));
    await until(() => chips().some((button) => !button.disabled));
    noSelection();
    expect(ownReads).toHaveLength(2);
  });

for (const surface of ['ordinary Subject', 'production Zone'] as const)
  test(`${surface} preserves a useful serialized queue during real non-success notifications`, async () => {
    client.setQueryData(sessionQuery.queryKey, sessionData());
    queueNativeRead({ status: 200, data: { kind: null } });
    if (surface === 'production Zone') await paint(zoneOutcome(subjectId));
    else await paintOrdinary();
    await until(() => ownReads.length === 1 && chips().some((button) => !button.disabled));
    if (surface === 'production Zone') await settleZoneActions();
    const initialCountReads = countReads.length;
    const write = deferred<NativeWriteResult>();
    nativeWriteQueue.push(() => write.promise);
    await clickKind('like');
    await clickKind('insightful');
    await clickKind('insightful');
    expect(nativeWrites).toHaveLength(1);
    const queuedButton = chip('like');
    expect(queuedButton.getAttribute('aria-pressed')).toBe('true');
    const sessionResponse = deferred<SessionIdentity>();
    browserSessionPending = sessionResponse;
    let fetch!: Promise<unknown>;
    await act(async () => {
      await client.invalidateQueries({ queryKey: sessionQuery.queryKey, exact: true, refetchType: 'none' });
      client.setQueryData(['session', 'unrelated'], sessionData());
      fetch = client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    expect(client.getQueryState(sessionQuery.queryKey)?.fetchStatus).toBe('fetching');
    expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('success');
    expect(ownReads).toHaveLength(1);
    expect(nativeWrites).toHaveLength(1);
    expect(chip('like') === queuedButton).toBe(true);
    expect(queuedButton.disabled).toBe(false);
    expect(queuedButton.getAttribute('aria-pressed')).toBe('true');
    await flush(() => write.resolve({ status: 200 }));
    await until(() => nativeWrites.length === 3 && chip('insightful').getAttribute('aria-pressed') !== 'true');
    expect(nativeWrites.map((write) => write.kind)).toEqual(['like', 'insightful', null]);
    expect(ownReads).toHaveLength(1);
    expect(nativeWrites.every((write) => write.authorization === 'Bearer token-reader-one')).toBe(true);
    if (surface === 'production Zone') independentZonePayload(1, 1);
    else expect(countReads).toHaveLength(initialCountReads + 3); // Each current callback refreshes the mounted public baseline.
    // Only its eventual successful commit retires the observation.
    await act(async () => {
      sessionResponse.resolve(storySession());
      await fetch;
      await tick();
    });
    await until(() => ownReads.length === 2);
  });

test('production Zone reloads its personal source after session loss while reaction refusal stays independent', async () => {
  client.setQueryData(sessionQuery.queryKey, sessionData());
  queueNativeRead({ status: 403 });
  await paint(zoneOutcome(subjectId));
  await until(() => ownReads.length === 1);
  await settleZoneActions();
  independentZone(1, 1);
  noSelection();
  expect(chips().every((button) => button.disabled)).toBe(true);
  await act(async () => {
    await client
      .fetchQuery({
        ...sessionQuery,
        staleTime: 0,
        queryFn: async () => {
          throw new Error('session cache refresh failed');
        },
      })
      .catch(() => undefined);
    await tick();
  });
  expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
  expect(client.getQueryData(sessionQuery.queryKey)).toEqual(sessionData());
  await until(() => personalCalls.length === 2 && personalCalls[1]?.result !== undefined && chips().length > 0);
  // A different browser session state retires the combined source; equal success does not.
  expect(personalCalls[0]!.result!.library?.provenance?.viewer).toBe('reader-one');
  independentZonePayload(2, 2);
  expect(ownReads).toHaveLength(1);
  browserSessionPending = deferred<SessionIdentity>();
  await flush(() => client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true }));
  await until(() => personalCalls.length === 3 && personalCalls[2]?.result !== undefined && chips().length > 0);
  independentZonePayload(3, 3);
  noSelection();
  expect(host.querySelectorAll('button[data-slot="reaction-chip"]:not(:disabled)')).toHaveLength(0);
  expect(ownReads).toHaveLength(1);
  expect(nativeWrites).toHaveLength(0);
  queueNativeRead({ status: 200, data: { kind: null } });
  let recovery!: Promise<unknown>;
  await flush(() => {
    recovery = client.fetchQuery(sessionQuery);
  });
  await act(async () => {
    browserSessionPending!.resolve(storySession());
    await recovery;
    await tick();
  });
  await until(
    () =>
      ownReads.length === 2 &&
      followButton()?.disabled === false &&
      chips().some((button) => !button.disabled),
  );
  const recoveredFollowReads = followReads.length;
  expect(recoveredFollowReads).toBeGreaterThan(mountedFollowReads);
  independentZone(4, 4, recoveredFollowReads);
});

test('anonymous production Zone makes zero private reaction reads and preserves its public counts', async () => {
  start.setStoryRequestContext({ visitor: 'Signed Out', url: window.location.href });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  await paint(zoneOutcome(subjectId));
  await until(() => personalCalls[0]?.result !== undefined && chips().length > 0);
  expect(ownReads).toHaveLength(0);
  expect(nativeWrites).toHaveLength(0);
  expect(countReads).toEqual([subjectId]);
  expect(personalCalls).toHaveLength(1);
  expect(preferenceReads).toHaveLength(0);
  expect(libraryEntryReads).toHaveLength(0);
  expect(followReads).toHaveLength(0);
  noSelection();
});

for (const surface of ['ordinary Subject', 'production Zone'] as const)
  test(`${surface} retires undispatched choices synchronously on equal success`, async () => {
    client.setQueryData(sessionQuery.queryKey, sessionData());
    queueNativeRead({ status: 200, data: { kind: null } });
    if (surface === 'production Zone') await paint(zoneOutcome(subjectId));
    else await paintOrdinary();
    await until(() => ownReads.length === 1 && chips().some((button) => !button.disabled));
    if (surface === 'production Zone') await settleZoneActions();
    const initialCountReads = countReads.length;
    const freshOwn = deferred<NativeReactionRead>();
    queueNativeRead(freshOwn);
    const oldButton = chip('like');
    await flush(() => {
      oldButton.click();
      chip('insightful').click();
      client.setQueryData(sessionQuery.queryKey, { ...sessionData() });
      oldButton.click();
    });
    await until(() => ownReads.length === 2);
    expect(nativeWrites).toHaveLength(0);
    noSelection();
    expect(chips().every((button) => button.disabled)).toBe(true);
    expect(countReads).toHaveLength(initialCountReads);
    if (surface === 'production Zone') {
      await until(() => followButton()?.disabled === false);
      independentZone(1, 1);
    }
    await flush(() => freshOwn.resolve({ status: 200, data: { kind: null } }));
    await until(() => chips().some((button) => !button.disabled));
  });

for (const boundary of ['target', 'provider', 'unmount', 'observed ABA'] as const)
  test(`actual ordinary Subject ${boundary} retirement rejects old own responses and admits only a fresh one`, async () => {
    client.setQueryData(sessionQuery.queryKey, sessionData());
    const oldOwn = deferred<NativeReactionRead>();
    const freshOwn = deferred<NativeReactionRead>();
    queueNativeRead(oldOwn);
    queueNativeRead(freshOwn);
    await paintOrdinary();
    await until(() => ownReads.length === 1 && chips().length > 0);
    if (boundary === 'target') {
      await paintOrdinary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06');
    } else if (boundary === 'provider') {
      replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      replacementClient.setQueryData(sessionQuery.queryKey, sessionData());
      await paintOrdinary(subjectId, replacementClient);
    } else if (boundary === 'unmount') {
      await act(async () => root.render(null));
      await paintOrdinary();
    } else {
      await flush(() => {
        client.setQueryData(sessionQuery.queryKey, sessionData('reader-two'));
        client.setQueryData(sessionQuery.queryKey, sessionData());
        oldOwn.resolve({ status: 200, data: { kind: 'love' } });
      });
    }
    await until(() => ownReads.length === 2);
    await flush(() => oldOwn.resolve({ status: 200, data: { kind: 'love' } }));
    noSelection();
    expect(chips().every((button) => button.disabled)).toBe(true);
    expect(nativeWrites).toHaveLength(0);
    await flush(() => freshOwn.resolve({ status: 200, data: { kind: null } }));
    await until(() => chips().some((button) => !button.disabled));
    expect(ownReads).toHaveLength(2);
    await clickKind('like');
    await until(() => nativeWrites.length === 1);
    expect(nativeWrites[0]).toMatchObject({
      id: boundary === 'target' ? '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06' : subjectId,
      method: 'put',
      kind: 'like',
      authorization: 'Bearer token-reader-one',
    });
  });

test('ordinary Subject does not start a later count refresh if an equal session success retires its current mutation cache update', async () => {
  client.setQueryData(sessionQuery.queryKey, sessionData());
  queueNativeRead({ status: 200, data: { kind: null } });
  await paintOrdinary();
  await until(() => ownReads.length === 1 && chips().some((button) => !button.disabled));
  const initialCountReads = countReads.length;
  const oldOwnQuery = client
    .getQueryCache()
    .findAll({ queryKey: ['subject-own-reaction'] })
    .find((query) => query.state.status === 'success')!;
  const write = deferred<NativeWriteResult>();
  nativeWriteQueue.push(() => write.promise);
  const freshOwn = deferred<NativeReactionRead>();
  queueNativeRead(freshOwn);
  await clickKind('like');
  await clickKind('insightful');
  let replacements = 0;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.query !== oldOwnQuery || event.type !== 'updated' || event.action.type !== 'success') return;
    replacements++;
    client.setQueryData(sessionQuery.queryKey, { ...sessionData() });
  });
  await flush(() => write.resolve({ status: 200 }));
  unsubscribe();
  await until(() => ownReads.length === 2);
  expect(replacements).toBe(1);
  expect(nativeWrites).toHaveLength(1); // The accepted write remains accepted; the queued choice is retired.
  expect(countReads).toHaveLength(initialCountReads);
  noSelection();
  expect(chips().every((button) => button.disabled)).toBe(true);
  await flush(() => freshOwn.resolve({ status: 200, data: { kind: null } }));
  await until(() => chips().some((button) => !button.disabled));
  await clickKind('like');
  await until(() => nativeWrites.length === 2 && countReads.length === initialCountReads + 1);
  expect(ownReads).toHaveLength(2);
});
