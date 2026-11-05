import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { FollowCountsReader, FollowCountsSearch } from '../src/library/private-follow-counts';

// UNRUN mounted regressions. Happy DOM checks behavior and associations; story plays author physical layout assertions.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/follow-counts' });
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
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { readFollowCounts } = await import('../src/library/private-follow-counts');
const { PrivateFollowCountsPage } = await import('../src/library/private-follow-counts-page');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
const viewer = { subject: 'alice', csrfToken: 'A'.repeat(22) };
const target = { targetType: 'collection' as const, targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000021' };
const contextHref = `/en/library/follow-counts?targetType=collection&targetId=${target.targetId}`;
const signInHref = `/auth/sign-in?return_to=${encodeURIComponent(contextHref)}`;
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const calls: Request[] = [];
const reads: FollowCountsSearch[] = [];
let reply: (outgoing: boolean) => Response;
let hold: Promise<void> | undefined;
const native = createKernelClient('https://kernel.example.test', {
  fetch: async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe('Bearer phone-counts');
    expect(request.cache).toBe('no-store');
    expect(new URL(request.url).search).toBe('');
    return reply(request.url.endsWith('/outgoing'));
  },
});
const read: FollowCountsReader = async ({ data }) => {
  reads.push(data);
  await hold;
  return { viewer, locale: getLocale(), ...(await readFollowCounts(native, 'Bearer phone-counts', data)) };
};
const response = (outgoing: boolean, count: number) =>
  Response.json(outgoing ? { followingCount: count } : { ...target, followerCount: count });
const failure = (status: number, code: string, retryAfter?: string) =>
  Response.json({ code }, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let releaseAdmission: () => void;
let context: FollowCountsSearch;
const setAdmission = (admitted: string[]) => {
  const snapshot = viewerExposureLifetime(client).getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Expected current viewer observation');
  client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, { subject: viewer.subject, admitted });
};
const route = createRootRoute({ component: () => <PrivateFollowCountsPage context={context} read={read} /> });
let router: ReturnType<typeof createRouter<typeof route>>;
const tree = () => (
  <QueryClientProvider client={client}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
const paint = () =>
  act(async () => {
    root.render(tree());
    await tick();
  });
const scalars = (element: ParentNode = host) =>
  [...element.querySelectorAll('[data-follow-count]')].map((node) => node.getAttribute('data-follow-count'));
const outgoingRegion = () => host.querySelector<HTMLElement>('section[aria-labelledby="outgoing-count-heading"]')!;
const targetRegion = () => host.querySelector<HTMLElement>('section[aria-labelledby="target-count-heading"]')!;
const reload = () => host.querySelector<HTMLButtonElement>('button')!;
const focusAndResize = async () => {
  const before = { reads: reads.length, calls: calls.length };
  for (const control of host.querySelectorAll<HTMLElement>('a, button')) {
    if (control instanceof HTMLButtonElement && control.disabled) continue;
    control.focus();
    expect(window.document.activeElement).toBe(control);
    expect(control.classList.contains('min-h-11')).toBe(true);
    expect(control.classList.contains('max-w-full')).toBe(true);
    expect(control.classList.contains('whitespace-normal')).toBe(true);
    expect(control.classList.contains('focus-visible:outline-2')).toBe(true);
  }
  for (const width of [320, 390, 1280]) {
    window.innerWidth = width;
    window.dispatchEvent(new window.Event('resize'));
  }
  window.dispatchEvent(new window.Event('focus'));
  await paint();
  expect({ reads: reads.length, calls: calls.length }).toEqual(before);
};

beforeEach(async () => {
  setLocale('en', { reload: false });
  calls.length = reads.length = 0;
  hold = undefined;
  context = target;
  reply = (outgoing) => response(outgoing, 0);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', ...viewer });
  releaseAdmission = viewerExposureLifetime(client).subscribe(() => {});
  setAdmission(['personal_library']);
  client.setQueryData(['exposure', 'anonymous'], []);
  router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: [contextHref] }) });
  await router.load();
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  releaseAdmission();
  client.clear();
});
afterAll(async () => {
  setLocale(previousLocale, { reload: false });
  host.remove();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('actual zero and a long formatted count retain native control order, exact destinations and one explicit reload', async () => {
  reply = (outgoing) => response(outgoing, outgoing ? 0 : Number.MAX_SAFE_INTEGER);
  await paint();
  expect(scalars()).toEqual(['0', String(Number.MAX_SAFE_INTEGER)]);
  expect(targetRegion().textContent).toContain(new Intl.NumberFormat('en').format(Number.MAX_SAFE_INTEGER));
  const links = [...host.querySelectorAll<HTMLAnchorElement>('a')];
  expect(links.map((link) => link.getAttribute('href'))).toEqual(['/en/library', '/en/library/following']);
  expect(links.map((link) => link.textContent)).toEqual([m.nav_library(), m.library_nav_following()]);
  const destinations: string[] = [];
  for (const link of links) {
    link.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        destinations.push(link.getAttribute('href')!);
      },
      { once: true },
    );
    link.click();
  }
  expect(destinations).toEqual(['/en/library', '/en/library/following']);
  expect(reload().textContent).toBe(m.library_follow_counts_reload());
  expect(reload().classList.contains('h-auto')).toBe(true);
  await focusAndResize();
  expect(reads).toHaveLength(1);
  expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
    '/v1/followCounts/outgoing',
    `/v1/followCounts/collection/${target.targetId}`,
  ]);
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await act(async () => {
    reload().click();
    await tick();
  });
  expect(reload().disabled).toBe(true);
  expect(scalars()).toEqual([]);
  expect(outgoingRegion().getAttribute('aria-busy')).toBe('true');
  await act(async () => {
    reload().click();
    await tick();
  });
  expect(reads).toHaveLength(2);
  await act(async () => {
    release();
    await tick();
  });
  expect(scalars()).toEqual(['0', String(Number.MAX_SAFE_INTEGER)]);
  expect(reload().disabled).toBe(false);
  expect(calls).toHaveLength(4);
});

for (const status of [404, 503]) {
  test(`outgoing zero remains independent of target ${status} and Retry-After seconds remain guidance only`, async () => {
    reply = (outgoing) =>
      outgoing ? response(true, 0) : failure(status, status === 404 ? 'not_found' : 'dependency_unavailable', '7');
    await paint();
    expect(scalars(outgoingRegion())).toEqual(['0']);
    expect(scalars(targetRegion())).toEqual([]);
    const alert = targetRegion().querySelector('[role="alert"]')!;
    expect(alert.getAttribute('aria-labelledby')).toBe('target-count-heading');
    expect(alert.textContent).toContain(
      status === 404 ? m.library_follow_counts_denied() : m.library_follow_counts_unavailable(),
    );
    expect(alert.textContent).toContain(m.library_follow_counts_retry_after({ value: '7' }));
    await focusAndResize();
    expect(reads).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
}

test('outgoing unavailability preserves target zero and exact date guidance; malformed Retry-After invents no advice', async () => {
  const date = 'Wed, 04 Nov 2026 12:34:00 GMT';
  reply = (outgoing) => (outgoing ? failure(503, 'dependency_unavailable', date) : response(false, 0));
  await paint();
  expect(scalars(outgoingRegion())).toEqual([]);
  expect(scalars(targetRegion())).toEqual(['0']);
  const formatted = new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short' }).format(Date.parse(date));
  expect(outgoingRegion().textContent).toContain(m.library_follow_counts_retry_at({ value: formatted }));
  await focusAndResize();
  reply = (outgoing) => (outgoing ? failure(503, 'dependency_unavailable', 'not-a-date') : response(false, 0));
  await act(async () => {
    reload().click();
    await tick();
  });
  expect(outgoingRegion().querySelector('[role="alert"]')!.textContent).toBe(m.library_follow_counts_unavailable());
  expect(scalars(targetRegion())).toEqual(['0']);
});

test('a closed outgoing read and a signed-out contextual read remain distinct from counts and preserve recovery multiplicity', async () => {
  reply = (outgoing) => (outgoing ? failure(403, 'platform_closed') : failure(401, 'invalid_credentials'));
  await paint();
  expect(scalars()).toEqual([]);
  expect(outgoingRegion().textContent).toContain(m.platform_closed_heading());
  expect(outgoingRegion().querySelector('a[href^="/auth/"]')).toBeNull();
  expect(targetRegion().textContent).toContain(m.library_sign_in());
  const signIn = targetRegion().querySelector<HTMLAnchorElement>('a')!;
  expect(signIn.getAttribute('href')).toBe(signInHref);
  expect(signIn.getAttribute('aria-describedby')).toBe('target-count-heading');
  expect(host.querySelectorAll('a[href^="/auth/"]')).toHaveLength(1);
  await focusAndResize();
  expect(calls).toHaveLength(2);
});

test('existing long translated notices and operation names remain complete in the mounted recovery page', async () => {
  setLocale('de', { reload: false });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  await paint();
  expect(host.textContent).toContain(m.library_follow_counts_description());
  expect(host.textContent).toContain(m.library_follow_counts_outgoing());
  expect(host.textContent).toContain(m.library_follow_counts_target());
  expect(outgoingRegion().querySelector('[role="alert"]')!.textContent).toContain(m.library_sign_in());
  const links = [...host.querySelectorAll<HTMLAnchorElement>('a[href^="/auth/sign-in?"]')];
  const returnTo = `/de/library/follow-counts?targetType=collection&targetId=${target.targetId}`;
  expect(links).toHaveLength(2);
  expect(links.every((link) => link.textContent === m.account_sign_in())).toBe(true);
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
    `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
  ]);
  expect(host.querySelector('button')).toBeNull();
  expect(scalars()).toEqual([]);
  await focusAndResize();
  expect(reads).toHaveLength(0);
  expect(calls).toHaveLength(0);
});

test('invalid target context keeps outgoing zero, gives context guidance and dispatches no target request', async () => {
  context = { invalidContext: true };
  await paint();
  expect(scalars()).toEqual(['0']);
  expect(targetRegion().querySelector('[role="status"]')!.textContent).toBe(m.library_follow_counts_invalid_context());
  expect(targetRegion().querySelector('a')).toBeNull();
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/followCounts/outgoing');
  await focusAndResize();
});

test('admission withdrawal retires private output and reload, including late responses; sign-out preserves both exact return links', async () => {
  await paint();
  expect(scalars()).toEqual(['0', '0']);
  let release!: () => void;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await act(async () => {
    reload().click();
    await tick();
  });
  const oldReload = reload();
  await act(async () => {
    flushSync(() => setAdmission([]));
    expect(scalars()).toEqual([]);
    expect(host.querySelector('button')).toBeNull();
    await tick();
  });
  expect(host.textContent).toContain(m.platform_closed_heading());
  expect(host.querySelector('a[href^="/auth/"]')).toBeNull();
  expect([...host.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
    '/en/library',
    '/en/library/following',
  ]);
  await act(async () => {
    oldReload.click();
    release();
    await tick();
  });
  expect(scalars()).toEqual([]);
  expect(reads).toHaveLength(2);
  await focusAndResize();
  await act(async () => {
    flushSync(() =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
    );
    expect(scalars()).toEqual([]);
    await tick();
  });
  const signIns = [...host.querySelectorAll<HTMLAnchorElement>('a[href^="/auth/sign-in?"]')];
  expect(signIns).toHaveLength(2);
  expect(signIns.map((link) => link.getAttribute('href'))).toEqual([signInHref, signInHref]);
  expect(signIns.map((link) => link.getAttribute('aria-describedby'))).toEqual([
    'outgoing-count-heading',
    'target-count-heading',
  ]);
  expect(signIns.every((link) => link.textContent === m.account_sign_in())).toBe(true);
  expect(host.querySelector('button')).toBeNull();
  await focusAndResize();
  expect(reads).toHaveLength(2);
});
