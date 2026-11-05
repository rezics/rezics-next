import { subjectSummary } from './factories/subjects';
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
let routeLoaderReads = false;
let routeReadPlan: ((subject: string, cursor: string | null) => OwnVotesRead) | null = null;
let commandPlan: (input: { data: unknown }) => Promise<unknown> = async () => ({ kind: 'rejected' });
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/kernel/client', () => ({ configured: () => false }));
mock.module('../src/ratings/own-votes/actions', () => ({
  readOwnVotesForViewer: ({ data }: { data: { cursor?: string } }) => {
    const call = { ...deferred<OwnVotesRead>(), subject: activeSubject, cursor: data.cursor ?? null };
    reads.push(call);
    for (const wake of readWaiters.splice(0)) wake();
    if (routeReadPlan) {
      const result = routeReadPlan(activeSubject, call.cursor);
      call.resolve(result);
      return Promise.resolve(result);
    }
    return call.promise;
  },
  executeOwnVoteIntent: (input: { data: unknown }) => commandPlan(input),
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
const { readOwnVotesForViewer } = await import('../src/ratings/own-votes/actions');
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
    subject: subjectSummary({ id: terminal, label: { value: 'Kokoro', language: 'en' } }),
    subjectHref: `/v1/subjects/${terminal}`,
    question: {
      id: question,
      revision: 3,
      label: 'How much does it stay with you?',
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 2 },
    },
    own: { units: 0, revision: 4, at: '2026-10-01T00:00:00.000Z' },
    actions: { state: 'editable', put: path, clear: path, readback: path },
  };
}
const pageFor = (subject: string): OwnVotesPage => ({ viewer: { accountId: subject }, votes: [row()], next: null });
const nativeRead = (
  subject = account,
  cursor: string | null = null,
  locale = getLocale(),
  page = pageFor(subject),
): OwnVotesRead => ({
  state: 'ready',
  page,
  subject,
  cursor,
  locale,
  source: 'rating.own_votes_page/v1',
});
const rootRoute = createRootRoute({
  component: function RootReader() {
    const cursor = useRouterState({
      select: ({ location }) => {
        const search = location.search as Record<string, unknown>;
        return typeof search.cursor === 'string' ? search.cursor : null;
      },
    });
    return createElement(
      'div',
      null,
      createElement(OwnVotesReturnProvider, null, createElement(Outlet)),
      createElement('output', { 'data-test-route-cursor': true }, `route:${cursor ?? 'first'}`),
    );
  },
});
const ratingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/ratings',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.cursor === 'string' ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => ({ cursor: typeof search.cursor === 'string' ? search.cursor : null }),
  loader: ({ deps }) =>
    routeLoaderReads
      ? readOwnVotesForViewer({ data: deps.cursor === null ? {} : { cursor: deps.cursor } })
      : nativeRead(account, deps.cursor),
  component: function RatingsRoute() {
    const search = useRouterState({ select: (state) => state.location.search });
    const cursor = typeof search.cursor === 'string' ? search.cursor : null;
    const initial = ratingsRoute.useLoaderData();
    const responseVersion = useRouterState({
      select: ({ matches }) => matches.find((match) => match.routeId === '/library/ratings')?.updatedAt ?? 0,
    });
    return createElement(CurrentViewerOwnVotesPage, { initial, cursor, responseVersion });
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
  activeSubject = account;
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
  const perform = (work: () => void | Promise<unknown>) =>
    act(async () => {
      await work();
    });
  function applyViewer(subject: string, csrfToken: string) {
    activeSubject = subject;
    client.setQueryData(sessionQuery.queryKey, session(subject, csrfToken));
    const current = viewerExposureLifetime(client).getSnapshot();
    if (current.state !== 'signed-in') throw new Error('Expected replacement browser observation');
    client.setQueryData(viewerExposureQuery(current.observation).queryKey, {
      subject: current.observation.subject,
      admitted: ['personal_library'],
    });
  }
  function expose(subject: string, csrfToken: string) {
    return perform(() => applyViewer(subject, csrfToken));
  }
  async function exposeSequence(subjects: string[]) {
    for (const [index, subject] of subjects.entries()) await expose(subject, `csrf-sequence-${index}`);
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
    exposeSequence,
    click: (node: Element) =>
      act(async () =>
        node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })),
      ),
    close: async () => {
      await act(async () => root.unmount());
      stopObservation();
      client.clear();
      host.remove();
    },
  };
}

async function waitForCursor(view: Awaited<ReturnType<typeof mounted>>, cursor: string | null) {
  return waitForText(view.host, `route:${cursor ?? 'first'}`);
}
function hasLink(view: Awaited<ReturnType<typeof mounted>>, name: string) {
  return [...view.host.querySelectorAll('a')].some((candidate) => candidate.textContent?.trim() === name);
}
async function waitForLink(view: Awaited<ReturnType<typeof mounted>>, name: string) {
  if (hasLink(view, name)) return true;
  return new Promise<boolean>((resolve) => {
    const observer = new window.MutationObserver(() => {
      if (!hasLink(view, name)) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve(true);
    });
    observer.observe(view.host, { subtree: true, childList: true, characterData: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, 1000);
  });
}
async function waitForBodyText(view: Awaited<ReturnType<typeof mounted>>, text: string) {
  return waitForText(document.body, text);
}
function bodyButton(view: Awaited<ReturnType<typeof mounted>>, name: string) {
  const button = [...document.body.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Expected ${name} button`);
  return button;
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

async function editDraft(view: Awaited<ReturnType<typeof mounted>>, value = '2') {
  const findButton = (name: string) => {
    const button = [...view.host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`Expected ${name} button`);
    return button;
  };
  await view.click(findButton(m.library_my_ratings_inspect()));
  await view.click(findButton(m.library_my_ratings_edit()));
  const input = view.host.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error('Expected the selected answer editor');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  if (!setter) throw new Error('Expected an input value setter');
  await view.perform(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  return input;
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
      throw new Error(
        JSON.stringify({ text: view.host.textContent, reads: reads.length, location: view.router.state.location }),
      );
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
    expect(
      view.host.querySelector(
        '[data-own-vote-target="' + target + '"][data-own-vote-question="' + question + '"] button',
      ),
    ).toBe(window.document.activeElement);
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
    const key = view.client
      .getQueryCache()
      .findAll({ queryKey: ['own-votes'] })
      .at(-1)?.queryKey;
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

test('real route pagination retries the exact cursor, preserves sparse and terminal pages, and truncates a branch', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  routeLoaderReads = true;
  const firstPage: OwnVotesPage = { viewer: { accountId: account }, votes: [row()], next: 'cursor-a' };
  const sparseB: OwnVotesPage = { viewer: { accountId: account }, votes: [], next: 'cursor-b' };
  const sparseC: OwnVotesPage = { viewer: { accountId: account }, votes: [], next: 'cursor-c' };
  const terminal: OwnVotesPage = { viewer: { accountId: account }, votes: [], next: null };
  const unavailable = (cursor: string): OwnVotesRead => ({
    state: 'unavailable',
    page: null,
    subject: account,
    cursor,
    locale: getLocale(),
    source: null,
  });
  const result = (cursor: string | null, page: OwnVotesPage) => nativeRead(account, cursor, getLocale(), page);
  const plans = new Map<string, OwnVotesRead[]>([
    ['first', [result(null, firstPage), result(null, firstPage)]],
    [
      'cursor-a',
      [unavailable('cursor-a'), result('cursor-a', sparseB), result('cursor-a', sparseC), result('cursor-a', sparseC)],
    ],
    ['cursor-b', [result('cursor-b', terminal)]],
    ['cursor-c', [result('cursor-c', terminal)]],
  ]);
  routeReadPlan = (_subject, cursor) => {
    const queue = plans.get(cursor ?? 'first');
    if (!queue?.length) throw new Error(`No route read was planned for ${cursor ?? 'first'}`);
    return queue.shift()!;
  };
  const view = await mounted();
  const findLink = (name: string) => {
    const link = [...view.host.querySelectorAll('a')].find((candidate) => candidate.textContent?.trim() === name);
    if (!link) throw new Error(`Expected ${name} link`);
    return link;
  };
  const moveAndRead = async (name: string, cursor: string | null, marker?: string) => {
    const index = reads.length;
    await view.click(findLink(name));
    const read = await waitForRead(index);
    expect(read.cursor).toBe(cursor);
    await act(async () => read.promise);
    expect(await waitForCursor(view, cursor)).toBe(true);
    if (marker) expect(await waitForText(view.host, marker)).toBe(true);
    return read;
  };
  try {
    expect(reads.map((read) => read.cursor)).toEqual([null]);
    await moveAndRead(m.library_my_ratings_continue(), 'cursor-a', m.library_my_ratings_unavailable());
    expect(view.host.querySelector('button')?.textContent).toBe(m.library_my_ratings_retry_page());

    const retryIndex = reads.length;
    const retry = [...view.host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === m.library_my_ratings_retry_page(),
    );
    if (!retry) throw new Error('Expected exact page retry');
    await view.click(retry);
    const retryRead = await waitForRead(retryIndex);
    expect(retryRead.cursor).toBe('cursor-a');
    await act(async () => retryRead.promise);
    expect(await waitForText(view.host, m.library_my_ratings_sparse())).toBe(true);
    expect(await waitForLink(view, m.library_my_ratings_continue())).toBe(true);

    await moveAndRead(m.library_my_ratings_continue(), 'cursor-b', m.library_my_ratings_empty());
    await moveAndRead(m.library_my_ratings_previous(), 'cursor-a', m.library_my_ratings_sparse());
    expect(hasLink(view, m.library_my_ratings_continue())).toBe(true);
    await moveAndRead(m.library_my_ratings_continue(), 'cursor-c', m.library_my_ratings_empty());
    await moveAndRead(m.library_my_ratings_previous(), 'cursor-a', m.library_my_ratings_sparse());
    await moveAndRead(m.library_my_ratings_first(), null, 'Kokoro');

    expect(reads.map((read) => read.cursor)).toEqual([
      null,
      'cursor-a',
      'cursor-a',
      'cursor-b',
      'cursor-a',
      'cursor-c',
      'cursor-a',
      null,
    ]);
    expect(view.host.querySelector('a')?.textContent).not.toBe(m.library_my_ratings_previous());
    expect(view.host.querySelectorAll('[data-own-vote-pair]')).toHaveLength(1);
  } finally {
    await view.close();
    routeLoaderReads = false;
    routeReadPlan = null;
  }
});

test('the route retains eight predecessor cursors and each Previous performs a fresh bounded read', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  routeLoaderReads = true;
  routeReadPlan = (_subject, cursor) => {
    const number = cursor === null ? 0 : Number(cursor.slice('cursor-'.length));
    const next = number === 10 ? null : `cursor-${number + 1}`;
    const page =
      number === 0
        ? { viewer: { accountId: account }, votes: [row()], next }
        : {
            viewer: { accountId: account },
            votes: [
              {
                ...row(),
                question: { ...row().question, label: `Page ${number}` },
              },
            ],
            next,
          };
    return nativeRead(account, cursor, getLocale(), page);
  };
  const view = await mounted();
  const findLink = (name: string) => {
    const link = [...view.host.querySelectorAll('a')].find((candidate) => candidate.textContent?.trim() === name);
    if (!link) throw new Error(`Expected ${name} link`);
    return link;
  };
  const moveAndRead = async (name: string, number: number) => {
    const cursor = number === 0 ? null : `cursor-${number}`;
    const index = reads.length;
    await view.click(findLink(name));
    const read = await waitForRead(index);
    expect(read.cursor).toBe(cursor);
    await act(async () => read.promise);
    expect(await waitForCursor(view, cursor)).toBe(true);
    if (number > 0) expect(await waitForText(view.host, `Page ${number}`)).toBe(true);
    if (name === m.library_my_ratings_previous() && number > 2)
      expect(await waitForLink(view, m.library_my_ratings_previous())).toBe(true);
  };
  try {
    for (let page = 1; page <= 10; page += 1) await moveAndRead(m.library_my_ratings_continue(), page);
    expect(hasLink(view, m.library_my_ratings_continue())).toBe(false);
    expect(await waitForLink(view, m.library_my_ratings_previous())).toBe(true);
    for (let page = 9; page >= 2; page -= 1) await moveAndRead(m.library_my_ratings_previous(), page);
    await act(async () => tick());
    expect(hasLink(view, m.library_my_ratings_previous())).toBe(false);
    expect(reads.map((read) => read.cursor)).toEqual([
      null,
      ...Array.from({ length: 10 }, (_, index) => `cursor-${index + 1}`),
      ...Array.from({ length: 8 }, (_, index) => `cursor-${9 - index}`),
    ]);
  } finally {
    await view.close();
    routeLoaderReads = false;
    routeReadPlan = null;
  }
});

test('dirty movement keeps the draft on Stay, retires it on Leave, then returns to the accepted cursor', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  routeLoaderReads = true;
  routeReadPlan = (subject, cursor) => {
    const next = cursor === null ? 'cursor-next' : 'cursor-tail';
    return nativeRead(subject, cursor, getLocale(), {
      viewer: { accountId: subject },
      votes: [row()],
      next: cursor === null ? next : cursor === 'cursor-next' ? 'cursor-tail' : null,
    });
  };
  const view = await mounted();
  const findLink = (name: string) => {
    const link = [...view.host.querySelectorAll('a')].find((candidate) => candidate.textContent?.trim() === name);
    if (!link) throw new Error(`Expected ${name} link`);
    return link;
  };
  const findButton = (name: string) => {
    const button = [...view.host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`Expected ${name} button`);
    return button;
  };
  try {
    const draft = await editDraft(view);
    const continueName = m.library_my_ratings_continue();
    await view.click(findLink(continueName));
    expect(await waitForBodyText(view, m.library_my_ratings_departure_title())).toBe(true);
    await view.click(bodyButton(view, m.library_my_ratings_stay()));
    expect(view.host.querySelector('[data-test-route-cursor]')?.textContent).toBe('route:first');
    expect((view.host.querySelector('input') as HTMLInputElement | null)?.value).toBe('2');

    const leaveIndex = reads.length;
    await view.click(findLink(continueName));
    expect(await waitForBodyText(view, m.library_my_ratings_departure_title())).toBe(true);
    await view.click(bodyButton(view, m.library_my_ratings_leave()));
    const targetRead = await waitForRead(leaveIndex);
    expect(targetRead.cursor).toBe('cursor-next');
    await act(async () => targetRead.promise);
    expect(await waitForCursor(view, 'cursor-next')).toBe(true);
    expect(view.host.querySelector('input')).toBeNull();

    const subject = [...view.host.querySelectorAll('a')].find((link) => link.textContent?.trim() === 'Kokoro');
    if (!subject) throw new Error('Expected the admitted Subject return link');
    await view.click(subject);
    expect(view.host.textContent).toContain('Subject reader');
    const returnRead = await back(view);
    expect(returnRead.cursor).toBe('cursor-next');
    await act(async () => returnRead.promise);
    expect(await waitForText(view.host, m.library_my_ratings_return_found())).toBe(true);
    expect(view.host.querySelector('[data-test-route-cursor]')?.textContent).toBe('route:cursor-next');
    expect(view.host.querySelector('input')).toBeNull();
    expect(view.host.textContent).not.toContain(m.library_my_ratings_edit());
    expect(draft.value).toBe('2');
  } finally {
    await view.close();
    routeLoaderReads = false;
    routeReadPlan = null;
  }
});

test('pending and uncertain commands lock staged movement; source and A/B/A replacement cancel the prompt', async () => {
  reads.length = 0;
  readWaiters.length = 0;
  routeLoaderReads = true;
  routeReadPlan = (subject, cursor) =>
    nativeRead(subject, cursor, getLocale(), {
      viewer: { accountId: subject },
      votes: [row()],
      next: cursor === null ? 'cursor-next' : null,
    });
  const commandCalls: unknown[] = [];
  const pendingCommand = deferred<unknown>();
  commandPlan = ({ data }) => {
    commandCalls.push(data);
    return commandCalls.length === 1 ? pendingCommand.promise : Promise.resolve({ kind: 'uncertain' });
  };
  const view = await mounted();
  const findLink = (name: string) => {
    const link = [...view.host.querySelectorAll('a')].find((candidate) => candidate.textContent?.trim() === name);
    if (!link) throw new Error(`Expected ${name} link`);
    return link;
  };
  const findButton = (name: string) => {
    const button = [...view.host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`Expected ${name} button`);
    return button;
  };
  try {
    await editDraft(view);
    await view.click(findButton(m.library_my_ratings_save()));
    await view.click(findLink(m.library_my_ratings_continue()));
    expect(await waitForBodyText(view, m.library_my_ratings_departure_locked())).toBe(true);
    expect(document.body.textContent).not.toContain(m.library_my_ratings_leave());
    await view.click(bodyButton(view, m.library_my_ratings_stay()));
    expect(view.host.querySelector('[data-test-route-cursor]')?.textContent).toBe('route:first');
    pendingCommand.resolve({ kind: 'uncertain' });
    await act(async () => pendingCommand.promise);
    expect(await waitForText(view.host, m.library_my_ratings_retry_original())).toBe(true);

    await view.click(findLink(m.library_my_ratings_continue()));
    expect(await waitForBodyText(view, m.library_my_ratings_departure_locked())).toBe(true);
    expect(document.body.textContent).not.toContain(m.library_my_ratings_leave());
    await view.click(bodyButton(view, m.library_my_ratings_stay()));
    expect(view.host.querySelector('[data-test-route-cursor]')?.textContent).toBe('route:first');
    await view.click(findButton(m.library_my_ratings_retry_original()));
    await act(async () => Promise.resolve());
    expect(commandCalls).toHaveLength(2);
    expect(commandCalls[1]).toBe(commandCalls[0]);
    expect(reads.every((read) => read.cursor !== 'cursor-next')).toBe(true);
  } finally {
    await view.close();
    routeLoaderReads = false;
    routeReadPlan = null;
    commandPlan = async () => ({ kind: 'rejected' });
  }

  for (const replace of [
    (view: Awaited<ReturnType<typeof mounted>>) => view.expose('55555555-5555-4555-8555-555555555555', 'csrf-b'),
    (view: Awaited<ReturnType<typeof mounted>>) =>
      view.exposeSequence(['55555555-5555-4555-8555-555555555555', account]),
  ]) {
    reads.length = 0;
    readWaiters.length = 0;
    routeLoaderReads = true;
    routeReadPlan = (subject, cursor) =>
      nativeRead(subject, cursor, getLocale(), {
        viewer: { accountId: subject },
        votes: [row()],
        next: cursor === null ? 'cursor-next' : null,
      });
    const replaced = await mounted();
    try {
      await editDraft(replaced);
      await replaced.click(
        [...replaced.host.querySelectorAll('a')].find(
          (candidate) => candidate.textContent?.trim() === m.library_my_ratings_continue(),
        )!,
      );
      expect(await waitForBodyText(replaced, m.library_my_ratings_departure_title())).toBe(true);
      await replace(replaced);
      if (document.body.textContent?.includes(m.library_my_ratings_leave())) {
        const leave = [...document.body.querySelectorAll('button')].find(
          (candidate) => candidate.textContent?.trim() === m.library_my_ratings_leave(),
        );
        if (leave) await replaced.click(leave);
      }
      await act(async () => tick());
      expect(replaced.host.querySelector('[data-test-route-cursor]')?.textContent).toBe('route:first');
      expect(reads.every((read) => read.cursor !== 'cursor-next')).toBe(true);
    } finally {
      await replaced.close();
      routeLoaderReads = false;
      routeReadPlan = null;
    }
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
