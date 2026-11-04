import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { OwnVoteEntry, OwnVotesPage } from '../../../services/kernel/src/rating/own-votes-page.ts';
import type { OwnVotesRead } from '../src/ratings/own-votes/actions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

type ReadCall = ReturnType<typeof deferred<OwnVotesRead>> & { subject: string; cursor: string | null };
const reads: ReadCall[] = [];
const readWaiters: (() => void)[] = [];
let activeSubject = '11111111-1111-4111-8111-111111111111';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/kernel/client', () => ({ configured: () => false }));
mock.module('../src/ratings/own-votes/actions', () => ({
  readOwnVotesForViewer: ({ data }: { data: { cursor?: string } }) => {
    const call = { ...deferred<OwnVotesRead>(), subject: activeSubject, cursor: data.cursor ?? null };
    reads.push(call);
    for (const wake of readWaiters.splice(0)) wake();
    return call.promise;
  },
  executeOwnVoteIntent: async () => ({ kind: 'rejected' }),
  voteReadbackForIntent: async () => ({ kind: 'unavailable' }),
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/library/ratings' });
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
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  FocusEvent: window.FocusEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouterState } =
  await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { CurrentViewerOwnVotesPage } = await import('../src/ratings/own-votes/page');
const { OwnVotesReturnProvider } = await import('../src/ratings/own-votes/return');
const { ownVotesQuery } = await import('../src/ratings/own-votes/current-origin');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const oldLocale = getLocale();
await setLocale('en', { reload: false });

const account = '11111111-1111-4111-8111-111111111111';
const terminal = '22222222-2222-4222-8222-222222222222';
const target = '33333333-3333-4333-8333-333333333333';
const question = '44444444-4444-4444-8444-444444444444';
const path = `/v1/subjects/${target}/ratings/${question}/vote`;
function row(): OwnVoteEntry {
  return {
    targetId: target,
    questionId: question,
    subject: {
      id: terminal,
      type: 'work',
      types: ['work'],
      label: { value: 'Kokoro', language: 'en' },
      creativeWork: true,
      cover: null,
    },
    subjectHref: `/v1/subjects/${terminal}`,
    question: { id: question, revision: 3, label: 'How much does it stay with you?', grain: 'work', scale: { min: 0, max: 20, displayStep: 2 } },
    own: { units: 0, revision: 4, at: '2026-10-01T00:00:00.000Z' },
    actions: { state: 'editable', put: path, clear: path, readback: path },
  };
}
const pageFor = (subject: string): OwnVotesPage => ({ viewer: { accountId: subject }, votes: [row()], next: null });
const nativeRead = (subject = account, cursor: string | null = null, locale = getLocale()): OwnVotesRead => ({
  state: 'ready',
  page: pageFor(subject),
  subject,
  cursor,
  locale,
  source: 'rating.own_votes_page/v1',
});
const rootRoute = createRootRoute({
  component: () => createElement(OwnVotesReturnProvider, null, createElement(Outlet)),
});
const ratingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/ratings',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' ? { cursor: search.cursor } : {}),
  }),
  component: function RatingsRoute() {
    const search = useRouterState({ select: (state) => state.location.search });
    const cursor = typeof search.cursor === 'string' ? search.cursor : null;
    return createElement(CurrentViewerOwnVotesPage, { initial: nativeRead(account, cursor), cursor });
  },
});
const subjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/subjects/$id/$slug',
  component: () => createElement('p', null, 'Subject reader'),
});
const routeTree = rootRoute.addChildren([ratingsRoute, subjectRoute]);

function session(subject = account, csrfToken = 'csrf-a') {
  return { state: 'signed-in' as const, subject, csrfToken };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitForRead(index: number): Promise<ReadCall> {
  while (!reads[index]) await new Promise<void>((resolve) => readWaiters.push(resolve));
  return reads[index]!;
}
async function waitForText(host: HTMLElement, text: string): Promise<boolean> {
  if (host.textContent?.includes(text)) return true;
  return new Promise((resolve) => {
    const observer = new window.MutationObserver(() => {
      if (!host.textContent?.includes(text)) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(true);
    });
    observer.observe(host, { subtree: true, childList: true, characterData: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, 1000);
  });
}
function ready(call: ReadCall, subject = call.subject, cursor = call.cursor) {
  call.resolve(nativeRead(subject, cursor));
}

async function mounted(initialPath = '/library/ratings') {
  const host = document.createElement('main');
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stopObservation = viewerExposureLifetime(client).subscribe(() => {});
  client.setQueryData(sessionQuery.queryKey, session());
  const observation = viewerExposureLifetime(client).getSnapshot();
  if (observation.state !== 'signed-in') throw new Error('Expected signed-in browser observation');
  client.setQueryData(viewerExposureQuery(observation.observation).queryKey, {
    subject: observation.observation.subject,
    admitted: ['personal_library'],
  });
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initialPath] }) });
  await router.load();
  const perform = (work: () => void | Promise<unknown>) => act(async () => { await work(); });
  function expose(subject: string, csrfToken: string) {
    activeSubject = subject;
    return perform(() => {
      client.setQueryData(sessionQuery.queryKey, session(subject, csrfToken));
      const current = viewerExposureLifetime(client).getSnapshot();
      if (current.state !== 'signed-in') throw new Error('Expected replacement browser observation');
      client.setQueryData(viewerExposureQuery(current.observation).queryKey, {
        subject: current.observation.subject,
        admitted: ['personal_library'],
      });
    });
  }
  const tree = createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }));
  host.innerHTML = renderToString(tree);
  const root = hydrateRoot(host as unknown as HTMLElement, tree);
  await act(async () => {
    await tick();
    root.render(tree);
    await tick();
  });
  return {
    host,
    client,
    router,
    perform,
    expose,
    click: (node: Element) =>
      act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))),
    close: async () => {
      await act(async () => root.unmount());
      stopObservation();
      client.clear();
      host.remove();
    },
  };
}

async function visitSubject(view: Awaited<ReturnType<typeof mounted>>) {
  const link = [...view.host.querySelectorAll('a')].find((node) => node.textContent === 'Kokoro');
  if (!link) throw new Error('Expected the disclosed terminal Subject link');
  await view.click(link);
}
async function back(view: Awaited<ReturnType<typeof mounted>>, index = reads.length) {
  await act(async () => {
    view.router.history.back();
    await tick();
  });
  return waitForRead(index);
}

afterAll(async () => {
  setLocale(oldLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('an admitted current page returns once to the exact inspected original pair and keeps the real cursor', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  const view = await mounted();
  try {
    if (view.host.querySelectorAll('[data-own-vote-pair]').length !== 1)
      throw new Error(JSON.stringify({ text: view.host.textContent, reads: reads.length, location: view.router.state.location }));
    expect(view.host.querySelectorAll('[data-own-vote-pair]')).toHaveLength(1);
    expect(reads).toHaveLength(0);
    const inspect = [...view.host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === m.library_my_ratings_inspect(),
    );
    if (!inspect) throw new Error(`Missing inspection action: ${view.host.textContent}`);
    expect(inspect).toBeDefined();
    await view.click(inspect!);
    await visitSubject(view);
    const call = await back(view);
    expect(call.cursor).toBeNull();
    expect(reads).toHaveLength(1);
    expect(view.host.textContent).toContain('Refreshing this page');
    expect(view.host.querySelector('[data-own-vote-return-status]')).toBeNull();
    ready(call);
    await act(async () => call.promise);
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    expect(view.host.textContent).toContain('The same original question and Subject pair');
    expect(view.host.querySelector('[data-own-vote-target="' + target + '"][data-own-vote-question="' + question + '"] button'))
      .toBe(window.document.activeElement);
    expect(view.host.querySelector('button[aria-label*="Edit"]')).toBeNull();
  } finally {
    await view.close();
  }
});

test('account ABA and locale replacement retire a deferred return before status or focus can commit', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  const view = await mounted();
  try {
    const inspect = [...view.host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === m.library_my_ratings_inspect(),
    )!;
    await view.click(inspect);
    await visitSubject(view);
    const old = await back(view);
    await view.expose('reader-b', 'csrf-b');
    expect(view.host.textContent).not.toContain('The same original question and Subject pair');
    await view.expose(account, 'csrf-a-returned');
    expect(view.host.textContent).not.toContain('The same original question and Subject pair');
    ready(old);
    const extraReads = reads.slice(1);
    for (const call of extraReads) ready(call);
    await act(async () => Promise.all(reads.map((call) => call.promise)));
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    expect(view.host.textContent).not.toContain('The same original question and Subject pair');
    expect(view.host.textContent).not.toContain('The inspected pair is not on this page');

    const nextInspect = [...view.host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === m.library_my_ratings_inspect(),
    );
    if (nextInspect) await view.click(nextInspect);
    await visitSubject(view);
    const localeRead = await back(view);
    await view.perform(async () => {
      await setLocale('ja', { reload: false });
      await view.router.invalidate();
    });
    ready(localeRead);
    for (const call of reads) ready(call);
    await act(async () => Promise.all(reads.map((call) => call.promise)));
    expect(view.host.textContent).not.toContain('The same original question and Subject pair');
    await setLocale('en', { reload: false });
    for (const call of reads.slice(1)) ready(call);
  } finally {
    await view.close();
    await setLocale('en', { reload: false });
  }
});

test('cursor and equal-response replacement reject the old refresh completion', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  const view = await mounted();
  try {
    const inspect = [...view.host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === m.library_my_ratings_inspect(),
    )!;
    await view.click(inspect);
    await visitSubject(view);
    const old = await back(view);
    const key = view.client.getQueryCache().findAll({ queryKey: ['own-votes'] }).at(-1)?.queryKey;
    expect(key).toBeDefined();
    view.client.setQueryData(key!, nativeRead());
    ready(old);
    await act(async () => old.promise);
    expect(view.host.textContent).not.toContain('The same original question and Subject pair');

    const nextIndex = reads.length;
    await view.perform(() => view.router.navigate({ to: '/library/ratings', search: { cursor: 'next/+sealed=' } }));
    const next = await waitForRead(nextIndex);
    expect(next.cursor).toBe('next/+sealed=');
    for (const call of reads) if (call !== next) ready(call);
    ready(next);
    await act(async () => Promise.all(reads.map((call) => call.promise)));
    expect(view.host.textContent).not.toContain('The same original question and Subject pair');
  } finally {
    await view.close();
  }
});

test('bfcache refresh is reader-local and two mounted readers cannot consume one another’s receipt', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  const first = await mounted();
  const second = await mounted();
  let secondClosed = false;
  try {
    for (const view of [first, second]) {
      const inspect = [...view.host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === m.library_my_ratings_inspect(),
      )!;
      await view.click(inspect);
      await visitSubject(view);
    }
    const firstReturn = await back(first);
    expect(reads).toHaveLength(1);
    expect(second.host.textContent).toContain('Subject reader');
    ready(firstReturn);
    await act(async () => firstReturn.promise);
    expect(first.host.textContent).toContain('The same original question and Subject pair');

    const secondReturn = await back(second);
    expect(reads).toHaveLength(2);
    ready(secondReturn);
    await act(async () => secondReturn.promise);
    expect(second.host.textContent).toContain('The same original question and Subject pair');

    await second.close();
    secondClosed = true;
    const inspect = [...first.host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === m.library_my_ratings_inspect(),
    );
    if (!inspect) throw new Error('Expected a current Inspect choice before bfcache return');
    await first.click(inspect);

    const pagehide = new window.Event('pagehide');
    Object.defineProperty(pagehide, 'persisted', { value: true });
    await act(async () => window.dispatchEvent(pagehide));
    const pageshow = new window.Event('pageshow');
    Object.defineProperty(pageshow, 'persisted', { value: true });
    await act(async () => window.dispatchEvent(pageshow));
    const bfcacheRead = await waitForRead(2);
    expect(reads).toHaveLength(3);
    ready(bfcacheRead);
    await act(async () => bfcacheRead.promise);
    const found = await waitForText(first.host, 'The same original question and Subject pair');
    expect(found).toBe(true);
  } finally {
    await first.close();
    if (!secondClosed) await second.close();
  }
});

test('ownVotesQuery still isolates current viewer, cursor, locale, exposure and source', () => {
  const cursor = 'sealed/+opaque=';
  const first = ownVotesQuery('reader-a', cursor, 'en', 'exposure-a', () => true);
  const variants = [
    ownVotesQuery('reader-b', cursor, 'en', 'exposure-a', () => true),
    ownVotesQuery('reader-a', 'next-cursor', 'en', 'exposure-a', () => true),
    ownVotesQuery('reader-a', cursor, 'ja', 'exposure-a', () => true),
    ownVotesQuery('reader-a', cursor, 'en', 'exposure-b', () => true),
    ownVotesQuery('reader-a', cursor, 'en', 'exposure-a', () => false),
  ];
  expect(new Set([first, ...variants].map(({ queryKey }) => JSON.stringify(queryKey))).size).toBe(5);
  expect(first.queryKey).toContain(cursor);
  expect(first).toMatchObject({
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
});
