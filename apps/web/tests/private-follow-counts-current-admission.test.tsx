import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { FollowCountsPage, FollowCountsSearch, FollowCountsViewer } from '../src/library/private-follow-counts';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

// UNRUN: mounted, controlled-response regressions for integration; no native or browser proof.
// Reuse the installed DOM and the established current-viewer mounting pattern.
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const exposure = await import('../src/kernel/viewer-exposure');
spyOn(exposure, 'readViewerExposure').mockImplementation(async ({ data }) => ({
  subject: data,
  admitted: ['personal_library'],
}));
const { loadPrivateFollowCounts, privateFollowCountsQuery } = await import('../src/library/private-follow-counts');
const { PrivateFollowCountsPage } = await import('../src/library/private-follow-counts-page');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const alice = { subject: 'alice', csrfToken: null as string | null };
const bob = { subject: 'bob', csrfToken: 'B'.repeat(22) };
const first = { targetType: 'collection' as const, targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000021' };
const second = { targetType: 'space' as const, targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000022' };
type Session = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject: string | null;
  csrfToken: string | null;
};
const signedIn = (viewer = alice): Session => ({ state: 'signed-in', ...viewer });
const reads: (ReturnType<typeof deferred<FollowCountsPage>> & { context: FollowCountsSearch })[] = [];
const read = ({ data }: { data: FollowCountsSearch }) => {
  const call = { ...deferred<FollowCountsPage>(), context: data };
  reads.push(call);
  return call.promise;
};
const ready = (viewer: FollowCountsViewer, context: FollowCountsSearch, count: number): FollowCountsPage => ({
  viewer,
  context,
  outgoing: { state: 'ready', count },
  target: context.targetType && context.targetId ? { state: 'ready', count } : null,
});
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let context: FollowCountsSearch;
const exposureKey = () => {
  const snapshot = exposure.viewerExposureLifetime(client).getSnapshot();
  return snapshot.state === 'signed-in'
    ? exposure.viewerExposureQuery(snapshot.observation).queryKey
    : exposureQuery.queryKey;
};
const setExposure = (admitted: string[]) => client.setQueryData(exposureKey(), { subject: 'alice', admitted });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const tree = () => (
  <QueryClientProvider client={client}>
    <PrivateFollowCountsPage context={context} read={read} />
  </QueryClientProvider>
);
const paint = () =>
  act(async () => {
    root.render(tree());
    await tick();
  });
const scalars = () =>
  [...host.querySelectorAll('[data-follow-count]')].map((node) => node.getAttribute('data-follow-count'));
const replace = (update: () => void) =>
  act(async () => {
    update();
    flushSync(() => root.render(tree()));
    // Assert at the replacement commit, before deferred IO or a later paint can hide a stale scalar.
    expect(scalars()).toEqual([]);
    await tick();
  });
const settle = (index: number, page: FollowCountsPage) =>
  act(async () => {
    reads[index]!.resolve(page);
    await tick();
  });
const reload = () =>
  act(async () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === m.library_follow_counts_reload(),
    )!;
    expect(button.disabled).toBe(false);
    button.click();
    await tick();
    expect(scalars()).toEqual([]);
  });

beforeEach(() => {
  reads.length = 0;
  context = first;
  setLocale('en', { reload: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedIn());
  setExposure(['personal_library']);
  client.setQueryData(['exposure', 'anonymous'], []);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
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

test('the mounted count journey retires admission, exact context and viewer ABA, including old reloads', async () => {
  // Even an indefinitely fresh unscoped caller cache cannot seed this mounted lifetime.
  client.setQueryData(privateFollowCountsQuery(alice, first).queryKey, ready(alice, first, 901));
  await paint();
  expect(reads).toHaveLength(1);
  expect(scalars()).toEqual([]);
  await settle(0, ready(alice, first, 17));
  expect(scalars()).toEqual(['17', '17']);
  context = { ...first };
  await paint();
  expect(reads).toHaveLength(1);

  await replace(() => setExposure([]));
  expect(host.textContent).toContain(m.platform_closed_heading());
  expect(host.querySelector('button')).toBeNull();
  expect(reads).toHaveLength(1);
  await replace(() => setExposure(['personal_library']));
  expect(reads).toHaveLength(2);
  expect(host.textContent).toContain(m.library_follow_counts_loading());
  await settle(1, ready(alice, first, 0));
  expect(scalars()).toEqual(['0', '0']);

  await reload();
  expect(reads).toHaveLength(3);
  await replace(() => setExposure([]));
  await replace(() => setExposure(['personal_library']));
  expect(reads).toHaveLength(4);
  await settle(2, ready(alice, first, 902));
  expect(scalars()).toEqual([]);
  await settle(3, ready(alice, first, 5));
  expect(scalars()).toEqual(['5', '5']);

  await reload();
  await replace(() => {
    context = second;
  });
  expect(reads).toHaveLength(6);
  expect(reads[5]!.context).toEqual(second);
  // B becomes usable without waiting for A's IO, and late A cannot replace it.
  await settle(5, ready(alice, second, 8));
  expect(scalars()).toEqual(['8', '8']);
  await replace(() => {
    context = first;
  });
  expect(reads).toHaveLength(7);
  await settle(4, ready(alice, first, 903));
  expect(scalars()).toEqual([]);
  await settle(6, ready(alice, first, 7));
  expect(scalars()).toEqual(['7', '7']);

  await reload();
  await replace(() => client.setQueryData(sessionQuery.queryKey, signedIn(bob)));
  expect(reads).toHaveLength(9);
  await settle(8, ready(bob, first, 11));
  expect(scalars()).toEqual(['11', '11']);
  await settle(7, ready(alice, first, 904));
  expect(scalars()).toEqual(['11', '11']);
  await replace(() => client.setQueryData(sessionQuery.queryKey, signedIn()));
  expect(reads).toHaveLength(10);
  await settle(9, ready(alice, first, 0));
  expect(scalars()).toEqual(['0', '0']);
  await reload();
  expect(reads).toHaveLength(11);
  await settle(10, ready(alice, first, 2));
  expect(scalars()).toEqual(['2', '2']);
  expect(host.querySelector('a[href="/en/library/following"]')).not.toBeNull();
});

test('only the actual prepared viewer and exact response context can supply mounted scalars', async () => {
  const calls: Request[] = [];
  let preparations = 0;
  const native = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      expect(request.headers.get('authorization')).toBe('Bearer bob-token');
      expect(request.cache).toBe('no-store');
      return Response.json(
        request.url.endsWith('/outgoing') ? { followingCount: 19 } : { ...first, followerCount: 19 },
      );
    },
  });
  const env: Partial<SessionEnv> = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://kernel.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web-count-test',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          preparations++;
          return { status: 'active' as const, ...bob, accessToken: 'bob-token' };
        },
      }),
    } as unknown as DurableObjectNamespace<SessionStore>,
  };
  const prepared = await loadPrivateFollowCounts(
    native,
    new Request('https://site.test/en/library/follow-counts', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
    env,
    first,
  );
  expect(prepared.viewer).toEqual(bob);
  expect(preparations).toBe(1);
  expect(calls).toHaveLength(2);
  await paint();
  await settle(0, prepared);
  expect(scalars()).toEqual([]);
  expect(host.textContent).toContain(m.library_follow_counts_unavailable());
  await reload();
  await settle(1, ready({ ...alice, subject: 'charlie' }, first, 905));
  expect(scalars()).toEqual([]);
  await reload();
  await settle(2, ready(alice, second, 906));
  expect(scalars()).toEqual([]);
  await reload();
  await settle(3, ready(alice, first, 0));
  expect(scalars()).toEqual(['0', '0']);
});

test('session uncertainty and absent subject retire pending IO without dispatching private reads', async () => {
  await paint();
  await settle(0, ready(alice, first, 21));
  await replace(() =>
    client.setQueryData(sessionQuery.queryKey, { state: 'unknown', subject: null, csrfToken: null } satisfies Session),
  );
  await replace(() => client.setQueryData(sessionQuery.queryKey, { ...signedIn(), subject: null }));
  await replace(() => client.setQueryData(sessionQuery.queryKey, { state: 'unavailable', ...alice } satisfies Session));
  await replace(() =>
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-out',
      subject: null,
      csrfToken: null,
    } satisfies Session),
  );
  expect(reads).toHaveLength(1);
  const signIn = host.querySelector<HTMLAnchorElement>('a[href^="/auth/sign-in?"]')!;
  expect(new URL(signIn.href).searchParams.get('return_to')).toBe(
    `/en/library/follow-counts?targetType=collection&targetId=${first.targetId}`,
  );
  await replace(() => client.setQueryData(sessionQuery.queryKey, signedIn()));
  expect(reads).toHaveLength(2);
  await replace(() => client.setQueryData(sessionQuery.queryKey, { ...signedIn(), subject: null }));
  await settle(1, ready(alice, first, 907));
  expect(scalars()).toEqual([]);
  expect(reads).toHaveLength(2);
  await replace(() => client.setQueryData(sessionQuery.queryKey, signedIn()));
  expect(reads).toHaveLength(3);
  await settle(2, ready(alice, first, 0));
  expect(scalars()).toEqual(['0', '0']);
});
