import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import memberships from '../src/kernel/recorded/my-realms.json';
import boardRecording from '../src/kernel/recorded/realm-boards.json';
import subjectRecording from '../src/kernel/recorded/subject.json';

const reader = 'story-viewer';
const otherReader = 'other-story-viewer';
const csrf = 'story-csrf-token';
const subjectId = subjectRecording.subject.id;
const subjectTitle = '旅人の物語 & المراجعات';
const firstRealm = { ...memberships.items[0]!, name: `مكتبة ${'RealmNameWithoutSpaces'.repeat(25)}` };
const laterRealm = {
  realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000099',
  name: `القرّاء ${'LateRealm'.repeat(24)}`,
};
const recordedBoard = boardRecording.items.find((board) => board.purpose === 'reviews')!;
const longTitle = `مراجعات الرحلة ${'عنوان'.repeat(60)}`;
const spaceId = '0192f3a0-6c1e-7b2a-9d4e-000000000098';
const headRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000097';
const source = { partition: 2, epoch: 1, position: '18' };
const candidate = {
  id: recordedBoard.id,
  title: longTitle,
  purpose: 'reviews' as const,
  actions: { createReview: 'allowed' as const },
  native: {
    kind: 'review' as const,
    boardId: recordedBoard.id,
    subjectIds: [subjectId] as [string],
    subjectSource: source,
    realmHeadRevisionId: headRevisionId,
    boardSecurityRevision: '1',
  },
};

type Gate<T> = { promise: Promise<T>; resolve(value: T): void };
function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const calls: { path: string; query: string; authorization: string | null; method: string }[] = [];
const headers: string[] = [];
const serverFunctionSignals: (AbortSignal | undefined)[] = [];
let realmRead: (cursor: string | null) => Promise<Response> = async (cursor) =>
  cursor
    ? Response.json({ items: [laterRealm], next: null })
    : Response.json({ items: [firstRealm], next: 'later-page' });
let destinationRead: (realmId: string, _boardId: string | null) => Promise<Response> = async (realmId) =>
  Response.json({
    state: 'choices',
    viewer: { state: 'current' },
    context: {
      subject: { id: subjectId, label: { value: subjectTitle, language: 'en' }, source },
      realm: { id: realmId, title: laterRealm.name, spaceId, headRevisionId },
    },
    items: [candidate],
    next: null,
  });
let serverReader = reader;
let request = new Request('https://review.test/en/subjects/review');

const client = createKernelClient('https://kernel.review.test', {
  fetch: async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push({
      path: url.pathname,
      query: url.search,
      authorization: req.headers.get('authorization'),
      method: req.method,
    });
    if (url.pathname === '/v1/me/realms') return realmRead(url.searchParams.get('cursor'));
    const match = /^\/v1\/realms\/([^/]+)\/review-destinations$/.exec(url.pathname);
    if (match) return destinationRead(decodeURIComponent(match[1]!), url.searchParams.get('boardId'));
    throw new Error(`Unexpected review request ${url.pathname}`);
  },
});

const start = await import('@tanstack/react-start');
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    let validate: ((input: unknown) => unknown) | undefined;
    return {
      validator(next: (input: unknown) => unknown) {
        validate = next;
        return this;
      },
      handler(handler: (input: { data: unknown }) => Promise<unknown>) {
        return async (input: { data?: unknown; signal?: AbortSignal } = {}) => {
          serverFunctionSignals.push(input.signal);
          const data = validate ? validate(input.data) : input.data;
          request = new Request('https://review.test/en/_server/review', {
            headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
          });
          return handler({ data });
        };
      },
    };
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => headers.push(`${name.toLowerCase()}: ${value}`),
}));
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.review.test',
    API_RESOURCE: 'https://kernel.review.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'review',
    WEBSITE_CLIENT_KEY: '{}',
    SITE_ORIGINS: 'https://review.test',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => ({
          status: 'active',
          accessToken: 'review-token',
          subject: serverReader,
          csrfToken: csrf,
        }),
      }),
    },
  },
}));
mock.module('../src/kernel/client', () => ({ kernelClient: () => client, requestLocale: () => 'en' }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://review.test/en/subjects/review' });
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
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { sessionQuery } = await import('../src/session/query');
const { WriteReviewAction } = await import('../src/subject/write-review');
const { reviewThreadHref } = await import('../src/threads/review-policy');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const navigations: string[] = [];
Object.defineProperty(window.location, 'assign', {
  configurable: true,
  value: (href: string) => navigations.push(href),
});
const signedIn = (subject = reader) => ({ state: 'signed-in', subject, csrfToken: csrf });
const settle = () => act(async () => new Promise<void>((done) => window.setTimeout(done, 0)));

async function until(ready: () => boolean) {
  for (let index = 0; index < 120; index++) {
    if (ready()) return;
    await settle();
  }
  throw new Error('Review destination journey did not settle');
}

async function surface(session: 'signed-in' | 'signed-out' | 'unavailable' = 'signed-in') {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  query.setQueryData(sessionQuery.queryKey, signedIn());
  const host = window.document.createElement('main');
  host.dir = 'rtl';
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let target = { subjectId, subjectTitle, locale: 'en', session };
  async function render(next: Partial<typeof target> = {}) {
    target = { ...target, ...next };
    await act(async () =>
      root.render(h(QueryClientProvider, { client: query }, h(StrictMode, null, h(WriteReviewAction, target)))),
    );
  }
  async function click(text: string) {
    const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));
    if (!button) throw new Error(`Missing review button: ${text}`);
    await act(async () => button.click());
  }
  async function unmount() {
    await act(async () => root.unmount());
    host.remove();
    query.clear();
  }
  await render();
  return { host, query, render, click, unmount };
}

function reset() {
  calls.length = 0;
  headers.length = 0;
  serverFunctionSignals.length = 0;
  navigations.length = 0;
  serverReader = reader;
  realmRead = async (cursor) =>
    cursor
      ? Response.json({ items: [laterRealm], next: null })
      : Response.json({ items: [firstRealm], next: 'later-page' });
  destinationRead = async (realmId) =>
    Response.json({
      state: 'choices',
      viewer: { state: 'current' },
      context: {
        subject: { id: subjectId, label: { value: subjectTitle, language: 'en' }, source },
        realm: { id: realmId, title: laterRealm.name, spaceId, headRevisionId },
      },
      items: [candidate],
      next: null,
    });
}

afterAll(async () => {
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('sign-in and unavailable states do not read private Realm or Board data', async () => {
  reset();
  await setLocale('en', { reload: false });
  const signedOut = await surface('signed-out');
  const unavailable = await surface('unavailable');
  try {
    expect(signedOut.host.querySelector('a')?.textContent).toBe(m.thread_review_sign_in());
    expect(signedOut.host.querySelector('a')?.getAttribute('href')).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(`/en/subjects/${subjectId}/reviews`)}`,
    );
    expect(unavailable.host.childElementCount).toBe(0);
    expect(calls).toHaveLength(0);
  } finally {
    await signedOut.unmount();
    await unavailable.unmount();
  }
});

test('the later Realm page and exact Board require deliberate selection before the existing composer opens', async () => {
  reset();
  await setLocale('en', { reload: false });
  const view = await surface();
  try {
    await view.click(m.thread_review_write());
    await until(() => calls.filter(({ path }) => path === '/v1/me/realms').length === 1);
    expect(calls.filter(({ path }) => path.endsWith('/review-destinations'))).toHaveLength(0);
    await until(() =>
      [...view.host.querySelectorAll('button')].some((button) => button.textContent?.includes(m.realms_more())),
    );
    await view.click(m.realms_more());
    await until(() => calls.filter(({ path }) => path === '/v1/me/realms').length === 2);
    expect(calls[1]?.query).toContain('cursor=later-page');

    await until(() =>
      [...view.host.querySelectorAll('button')].some((button) => button.textContent?.includes(laterRealm.name)),
    );
    await view.click(laterRealm.name);
    await until(() => calls.filter(({ path }) => path.endsWith('/review-destinations')).length === 1);
    const page = calls.find(({ path }) => path.endsWith('/review-destinations'))!;
    expect(page.path).toBe(`/v1/realms/${laterRealm.realmId}/review-destinations`);
    expect(page.query).toContain(`subjectId=${subjectId}`);
    expect(navigations).toHaveLength(0);
    await until(() =>
      [...view.host.querySelectorAll('button')].some((button) =>
        button.textContent?.includes(m.thread_review_select_board()),
      ),
    );
    expect(view.host.textContent).toContain(longTitle);
    expect(view.host.textContent).toContain(laterRealm.name);
    expect(view.host.querySelector('a')).toBeNull();

    await view.click(m.thread_review_select_board());
    await until(() => navigations.length === 1);
    expect(calls.filter(({ path }) => path.endsWith('/review-destinations'))).toHaveLength(2);
    expect(calls[3]?.query).toContain(`subjectId=${subjectId}`);
    expect(calls[3]?.query).toContain(`boardId=${recordedBoard.id}`);
    expect(navigations).toEqual([reviewThreadHref('en', recordedBoard.id, subjectId, subjectTitle)]);
    expect(
      calls.every(({ authorization, method }) => authorization === 'Bearer review-token' && method === 'GET'),
    ).toBe(true);
    expect(headers.every((header) => header === 'cache-control: private, no-store')).toBe(true);
  } finally {
    await view.unmount();
  }
});

test('a Realm replacement retires a late destination page and its selection', async () => {
  reset();
  await setLocale('en', { reload: false });
  const pending = gate<Response>();
  destinationRead = () => pending.promise;
  const view = await surface();
  try {
    await view.click(m.thread_review_write());
    await until(() => calls.filter(({ path }) => path === '/v1/me/realms').length === 1);
    await view.click(laterRealm.name);
    await until(() => calls.filter(({ path }) => path.endsWith('/review-destinations')).length === 1);
    const original = view.host.querySelector('button[aria-pressed="true"]');
    expect(original?.textContent).toContain(laterRealm.name);
    await act(async () => view.query.setQueryData(sessionQuery.queryKey, signedIn(otherReader)));
    await settle();
    await act(async () => view.query.setQueryData(sessionQuery.queryKey, signedIn()));
    await view.render({
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000096',
      locale: 'zh-Hant',
      subjectTitle: '替換後的作品',
    });
    expect(serverFunctionSignals.at(-1)?.aborted).toBe(true);
    pending.resolve(
      Response.json({
        state: 'choices',
        viewer: { state: 'current' },
        context: {
          subject: { id: subjectId, label: { value: subjectTitle, language: 'en' }, source },
          realm: { id: laterRealm.realmId, title: laterRealm.name, spaceId, headRevisionId },
        },
        items: [candidate],
        next: null,
      }),
    );
    await settle();
    expect(navigations).toHaveLength(0);
    expect(view.host.querySelector('button[aria-pressed="true"]')).toBeNull();
    expect(view.host.querySelector('ul[aria-label]')).toBeNull();
  } finally {
    await view.unmount();
  }
});
