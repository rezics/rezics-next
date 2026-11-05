import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { QueryClient, QueryClientProvider, QueryObserver, notifyManager } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';

const readerA = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const readerB = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
const subjectA = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const subjectB = '0192f3a0-6c1e-7b2a-9d4e-000000000202';
const realmA = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
const boardA = '0192f3a0-6c1e-7b2a-9d4e-000000000401';
const boardB = '0192f3a0-6c1e-7b2a-9d4e-000000000402';
const boardC = '0192f3a0-6c1e-7b2a-9d4e-000000000403';
const boardD = '0192f3a0-6c1e-7b2a-9d4e-000000000404';
const origin = 'https://api.review.test';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: Error): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const nativeCalls: {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  csrfHeader: string | null;
}[] = [];
const serverCalls: { data: unknown; request: Request }[] = [];
const credentialReads: { subject: string; csrfToken: string | null }[] = [];
const responseHeaders: { name: string; value: string }[] = [];
const membershipPlans: ((request: Request) => Promise<Response>)[] = [];
let realmItems: { realmId: string; name: string; description?: string | null }[] = [];
let boardResponse: (realmId: string, cursor: string | null) => Promise<Response> | Response = () =>
  Response.json({ items: [], next: null });
let serverReader = readerA;
let serverCsrf: string | null = null;
let currentRequest = new Request('https://site.review.test/en/subjects/book/reviews');
let requestHeaders: HeadersInit = {};

const sessionEnv = {
  AUTH_ISSUER: 'https://auth.review.test',
  API_RESOURCE: origin,
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'review-web',
  WEBSITE_CLIENT_KEY: '{}',
  SITE_ORIGINS: 'https://site.review.test',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credential: async () => {
        credentialReads.push({ subject: serverReader, csrfToken: serverCsrf });
        return {
          status: 'active' as const,
          accessToken: `access-${serverReader}`,
          subject: serverReader,
          csrfToken: serverCsrf,
        };
      },
    }),
  },
};

const nativeClient = createKernelClient(origin, {
  fetch: async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    nativeCalls.push({
      method: request.method,
      path: url.pathname,
      query: url.search,
      authorization: request.headers.get('authorization'),
      csrfHeader: request.headers.get('x-csrf-token'),
    });
    if (url.pathname === '/v1/me/realms') {
      const plan = membershipPlans.shift();
      return plan ? plan(request) : Response.json({ items: realmItems, next: null });
    }
    const boardMatch = url.pathname.match(/^\/v1\/realms\/([^/]+)\/boards$/);
    if (boardMatch) return boardResponse(decodeURIComponent(boardMatch[1]!), url.searchParams.get('cursor'));
    throw new Error(`Unexpected native request: ${request.method} ${url.pathname}`);
  },
});

const start = await import('@tanstack/react-start');
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    let validate: ((value: unknown) => unknown) | undefined;
    return {
      validator(next: (value: unknown) => unknown) {
        validate = next;
        return this;
      },
      handler(handler: (input: { data: unknown }) => Promise<unknown>) {
        return async (input: { data?: unknown; headers?: HeadersInit } = {}) => {
          const data = validate ? validate(input.data) : input.data;
          const headers = new Headers(requestHeaders);
          for (const [name, value] of new Headers(input.headers)) headers.set(name, value);
          if (!headers.has('cookie')) headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          currentRequest = new Request('https://site.review.test/en/_server/review-entry', { headers });
          serverCalls.push({ data: structuredClone(data), request: currentRequest });
          return handler({ data });
        };
      },
    };
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.push({ name, value }),
}));
mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => nativeClient, requestLocale: () => 'en' }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.review.test/en/subjects/book/reviews' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Node: window.Node,
  Element: window.Element,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { sessionQuery } = await import('../src/session/query');
const { fingerprintReviewCsrf } = await import('../src/subject/write-review-lifetime');
const { WriteReviewAction, readRealmReviewBoards } = await import('../src/subject/write-review');
const { readMyRealmsPageForReview } = await import('../src/community/space-actions');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

type Session = { state: string; subject: string | null; csrfToken: string | null };
const signedIn = (subject = readerA, csrfToken: string | null = null): Session => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
const realm = (n: number) => ({
  realmId: `0192f3a0-6c1e-7b2a-9d4e-${String(300 + n).padStart(12, '0')}`,
  name: `Realm ${n}`,
  description: null,
});
const reviewBoard = (id: string, title: string, realmId = realmA) => ({
  id,
  realmId,
  title,
  purpose: 'reviews',
  availability: 'available',
  visibility: 'protected',
});
const expectedReader = async (subject = readerA, csrfToken: string | null = null) => ({
  subject,
  csrfFingerprint: await fingerprintReviewCsrf(csrfToken),
});
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
async function until(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function response(items: unknown[], next: string | null = null) {
  return Response.json({ items, next });
}
function membershipCalls() {
  return nativeCalls.filter((call) => call.path === '/v1/me/realms');
}
function boardCalls() {
  return nativeCalls.filter((call) => call.path.endsWith('/boards'));
}

async function createSurface(options: { strict?: boolean; session?: Session } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, options.session ?? signedIn());
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let target = { subjectId: subjectA, subjectTitle: 'Original title', locale: 'en' };
  const action = () =>
    createElement(WriteReviewAction, {
      ...target,
      session: 'signed-in',
    });
  const tree = () =>
    createElement(
      QueryClientProvider,
      { client },
      options.strict ? createElement(StrictMode, null, action()) : action(),
    );
  const render = async (next?: typeof target) => {
    if (next) target = next;
    await act(async () => root.render(tree()));
  };
  const clickWrite = async () => {
    const button = host.querySelector('button');
    if (!button) throw new Error('The write-review button is missing');
    await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  };
  await render();
  return { client, host, render, clickWrite, unmount };
}

afterAll(async () => {
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('one connected review-entry preparation and chooser admits only same-prepared reads and current navigation', async () => {
  await setLocale('en', { reload: false });
  nativeCalls.length = 0;
  serverCalls.length = 0;
  credentialReads.length = 0;
  responseHeaders.length = 0;
  membershipPlans.length = 0;
  realmItems = [realm(1)];
  serverReader = readerA;
  serverCsrf = null;
  requestHeaders = {};
  boardResponse = () => response([]);

  // These are the actual server wrappers. Each actual loadMyRealms or board read prepares once;
  // the server result carries only the identity fingerprint from that same Request object.
  const expectedA = await expectedReader(readerA, null);
  const prepared = await readMyRealmsPageForReview({ data: { expected: expectedA } });
  console.log({ prepared, credentialSubjects: credentialReads.map(({ subject }) => subject), authorized: membershipCalls().map(({ authorization }) => !!authorization) });
  expect(prepared).toMatchObject({
    kind: 'ready',
    page: { signedIn: true, realms: [{ realmId: realmA, name: 'Realm 1' }] },
    provenance: expectedA,
  });
  expect(credentialReads.at(-1)).toEqual({ subject: readerA, csrfToken: null });
  expect(nativeCalls.at(-1)?.authorization).toBe(`Bearer access-${readerA}`);
  expect(nativeCalls.every((call) => call.method === 'GET' && call.csrfHeader === null)).toBe(true);
  expect(JSON.stringify(prepared)).not.toContain(`access-${readerA}`);
  expect(JSON.stringify(prepared)).not.toContain('csrfToken');

  serverReader = readerB;
  const mismatched = await readMyRealmsPageForReview({ data: { expected: expectedA } });
  expect(mismatched).toEqual({ kind: 'mismatch' });
  expect(JSON.stringify(mismatched)).not.toContain('Realm 1');

  // An externally supplied bearer can complete the native read but has no same-prepared subject
  // provenance, so the private page is withheld instead of being stamped with expected state.
  serverReader = readerA;
  const missingProvenance = await readMyRealmsPageForReview({
    data: { expected: expectedA },
    headers: { authorization: 'Bearer external-reader' },
  } as never);
  expect(missingProvenance).toEqual({ kind: 'mismatch' });
  expect(JSON.stringify(missingProvenance)).not.toContain('Realm 1');

  const boardCountBeforeMismatch = boardCalls().length;
  serverReader = readerB;
  const boardMismatch = await readRealmReviewBoards({ data: { realms: [realm(1)], expected: expectedA } });
  expect(boardMismatch).toEqual({ kind: 'mismatch' });
  expect(boardCalls()).toHaveLength(boardCountBeforeMismatch);
  expect(serverCalls.every(({ data }) => !JSON.stringify(data).includes('access-'))).toBe(true);
  expect(serverCalls.every(({ data }) => !JSON.stringify(data).includes('csrfToken'))).toBe(true);

  // StrictMode replay retains the single initial null-CSRF read; expanding while it is pending
  // queues the board lookup until that private result is admitted.
  serverReader = readerA;
  const pageGate = deferred<Response>();
  membershipPlans.push(() => pageGate.promise);
  const baselinePages = membershipCalls().length;
  const surface = await createSurface({ strict: true, session: signedIn(readerA, null) });
  await until(() => membershipCalls().length > baselinePages, 'the pending membership read');
  expect(membershipCalls().length - baselinePages).toBe(1);
  await surface.clickWrite();
  expect(boardCalls()).toHaveLength(boardCountBeforeMismatch);
  pageGate.resolve(response([realm(1)]));
  await until(() => boardCalls().length > boardCountBeforeMismatch, 'the queued board lookup');
  await until(() => (surface.host.textContent ?? '').includes(m.thread_review_no_board()), 'the empty board result');
  expect(boardCalls().slice(boardCountBeforeMismatch)).toHaveLength(1);
  expect(credentialReads.at(-1)).toEqual({ subject: readerA, csrfToken: null });

  const navigations: string[] = [];
  Object.defineProperty(window.location, 'assign', {
    configurable: true,
    value: (href: string) => navigations.push(href),
  });

  // An equal successful session replacement retires the complete previous visit and starts one
  // new preparation. A one-choice result still follows the existing automatic destination once.
  boardResponse = () => response([reviewBoard(boardA, 'Single review board')]);
  const pagesBeforeEqualReplacement = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await until(() => membershipCalls().length > pagesBeforeEqualReplacement, 'the replacement membership read');
  await surface.clickWrite();
  await until(() => navigations.length === 1, 'the single-choice navigation');
  expect(navigations).toEqual([`/en/boards/${boardA}/new?subject=${subjectA}&subjectTitle=Original%20title`]);

  // The existing native board reader still pages in native order, filters purpose/availability/
  // disclosure, and terminates when the cursor repeats. The connected chooser keeps two choices.
  boardResponse = (_realmId, cursor) =>
    cursor === null
      ? response(
          [
            reviewBoard(boardA, 'First review board'),
            { ...reviewBoard(boardB, 'Discussion board'), purpose: 'discussion', visibility: 'published' },
            { ...reviewBoard(boardC, 'Unavailable review board'), availability: 'unavailable' },
            { ...reviewBoard(boardD, 'Taken down review board'), visibility: 'taken_down' },
          ],
          'review-cursor',
        )
      : response([reviewBoard('0192f3a0-6c1e-7b2a-9d4e-000000000405', 'Second review board')], 'review-cursor');
  const pagesBeforeMany = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await until(() => membershipCalls().length > pagesBeforeMany, 'the many-choice membership read');
  const boardsBeforeMany = boardCalls().length;
  await surface.clickWrite();
  await until(() => boardCalls().length >= boardsBeforeMany + 2, 'both native board pages');
  await until(() => surface.host.querySelectorAll('a[href*="/boards/"]').length === 2, 'the filtered chooser');
  expect(
    boardCalls()
      .slice(boardsBeforeMany)
      .map((call) => call.query),
  ).toEqual(['?limit=100', '?limit=100&cursor=review-cursor']);
  expect([...surface.host.querySelectorAll('a[href*="/boards/"]')].map((link) => link.textContent?.trim())).toEqual([
    'First review boardRealm 1',
    'Second review boardRealm 1',
  ]);
  expect(navigations).toHaveLength(1);

  // A same-account-compatible component lifetime still retires on account replacement; the new
  // account performs its own prepared membership and board reads with its own reader provenance.
  serverReader = readerB;
  serverCsrf = 'csrf-b';
  const pagesBeforeAccountReplacement = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerB, 'csrf-b')));
  await until(() => membershipCalls().length > pagesBeforeAccountReplacement, 'the replacement-account page');
  const boardsBeforeAccountReplacement = boardCalls().length;
  await surface.clickWrite();
  await until(() => boardCalls().length >= boardsBeforeAccountReplacement + 2, 'the replacement-account board pages');
  await until(() => (surface.host.textContent ?? '').includes('First review board'), 'the replacement-account choices');
  expect(credentialReads.at(-1)).toEqual({ subject: readerB, csrfToken: 'csrf-b' });
  expect(navigations).toHaveLength(1);

  // A credential refresh for the same account also replaces the owner and binds the new read.
  serverReader = readerA;
  serverCsrf = 'csrf-a';
  boardResponse = () =>
    response([reviewBoard(boardA, 'Refreshed credential choice'), reviewBoard(boardB, 'Second choice')]);
  const pagesBeforeCredentialChange = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, 'csrf-a')));
  await until(() => membershipCalls().length > pagesBeforeCredentialChange, 'the refreshed-credential page');
  const boardsBeforeCredentialChange = boardCalls().length;
  await surface.clickWrite();
  await until(() => boardCalls().length > boardsBeforeCredentialChange, 'the refreshed-credential boards');
  await until(
    () => (surface.host.textContent ?? '').includes('Refreshed credential choice'),
    'the refreshed-credential choices',
  );
  expect(credentialReads.at(-1)).toEqual({ subject: readerA, csrfToken: 'csrf-a' });

  serverReader = readerA;
  serverCsrf = null;

  // Query fetch and observer notifications do not retire healthy work. The pending native board
  // page settles while a session fetch is merely in flight, then its successful replacement retires.
  const oldBoardGate = deferred<Response>();
  boardResponse = () => oldBoardGate.promise;
  const pagesBeforeFetch = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await until(() => membershipCalls().length > pagesBeforeFetch, 'the fetch-control membership read');
  const fetchObserver = new QueryObserver(surface.client, { ...sessionQuery, enabled: false });
  const stopObserver = fetchObserver.subscribe(() => undefined);
  await settle();
  stopObserver();
  await surface.clickWrite();
  const boardCallCountBeforeFetch = boardCalls().length;
  await until(() => boardCalls().length > boardCallCountBeforeFetch, 'the board read before session fetch');
  const sessionGate = deferred<Session>();
  const sessionFetch = surface.client
    .fetchQuery({ queryKey: sessionQuery.queryKey, queryFn: () => sessionGate.promise, staleTime: 0, retry: false })
    .catch(() => undefined);
  await until(() => surface.client.getQueryState(sessionQuery.queryKey)?.fetchStatus === 'fetching', 'fetch status');
  oldBoardGate.resolve(
    response([reviewBoard(boardA, 'Healthy after fetch start'), reviewBoard(boardB, 'Second healthy choice')]),
  );
  await until(
    () => (surface.host.textContent ?? '').includes('Healthy after fetch start'),
    'the healthy pending result',
  );
  expect(membershipCalls().length - pagesBeforeFetch).toBe(1);
  const pagesBeforeFetchSuccess = membershipCalls().length;
  await act(async () => {
    sessionGate.resolve(signedIn(readerA, null));
    await sessionFetch;
  });
  await until(() => membershipCalls().length > pagesBeforeFetchSuccess, 'the successful session-fetch replacement');

  // A current subject/title/locale change retires an outstanding automatic lookup. Resolving the
  // old one-choice result cannot publish or navigate; the new target still gets its own result.
  const targetGate = deferred<Response>();
  const newTargetGate = deferred<Response>();
  let targetBoardCalls = 0;
  boardResponse = () => (targetBoardCalls++ === 0 ? targetGate.promise : newTargetGate.promise);
  await surface.clickWrite();
  const targetBoardCount = boardCalls().length;
  await until(() => boardCalls().length > targetBoardCount, 'the pending old-target boards');
  await surface.render({ subjectId: subjectB, subjectTitle: 'Changed title & name', locale: 'zh-Hant' });
  const pagesAfterTargetChange = membershipCalls().length;
  await until(() => membershipCalls().length > pagesAfterTargetChange, 'the new-target membership read');
  const newTargetBoardStart = boardCalls().length;
  await surface.clickWrite();
  await until(() => boardCalls().length > newTargetBoardStart, 'the current target board read');
  targetGate.resolve(response([reviewBoard(boardA, 'Obsolete single choice')]));
  await settle();
  expect(navigations).toHaveLength(1);
  expect(surface.host.textContent ?? '').not.toContain('Obsolete single choice');
  expect(surface.host.textContent ?? '').toContain(m.thread_review_boards_loading());

  newTargetGate.resolve(
    response([reviewBoard(boardB, 'Current target board'), reviewBoard(boardC, 'Another current board')]),
  );
  await until(() => (surface.host.textContent ?? '').includes('Current target board'), 'the new target choices');
  expect(surface.host.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toContain(
    `/zh-Hant/boards/${boardB}/new?subject=${subjectB}&subjectTitle=Changed%20title%20%26%20name`,
  );

  // The client admits only the first twenty memberships into the unchanged native paginated reader.
  realmItems = Array.from({ length: 25 }, (_, index) => realm(index + 1));
  boardResponse = () => response([]);
  const pagesBeforeFirstTwenty = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await until(() => membershipCalls().length > pagesBeforeFirstTwenty, 'the bounded membership page');
  const firstTwentyBoardStart = boardCalls().length;
  await surface.clickWrite();
  await until(() => boardCalls().length >= firstTwentyBoardStart + 20, 'the first twenty Realm board reads');
  const boundedReads = boardCalls().slice(firstTwentyBoardStart);
  expect(boundedReads).toHaveLength(20);
  expect(boundedReads.map((call) => call.path.split('/')[3])).toEqual(
    Array.from({ length: 20 }, (_, index) => realm(index + 1).realmId),
  );

  // A failed session read and removal retire in-flight membership data. After recovery the new
  // owner reads again; stale completion/finally cannot replace its pending state.
  const stalePageGate = deferred<Response>();
  membershipPlans.push(() => stalePageGate.promise);
  const pagesBeforeError = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await until(() => membershipCalls().length > pagesBeforeError, 'the page pending session error');
  const failure = surface.client
    .fetchQuery({
      queryKey: sessionQuery.queryKey,
      queryFn: async () => {
        throw new Error('session read failed');
      },
      staleTime: 0,
      retry: false,
    })
    .catch(() => undefined);
  await until(
    () =>
      surface.client.getQueryState(sessionQuery.queryKey)?.fetchStatus === 'idle' &&
      !!surface.client.getQueryState(sessionQuery.queryKey)?.error,
    'the failed session read',
  );
  stalePageGate.resolve(response([realm(1)]));
  await failure;
  await settle();
  expect(boardCalls().length).toBe(firstTwentyBoardStart + 20);
  await surface.clickWrite();
  expect(surface.host.textContent ?? '').toContain(m.thread_review_unavailable());
  expect(surface.host.querySelectorAll('a[href*="/boards/"]')).toHaveLength(0);

  const staleRemovedGate = deferred<Response>();
  membershipPlans.push(() => staleRemovedGate.promise);
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  const pagesBeforeRemoval = membershipCalls().length;
  await until(() => membershipCalls().length > pagesBeforeRemoval, 'the page pending cache removal');
  await act(async () => surface.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true }));
  staleRemovedGate.resolve(response([realm(1)]));
  await settle();
  expect(boardCalls().length).toBe(firstTwentyBoardStart + 20);

  // The observer records both sides of an A-to-B-to-A batch. The fresh owner remains usable while
  // the prior page settles without publication or a queued board read.
  const staleAbaGate = deferred<Response>();
  membershipPlans.push(() => staleAbaGate.promise);
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  const pagesBeforeAba = membershipCalls().length;
  await until(() => membershipCalls().length > pagesBeforeAba, 'the page pending batched ABA');
  const freshPagesBeforeAba = membershipCalls().length;
  realmItems = [realm(1)];
  await act(async () =>
    notifyManager.batch(() => {
      surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerB, 'csrf-b'));
      surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null));
    }),
  );
  await until(() => membershipCalls().length > freshPagesBeforeAba, 'the fresh ABA owner read');
  staleAbaGate.resolve(response([realm(1)]));
  await settle();
  expect(boardCalls().length).toBe(firstTwentyBoardStart + 20);
  const freshBoardsAfterAba = boardCalls().length;
  await surface.clickWrite();
  await until(() => boardCalls().length > freshBoardsAfterAba, 'the usable ABA replacement owner');
  await until(
    () => (surface.host.textContent ?? '').includes(m.thread_review_no_board()),
    'the ABA owner empty choices',
  );

  // Unknown, signed-out and signed-in-without-subject cache states are never ready for a private read.
  const pagesBeforeNotReady = membershipCalls().length;
  await act(async () =>
    surface.client.setQueryData(sessionQuery.queryKey, { state: 'unknown', subject: null, csrfToken: null }),
  );
  await settle();
  expect(membershipCalls()).toHaveLength(pagesBeforeNotReady);
  await act(async () =>
    surface.client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
  );
  await settle();
  expect(membershipCalls()).toHaveLength(pagesBeforeNotReady);
  await act(async () =>
    surface.client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: null, csrfToken: null }),
  );
  await settle();
  expect(membershipCalls()).toHaveLength(pagesBeforeNotReady);

  // A successful current page with zero realms is still a real empty result; the final unmount
  // immediately disconnects pending work so its later one-choice settlement cannot navigate.
  realmItems = [];
  const pagesBeforeEmpty = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await until(() => membershipCalls().length > pagesBeforeEmpty, 'the recovered current page');
  await surface.clickWrite();
  await until(
    () => (surface.host.textContent ?? '').includes(m.thread_review_no_realms()),
    'the empty membership result',
  );

  realmItems = [realm(1)];
  const pagesBeforeFinal = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await until(() => membershipCalls().length > pagesBeforeFinal, 'the final mounted page');
  const finalBoardGate = deferred<Response>();
  boardResponse = () => finalBoardGate.promise;
  await surface.clickWrite();
  const finalBoardStart = boardCalls().length;
  await until(() => boardCalls().length > finalBoardStart, 'the final pending board lookup');
  const navigationCount = navigations.length;
  await surface.unmount();
  finalBoardGate.resolve(response([reviewBoard(boardA, 'Unmounted single choice')]));
  await settle();
  expect(navigations).toHaveLength(navigationCount);
  expect(serverCalls.every(({ data }) => !JSON.stringify(data).includes('access-'))).toBe(true);
  expect(
    responseHeaders.every(({ name, value }) => name.toLowerCase() === 'cache-control' && value === 'private, no-store'),
  ).toBe(true);
});
