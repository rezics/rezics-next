import { expect, mock, test } from 'bun:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseSelection,
  parseStatus,
  readErasureStatus,
  type ErasureStatus,
  type Page,
} from '../src/accounts/erasure-progress/data';
import { ErasureReader } from '../src/accounts/erasure-progress/reader';
import { ErasureProgressView } from '../src/accounts/erasure-progress/view';
import { m } from '../src/paraglide/messages.js';

const accountId = '019a0000-0000-7000-8000-000000000001';
const viewerId = '019a0000-0000-7000-8000-000000000002';
const selection = { accountId, viewerId };
const at = '2026-10-01T10:00:00.000Z';
const completedAt = '2026-10-02T10:00:00.000Z';
const pending = (): ErasureStatus => ({
  accountId,
  state: 'pending',
  at,
  completedAt: null,
  pendingParticipants: ['auth', 'shared-history'],
  retentionOutstanding: false,
  lateItems: true,
  effectsFrontier: true,
});
const ready = (value = pending()): Page => ({ status: 'ready', viewerId, value });
const html = (page: Page) => renderToStaticMarkup(createElement(ErasureProgressView, { page }));

test('private platform erasure progress shows exact native pending retention and completion without inferring success from unavailable or missing participant proof', async () => {
  let body: unknown = pending();
  let status = 200;
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(body, { status });
  };
  const read = () =>
    readErasureStatus('https://kernel.example.test', 'Bearer current-native-scope', selection, fetcher);
  const first = await read();
  expect(first).toEqual(ready());
  expect(html(first)).toContain(m.erasure_pending());
  expect(html(first)).toContain('shared-history');
  expect(html(first)).toContain(`dateTime="${at}"`);
  expect(html(first)).toContain(m.erasure_not_reported());
  expect(html(first)).toContain(m.erasure_late_yes());
  expect(html(first)).toContain(m.erasure_frontier_yes());
  expect(html(first)).not.toContain('<progress');
  expect(html(first)).not.toContain('<form');
  expect(html(first)).not.toContain('role="progressbar"');
  const retention: ErasureStatus = {
    ...pending(),
    state: 'retention-outstanding',
    completedAt,
    pendingParticipants: [],
    retentionOutstanding: true,
    lateItems: false,
    effectsFrontier: false,
  };
  body = retention;
  const retained = await read();
  expect(retained).toEqual(ready(retention));
  expect(html(retained)).toContain(m.erasure_retention_help());
  expect(html(retained)).toContain(`dateTime="${completedAt}"`);
  expect(html(retained)).not.toContain(`<h2>${m.erasure_complete()}</h2>`);
  body = { ...retention, state: 'complete', retentionOutstanding: false };
  const complete = await read();
  expect(complete.status).toBe('ready');
  expect(html(complete)).toContain(`<h2>${m.erasure_complete()}</h2>`);
  expect(html(complete)).toContain(m.erasure_complete_help());

  // No names, no queued work and false flags never upgrade a native pending observation.
  const unknownProof = { ...pending(), pendingParticipants: [], lateItems: false, effectsFrontier: false };
  body = unknownProof;
  const unknown = await read();
  expect(unknown).toEqual(ready(unknownProof));
  expect(html(unknown)).toContain(m.erasure_pending_help());
  expect(html(unknown)).toContain(m.erasure_no_pending_names());
  expect(html(unknown)).toContain(m.erasure_frontier_no());
  for (const code of [401, 403, 404, 202, 503]) {
    status = code;
    body = { ...pending(), secret: 'private reason, store and locator' };
    const failure = await read();
    expect(failure).toEqual({
      status: code === 401 ? 'signed-out' : code === 403 ? 'denied' : code === 404 ? 'missing' : 'unavailable',
    });
    expect(html(failure)).not.toContain(accountId);
    expect(html(failure)).not.toContain('shared-history');
    expect(html(failure)).not.toContain('private reason');
    expect(html(failure)).not.toContain(`<h2>${m.erasure_complete()}</h2>`);
  }
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(request.url).toBe(`https://kernel.example.test/v1/accounts/${accountId}/erasureStatus`);
    expect(request.body).toBeNull();
    expect(request.headers.get('authorization')).toBe('Bearer current-native-scope');
    expect(request.headers.get('cache-control')).toBe('no-store');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('error');
  }
});

test('closed native allowlist rejects omitted, private, unknown and contradictory observations without guessing proof', async () => {
  const { effectsFrontier: _missing, ...omitted } = pending();
  const malformed: unknown[] = [
    null,
    [],
    {},
    omitted,
    { ...pending(), accountId: viewerId },
    { ...pending(), stores: ['private-store'] },
    { ...pending(), state: 'queued' },
    { ...pending(), state: 'complete' },
    { ...pending(), completedAt },
    { ...pending(), state: 'retention-outstanding' },
    { ...pending(), effectsFrontier: null },
    { ...pending(), lateItems: 'false' },
    { ...pending(), pendingParticipants: null },
    { ...pending(), pendingParticipants: ['auth', 'auth'] },
    { ...pending(), pendingParticipants: ['secret/store?token=secret'] },
    { ...pending(), pendingParticipants: ['x'.repeat(65)] },
    { ...pending(), pendingParticipants: Array.from({ length: 65 }, (_, n) => `participant-${n}`) },
    { ...pending(), at: '2026-02-30T10:00:00.000Z' },
    {
      ...pending(),
      state: 'complete',
      completedAt: '2026-09-01T10:00:00.000Z',
      pendingParticipants: [],
      lateItems: false,
      effectsFrontier: false,
    },
  ];
  for (const value of malformed) expect(parseStatus(value, accountId)).toBeNull();
  for (const value of [undefined, accountId, { accountId, viewerId, role: 'admin' }, { accountId: 'handle', viewerId }])
    expect(() => parseSelection(value)).toThrow();
  let calls = 0;
  const never: typeof fetch = async () => {
    calls++;
    throw new Error('must not fetch');
  };
  expect(await readErasureStatus(undefined, 'Bearer viewer', selection, never)).toEqual({ status: 'unavailable' });
  expect(calls).toBe(0);
  for (const response of [
    new Response('not JSON', { headers: { 'content-type': 'text/html' } }),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response(' '.repeat(16_385), { headers: { 'content-type': 'application/json' } }),
    Response.json(omitted),
  ])
    expect(
      await readErasureStatus('https://kernel.example.test', 'Bearer viewer', selection, async () => response),
    ).toEqual({ status: 'unavailable' });
  expect(
    await readErasureStatus('https://kernel.example.test', 'Bearer viewer', selection, async () => {
      throw new Error('private upstream error');
    }),
  ).toEqual({ status: 'unavailable' });
});

test('explicit reload replaces sensitive observations and discards stale results after denial, signout or viewer changes', async () => {
  const replies: ((page: Page) => void)[] = [];
  const reader = new ErasureReader(selection, () => new Promise((resolve) => replies.push(resolve)));
  const first = reader.reload();
  replies[0]!(ready());
  await first;
  expect(html(reader.snapshot())).toContain(accountId);
  const slow = reader.reload();
  expect(reader.snapshot()).toEqual({ status: 'loading' });
  expect(html(reader.snapshot())).not.toContain(accountId);
  const denial = reader.reload();
  replies[2]!({ status: 'denied' });
  await denial;
  replies[1]!(ready());
  await slow;
  expect(reader.snapshot()).toEqual({ status: 'denied' });
  const oldSession = reader.reload();
  reader.clear();
  replies[3]!(ready());
  await oldSession;
  expect(reader.snapshot()).toEqual({ status: 'loading' });
  const foreign = reader.reload();
  replies[4]!({ status: 'ready', viewerId: accountId, value: pending() });
  await foreign;
  expect(reader.snapshot()).toEqual({ status: 'unavailable' });
  for (const status of ['signed-out', 'unavailable', 'missing'] as const) {
    const reload = reader.reload();
    replies.at(-1)!({ status });
    await reload;
    expect(reader.snapshot()).toEqual({ status });
    expect(html(reader.snapshot())).not.toContain(accountId);
  }
  expect(replies).toHaveLength(8); // only explicit calls, no timer or background recovery
});

test('Default erasure page recovers an unavailable session through explicit read retry and supplies a validated sign-in return without disclosing prior account status', async () => {
  // Use the delivered page, session query, BFF and real React/Query/Router providers. Only request/native
  // transports are controlled, as in the existing session recovery tests; no viewer provider grants authority.
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const start = await import('../.storybook/react-start');
  let sessionCalls = 0;
  type Identity = boolean | { signedIn: true; subject: string; csrfToken: string };
  let nativeSession: () => Promise<Identity> = async () => {
    throw new Error('session unavailable');
  };
  let nativeViewer = viewerId;
  const nativeCalls: Request[] = [];
  const replies: ((response: Response) => void)[] = [];
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  };
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => ({
    getRequest: () =>
      new Request('https://site.test/platform/erasure', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      }),
    setResponseHeader() {},
  }));
  mock.module('cloudflare:workers', () => ({
    env: {
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://kernel.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'erasure-recovery-test',
      WEBSITE_CLIENT_KEY: '{}',
      KERNEL_ORIGIN: 'https://kernel.test',
      SESSIONS: {
        idFromName: (id: string) => id,
        get: () => ({
          signedIn: () => {
            sessionCalls++;
            return nativeSession();
          },
          credential: async () => ({
            status: 'active',
            subject: nativeViewer,
            accessToken: nativeViewer,
            csrfToken: 'current-token',
          }),
        }),
      },
    },
  }));
  globalThis.fetch = (async (input, init) => {
    nativeCalls.push(new Request(input, init));
    return new Promise<Response>((resolve) => replies.push(resolve));
  }) as typeof fetch;
  const { AccountErasurePage } = await import('../src/accounts/erasure-progress/page');
  const { erasureSignInHref } = await import('../src/accounts/erasure-progress/view');
  const { sessionQuery } = await import('../src/session/query');
  const client = new QueryClient();
  const routeRoot = createRootRoute();
  const route = createRoute({
    getParentRoute: () => routeRoot,
    path: '/$locale/platform/accounts/$accountId/erasure',
    component: () => createElement(AccountErasurePage, { accountId: route.useParams().accountId }),
  });
  const returnTo = `/fr/platform/accounts/${accountId}/erasure?from=account&view=status#latest`;
  const router = createRouter({
    routeTree: routeRoot.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [returnTo] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = () =>
    act(async () => {
      await Bun.sleep(5);
    });
  const button = () => host.querySelector('button')!;
  const concealed = () => {
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('time')).toBeNull();
    expect(host.textContent).not.toContain(accountId);
    expect(host.textContent).not.toContain('shared-history');
    expect(host.textContent).not.toContain(m.erasure_complete());
  };
  try {
    await router.load();
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    });
    await settle();
    expect(sessionCalls).toBe(1);
    expect(nativeCalls).toHaveLength(0);
    expect(button().textContent).toBe(m.erasure_retry_session());
    concealed();
    const discovery = deferred<Identity>();
    nativeSession = () => discovery.promise;
    await act(async () => {
      button().click();
      button().click();
    });
    expect(sessionCalls).toBe(2);
    expect(button().disabled).toBe(true);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    concealed();
    await act(async () => {
      discovery.resolve(false);
    });
    await settle();
    expect(host.querySelector('a')?.getAttribute('href')).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
    );
    expect(host.querySelector('button')).toBeNull();
    expect(nativeCalls).toHaveLength(0);
    concealed();
    for (const unsafe of [
      'https://outside.test',
      '//outside.test',
      '/\\outside.test',
      '/settings',
      '/platform/accounts/../erasure',
      '/\n/platform/accounts/x/erasure',
    ])
      expect(erasureSignInHref(unsafe)).toBe('/auth/sign-in?return_to=%2F');

    // A later failed discovery must be retryable even though the existing query is fresh forever.
    nativeSession = async () => {
      throw new Error('session unavailable again');
    };
    await act(async () => {
      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    await settle();
    const signedIn = deferred<Identity>();
    nativeSession = () => signedIn.promise;
    await act(async () => {
      button().click();
    });
    expect(nativeCalls).toHaveLength(0);
    await act(async () => {
      signedIn.resolve({ signedIn: true, subject: viewerId, csrfToken: 'current-token' });
    });
    await settle();
    expect(sessionCalls).toBe(4);
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]!.headers.get('authorization')).toBe(`Bearer ${viewerId}`);
    await act(async () => {
      replies[0]!(Response.json(pending()));
    });
    await settle();
    expect(host.textContent).toContain(m.erasure_pending());
    expect(host.querySelector('details')?.open).toBe(false);
    expect(host.querySelector('details')?.textContent).toContain(accountId);
    expect(host.querySelector('details code')?.textContent).toBe('auth');
    expect(host.querySelector('section ul')?.textContent).toContain(m.erasure_participant_auth());

    await act(async () => {
      button().click();
    });
    expect(nativeCalls).toHaveLength(2);
    concealed();
    const changed = deferred<Identity>();
    nativeSession = () => changed.promise;
    let changing!: Promise<unknown>;
    await act(async () => {
      changing = client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    // A stale terminal response cannot disclose the former private observation during session discovery.
    await act(async () => {
      replies[1]!(
        Response.json({
          ...pending(),
          state: 'complete',
          completedAt,
          pendingParticipants: [],
          lateItems: false,
          effectsFrontier: false,
        }),
      );
    });
    await settle();
    concealed();
    nativeViewer = '019a0000-0000-7000-8000-000000000003';
    await act(async () => {
      changed.resolve({ signedIn: true, subject: nativeViewer, csrfToken: 'new-token' });
      await changing;
    });
    await settle();
    expect(nativeCalls).toHaveLength(3);
    expect(nativeCalls[2]!.headers.get('authorization')).toBe(`Bearer ${nativeViewer}`);
    concealed();
    const nextAccount = '019a0000-0000-7000-8000-000000000004';
    await act(async () => {
      await router.navigate({
        to: '/$locale/platform/accounts/$accountId/erasure',
        params: { locale: 'fr', accountId: nextAccount },
      });
    });
    await settle();
    expect(nativeCalls).toHaveLength(4);
    expect(new URL(nativeCalls[3]!.url).pathname).toBe(`/v1/accounts/${nextAccount}/erasureStatus`);
    await act(async () => {
      replies[2]!(Response.json(pending()));
    });
    await settle();
    concealed();
    await act(async () => {
      root.unmount();
      replies[3]!(Response.json({ ...pending(), accountId: nextAccount }));
    });
    await settle();
    expect(host.textContent).toBe('');
    expect(sessionCalls).toBe(5);
    expect(nativeCalls.every((request) => request.method === 'GET' && request.body === null)).toBe(true);
    expect(sessionQuery.retry).toBe(false);
    expect(sessionQuery.staleTime).toBe(Infinity);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
});

test('Default erasure progress explains accepted deletion, ongoing removal and required retention in ordinary language while preserving every native status distinction and diagnostics', async () => {
  const { getLocale, locales, setLocale } = await import('../src/paraglide/runtime.js');
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  const previousLocale = getLocale();
  const returnTo = `/fr/platform/accounts/${accountId}/erasure`;
  const render = (page: Page, sessionRecovery = false) => {
    const host = window.document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      createElement(ErasureProgressView, { page, returnTo, sessionRecovery, reload() {} }),
    );
    return host;
  };
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const labels = [
        ['access', m.erasure_participant_access()],
        ['auth', m.erasure_participant_auth()],
        ['library', m.erasure_participant_library()],
        ['commerce', m.erasure_participant_commerce()],
        ['content', m.erasure_participant_content()],
        ['community', m.erasure_participant_community()],
        ['semantic', m.erasure_participant_semantic()],
        ['search', m.erasure_participant_search()],
        ['imports', m.erasure_participant_imports()],
        ['shared-history', m.erasure_participant_history()],
        ['delivery', m.erasure_participant_delivery()],
        ['future-service', m.erasure_participant_other()],
      ] as const;
      const observations: ErasureStatus[] = [
        { ...pending(), pendingParticipants: labels.map(([name]) => name) },
        { ...pending(), pendingParticipants: [], lateItems: false, effectsFrontier: false },
        {
          ...pending(),
          pendingParticipants: [],
          retentionOutstanding: true,
          lateItems: false,
          effectsFrontier: false,
        },
        {
          ...pending(),
          state: 'retention-outstanding',
          completedAt,
          pendingParticipants: [],
          retentionOutstanding: true,
          lateItems: false,
          effectsFrontier: false,
        },
        {
          ...pending(),
          state: 'complete',
          completedAt,
          pendingParticipants: [],
          lateItems: false,
          effectsFrontier: false,
        },
      ];
      for (const observation of observations) {
        const host = render(ready(observation));
        const details = host.querySelector('details')!;
        expect(details.open).toBe(false);
        expect(details.textContent).toContain(accountId);
        // Preserve native values independently, including false flags and the absent completion date.
        for (const [field, value] of [
          ['state', observation.state],
          ['at', at],
          ['completedAt', observation.completedAt ?? 'null'],
          ['retentionOutstanding', String(observation.retentionOutstanding)],
          ['lateItems', String(observation.lateItems)],
          ['effectsFrontier', String(observation.effectsFrontier)],
        ]) {
          const codes = details.querySelectorAll('dt code');
          const label = Array.from(codes as NodeListOf<Element>).find((code) => code.textContent === field)!;
          expect(label.parentElement?.nextElementSibling?.textContent).toBe(value);
        }
        for (const name of observation.pendingParticipants) expect(details.textContent).toContain(name);
        details.remove();
        const primary = host.textContent;
        expect(host.querySelector('h1')?.textContent).toBe(m.erasure_title());
        expect(primary).toContain(m.erasure_accepted());
        expect(primary).toContain(m.erasure_barrier_help());
        expect(primary).not.toContain(accountId);
        expect(primary).not.toMatch(
          /effectsFrontier|retentionOutstanding|pendingParticipants|shared-history|future-service/,
        );
        expect(host.querySelector('time')?.getAttribute('dateTime')).toBe(at);
        expect(host.querySelectorAll('time')).toHaveLength(observation.completedAt ? 2 : 1);
        expect(primary).toContain(
          observation.retentionOutstanding ? m.erasure_retained_yes() : m.erasure_retained_no(),
        );
        expect(primary).toContain(observation.lateItems ? m.erasure_late_yes() : m.erasure_late_no());
        expect(primary).toContain(observation.effectsFrontier ? m.erasure_frontier_yes() : m.erasure_frontier_no());
        if (observation.state === 'pending') {
          expect(host.querySelector('h2')?.textContent).toBe(m.erasure_pending());
          expect(primary).toContain(m.erasure_pending_help());
          if (observation.pendingParticipants.length) {
            for (const [, label] of labels) expect(primary).toContain(label);
          } else expect(primary).toContain(m.erasure_no_pending_names());
        } else {
          expect(host.querySelector('h2')?.textContent).toBe(
            observation.state === 'complete' ? m.erasure_complete() : m.erasure_retention(),
          );
          expect(primary).toContain(
            observation.state === 'complete' ? m.erasure_complete_help() : m.erasure_retention_help(),
          );
          expect(host.querySelectorAll('time')[1]?.getAttribute('dateTime')).toBe(completedAt);
        }
        expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
        expect(host.querySelector('button')?.textContent).toBe(m.erasure_reload());
      }
      for (const [status, message] of [
        ['signed-out', m.erasure_signed_out()],
        ['denied', m.erasure_denied()],
        ['missing', m.erasure_missing()],
        ['unavailable', m.erasure_unavailable()],
        ['loading', m.erasure_loading()],
      ] as const) {
        const host = render({ status });
        expect(host.querySelector('[role="status"]')?.textContent).toBe(message);
        expect(host.textContent).not.toContain(m.erasure_accepted());
        expect(host.textContent).not.toContain(accountId);
        expect(host.querySelector('details')).toBeNull();
        if (status === 'signed-out') {
          expect(host.querySelector('a')?.getAttribute('href')).toBe(
            `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
          );
          expect(host.querySelector('button')).toBeNull();
        } else if (status === 'loading') expect(host.querySelector('button')?.disabled).toBe(true);
      }
      const recovery = render({ status: 'unavailable' }, true);
      expect(recovery.querySelector('[role="status"]')?.textContent).toBe(m.erasure_session_unavailable());
      expect(recovery.querySelector('button')?.textContent).toBe(m.erasure_retry_session());
    }
  } finally {
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.close();
  }
});
