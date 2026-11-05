import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ContinueEntry, ContinueResult } from '../src/library/continue-source';
import {
  CONTINUE_WINDOW_MAX_PREDECESSORS,
  CONTINUE_WINDOW_QUERY_KEY,
  acceptContinueWindow,
  continueWindowOwner,
  continueWindowPrevious,
  continueWindowVisit,
  stageContinueWindow,
} from '../src/library/continue-window-navigation';
import { sessionQueryKey } from '../src/session/browser-state';
import { continueCursorHref, continueNewestHref } from '../src/library/continue-address';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/continue' });
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

let pageReader: (cursor: unknown) => Promise<ContinueResult> = async () => ({
  state: 'loaded',
  entries: [],
  next: null,
});
const readCalls: unknown[] = [];
const readContinueEntries = mock(async (input: { data: { cursor?: unknown } }) => {
  readCalls.push(input.data.cursor);
  return pageReader(input.data.cursor);
});
mock.module('../src/kernel/exposure', () => ({ prepareExposure: async () => {}, useOperation: () => true }));
mock.module('../src/session/guard', () => ({ requireSignedIn: async () => {} }));
mock.module('../src/library/pins-current', () => ({ useCurrentLibraryNavigation: () => ({ data: undefined }) }));
mock.module('../src/library/library-nav', () => ({ LibraryNavigation: () => null }));
mock.module('../src/library/continue-read', () => ({ readContinueEntries }));

const { createRoot } = await import('react-dom/client');
const { Route } = await import('../src/routes/library/continue');

function parseSearch(searchString: string): Record<string, unknown> {
  const search = new URLSearchParams(searchString);
  const parsed: Record<string, unknown> = Object.create(null);
  for (const [key, value] of search) {
    if (!Object.hasOwn(parsed, key)) parsed[key] = value;
    else if (Array.isArray(parsed[key])) (parsed[key] as string[]).push(value);
    else parsed[key] = [parsed[key] as string, value];
  }
  return parsed;
}

function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.append(key, value);
    else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') params.append(key, item);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function entry(label: string): ContinueEntry {
  const subjectId = `subject-${label.toLowerCase().replaceAll(' ', '-')}`;
  return {
    subjectId,
    label,
    language: 'en',
    summary: {
      id: subjectId,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: label, language: 'en' },
      creativeWork: true,
      cover: null,
    },
    progress: {
      sessionId: `session-${label.toLowerCase().replaceAll(' ', '-')}`,
      mode: 'scalar_amount',
      unit: 'page',
      amount: '4.25',
      total: '10',
      completedUnitCount: 0,
      locator: null,
    },
  };
}

function page(label: string, next: string | null): ContinueResult {
  return { state: 'loaded', entries: [entry(label)], next };
}

function link(host: HTMLElement, label: string): HTMLAnchorElement {
  const result = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
    (anchor) => anchor.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing Continue link: ${label}`);
  return result;
}

function hasLink(host: HTMLElement, label: string): boolean {
  return [...host.querySelectorAll<HTMLAnchorElement>('a')].some((anchor) => anchor.textContent?.trim() === label);
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
}

async function mount(path: string, read: (cursor: unknown) => Promise<ContinueResult> | ContinueResult) {
  pageReader = async (cursor) => read(cursor);
  readCalls.length = 0;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader-a', csrfToken: 'token-a' });
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: () => <Outlet /> });
  const continueRoute = Route.update({ getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([continueRoute]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
    parseSearch,
    stringifySearch,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
    defaultPendingComponent: () => <p>Continue loading</p>,
    defaultErrorComponent: () => <p>Continue route failed</p>,
  });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  let key = 0;
  const render = () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider key={key} router={router} />
      </QueryClientProvider>,
    );
  await act(async () => render());
  await settle();
  return {
    host,
    root,
    queryClient,
    router,
    async remount() {
      key += 1;
      await act(async () => render());
      await settle();
    },
    async close() {
      await act(async () => root.unmount());
      router.history.destroy();
      queryClient.clear();
      host.remove();
    },
  };
}

async function activate(host: HTMLElement, label: string, keyboard = false) {
  const anchor = link(host, label);
  await act(async () => {
    anchor.focus();
    if (keyboard) anchor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    anchor.click();
  });
  await settle();
}

async function clickRetry(host: HTMLElement) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === m.library_follow_retry(),
  );
  if (!button) throw new Error('Missing Continue Retry button');
  await act(async () => button.click());
  await settle();
}

afterAll(async () => {
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the actual Router browses three native windows across remount, Back, Forward, Previous and First', async () => {
  const ui = await mount('/library/continue?display=compact&tag=a&tag=b#resume', (cursor) => {
    if (cursor === undefined) return page('Book A', 'cursor-b');
    if (cursor === 'cursor-b') return page('Book B', 'cursor-c');
    if (cursor === 'cursor-c') return { state: 'loaded', entries: [], next: null };
    return { state: 'unavailable', status: 503 };
  });
  try {
    expect(ui.host.textContent).toContain('Book A');
    expect(ui.host.querySelector<HTMLAnchorElement>('[data-slot="cover-card-title"]')?.getAttribute('href')).toBe(
      '/en/library/progress/session-book-a',
    );
    expect(ui.host.querySelector(`a[href*="cursor-b"]`)?.getAttribute('href')).toBe(
      '/en/library/continue?display=compact&tag=a&tag=b&cursor=cursor-b#resume',
    );
    expect(ui.host.querySelector(`a[aria-disabled="true"]`)).toBeNull();

    await activate(ui.host, m.library_next_page(), true);
    expect(ui.host.textContent).toContain('Book B');
    expect(window.document.activeElement?.tagName).toBe('H1');
    expect(link(ui.host, m.library_continue_previous_window()).getAttribute('href')).toBe(
      '/en/library/continue?display=compact&tag=a&tag=b#resume',
    );
    expect(link(ui.host, m.library_continue_first_window()).getAttribute('href')).toBe(
      '/en/library/continue?display=compact&tag=a&tag=b#resume',
    );

    await activate(ui.host, m.library_next_page());
    expect(ui.host.textContent).toContain(m.library_continue_empty());
    expect(ui.host.textContent).not.toContain('Book B');
    expect(ui.host.querySelector(`a[href*="cursor-c"]`)).toBeNull();
    expect(link(ui.host, m.library_continue_previous_window()).getAttribute('href')).toBe(
      '/en/library/continue?display=compact&tag=a&tag=b&cursor=cursor-b#resume',
    );
    await ui.remount();
    expect(ui.host.textContent).toContain(m.library_continue_empty());

    await act(async () => ui.router.history.back());
    await settle();
    expect(ui.host.textContent).toContain('Book B');
    expect(link(ui.host, m.library_continue_previous_window()).getAttribute('href')).toBe(
      '/en/library/continue?display=compact&tag=a&tag=b#resume',
    );
    await act(async () => ui.router.history.forward());
    await settle();
    expect(ui.host.textContent).toContain(m.library_continue_empty());

    await activate(ui.host, m.library_continue_previous_window());
    expect(ui.host.textContent).toContain('Book B');
    await activate(ui.host, m.library_continue_first_window());
    expect(ui.host.textContent).toContain('Book A');
    expect(ui.host.querySelector(`a[aria-disabled="true"]`)).toBeNull();
    expect(link(ui.host, m.library_next_page()).getAttribute('href')).toBe(
      '/en/library/continue?display=compact&tag=a&tag=b&cursor=cursor-b#resume',
    );
  } finally {
    await ui.close();
  }
});

test('direct later pages offer First only; preparing and failed targets retry the exact cursor before Previous appears', async () => {
  const direct = await mount('/library/continue?cursor=cursor-c&tag=x#mark', (cursor) =>
    cursor === 'cursor-c' ? page('Book C', null) : page('Book A', 'cursor-b'),
  );
  try {
    expect(direct.host.textContent).toContain('Book C');
    expect(hasLink(direct.host, m.library_continue_previous_window())).toBe(false);
    expect(link(direct.host, m.library_continue_first_window()).getAttribute('href')).toBe(
      '/en/library/continue?tag=x#mark',
    );
  } finally {
    await direct.close();
  }

  let targetReads = 0;
  const retryUi = await mount('/library/continue?display=compact#resume', (cursor) => {
    if (cursor === undefined) return page('Book A', 'cursor-b');
    targetReads += 1;
    if (targetReads === 1) return { state: 'preparing', retryAfter: 30 };
    if (targetReads === 2) return { state: 'unavailable', status: 503 };
    return page('Book B', 'cursor-c');
  });
  try {
    await activate(retryUi.host, m.library_next_page());
    expect(retryUi.host.textContent).toContain(m.library_continue_preparing());
    expect(hasLink(retryUi.host, m.library_continue_previous_window())).toBe(false);
    expect(retryUi.host.textContent).not.toContain(m.library_continue_empty());
    await clickRetry(retryUi.host);
    expect(retryUi.host.textContent).toContain(m.library_continue_unavailable());
    await clickRetry(retryUi.host);
    expect(retryUi.host.textContent).toContain('Book B');
    expect(readCalls.slice(-2)).toEqual(['cursor-b', 'cursor-b']);
    expect(link(retryUi.host, m.library_continue_previous_window()).getAttribute('href')).toBe(
      '/en/library/continue?display=compact#resume',
    );
  } finally {
    await retryUi.close();
  }
});

test('stale cursor restart preserves unrelated fields and retires the old visit', async () => {
  const ui = await mount('/library/continue?display=compact&cursor=cursor-old&tag=a&tag=b#resume', (cursor) =>
    cursor === 'cursor-old' ? { state: 'unavailable', status: 409, reason: 'stale-address' } : page('Book A', null),
  );
  try {
    expect(ui.host.textContent).toContain(m.library_continue_address_expired());
    const newest = link(ui.host, m.library_continue_address_newest());
    expect(newest.getAttribute('href')).toBe('/en/library/continue?display=compact&tag=a&tag=b#resume');
    newest.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await act(async () => newest.click());
    expect(ui.queryClient.getQueryData(CONTINUE_WINDOW_QUERY_KEY)).toBeUndefined();
    expect(continueNewestHref('en', '?cursor=old&tag=a&tag=b', '#resume')).toBe(
      '/en/library/continue?tag=a&tag=b#resume',
    );
  } finally {
    await ui.close();
  }
});

test('session replacement during a staged read retires old rows and focus intent immediately', async () => {
  let resolveOld!: (result: ContinueResult) => void;
  let targetReads = 0;
  const outside = window.document.createElement('button');
  outside.textContent = 'Other focus';
  window.document.body.append(outside);
  const ui = await mount('/library/continue', (cursor) => {
    if (cursor === undefined) return page('Book A', 'cursor-b');
    targetReads += 1;
    if (targetReads === 1) return new Promise<ContinueResult>((resolve) => (resolveOld = resolve));
    return page('Book B current', null);
  });
  try {
    await activate(ui.host, m.library_next_page(), true);
    outside.focus();
    await act(async () => {
      ui.queryClient.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader-a', csrfToken: 'token-a' });
      ui.queryClient.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader-b', csrfToken: 'token-b' });
      ui.queryClient.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader-a', csrfToken: 'token-a' });
    });
    await act(async () => resolveOld(page('Book B retired', 'cursor-c')));
    await settle();
    expect(ui.host.textContent).toContain('Book B current');
    expect(ui.host.textContent).not.toContain('Book B retired');
    expect(hasLink(ui.host, m.library_continue_previous_window())).toBe(false);
    expect(window.document.activeElement).toBe(outside);
    expect(ui.queryClient.getQueryData(CONTINUE_WINDOW_QUERY_KEY)).toBeUndefined();
  } finally {
    outside.remove();
    await ui.close();
  }
});

test('coordinate commits are exact, branch from the current page and retain eight predecessors', () => {
  const client = new QueryClient();
  client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'token' });
  const owner = continueWindowOwner(client, 'en', readContinueEntries);
  const visitId = 'route-visit';
  let current: string | null = null;
  for (let index = 1; index <= 11; index += 1) {
    const target = `cursor-${index}`;
    expect(
      stageContinueWindow(client, {
        visitId,
        owner,
        current,
        target,
        direction: 'next',
        restoreHeadingFocus: false,
      }),
    ).toBe(true);
    expect(acceptContinueWindow(client, { visitId, owner, current: target, loaded: false }).committed).toBe(false);
    expect(
      stageContinueWindow(client, {
        visitId,
        owner,
        current,
        target: 'duplicate',
        direction: 'next',
        restoreHeadingFocus: false,
      }),
    ).toBe(false);
    expect(acceptContinueWindow(client, { visitId, owner, current: target, loaded: true }).committed).toBe(true);
    current = target;
  }
  const visit = client.getQueryData<{ path: (string | null)[] }>(CONTINUE_WINDOW_QUERY_KEY)!;
  expect(CONTINUE_WINDOW_MAX_PREDECESSORS).toBe(8);
  expect(visit.path).toHaveLength(9);
  expect(visit.path[0]).toBe('cursor-3');
  expect(continueWindowPrevious(visit as never, current)).toEqual({ target: 'cursor-10' });

  expect(
    stageContinueWindow(client, {
      visitId,
      owner,
      current: 'cursor-8',
      target: 'branch',
      direction: 'next',
      restoreHeadingFocus: false,
    }),
  ).toBe(true);
  expect(acceptContinueWindow(client, { visitId, owner, current: 'branch', loaded: true }).committed).toBe(true);
  const branched = client.getQueryData<{ path: (string | null)[] }>(CONTINUE_WINDOW_QUERY_KEY)!;
  expect(branched.path).toEqual(['cursor-3', 'cursor-4', 'cursor-5', 'cursor-6', 'cursor-7', 'cursor-8', 'branch']);
  const replacementClient = new QueryClient();
  replacementClient.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'token' });
  expect(
    continueWindowVisit(replacementClient, visitId, continueWindowOwner(replacementClient, 'en', readContinueEntries)),
  ).toBe(undefined);
  expect(continueWindowVisit(client, visitId, continueWindowOwner(client, 'fr', readContinueEntries))).toBeUndefined();
  expect(
    continueWindowVisit(
      client,
      visitId,
      continueWindowOwner(client, 'en', () => Promise.resolve(page('Other', null))),
    ),
  ).toBeUndefined();
  replacementClient.clear();
  client.clear();
});

test('cursor links preserve opaque bytes, other query values and the fragment', () => {
  expect(continueCursorHref('fr', '?cursor=old&tag=a&tag=b&display=compact', '#resume', 'next+/==?&')).toBe(
    '/fr/library/continue?tag=a&tag=b&display=compact&cursor=next%2B%2F%3D%3D%3F%26#resume',
  );
  expect(continueCursorHref('fr', '?cursor=old&tag=a&tag=b', '#resume', null)).toBe(
    '/fr/library/continue?tag=a&tag=b#resume',
  );
});
