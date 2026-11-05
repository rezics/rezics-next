import { afterAll, expect, mock, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import accounts from '../src/kernel/recorded/accounts.json';
import { current, id, later, selected } from '../src/stories/exact-revision/fixture';
import type { ExactRevisionState } from '../src/threads/exact-revision';
import type { ExactRevisionVisit } from '../src/threads/exact-revision-caller';
import type { HistoricalReadBinding, HistoricalReadEnvelope } from '../src/threads/historical-reader-provenance';

// One production-composition regression; its assertions are intentionally UNRUN at this boundary.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/posts/example/revisions/example' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
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
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

type Session = { state: 'signed-in' | 'signed-out' | 'unknown'; subject: string | null; csrfToken: string | null };
const readerId = selected.authorId;
const session: Session = { state: 'signed-in', subject: readerId, csrfToken: null };
const anonymous: Session = { state: 'signed-out', subject: null, csrfToken: null };
const privateToken = 'private-reader-bearer';
const privateCsrf = 'private-reader-csrf';
const mediaId = id(71);
const privatePost = {
  ...selected,
  mediaIds: [mediaId],
  body: {
    ...selected.body,
    doc: {
      ...selected.body.doc,
      content: [
        ...(selected.body.doc.content ?? []),
        { type: 'image', attrs: { id: 'historical-reader-image', src: mediaId, alt: 'Private revision artwork' } },
      ],
    },
  },
};
const author = {
  ...accounts.accounts[0]!,
  id: readerId,
  displayName: 'Private history author',
  state: 'active' as const,
  handle: 'history-reader',
};
const publicPostId = id(72);
const publicRevisionId = id(73);
const publicPost = {
  ...selected,
  id: publicPostId,
  revisionId: publicRevisionId,
  body: {
    ...selected.body,
    doc: {
      ...selected.body.doc,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Anonymous public revision' }] }],
    },
  },
};

type NativeCall = {
  path: string;
  method: string;
  cursor: string | null;
  limit: string | null;
  authorization: string | null;
};
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

let activeServerSubject: string | null = readerId;
let activeServerToken: string | null = privateToken;
let activeServerCsrf: string | null = privateCsrf;
let hasSessionCookie = true;
let explicitAuthorization: string | null = null;
let deferNextHistoryCursor = false;
let deferredHistory: Deferred<Response> | undefined;
let deferNextExact = false;
let deferredExact: Deferred<Response> | undefined;
let failNextExact = false;
const nativeCalls: NativeCall[] = [];
const exactCalls: NativeCall[] = [];
const historyCalls: NativeCall[] = [];
const editionReads: { postId: string; revisionId: string }[] = [];
const env = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'historical-reader-test',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (value: string) => value,
    get: () => ({
      credential: async () =>
        activeServerSubject && activeServerToken
          ? {
              status: 'active' as const,
              subject: activeServerSubject,
              accessToken: activeServerToken,
              csrfToken: activeServerCsrf,
            }
          : { status: 'absent' as const },
      credentialIfFresh: async () =>
        activeServerSubject && activeServerToken
          ? {
              status: 'active' as const,
              subject: activeServerSubject,
              accessToken: activeServerToken,
              csrfToken: activeServerCsrf,
            }
          : { status: 'absent' as const },
    }),
  },
};

function requestForReader() {
  const headers = new Headers();
  if (hasSessionCookie) headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
  if (explicitAuthorization) headers.set('authorization', explicitAuthorization);
  return new Request('https://site.test/en/thread', { headers });
}

function presentation(idValue: string) {
  return {
    id: idValue,
    containerId: selected.threadId,
    digest: 'a'.repeat(64),
    width: 240,
    height: 160,
    variants: [{ format: 'webp', width: 240, height: 160 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
}

async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const authorization = request.headers.get('authorization');
  const call: NativeCall = {
    path: url.pathname,
    method: request.method,
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit'),
    authorization,
  };
  nativeCalls.push(call);

  const exactPath = /^\/v1\/posts\/([^/]+)\/revisions\/([^/]+)$/.exec(url.pathname);
  if (exactPath) {
    exactCalls.push(call);
    if (exactPath[1] === publicPostId && exactPath[2] === publicRevisionId) return Response.json({ post: publicPost });
    if (authorization !== `Bearer ${privateToken}`) return Response.json({ code: 'not_found' }, { status: 404 });
    if (failNextExact) {
      failNextExact = false;
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    }
    if (deferNextExact) {
      deferNextExact = false;
      deferredExact = deferred<Response>();
      return deferredExact.promise;
    }
    return Response.json({ post: privatePost });
  }

  const historyPath = /^\/v1\/posts\/([^/]+)\/revisions$/.exec(url.pathname);
  if (historyPath) {
    historyCalls.push(call);
    if (historyPath[1] === publicPostId && authorization === null)
      return Response.json({ revisions: [publicPost], next: null });
    if (historyPath[1] !== selected.id || authorization !== `Bearer ${privateToken}`)
      return Response.json({ code: 'not_found' }, { status: 404 });
    if (call.cursor && deferNextHistoryCursor) {
      deferNextHistoryCursor = false;
      deferredHistory = deferred<Response>();
      return deferredHistory.promise;
    }
    return Response.json({
      revisions: call.cursor ? [later] : [privatePost],
      next: call.cursor ? null : 'history/cursor+1',
    });
  }

  if (url.pathname === `/v1/threads/${selected.threadId}`) return Response.json(current);
  if (url.pathname === '/v1/accounts') return Response.json({ accounts: [author] });
  if (url.pathname === '/v1/media/presentations') {
    const body = (await request.json()) as { ids?: string[] };
    return Response.json({ images: (body.ids ?? []).filter((entry) => entry === mediaId).map(presentation) });
  }
  if (url.pathname === `/v1/subjects/${selected.subjectIds[0]}`)
    return Response.json({
      subject: { id: selected.subjectIds[0], type: 'subject', labels: { en: 'Historical subject' } },
      summary: { types: ['subject'], label: { value: 'Historical subject' } },
    });
  if (url.pathname === `/v1/subjects/${selected.subjectIds[0]}/ratings/${selected.voteCitation!.questionId}/vote`)
    return Response.json({ units: 9000, revision: 4 });
  throw new Error(`Unexpected native request: ${request.method} ${url.pathname}`);
}

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: requestForReader,
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}));
mock.module('cloudflare:workers', () => ({ env }));
const { createKernelClient } = await import('@rezics/client');
mock.module('../src/kernel/client', () => ({
  kernelClient: () => {
    return createKernelClient('https://kernel.test', {
      fetch: Object.assign(nativeFetch, { preconnect() {} }),
    });
  },
}));
mock.module('../src/content-editions/edition-create-actions', () => ({
  readEditionCreateEntry: async ({ data }: { data: { postId: string; revisionId: string } }) => {
    editionReads.push({ ...data });
    return { kind: 'available' as const };
  },
}));

const { QueryClient, QueryClientProvider, dehydrate, hydrate } = await import('@tanstack/react-query');
const startCore = Bun.resolveSync('@tanstack/start-server-core', import.meta.dir);
const serovalPath = Bun.resolveSync('seroval', dirname(startCore));
const seroval = (await import(serovalPath)) as {
  serialize(value: unknown): string;
  deserialize<T>(value: string): T;
};
const { createRoot } = await import('react-dom/client');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const { readExactRevision } = await import('../src/threads/exact-revision-read');
const { readPostHistory } = await import('../src/threads/reads');
const { readExactRevisionVisit, ExactRevisionCaller } = await import('../src/threads/exact-revision-caller');
const { PostHistory } = await import('../src/threads/post-history');
const { sessionCsrfToken } = await import('../src/session/query');
const identity = { postId: selected.id, revisionId: selected.revisionId };
const cursor = 'history/cursor+1';
const authority = {};

async function exactVisit(
  client: InstanceType<typeof QueryClient>,
  idValue = identity,
  mode: 'anonymous' | 'session' = 'session',
  locale = 'en',
) {
  return readExactRevisionVisit(client, idValue, locale, mode, (binding: HistoricalReadBinding) =>
    readExactRevision({ data: { ...idValue, locale, credentialMode: mode, binding } }),
  );
}

async function serializeValue<T>(value: T): Promise<{ wire: string; parsed: T }> {
  const wire = seroval.serialize(value);
  return { wire, parsed: seroval.deserialize<T>(wire) };
}

function serializeVisit(visit: ExactRevisionVisit) {
  return serializeValue(visit);
}

type HarnessProps = {
  exactIdentity?: typeof identity;
  locale?: string;
  mode?: 'anonymous' | 'session';
  postId?: string;
  viewerId?: string;
  anonymousReader?: boolean;
  readAuthority?: object;
  onRetry?: () => void;
};

function createHarness(client: InstanceType<typeof QueryClient>, visit: ExactRevisionVisit, options?: HarnessProps) {
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  let retry = options?.onRetry ?? (() => {});
  let props: {
    visit: ExactRevisionVisit;
    identity: typeof identity;
    locale: string;
    mode: 'anonymous' | 'session';
    postId: string;
    viewerId: string | undefined;
    readAuthority: object;
  } = {
    visit,
    identity: options?.exactIdentity ?? identity,
    locale: options?.locale ?? 'en',
    mode: options?.mode ?? 'session',
    postId: options?.postId ?? selected.id,
    viewerId: options?.viewerId ?? (options?.anonymousReader ? undefined : readerId),
    readAuthority: options?.readAuthority ?? authority,
  };
  const root = createRoot(host);
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <ExactRevisionCaller
          visit={props.visit}
          identity={props.identity}
          locale={props.locale}
          credentialMode={props.mode}
          loading={false}
          onRetry={retry}
        />
        <PostHistory postId={props.postId} viewerId={props.viewerId} readAuthority={props.readAuthority} review />
      </QueryClientProvider>
    </StrictMode>
  );
  return {
    host,
    async render() {
      await act(async () => {
        root.render(tree());
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      await act(async () => root.render(tree()));
    },
    setRetry(value: () => void) {
      retry = value;
    },
    root,
    async unmount() {
      await act(async () => root.unmount());
      await new Promise((resolve) => setTimeout(resolve, 0));
      host.remove();
    },
  };
}

function retainButton(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  const key = Object.getOwnPropertyNames(button!).find((name) => name.startsWith('__reactProps$'));
  const props = (button as unknown as Record<string, { onClick?: () => void }>)[key!];
  expect(typeof props?.onClick).toBe('function');
  return props!.onClick!;
}

async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // Explicit inspection replaces the former automatic mounting of every returned document.
  const region = host.querySelector<HTMLElement>('section > ol')?.parentElement;
  if (region && !region.hidden && !region.querySelector('[data-history-inspector]')) {
    const inspect = region.querySelector<HTMLButtonElement>('[data-history-inspect="0"]');
    if (inspect) await act(async () => inspect.click());
  }
}

function exactDisclosure(host: HTMLElement) {
  expect(host.textContent).toContain('The original edition leaves room for the reader to pause.');
  expect(host.textContent).toContain('CC-BY-SA-4.0');
  expect(host.textContent).toContain('Private revision artwork');
}

function privateDisclosure(host: HTMLElement) {
  exactDisclosure(host);
  expect(host.textContent).toContain('Private history author');
}

function retiredDisclosure(host: HTMLElement) {
  for (const text of [
    'The original edition leaves room for the reader to pause.',
    'Private history author',
    'CC-BY-SA-4.0',
    'Private revision artwork',
    m.thread_provenance_current_vote(),
  ])
    expect(host.innerHTML).not.toContain(text);
  expect(host.querySelector(`[aria-label="${m.edition_publication_entry_heading()}"]`)).toBeNull();
  expect(host.querySelector('section > ol')).toBeNull();
}

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('exact revision and history share actual reader provenance, serialized admission and one retiring caller lifetime', async () => {
  setLocale('en', { reload: false });
  nativeCalls.length = 0;
  exactCalls.length = 0;
  historyCalls.length = 0;
  editionReads.length = 0;
  activeServerSubject = readerId;
  activeServerToken = privateToken;
  activeServerCsrf = privateCsrf;
  hasSessionCookie = true;
  explicitAuthorization = null;

  const serverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  serverClient.setQueryData(['session'], session, { updatedAt: 1_700_000_000_000 });
  const serverVisit = await exactVisit(serverClient);
  expect(serverVisit.page.state).toBe('ready');
  expect(serverVisit.provenance.actualReader).toEqual({ credentialMode: 'session', subject: readerId, complete: true });
  const { wire, parsed } = await serializeVisit(serverVisit);
  expect(wire).not.toContain(privateToken);
  expect(wire).not.toContain(privateCsrf);

  // Real QueryClient dehydration carries the original cache lineage into a separate browser cache.
  const browserClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const cacheWire = await serializeValue(dehydrate(serverClient));
  hydrate(browserClient, cacheWire.parsed);
  const harness = createHarness(browserClient, parsed);
  let harnessMounted = true;
  try {
    await harness.render();
    exactDisclosure(harness.host);
    expect(harness.host.querySelector('picture img')?.getAttribute('alt')).toBe('Private revision artwork');
    expect(harness.host.querySelector(`[aria-label="${m.edition_publication_entry_heading()}"]`)).not.toBeNull();
    expect(sessionCsrfToken()).toBeNull();
    expect(editionReads).toEqual([{ postId: selected.id, revisionId: selected.revisionId }]);
    expect(exactCalls).toHaveLength(1);
    expect(exactCalls[0]?.authorization).toBe(`Bearer ${privateToken}`);

    const otherPost = { postId: id(80), revisionId: identity.revisionId };
    await harness.update({ identity: otherPost });
    retiredDisclosure(harness.host);
    const afterPostChange = await exactVisit(browserClient);
    await harness.update({ visit: (await serializeVisit(afterPostChange)).parsed, identity });
    exactDisclosure(harness.host);

    const otherRevision = { postId: identity.postId, revisionId: id(81) };
    await harness.update({ identity: otherRevision });
    retiredDisclosure(harness.host);
    const afterRevisionChange = await exactVisit(browserClient);
    await harness.update({ visit: (await serializeVisit(afterRevisionChange)).parsed, identity });
    exactDisclosure(harness.host);

    setLocale('fr', { reload: false });
    const frenchVisit = await exactVisit(browserClient, identity, 'session', 'fr');
    await harness.update({ visit: (await serializeVisit(frenchVisit)).parsed, locale: 'fr' });
    exactDisclosure(harness.host);
    setLocale('en', { reload: false });
    const englishVisit = await exactVisit(browserClient);
    await harness.update({ visit: (await serializeVisit(englishVisit)).parsed, locale: 'en' });
    exactDisclosure(harness.host);

    // Changing credential mode cannot keep the prior session admission alive.
    const beforeModeChange = exactCalls.length;
    await harness.update({ mode: 'anonymous' });
    retiredDisclosure(harness.host);
    expect(exactCalls).toHaveLength(beforeModeChange);
    const sessionModeVisit = await exactVisit(browserClient);
    await harness.update({ visit: (await serializeVisit(sessionModeVisit)).parsed, mode: 'session' });
    exactDisclosure(harness.host);

    // The history reader must use its own prepared response subject and withhold an unproven bearer.
    activeServerSubject = id(91);
    activeServerToken = 'different-history-reader-token';
    await click(harness.host, m.thread_history_show());
    expect(historyCalls.at(-1)?.authorization).toBe(`Bearer ${activeServerToken}`);
    expect(harness.host.querySelector('section > ol')).toBeNull();
    expect(harness.host.querySelector('section')?.textContent).toContain(m.thread_history_unavailable());
    activeServerSubject = readerId;
    activeServerToken = privateToken;
    await click(harness.host, m.exact_revision_retry());
    expect(harness.host.querySelectorAll('section > ol > li')).toHaveLength(1);

    // A credential without a subject is also incomplete even when native data returns successfully.
    await harness.update({ readAuthority: {} });
    hasSessionCookie = false;
    explicitAuthorization = `Bearer ${privateToken}`;
    await click(harness.host, m.thread_history_show());
    expect(historyCalls.at(-1)?.authorization).toBe(`Bearer ${privateToken}`);
    expect(harness.host.querySelector('section > ol')).toBeNull();
    expect(harness.host.querySelector('section')?.textContent).toContain(m.thread_history_unavailable());
    hasSessionCookie = true;
    explicitAuthorization = null;
    await click(harness.host, m.exact_revision_retry());
    expect(harness.host.querySelectorAll('section > ol > li')).toHaveLength(1);

    // A signed-in read-only cache with null CSRF still performs the bounded native history read.
    expect(historyCalls.at(-1)).toMatchObject({
      path: `/v1/posts/${selected.id}/revisions`,
      limit: '20',
      cursor: null,
    });
    expect(historyCalls.at(-1)?.authorization).toBe(`Bearer ${privateToken}`);
    expect(harness.host.textContent).toContain('Private history author');
    expect(harness.host.textContent).toContain('CC-BY-SA-4.0');
    expect(harness.host.textContent).toContain('Private revision artwork');
    expect(harness.host.textContent).toContain(m.thread_provenance_current_vote());

    // Queue a cursor request, then replace the session with an equal value before its native response settles.
    deferNextHistoryCursor = true;
    await click(harness.host, m.thread_history_more());
    expect(deferredHistory).toBeDefined();
    const obsoleteHistory = deferredHistory!;
    expect(historyCalls.at(-1)).toMatchObject({ cursor, limit: '20', authorization: `Bearer ${privateToken}` });
    const retainedMore = retainButton(harness.host, m.thread_history_more());
    const beforeReplacement = historyCalls.length;
    await act(async () => browserClient.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 }));
    retiredDisclosure(harness.host);
    await act(async () => retainedMore());
    expect(historyCalls).toHaveLength(beforeReplacement);
    retiredDisclosure(harness.host);

    // The retired wire visit cannot be stamped with the replacement cache; a new exact owner is required.
    const exactReadsBeforeFresh = exactCalls.length;
    const freshVisit = await exactVisit(browserClient);
    const serializedFresh = (await serializeVisit(freshVisit)).parsed;
    await harness.update({ visit: serializedFresh });
    exactDisclosure(harness.host);
    expect(exactCalls).toHaveLength(exactReadsBeforeFresh + 1);

    // An old finalizer cannot clear a successor cursor request or merge its page into the fresh owner.
    await click(harness.host, m.thread_history_show());
    privateDisclosure(harness.host);
    deferNextHistoryCursor = true;
    await click(harness.host, m.thread_history_more());
    const successorHistory = deferredHistory!;
    expect(successorHistory).not.toBe(obsoleteHistory);
    obsoleteHistory.resolve(Response.json({ revisions: [later], next: null }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(harness.host.querySelectorAll('section > ol > li')).toHaveLength(1);
    expect(harness.host.querySelector('section > [role="status"]')?.textContent).toContain(m.thread_history_loading());
    expect(
      [...harness.host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === m.thread_history_more(),
      )?.disabled,
    ).toBe(true);
    successorHistory.resolve(Response.json({ code: 'dependency_unavailable' }, { status: 503 }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(historyCalls.at(-1)).toMatchObject({ cursor, limit: '20' });
    expect(harness.host.textContent).toContain(m.thread_history_unavailable());

    // Cursor recovery retains the exact failed cursor and limit 20 on the current owner.
    await click(harness.host, m.exact_revision_retry());
    expect(historyCalls.at(-1)).toMatchObject({ cursor, limit: '20' });
    expect(harness.host.querySelectorAll('section > ol > li')).toHaveLength(2);

    // Fetch/observer notifications retain a healthy visit; a later error/removal/ABA cannot revive it.
    const retryCount = historyCalls.length;
    const sourceQuery = browserClient.getQueryCache().find({ queryKey: ['session'], exact: true });
    expect(sourceQuery).toBeDefined();
    await act(async () => {
      sourceQuery!.setState({ ...sourceQuery!.state, fetchStatus: 'fetching' });
    });
    privateDisclosure(harness.host);
    await act(async () => {
      sourceQuery!.setState({ ...sourceQuery!.state, fetchStatus: 'idle' });
      browserClient.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 });
      browserClient.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 });
    });
    retiredDisclosure(harness.host);
    const staleRetry = retainButton(harness.host, m.thread_history_show());
    await act(async () => staleRetry());
    expect(historyCalls).toHaveLength(retryCount);

    const afterAbaVisit = await exactVisit(browserClient);
    await harness.update({ visit: (await serializeVisit(afterAbaVisit)).parsed });
    exactDisclosure(harness.host);
    await click(harness.host, m.thread_history_show());
    privateDisclosure(harness.host);
    const sameTupleQuery = browserClient.getQueryCache().find({ queryKey: ['session'], exact: true })!;
    await act(async () =>
      sameTupleQuery.setState({ ...sameTupleQuery.state, status: 'error', error: new Error('session failed') }),
    );
    retiredDisclosure(harness.host);
    await act(async () => browserClient.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 }));
    retiredDisclosure(harness.host);

    // A fresh reader after error recovery is usable; removal and equal-value return retire that fresh owner too.
    const recovered = await exactVisit(browserClient);
    await harness.update({ visit: (await serializeVisit(recovered)).parsed });
    exactDisclosure(harness.host);
    await click(harness.host, m.thread_history_show());
    privateDisclosure(harness.host);
    await act(async () => browserClient.removeQueries({ queryKey: ['session'], exact: true }));
    retiredDisclosure(harness.host);
    await act(async () => browserClient.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 }));
    retiredDisclosure(harness.host);

    const staleAfterUnmount = retainButton(harness.host, m.thread_history_show());
    const beforeUnmount = historyCalls.length;
    await harness.unmount();
    harnessMounted = false;
    await act(async () => staleAfterUnmount());
    expect(historyCalls).toHaveLength(beforeUnmount);
  } finally {
    if (harnessMounted) await harness.unmount();
    serverClient.clear();
    browserClient.clear();
  }

  // A replacement in the exact loader's queued microtask is fenced before the BFF/native call.
  const queuedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queuedClient.setQueryData(['session'], session, { updatedAt: 1_700_000_000_000 });
  const exactCallsBeforeQueue = exactCalls.length;
  const queuedRead = exactVisit(queuedClient);
  queuedClient.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 });
  const queuedVisit = await queuedRead;
  expect(queuedVisit.page).toEqual({ state: 'loading' });
  expect(exactCalls).toHaveLength(exactCallsBeforeQueue);
  queuedClient.clear();

  // A completed private native result cannot publish after the browser cache replaced its reader.
  const staleClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  staleClient.setQueryData(['session'], session, { updatedAt: 1_700_000_000_000 });
  deferNextExact = true;
  const staleRead = exactVisit(staleClient);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(deferredExact).toBeDefined();
  staleClient.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 });
  deferredExact!.resolve(Response.json({ post: privatePost }));
  const staleVisit = await staleRead;
  expect(staleVisit.page).toEqual({ state: 'loading' });
  const staleHarness = createHarness(staleClient, staleVisit);
  await staleHarness.render();
  retiredDisclosure(staleHarness.host);
  await staleHarness.unmount();
  staleClient.clear();

  // Same-account mismatches and credential-only requests never inherit the expected account as actual provenance.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], session, { updatedAt: 1_700_000_000_000 });
  const beforeMismatch = exactCalls.length;
  activeServerSubject = id(91);
  activeServerToken = 'different-reader-token';
  const mismatch = await exactVisit(client);
  expect(mismatch.provenance.actualReader.subject).toBe(id(91));
  expect(mismatch.page).toEqual({ state: 'unavailable', status: 404 });
  expect(exactCalls).toHaveLength(beforeMismatch + 1);

  activeServerSubject = readerId;
  activeServerToken = privateToken;
  hasSessionCookie = false;
  explicitAuthorization = `Bearer ${privateToken}`;
  const missing = await exactVisit(client);
  expect(missing.provenance.actualReader).toEqual({ credentialMode: 'session', subject: null, complete: false });
  expect(missing.page).toEqual({ state: 'unavailable', status: 404 });

  // A current exact problem retries through the same route caller and gets a fresh admitted visit.
  hasSessionCookie = true;
  explicitAuthorization = null;
  hasSessionCookie = false;
  const anonymousFallback = await exactVisit(client, { postId: publicPostId, revisionId: publicRevisionId });
  expect(anonymousFallback.provenance.actualReader).toEqual({
    credentialMode: 'anonymous',
    subject: null,
    complete: true,
  });
  expect(anonymousFallback.page.state).toBe('ready');
  if (anonymousFallback.page.state === 'ready')
    expect(JSON.stringify(anonymousFallback.page)).toContain('Anonymous public revision');
  expect(exactCalls.at(-1)?.authorization).toBeNull();
  hasSessionCookie = true;
  failNextExact = true;
  const failedExact = await exactVisit(client);
  expect(failedExact.page).toMatchObject({ state: 'problem', status: 503 });
  let exactRetryCount = 0;
  const retryHarness = createHarness(client, (await serializeVisit(failedExact)).parsed, {
    onRetry: () => exactRetryCount++,
  });
  await retryHarness.render();
  await click(retryHarness.host, m.exact_revision_retry());
  expect(exactRetryCount).toBe(1);
  const retriedVisit = await exactVisit(client);
  await retryHarness.update({ visit: (await serializeVisit(retriedVisit)).parsed });
  expect(retryHarness.host.textContent).toContain('The original edition leaves room for the reader to pause.');
  expect(retryHarness.host.textContent).toContain('Private revision artwork');
  expect(retryHarness.host.querySelector(`[aria-label="${m.edition_publication_entry_heading()}"]`)).not.toBeNull();
  await click(retryHarness.host, m.thread_history_show());
  privateDisclosure(retryHarness.host);
  await retryHarness.unmount();

  // Real anonymous fallback stays anonymous and public SSR uses the unmodified native public floor.
  explicitAuthorization = null;
  const anonymousClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  anonymousClient.setQueryData(['session'], anonymous, { updatedAt: 1_700_000_000_000 });
  const publicIdentity = { postId: publicPostId, revisionId: publicRevisionId };
  const publicVisit = await exactVisit(anonymousClient, publicIdentity, 'anonymous');
  expect(publicVisit.provenance.actualReader).toEqual({ credentialMode: 'anonymous', subject: null, complete: true });
  expect(publicVisit.page.state).toBe('ready');
  if (publicVisit.page.state === 'ready')
    expect(JSON.stringify(publicVisit.page)).toContain('Anonymous public revision');
  const publicHarness = createHarness(anonymousClient, (await serializeVisit(publicVisit)).parsed, {
    exactIdentity: publicIdentity,
    mode: 'anonymous',
    postId: publicPostId,
  });
  await publicHarness.render();
  expect(publicHarness.host.textContent).toContain('Anonymous public revision');
  expect(publicHarness.host.textContent).not.toContain('Private revision artwork');
  await click(publicHarness.host, m.thread_history_show());
  expect(historyCalls.at(-1)).toMatchObject({
    path: `/v1/posts/${publicPostId}/revisions`,
    limit: '20',
    cursor: null,
    authorization: null,
  });
  expect(publicHarness.host.textContent).toContain('Anonymous public revision');
  await publicHarness.unmount();
  anonymousClient.clear();

  // An anonymous SSR body survives the independent cache's first anonymous preparation, then retires
  // when the prepared browser session becomes a viewer and the route supplies its current visit.
  const ssrClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ssrPublicVisit = await exactVisit(ssrClient, publicIdentity, 'anonymous');
  expect(ssrPublicVisit.page.state).toBe('ready');
  const browserAfterSsr = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ssrCache = await serializeValue(dehydrate(ssrClient));
  hydrate(browserAfterSsr, ssrCache.parsed);
  const ssrHarness = createHarness(browserAfterSsr, (await serializeVisit(ssrPublicVisit)).parsed, {
    exactIdentity: publicIdentity,
    mode: 'anonymous',
    postId: publicPostId,
    anonymousReader: true,
  });
  await ssrHarness.render();
  expect(ssrHarness.host.textContent).toContain('Anonymous public revision');
  await act(async () => browserAfterSsr.setQueryData(['session'], { ...session }, { updatedAt: 1_700_000_000_000 }));
  expect(ssrHarness.host.textContent).not.toContain('Anonymous public revision');
  expect(ssrHarness.host.querySelector(`[aria-label="${m.edition_publication_entry_heading()}"]`)).toBeNull();
  const firstPreparedVisit = await exactVisit(browserAfterSsr);
  await ssrHarness.update({
    visit: (await serializeVisit(firstPreparedVisit)).parsed,
    identity,
    mode: 'session',
    postId: selected.id,
    viewerId: readerId,
  });
  await click(ssrHarness.host, m.thread_history_show());
  privateDisclosure(ssrHarness.host);
  await ssrHarness.unmount();
  ssrClient.clear();
  browserAfterSsr.clear();

  expect(historyCalls.every((call) => call.limit === '20')).toBe(true);
  client.clear();
});
