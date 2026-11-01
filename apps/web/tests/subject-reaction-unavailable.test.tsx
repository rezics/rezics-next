import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { KernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import recordedSubject from '../src/kernel/recorded/zone-subject-page.json';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { SessionEnv } from '../src/session/client';
import type { SubjectReactionKind } from '../src/features/pages/subject-reactions';
import type { ZoneSubjectPersonalTransport } from '../src/zones/zone-shell';

// UNRUN: the connected native-read and actual Zone owner journey is authored; current verification is Web typing only.
const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/zones/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11/subjects/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01' });
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
const previousGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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
    return browserSessionPending?.promise ?? Promise.resolve({ signedIn: true, subject: preparedReader, csrfToken: preparedCsrf });
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
      put: async (
        input: { kind: SubjectReactionKind },
        options: { headers?: { authorization?: string } },
      ) => {
        nativeWrites.push({ id, method: 'put', kind: input.kind, authorization: options.headers?.authorization });
        return { status: 200, data: { kind: input.kind } };
      },
      delete: async (_input: undefined, options: { headers?: { authorization?: string } }) => {
        nativeWrites.push({ id, method: 'delete', kind: null, authorization: options.headers?.authorization });
        return { status: 204 };
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
              { kind: 'laugh', count: 0 },
              { kind: 'insightful', count: 3 },
              { kind: 'sad', count: 0 },
            ],
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
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: workerEnv }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => fakeKernelClient }));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } = await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { loadSubjectReactions, readOwnReaction } = await import('../src/features/pages/subject-reactions');
const { ZoneSubjectPage, loadZoneSubjectPersonal } = await import('../src/zones/zone-shell');
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
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await tick();
  expect(check()).toBe(true);
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
  const found = chips().find((button) => button.textContent?.startsWith(label));
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
        (button) => button.textContent?.trim() === (kind === 'love' ? m.reaction_love() : kind === 'laugh' ? m.reaction_laugh() : m.reaction_sad()),
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
  preferenceReads.length = 0;
  libraryEntryReads.length = 0;
  followReads.length = 0;
  personalCalls = [];
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
  const publicWithUnavailableOwn = await loadSubjectReactions(native, directRequest(), sessionEnv, subjectId, 'reader-one');
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
  browserSessionPending = deferred<SessionIdentity>();
  queueNativeRead({ status: 503 });
  holdPersonalCalls = new Set([1, 2, 5]);
  const firstOutcome = zoneOutcome(subjectId);
  await paint(firstOutcome);
  await until(() => browserSessionReadCount > 0 && personalCalls.length === 1 && personalCalls[0]!.result !== undefined);

  const firstPersonal = personalCalls[0]!.result!;
  expect(personalCalls[0]!.input.data).toEqual({
    id: subjectId,
    locale: 'en',
    overview: true,
    subjectType: 'schema:Book',
  });
  expect(firstPersonal.reader).toEqual({ spoilerLevel: 2, suitability: 'show' });
  expect(firstPersonal.library?.provenance).toMatchObject({ viewer: 'reader-one', subjectId });
  expect(firstPersonal.reactions).toMatchObject({ counts: { like: 2 }, value: null });
  expect(personalCalls).toHaveLength(1);
  expect(countReads.length - countReadsBeforeMount).toBe(1);

  await flush(() => browserSessionPending!.resolve(storySession()));
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

  await until(() => libraryEntryButton() !== null && followReads.includes(subjectId));
  expect(libraryEntryButton()?.disabled).toBe(false);
  const followButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === m.library_follow(),
  );
  expect(followButton).toBeDefined();
  expect(followButton!.disabled).toBe(false);
  const moreActions = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === m.report_more(),
  );
  expect(moreActions).toBeDefined();
  await flush(() => moreActions!.click());
  expect([...window.document.querySelectorAll('button')].some((button) => button.textContent?.trim() === m.report_action())).toBe(true);
  expect(preferenceReads).toContain('reader-one');
  expect(libraryEntryReads).toContain(subjectId);

  await client
    .fetchQuery({
      ...sessionQuery,
      staleTime: 0,
      queryFn: async () => {
        throw new Error('session cache refresh failed');
      },
    })
    .catch(() => undefined);
  expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
  expect(client.getQueryData(sessionQuery.queryKey)).toMatchObject(sessionData());
  expect(host.textContent).toContain('ZONE-PREFERENCE-WITNESS');
  expect(chips().every((button) => button.disabled)).toBe(true);
  expect(personalCalls).toHaveLength(1);
  expect(countReads.length - countReadsBeforeMount).toBe(1);
  expect(nativeWrites).toHaveLength(0);

  queueNativeRead({ status: 200, data: { kind: null } });
  await flush(() => client.setQueryData(sessionQuery.queryKey, sessionData()));
  await until(() => ownReads.length === ownReadsBeforeMount + 2 && chips().some((button) => !button.disabled));
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(personalCalls).toHaveLength(1);
  expect(countReads.length - countReadsBeforeMount).toBe(1);

  await clickKind('like');
  await until(() => nativeWrites.length === 1 && chip('like').getAttribute('aria-pressed') === 'true');
  expect(nativeWrites[0]).toMatchObject({ id: subjectId, method: 'put', kind: 'like', authorization: 'Bearer token-reader-one' });
  await clickKind('like');
  await until(() => nativeWrites.length === 2 && chips().every((button) => button.getAttribute('aria-pressed') !== 'true'));
  expect(nativeWrites[1]).toMatchObject({ id: subjectId, method: 'delete', kind: null, authorization: 'Bearer token-reader-one' });

  const secondId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
  const oldSecondOwnRead = deferred<NativeReactionRead>();
  queueNativeRead(oldSecondOwnRead);
  const secondOutcome = zoneOutcome(secondId);
  await paint(secondOutcome);
  await until(() => personalCalls.length === 2 && personalCalls[1]!.result !== undefined && ownReads.length === ownReadsBeforeMount + 3);
  expect(personalCalls[1]!.input.data.id).toBe(secondId);
  expect(personalCalls[1]!.gate).toBeDefined();
  const oldSecondPersonal = personalCalls[1]!.result!;
  expect(oldSecondPersonal.library?.provenance?.subjectId).toBe(secondId);

  const thirdId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e07';
  queueNativeRead({ status: 200, data: { kind: null } });
  await paint(zoneOutcome(thirdId));
  await until(() => personalCalls.length === 3 && personalCalls[2]!.result !== undefined && ownReads.length === ownReadsBeforeMount + 4);
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
  await paint(zoneOutcome(fourthId));
  await until(() => personalCalls.length === 4 && personalCalls[3]!.result !== undefined && ownReads.length === ownReadsBeforeMount + 5);
  const oldProviderClient = client;
  replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacementClient.setQueryData(sessionQuery.queryKey, sessionData());
  queueNativeRead({ status: 200, data: { kind: null } });
  await paint(zoneOutcome(fourthId), replacementClient);
  await until(() => ownReads.length === ownReadsBeforeMount + 6 && chips().length > 0 && chips().some((button) => !button.disabled));
  const combinedCountBeforeOldResponse = personalCalls.length;
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
