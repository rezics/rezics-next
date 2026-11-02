import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, StrictMode } from 'react';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import memberships from '../src/kernel/recorded/my-realms.json';
import boardRecording from '../src/kernel/recorded/realm-boards.json';
import subjectRecording from '../src/kernel/recorded/subject.json';

// Authored mounted presentation regressions. Native, browser geometry and growth execution are UNRUN.
const reader = 'story-viewer';
const otherReader = 'other-story-viewer';
const csrf = 'story-csrf-token';
const subjectId = subjectRecording.subject.id;
const subjectTitle = '旅人の物語 & المراجعات';
const realm = memberships.items[0]!;
const recordedBoard = boardRecording.items.find((board) => board.purpose === 'reviews')!;
const longTitle = `مراجعات الرحلة الطويلة ${'عنوان'.repeat(60)}`;
const longRealm = `مكتبة القراء والمترجمين ${'RealmNameWithoutSpaces'.repeat(25)}`;
const secondBoard = { ...recordedBoard, id: boardRecording.items[0]!.id, title: null };
const choices = [{ ...recordedBoard, title: longTitle }, secondBoard];

type Gate<T> = { promise: Promise<T>; resolve(value: T): void };
function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const response = (items: unknown[], next: string | null = null) => Response.json({ items, next });
const calls: { path: string; query: string; authorization: string | null; method: string }[] = [];
const headers: string[] = [];
let realms = [{ ...realm, name: longRealm }];
let membershipRead = () => Promise.resolve(response(realms));
let boardRead: (realmId: string) => Promise<Response> = async () => response(choices);
let serverReader = reader;
let request = new Request('https://review.test/en/reviews');
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
    if (url.pathname === '/v1/me/realms') return membershipRead();
    const match = /^\/v1\/realms\/([^/]+)\/boards$/.exec(url.pathname);
    if (match) return boardRead(decodeURIComponent(match[1]!));
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
        return async (input: { data?: unknown } = {}) => {
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
const window = new Window({ url: 'https://review.test/en/reviews' });
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
const { WriteReviewAction, REALM_PAGE_LIMIT } = await import('../src/subject/write-review');
const { reviewThreadHref } = await import('../src/threads/review-policy');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const navigations: string[] = [];
Object.defineProperty(window.location, 'assign', {
  configurable: true,
  value: (href: string) => navigations.push(href),
});
const signedIn = (subject = reader) => ({ state: 'signed-in', subject, csrfToken: csrf });
const settle = () =>
  act(async () => {
    await new Promise<void>((done) => window.setTimeout(done, 0));
  });
async function until(ready: () => boolean) {
  for (let n = 0; n < 120; n++) {
    if (ready()) return;
    await settle();
  }
  throw new Error('Review presentation did not settle');
}
const membershipCalls = () => calls.filter(({ path }) => path === '/v1/me/realms');
const boardCalls = () => calls.filter(({ path }) => path.endsWith('/boards'));
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
  async function toggle() {
    const button = host.querySelector('button');
    if (!button) throw new Error('Missing deliberate review entry');
    await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  }
  async function unmount() {
    await act(async () => root.unmount());
    host.remove();
    query.clear();
  }
  await render();
  return { host, query, render, toggle, unmount };
}
function reset() {
  calls.length = 0;
  headers.length = 0;
  navigations.length = 0;
  serverReader = reader;
  realms = [{ ...realm, name: longRealm }];
  membershipRead = async () => response(realms);
  boardRead = async () => response(choices);
}
afterAll(async () => {
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('shared sign-in prompt differs from unavailable, and neither admits private reads', async () => {
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

test('initial load, deliberate expansion, full identity, independent destinations and focus retain native counts', async () => {
  reset();
  const page = gate<Response>();
  membershipRead = () => page.promise;
  const first = await surface();
  const second = await surface();
  try {
    await until(() => membershipCalls().length === 2);
    expect(first.host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(boardCalls()).toHaveLength(0);
    await first.toggle();
    expect(first.host.textContent).toContain(m.thread_review_boards_loading());
    expect(second.host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    page.resolve(response(realms, 'unfollowed-membership-cursor'));
    await until(() => first.host.querySelectorAll('li').length === 2);
    const list = first.host.querySelector('ul')!;
    expect(list.getAttribute('aria-label')).toBe(m.thread_review_choose_board());
    expect([...list.children].every((row) => row.tagName === 'LI')).toBe(true);
    const links = [...list.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      choices.map((board) => reviewThreadHref('en', board.id, subjectId, subjectTitle)),
    );
    expect(links.map((link) => link.textContent)).toEqual([longTitle + longRealm, m.threads_untitled() + longRealm]);
    for (const [index, row] of [...list.children].entries()) {
      expect(row.querySelectorAll('a')).toHaveLength(1);
      expect(row.querySelector('h3 [dir="auto"]')?.textContent).toBe(index === 0 ? longTitle : m.threads_untitled());
      expect(row.querySelector('a a, a button')).toBeNull();
      expect(row.textContent).not.toContain(realm.realmId);
      links[index]!.focus();
      expect(window.document.activeElement).toBe(links[index]);
      expect(links[index]!.className).toContain('focus-visible:outline-2');
      expect(links[index]!.className).toContain('min-h-11');
      expect(links[index]!.className).toContain('[overflow-wrap:anywhere]');
    }
    expect(boardCalls()).toHaveLength(1);
    await first.toggle();
    expect(first.host.querySelector('ul')).toBeNull();
    await first.toggle();
    await second.toggle();
    await until(() => second.host.querySelectorAll('li').length === 2);
    expect(membershipCalls()).toHaveLength(2);
    expect(boardCalls()).toHaveLength(2);
    expect(boardCalls().map(({ query }) => query)).toEqual(['?limit=100', '?limit=100']);
    expect(navigations).toHaveLength(0);
    expect(calls.every((call) => call.method === 'GET' && call.authorization === 'Bearer review-token')).toBe(true);
    expect(headers.every((value) => value === 'cache-control: private, no-store')).toBe(true);
  } finally {
    await first.unmount();
    await second.unmount();
  }
});

test('empty memberships, denied/zero boards, failed reads and mismatched provenance remain distinct without retry', async () => {
  for (const mode of [
    'no-realms',
    'denied',
    'zero',
    'failed-page',
    'failed-boards',
    'mismatch-page',
    'mismatch-boards',
  ] as const) {
    reset();
    if (mode === 'no-realms') realms = [];
    if (mode === 'failed-page') membershipRead = async () => new Response(null, { status: 503 });
    if (mode === 'mismatch-page') serverReader = otherReader;
    if (mode === 'denied') boardRead = async () => new Response(null, { status: 403 });
    if (mode === 'zero')
      boardRead = async () => response(boardRecording.items.filter((board) => board.purpose !== 'reviews'));
    if (mode === 'failed-boards') boardRead = async () => new Response(null, { status: 503 });
    const view = await surface();
    try {
      await until(() => membershipCalls().length === 1);
      await settle();
      if (mode === 'mismatch-boards') serverReader = otherReader;
      await view.toggle();
      const message =
        mode === 'no-realms'
          ? m.thread_review_no_realms()
          : mode === 'zero' || mode === 'denied'
            ? m.thread_review_no_board()
            : m.thread_review_unavailable();
      await until(() => (view.host.textContent ?? '').includes(message));
      expect(view.host.querySelectorAll('a, ul')).toHaveLength(0);
      expect(view.host.querySelectorAll('button')).toHaveLength(1);
      expect(view.host.querySelector('[role="alert"]') !== null).toBe(message === m.thread_review_unavailable());
      const count = calls.length;
      await view.toggle();
      await view.toggle();
      await settle();
      expect(calls).toHaveLength(count);
      if (mode === 'mismatch-boards' || mode === 'mismatch-page' || mode === 'no-realms')
        expect(boardCalls()).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  }
});

test('one current eligible board uses the claimed exact destination without a duplicate card', async () => {
  reset();
  boardRead = async () => response([recordedBoard]);
  const view = await surface();
  try {
    await until(() => membershipCalls().length === 1);
    await settle();
    await view.toggle();
    await until(() => navigations.length === 1);
    expect(navigations).toEqual([reviewThreadHref('en', recordedBoard.id, subjectId, subjectTitle)]);
    expect(view.host.querySelector('li, a')).toBeNull();
    await view.toggle();
    await view.toggle();
    await settle();
    expect(navigations).toHaveLength(1);
    expect(boardCalls()).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});

test('retired in-flight and same-reader ABA completions cannot publish or navigate; fresh visit remains usable', async () => {
  reset();
  const old = gate<Response>();
  boardRead = () => old.promise;
  const view = await surface();
  try {
    await until(() => membershipCalls().length === 1);
    await settle();
    await view.toggle();
    await until(() => boardCalls().length === 1);
    boardRead = async () => response(choices);
    await act(async () =>
      notifyManager.batch(() => {
        view.query.setQueryData(sessionQuery.queryKey, signedIn(otherReader));
        view.query.setQueryData(sessionQuery.queryKey, signedIn());
      }),
    );
    await until(() => membershipCalls().length === 2);
    old.resolve(response([recordedBoard]));
    await settle();
    expect(navigations).toHaveLength(0);
    expect(view.host.querySelector('ul')).toBeNull();
    expect(view.host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await view.toggle();
    await until(() => view.host.querySelectorAll('li').length === 2);
    const link = view.host.querySelector('a')!;
    // Dispatch before React replaces the DOM: the retired link itself must suppress navigation.
    await act(async () => {
      view.query.setQueryData(sessionQuery.queryKey, signedIn());
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    });
    await until(() => membershipCalls().length === 3);
    const late = gate<Response>();
    boardRead = () => late.promise;
    await view.toggle();
    await until(() => boardCalls().length === 3);
    await view.render({ subjectTitle: 'New exact target', locale: 'zh-Hant' });
    late.resolve(response([recordedBoard]));
    await settle();
    expect(navigations).toHaveLength(0);
    boardRead = async () => response(choices);
    await view.toggle();
    await until(() => view.host.querySelectorAll('li').length === 2);
    expect(view.host.querySelector('a')?.getAttribute('href')).toBe(
      reviewThreadHref('zh-Hant', choices[0]!.id, subjectId, 'New exact target'),
    );
  } finally {
    await view.unmount();
  }
  const unmounted = gate<Response>();
  boardRead = () => unmounted.promise;
  const finalView = await surface();
  await settle();
  const count = boardCalls().length;
  await finalView.toggle();
  await until(() => boardCalls().length > count);
  await finalView.unmount();
  unmounted.resolve(response([recordedBoard]));
  await settle();
  expect(navigations).toHaveLength(0);
});

test('supplied growth at 1/8/20 Realms keeps source order, one membership page and one bounded native read per Realm', async () => {
  expect(REALM_PAGE_LIMIT).toBe(20);
  for (const count of [1, 8, REALM_PAGE_LIMIT]) {
    reset();
    realms = Array.from({ length: count }, (_, n) => ({
      ...realm,
      realmId: `0192f3a0-6c1e-7b2a-9d4e-${String(n + 1).padStart(12, '0')}`,
      name: `${longRealm} ${n + 1}`,
    }));
    membershipRead = async () => response(realms, 'not-traversed');
    boardRead = async (realmId) => response([{ ...recordedBoard, id: realmId, realmId }]);
    const view = await surface();
    try {
      await until(() => membershipCalls().length === 1);
      await settle();
      await view.toggle();
      await until(() => (count === 1 ? navigations.length === 1 : view.host.querySelectorAll('li').length === count));
      expect(membershipCalls()).toHaveLength(1);
      expect(boardCalls()).toHaveLength(count);
      expect(boardCalls().map(({ path }) => path.split('/')[3])).toEqual(realms.map(({ realmId }) => realmId));
      expect(boardCalls().every(({ query }) => query === '?limit=100')).toBe(true);
      if (count > 1)
        expect(
          [...view.host.querySelectorAll('li')].map((row) => row.querySelector('a span:last-child')?.textContent),
        ).toEqual(realms.map(({ name }) => name));
    } finally {
      await view.unmount();
    }
  }
});
