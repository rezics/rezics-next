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
const returnToA = `/en/subjects/${subjectA}/work/reviews?realm=${realmA}#subject-community-reviews`;
const returnToB = `/zh-Hant/subjects/${subjectB}/work/reviews?realm=${realmA}#subject-community-reviews`;
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
let serverReader = readerA;
let serverCsrf: string | null = null;
let currentRequest = new Request('https://site.review.test/en/subjects/book/reviews');
let requestHeaders: HeadersInit = {};
const subjectSource = { partition: 2, epoch: 1, position: '18' };
const spaceId = '0192f3a0-6c1e-7b2a-9d4e-000000000501';
const realmHeadRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000502';

function destinationItem(id: string, title: string, subjectId: string) {
  return {
    id,
    title,
    purpose: 'reviews' as const,
    actions: { createReview: 'allowed' as const },
    native: {
      kind: 'review' as const,
      boardId: id,
      subjectIds: [subjectId] as [string],
      subjectSource,
      realmHeadRevisionId,
      boardSecurityRevision: '1',
    },
  };
}

function destinationPage(
  realmId: string,
  subjectId: string,
  items: ReturnType<typeof destinationItem>[],
  next: string | null = null,
  state: 'choices' | 'sparse' | 'no-destinations' | 'exhausted' = items.length > 0
    ? 'choices'
    : next
      ? 'sparse'
      : 'no-destinations',
) {
  return Response.json({
    state,
    viewer: { state: 'current' },
    context: {
      subject: { id: subjectId, label: null, source: subjectSource },
      realm: {
        id: realmId,
        title: realmItems.find((entry) => entry.realmId === realmId)?.name ?? 'Realm',
        spaceId,
        headRevisionId: realmHeadRevisionId,
      },
    },
    items,
    next,
  });
}

let destinationRead: (
  realmId: string,
  subjectId: string,
  boardId: string | null,
  cursor: string | null,
) => Promise<Response> | Response = (realmId, subjectId) =>
  destinationPage(realmId, subjectId, [destinationItem(boardA, 'Single review board', subjectId)]);

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
    const destinationMatch = url.pathname.match(/^\/v1\/realms\/([^/]+)\/review-destinations$/);
    if (destinationMatch)
      return destinationRead(
        decodeURIComponent(destinationMatch[1]!),
        url.searchParams.get('subjectId')!,
        url.searchParams.get('boardId'),
        url.searchParams.get('cursor'),
      );
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
const { WriteReviewAction } = await import('../src/subject/write-review');
const { reviewThreadHref } = await import('../src/threads/review-policy');
const { readReviewDestination } = await import('../src/threads/review-destination/server');
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
function destinationCalls() {
  return nativeCalls.filter((call) => call.path.endsWith('/review-destinations'));
}

async function createSurface(options: { strict?: boolean; session?: Session } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, options.session ?? signedIn());
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let target = { subjectId: subjectA, subjectTitle: 'Original title', locale: 'en', returnTo: returnToA };
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
  const render = async (next?: Partial<typeof target>) => {
    if (next) target = { ...target, ...next };
    await act(async () => root.render(tree()));
  };
  const clickText = async (label: string) => {
    await until(
      () => [...host.querySelectorAll('button')].some((button) => button.textContent?.trim() === label),
      label,
    );
    const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    if (!button) throw new Error(`The button is missing: ${label}`);
    await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  };
  const clickWrite = () => clickText(m.thread_review_write());
  const clickRealm = async (name: string) => {
    await until(() => [...host.querySelectorAll('li')].some((item) => item.textContent?.trim() === name), name);
    const item = [...host.querySelectorAll('li')].find((entry) => entry.textContent?.trim() === name);
    const button = item?.querySelector('button');
    if (!button) throw new Error(`The Realm choice is missing: ${name}`);
    await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  };
  const clickBoard = async (title: string) => {
    await until(() => [...host.querySelectorAll('li')].some((item) => item.textContent?.includes(title)), title);
    const item = [...host.querySelectorAll('li')].find((entry) => entry.textContent?.includes(title));
    const button = item?.querySelector('button');
    if (!button) throw new Error(`The Board choice is missing: ${title}`);
    await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  };
  await render();
  return { client, host, render, clickText, clickWrite, clickRealm, clickBoard, unmount };
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
  destinationRead = (realmId, subjectId) => destinationPage(realmId, subjectId, []);

  // These are the actual server wrappers. Each actual loadMyRealms or board read prepares once;
  // the server result carries only the identity fingerprint from that same Request object.
  const expectedA = await expectedReader(readerA, null);
  const prepared = await readMyRealmsPageForReview({ data: { expected: expectedA } });
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

  const boardCountBeforeMismatch = destinationCalls().length;
  serverReader = readerB;
  const boardMismatch = await readReviewDestination({
    data: { realmId: realmA, subjectId: subjectA, locale: 'en', expected: expectedA },
  });
  expect(boardMismatch).toEqual({ kind: 'mismatch' });
  expect(destinationCalls()).toHaveLength(boardCountBeforeMismatch);
  expect(serverCalls.every(({ data }) => !JSON.stringify(data).includes('access-'))).toBe(true);
  expect(serverCalls.every(({ data }) => !JSON.stringify(data).includes('csrfToken'))).toBe(true);

  // StrictMode does not duplicate the user-triggered private read. Realm and Board destinations
  // remain unopened until the reader chooses the exact Realm.
  serverReader = readerA;
  const pageGate = deferred<Response>();
  membershipPlans.push(() => pageGate.promise);
  const baselinePages = membershipCalls().length;
  const surface = await createSurface({ strict: true, session: signedIn(readerA, null) });
  expect(membershipCalls()).toHaveLength(baselinePages);
  await surface.clickWrite();
  await until(() => membershipCalls().length > baselinePages, 'the pending membership read');
  expect(membershipCalls().length - baselinePages).toBe(1);
  expect(destinationCalls()).toHaveLength(boardCountBeforeMismatch);
  pageGate.resolve(response([realm(1)]));
  await surface.clickRealm('Realm 1');
  await until(() => destinationCalls().length > boardCountBeforeMismatch, 'the queued board lookup');
  await until(() => (surface.host.textContent ?? '').includes(m.thread_review_no_board()), 'the empty board result');
  expect(destinationCalls().slice(boardCountBeforeMismatch)).toHaveLength(1);
  expect(credentialReads.at(-1)).toEqual({ subject: readerA, csrfToken: null });

  const navigations: string[] = [];
  Object.defineProperty(window.location, 'assign', {
    configurable: true,
    value: (href: string) => navigations.push(href),
  });

  // An equal successful session replacement retires the visit. Even one eligible Board requires
  // deliberate selection and exact native inspection before navigation.
  destinationRead = (realmId, subjectId) =>
    destinationPage(realmId, subjectId, [destinationItem(boardA, 'Single review board', subjectId)]);
  const pagesBeforeEqualReplacement = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeEqualReplacement, 'the replacement membership read');
  await surface.clickRealm('Realm 1');
  await until(() => (surface.host.textContent ?? '').includes('Single review board'), 'the sole Board choice');
  expect(navigations).toHaveLength(0);
  await surface.clickBoard('Single review board');
  await until(() => navigations.length === 1, 'the single-choice navigation');
  expect(navigations).toEqual([reviewThreadHref('en', boardA, subjectA, 'Original title', returnToA)]);
  expect(destinationCalls().at(-1)?.query).toContain(`boardId=${boardA}`);

  // Sparse destination pages continue only on explicit More with the exact original cursor.
  destinationRead = (realmId, subjectId, boardId, cursor) =>
    boardId
      ? destinationPage(realmId, subjectId, [destinationItem(boardA, 'First review board', subjectId)])
      : cursor === null
        ? destinationPage(realmId, subjectId, [], 'review-cursor', 'sparse')
        : destinationPage(realmId, subjectId, [
            destinationItem(boardA, 'First review board', subjectId),
            destinationItem(boardB, 'Second review board', subjectId),
          ]);
  const pagesBeforeMany = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeMany, 'the many-choice membership read');
  const boardsBeforeMany = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(
    () => surface.host.textContent?.includes(m.thread_review_sparse()) === true,
    'the sparse destination page',
  );
  expect(destinationCalls()).toHaveLength(boardsBeforeMany + 1);
  await surface.clickText(m.thread_review_more());
  await until(() => (surface.host.textContent ?? '').includes('Second review board'), 'the continued choices');
  expect(destinationCalls()).toHaveLength(boardsBeforeMany + 2);
  expect(destinationCalls()[boardsBeforeMany]?.query).not.toContain('cursor=');
  expect(destinationCalls()[boardsBeforeMany + 1]?.query).toContain('cursor=review-cursor');
  expect(surface.host.querySelectorAll('section[aria-labelledby="review-board-heading"] li')).toHaveLength(2);
  expect(navigations).toHaveLength(1);

  // A same-account-compatible component lifetime still retires on account replacement; the new
  // account performs its own prepared membership and board reads with its own reader provenance.
  serverReader = readerB;
  serverCsrf = 'csrf-b';
  destinationRead = (realmId, subjectId) =>
    destinationPage(realmId, subjectId, [destinationItem(boardA, 'Account replacement choice', subjectId)]);
  const pagesBeforeAccountReplacement = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerB, 'csrf-b')));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeAccountReplacement, 'the replacement-account page');
  const boardsBeforeAccountReplacement = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(() => destinationCalls().length > boardsBeforeAccountReplacement, 'the replacement-account destination');
  await until(
    () => (surface.host.textContent ?? '').includes('Account replacement choice'),
    'the replacement-account choice',
  );
  expect(credentialReads.at(-1)).toEqual({ subject: readerB, csrfToken: 'csrf-b' });
  expect(navigations).toHaveLength(1);

  // A credential refresh for the same account also replaces the owner and binds the new read.
  serverReader = readerA;
  serverCsrf = 'csrf-a';
  destinationRead = (realmId, subjectId) =>
    destinationPage(realmId, subjectId, [
      destinationItem(boardA, 'Refreshed credential choice', subjectId),
      destinationItem(boardB, 'Second choice', subjectId),
    ]);
  const pagesBeforeCredentialChange = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, 'csrf-a')));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeCredentialChange, 'the refreshed-credential page');
  const boardsBeforeCredentialChange = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(() => destinationCalls().length > boardsBeforeCredentialChange, 'the refreshed-credential boards');
  await until(
    () => (surface.host.textContent ?? '').includes('Refreshed credential choice'),
    'the refreshed-credential choices',
  );
  expect(credentialReads.at(-1)).toEqual({ subject: readerA, csrfToken: 'csrf-a' });

  serverReader = readerA;
  serverCsrf = null;

  // Query fetch and observer notifications do not retire healthy work. The pending native destination
  // page settles while a session fetch is merely in flight, then its successful replacement retires.
  const oldBoardGate = deferred<Response>();
  destinationRead = (_realmId, _subjectId, boardId) =>
    boardId
      ? destinationPage(realmA, subjectA, [destinationItem(boardA, 'Inspected Board', subjectA)])
      : oldBoardGate.promise;
  const pagesBeforeFetch = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeFetch, 'the fetch-control membership read');
  const boardCallCountBeforeFetch = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  const fetchObserver = new QueryObserver(surface.client, { ...sessionQuery, enabled: false });
  const stopObserver = fetchObserver.subscribe(() => undefined);
  await settle();
  stopObserver();
  await until(() => destinationCalls().length > boardCallCountBeforeFetch, 'the board read before session fetch');
  const sessionGate = deferred<Session>();
  const sessionFetch = surface.client
    .fetchQuery({ queryKey: sessionQuery.queryKey, queryFn: () => sessionGate.promise, staleTime: 0, retry: false })
    .catch(() => undefined);
  await until(() => surface.client.getQueryState(sessionQuery.queryKey)?.fetchStatus === 'fetching', 'fetch status');
  oldBoardGate.resolve(
    destinationPage(realmA, subjectA, [
      destinationItem(boardA, 'Healthy after fetch start', subjectA),
      destinationItem(boardB, 'Second healthy choice', subjectA),
    ]),
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
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeFetchSuccess, 'the successful session-fetch replacement');

  // A current subject/title/locale change retires an outstanding selected-Realm lookup. Resolving
  // the old one-choice result cannot publish or navigate; the new target gets its own destinations.
  const targetGate = deferred<Response>();
  const newTargetGate = deferred<Response>();
  destinationRead = (realmId, subjectId, boardId) =>
    boardId
      ? destinationPage(realmId, subjectId, [destinationItem(boardId, 'Exact inspected Board', subjectId)])
      : subjectId === subjectA
        ? targetGate.promise
        : newTargetGate.promise;
  const targetBoardCount = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(() => destinationCalls().length > targetBoardCount, 'the pending old-target boards');
  await surface.render({
    subjectId: subjectB,
    subjectTitle: 'Changed title & name',
    locale: 'zh-Hant',
    returnTo: returnToB,
  });
  const pagesAfterTargetChange = membershipCalls().length;
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesAfterTargetChange, 'the new-target membership read');
  const newTargetBoardStart = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(() => destinationCalls().length > newTargetBoardStart, 'the current target board read');
  targetGate.resolve(destinationPage(realmA, subjectA, [destinationItem(boardA, 'Obsolete single choice', subjectA)]));
  await settle();
  expect(navigations).toHaveLength(1);
  expect(surface.host.textContent ?? '').not.toContain('Obsolete single choice');
  expect(surface.host.textContent ?? '').toContain(m.thread_review_preparing());

  newTargetGate.resolve(
    destinationPage(realmA, subjectB, [
      destinationItem(boardB, 'Current target board', subjectB),
      destinationItem(boardC, 'Another current board', subjectB),
    ]),
  );
  await until(() => (surface.host.textContent ?? '').includes('Current target board'), 'the new target choices');
  await surface.clickBoard('Current target board');
  await until(() => navigations.length === 2, 'the replacement-target navigation');
  expect(navigations[1]).toBe(reviewThreadHref('zh-Hant', boardB, subjectB, 'Changed title & name', returnToB));

  // Replacing only the source address retires the pending visit and sends the current exact address
  // through the same composer route after a fresh Realm and Board read.
  const staleAddressGate = deferred<Response>();
  const returnToReplacement = `/zh-Hant/subjects/${subjectB}/work/reviews?realm=${realmA}#subject-community-review-list`;
  let addressRead = 0;
  destinationRead = (realmId, subjectId, boardId) => {
    if (boardId)
      return destinationPage(realmId, subjectId, [destinationItem(boardId, 'Address-bound Board', subjectId)]);
    return addressRead++ === 0
      ? staleAddressGate.promise
      : destinationPage(realmId, subjectId, [destinationItem(boardD, 'Address-bound Board', subjectId)]);
  };
  const pagesBeforeAddressChange = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeAddressChange, 'the address-bound membership read');
  const addressBoardsBefore = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(() => destinationCalls().length > addressBoardsBefore, 'the pending original-address lookup');
  await surface.render({ returnTo: returnToReplacement });
  const pagesAfterAddressChange = membershipCalls().length;
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesAfterAddressChange, 'the replacement-address membership read');
  const replacementBoardsBefore = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(
    () => (surface.host.textContent ?? '').includes('Address-bound Board'),
    'the replacement-address Board choices',
  );
  staleAddressGate.resolve(
    destinationPage(realmA, subjectB, [destinationItem(boardC, 'Stale address choice', subjectB)]),
  );
  await settle();
  expect(navigations).toHaveLength(2);
  expect(surface.host.textContent ?? '').not.toContain('Stale address choice');
  expect(destinationCalls().length).toBeGreaterThan(replacementBoardsBefore);
  await surface.clickBoard('Address-bound Board');
  await until(() => navigations.length === 3, 'the address-replacement navigation');
  expect(navigations[2]).toBe(
    reviewThreadHref('zh-Hant', boardD, subjectB, 'Changed title & name', returnToReplacement),
  );

  // The chooser retains the original twenty-Realm window and reads destinations only for the
  // deliberately selected Realm, rather than walking membership or Board populations.
  realmItems = Array.from({ length: 25 }, (_, index) => realm(index + 1));
  destinationRead = (realmId, subjectId) => destinationPage(realmId, subjectId, []);
  const pagesBeforeFirstTwenty = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeFirstTwenty, 'the bounded membership page');
  const realmChoices = surface.host.querySelectorAll('section[aria-labelledby="review-realm-heading"] li');
  expect(realmChoices).toHaveLength(20);
  const firstDestination = destinationCalls().length;
  await surface.clickRealm(realm(1).name);
  await until(() => destinationCalls().length > firstDestination, 'the selected Realm destinations');
  expect(destinationCalls().slice(firstDestination)).toHaveLength(1);
  expect(destinationCalls().at(-1)?.path).toBe(`/v1/realms/${realm(1).realmId}/review-destinations`);
  await until(
    () => (surface.host.textContent ?? '').includes(m.thread_review_no_board()),
    'the selected Realm empty page',
  );

  // A failed session read and removal retire in-flight membership data. After recovery the new
  // owner reads again; stale completion/finally cannot replace its pending state.
  const stalePageGate = deferred<Response>();
  membershipPlans.push(() => stalePageGate.promise);
  const pagesBeforeError = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await surface.clickWrite();
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
  expect(destinationCalls()).toHaveLength(firstDestination + 1);
  expect(surface.host.textContent ?? '').toContain(m.thread_review_unavailable());
  expect(surface.host.querySelectorAll('ul[aria-label]')).toHaveLength(0);

  const staleRemovedGate = deferred<Response>();
  membershipPlans.push(() => staleRemovedGate.promise);
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  const pagesBeforeRemoval = membershipCalls().length;
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeRemoval, 'the page pending cache removal');
  await act(async () => surface.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true }));
  staleRemovedGate.resolve(response([realm(1)]));
  await settle();
  expect(destinationCalls()).toHaveLength(firstDestination + 1);

  // The observer records both sides of an A-to-B-to-A batch. The fresh owner remains usable while
  // the prior page settles without publication or a queued board read.
  const staleAbaGate = deferred<Response>();
  membershipPlans.push(() => staleAbaGate.promise);
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  const pagesBeforeAba = membershipCalls().length;
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeAba, 'the page pending batched ABA');
  const freshPagesBeforeAba = membershipCalls().length;
  realmItems = [realm(1)];
  await act(async () =>
    notifyManager.batch(() => {
      surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerB, 'csrf-b'));
      surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null));
    }),
  );
  await surface.clickWrite();
  await until(() => membershipCalls().length > freshPagesBeforeAba, 'the fresh ABA owner read');
  staleAbaGate.resolve(response([realm(1)]));
  await settle();
  expect(destinationCalls()).toHaveLength(firstDestination + 1);
  const freshBoardsAfterAba = destinationCalls().length;
  await surface.clickRealm('Realm 1');
  await until(() => destinationCalls().length > freshBoardsAfterAba, 'the usable ABA replacement owner');
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
  // immediately disconnects a pending exact Board inspection so its later settlement cannot navigate.
  realmItems = [];
  const pagesBeforeEmpty = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeEmpty, 'the recovered current page');
  await until(
    () => (surface.host.textContent ?? '').includes(m.thread_review_no_realms()),
    'the empty membership result',
  );

  realmItems = [realm(1)];
  const pagesBeforeFinal = membershipCalls().length;
  await act(async () => surface.client.setQueryData(sessionQuery.queryKey, signedIn(readerA, null)));
  const finalBoardGate = deferred<Response>();
  destinationRead = (realmId, subjectId, boardId) =>
    boardId
      ? finalBoardGate.promise
      : destinationPage(realmId, subjectId, [destinationItem(boardA, 'Unmounted single choice', subjectId)]);
  await surface.clickWrite();
  await until(() => membershipCalls().length > pagesBeforeFinal, 'the final mounted page');
  await surface.clickRealm('Realm 1');
  const finalBoardStart = destinationCalls().length;
  await until(() => (surface.host.textContent ?? '').includes('Unmounted single choice'), 'the final Board choice');
  await surface.clickBoard('Unmounted single choice');
  await until(
    () => destinationCalls().length > finalBoardStart && destinationCalls().at(-1)?.query.includes(`boardId=${boardA}`),
    'the final pending exact inspection',
  );
  const navigationCount = navigations.length;
  await surface.unmount();
  finalBoardGate.resolve(
    destinationPage(realmA, subjectA, [destinationItem(boardA, 'Unmounted single choice', subjectA)]),
  );
  await settle();
  expect(navigations).toHaveLength(navigationCount);
  expect(serverCalls.every(({ data }) => !JSON.stringify(data).includes('access-'))).toBe(true);
  expect(
    responseHeaders.every(({ name, value }) => name.toLowerCase() === 'cache-control' && value === 'private, no-store'),
  ).toBe(true);
});
