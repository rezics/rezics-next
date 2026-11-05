import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentType } from 'react';
import * as start from '../.storybook/react-start';
import type {
  BuyerEntitlement,
  BuyerEntitlementCurrentRead,
  BuyerEntitlementsCurrentRead,
  EntitlementsAddress,
} from '../src/checkout/entitlements';
import { fixedEditionTerms, mappedEntitlement } from '../src/kernel/fake/entitlements';
import type { SessionEnv } from '../src/session/client';

// UNRUN: authored for controller integration. Constructed HTTP inputs and the installed DOM
// exercise actual server exports, route components, session/exposure hooks and presentation.
// They do not establish native sale/use authority or browser/visual acceptance.
type Preparation = { status: 'active' | 'absent' | 'unavailable'; subject?: string; accessToken?: string };
let preparations: Preparation[] = [];
let preparationCalls = 0;
const credential = async () => {
  preparationCalls++;
  return { status: 'active', subject: 'A', accessToken: 'credential-A', csrfToken: 'csrf', ...preparations.shift() };
};
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid entitlement:read',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
};
const request = () =>
  new Request('https://site.test/en/entitlements', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let currentRequest = request();
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
afterAll(() => mock.restore());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
function record(viewer: string, n = 1): BuyerEntitlement {
  return {
    ...mappedEntitlement,
    id: id(n),
    orderId: id(n + 100),
    summary: { ...mappedEntitlement.summary!, label: { value: `Private ${viewer}`, language: 'en' } },
  };
}
function list(viewer: string, cursor: string | null = null, locale = 'en'): BuyerEntitlementsCurrentRead {
  return {
    sessionSubject: viewer,
    requested: { kind: 'list', locale, cursor },
    page: { kind: 'ready', data: { entitlements: [record(viewer)], next: `next-${viewer}+/=` } },
  };
}
function detail(viewer: string, pointId = id(1), locale = 'en'): BuyerEntitlementCurrentRead {
  return {
    sessionSubject: viewer,
    requested: { kind: 'detail', locale, id: pointId },
    page: { kind: 'ready', data: { ...record(viewer), id: pointId }, creatorName: `Creator ${viewer}` },
  };
}

test('actual server reads bind the exact consumed preparation, preserve old exports and refuse stale associations before IO', async () => {
  const reads = await import('../src/checkout/entitlements');
  const { prepareSession, viewerCredential, sessionSubject } = await import('../src/session/request');
  const { createKernelClient } = await import('@rezics/client');
  const calls: Request[] = [];
  let rows = Array.from({ length: 20 }, (_, n) => record('A', n + 1));
  rows[1] = { ...rows[1]!, active: false, revokedAt: '2026-10-29T08:31:42Z', revokeReason: 'refund' };
  rows[2] = { ...rows[2]!, active: false, revokedAt: '2026-10-29T08:31:42Z', revokeReason: 'dispute' };
  rows[3] = { ...rows[3]!, contentEdition: null, summary: null };
  let point = rows[0]!;
  let status = 200;
  let hold:
    | { path: string; started: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>> }
    | undefined;
  const native = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const path = new URL(call.url).pathname;
    if (hold?.path === path) {
      const held = hold;
      hold = undefined;
      held.started.resolve();
      return held.response.promise;
    }
    if (status !== 200) return Response.json({ code: 'test_response' }, { status });
    if (path === '/v1/entitlements') return Response.json({ entitlements: rows, next: 'signed/native+next=' });
    if (path.startsWith('/v1/entitlements/')) return Response.json({ entitlement: point });
    if (path === '/v1/accounts')
      return Response.json({
        accounts: [{ id: fixedEditionTerms.creatorAccountId, displayName: 'Captured creator', state: 'active' }],
      });
    throw new Error(`Unexpected request: ${call.url}`);
  });
  const page = (cursor = '') => reads.readBuyerEntitlementsCurrent({ data: { locale: 'en', cursor } });
  const one = () => reads.readBuyerEntitlementCurrent({ data: { locale: 'en', id: point.id } });
  try {
    preparations = [
      { status: 'active', subject: 'A', accessToken: 'exact-A' },
      { status: 'active', subject: 'B', accessToken: 'exact-B' },
    ];
    const before = preparationCalls;
    const healthy = await page('signed/request+cursor=');
    expect(healthy).toEqual({
      sessionSubject: 'A',
      requested: { kind: 'list', locale: 'en', cursor: 'signed/request+cursor=' },
      page: { kind: 'ready', data: { entitlements: rows, next: 'signed/native+next=' } },
    });
    expect(preparationCalls - before).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer exact-A');
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({
      limit: '20',
      cursor: 'signed/request+cursor=',
    });
    const pointRead = await one();
    expect(pointRead).toEqual({
      sessionSubject: 'B',
      requested: { kind: 'detail', locale: 'en', id: point.id },
      page: { kind: 'ready', data: point, creatorName: 'Captured creator' },
    });
    expect(preparationCalls - before).toBe(2);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/entitlements',
      `/v1/entitlements/${point.id}`,
      '/v1/accounts',
    ]);
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer exact-B');
    expect(calls[2]!.headers.has('authorization')).toBe(false);
    expect(calls.slice(0, 2).every((call) => call.cache === 'no-store' && call.redirect === 'manual')).toBe(true);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(JSON.stringify([healthy, pointRead])).not.toContain('exact-A');
    expect(JSON.stringify([healthy, pointRead])).not.toContain('exact-B');

    // Original Request maps retain A, but a refused preparation never certifies them.
    await prepareSession(currentRequest, env as unknown as Partial<SessionEnv>);
    expect(sessionSubject(currentRequest)).toBe('A');
    expect(viewerCredential(currentRequest)).toBe('Bearer credential-A');
    preparations = [{ status: 'absent' }, { status: 'absent' }, { status: 'absent' }, { status: 'absent' }];
    calls.length = 0;
    expect(await page()).toMatchObject({ sessionSubject: null, requested: { cursor: null }, page: { kind: 'denied' } });
    expect(await one()).toMatchObject({ sessionSubject: null, page: { kind: 'denied' } });
    const client = createKernelClient('https://kernel.test');
    expect(
      await reads.loadBuyerEntitlements(client, currentRequest, env as unknown as Partial<SessionEnv>, {}),
    ).toEqual({ kind: 'denied' });
    expect(
      await reads.loadBuyerEntitlement(client, currentRequest, env as unknown as Partial<SessionEnv>, point.id),
    ).toEqual({ kind: 'denied' });
    expect(viewerCredential(currentRequest)).toBe('Bearer credential-A');
    expect(calls).toHaveLength(0);
    preparations = [{ status: 'unavailable' }, { status: 'unavailable' }];
    await expect(page()).rejects.toMatchObject({ problem: { status: 502, code: 'dependency_unavailable' } });
    await expect(one()).rejects.toMatchObject({ problem: { status: 502, code: 'dependency_unavailable' } });
    expect(calls).toHaveLength(0);

    for (const headers of [
      { authorization: 'Bearer explicit' },
      { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, authorization: 'Bearer explicit' },
    ]) {
      currentRequest = new Request('https://site.test/en/entitlements', { headers });
      expect((await page()).sessionSubject).toBeNull();
      expect((await one()).sessionSubject).toBeNull();
      expect(await reads.readBuyerEntitlements({ data: { locale: 'en' } })).toEqual(healthy.page);
      expect(await reads.readBuyerEntitlement({ data: { locale: 'en', id: point.id } })).toEqual(pointRead.page);
    }
    currentRequest = request();
    await prepareSession(currentRequest, env as unknown as Partial<SessionEnv>);
    currentRequest.headers.set('authorization', 'Bearer unrelated');
    expect((await one()).sessionSubject).toBeNull();
    currentRequest.headers.delete('authorization');
    currentRequest.headers.delete('cookie');
    calls.length = 0;
    expect((await page()).sessionSubject).toBeNull();
    expect(calls).toHaveLength(0);
    currentRequest = request();
    preparations = [
      { status: 'active', subject: '' },
      { status: 'active', subject: '' },
    ];
    expect((await page()).sessionSubject).toBeNull();
    expect((await one()).sessionSubject).toBeNull();

    const { duringPublicCacheRender } = await import('../src/security/page-cache');
    const beforePublicRender = calls.length;
    await expect(duringPublicCacheRender(currentRequest, () => page())).rejects.toMatchObject({
      name: 'PublicCacheReadError',
    });
    expect(calls).toHaveLength(beforePublicRender);

    // Both the native response and contextual enrichment may finish after a newer buyer's read.
    for (const path of ['/v1/entitlements', '/v1/accounts']) {
      const blocked = { path, started: deferred<void>(), response: deferred<Response>() };
      hold = blocked;
      const pendingA = path === '/v1/accounts' ? one() : page();
      await blocked.started.promise;
      preparations = [{ status: 'active', subject: 'B', accessToken: 'credential-B' }];
      const usableB = path === '/v1/accounts' ? await one() : await page();
      expect(usableB.sessionSubject).toBe('B');
      blocked.response.resolve(
        Response.json(
          path === '/v1/accounts'
            ? { accounts: [{ id: fixedEditionTerms.creatorAccountId, displayName: 'Late creator A', state: 'active' }] }
            : { entitlements: rows, next: 'late-A' },
        ),
      );
      expect((await pendingA).sessionSubject).toBe('A');
    }

    for (const [responseStatus, kind] of [
      [202, 'preparing'],
      [403, 'denied'],
      [400, 'cursor-error'],
      [409, 'cursor-error'],
      [503, 'unavailable'],
    ] as const) {
      status = responseStatus;
      expect((await page()).page).toEqual({ kind });
      expect((await one()).page).toEqual({ kind });
    }
    status = 200;
    for (const historical of [rows[1]!, rows[2]!, rows[3]!]) {
      point = historical;
      expect((await one()).page).toMatchObject({ kind: 'ready', data: historical });
    }
    point = rows[0]!;
    calls.length = 0;
    const mismatch = await reads.readBuyerEntitlementCurrent({ data: { locale: 'en', id: id(99) } });
    expect(mismatch.page).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1); // No enrichment of an unrelated record.
    rows = [];
    expect((await page()).page).toEqual({ kind: 'ready', data: { entitlements: [], next: 'signed/native+next=' } });
    rows = Array(21).fill(point);
    expect((await page()).page).toEqual({ kind: 'unavailable' });
    point = { ...point, contentEdition: { ...fixedEditionTerms, targetSubjectId: id(98) } };
    expect((await one()).page).toEqual({ kind: 'unavailable' });
    const count = calls.length;
    expect(() => reads.readBuyerEntitlementsCurrent({ data: { locale: 'invalid' } })).toThrow();
    expect(() => page('x'.repeat(4097))).toThrow();
    expect(() => reads.readBuyerEntitlementCurrent({ data: { locale: 'en', id: 'invalid' } })).toThrow();
    expect(calls).toHaveLength(count);
  } finally {
    native.mockRestore();
  }
});

test('actual list and detail retire viewer/admission/address lifetimes during render and ignore obsolete callbacks, results and loader payloads including ABA', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/entitlements' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
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
  const { createRoot, hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { flushSync } = await import('react-dom');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const reads = await import('../src/checkout/entitlements');
  const { Route: ListRoute } = await import('../src/routes/entitlements/index');
  const { Route: DetailRoute } = await import('../src/routes/entitlements/$id');
  const listView = await import('../src/checkout/entitlements-page');
  const detailView = await import('../src/checkout/entitlement-page');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  let initialList = list('A');
  let initialDetail = detail('A');
  let cursor: string | undefined;
  let pointId = id(1);
  let locale: 'en' | 'zh-Hant' = 'en';
  let mode: 'list' | 'detail' = 'list';
  let currentRetry: (() => void) | undefined;
  const originalList = listView.EntitlementsPage;
  const originalDetail = detailView.EntitlementPage;
  const spies = [
    spyOn(ListRoute, 'useLoaderData').mockImplementation(() => initialList),
    spyOn(ListRoute, 'useSearch').mockImplementation(() => (cursor ? { cursor } : {})),
    spyOn(DetailRoute, 'useLoaderData').mockImplementation(() => initialDetail),
    spyOn(DetailRoute, 'useParams').mockImplementation(() => ({ id: pointId })),
    spyOn(listView, 'EntitlementsPage').mockImplementation((props) => {
      currentRetry = props.retry;
      return originalList(props);
    }),
    spyOn(detailView, 'EntitlementPage').mockImplementation((props) => {
      currentRetry = props.retry;
      return originalDetail(props);
    }),
  ];
  const pending: {
    address: EntitlementsAddress;
    work: ReturnType<typeof deferred<BuyerEntitlementsCurrentRead | BuyerEntitlementCurrentRead>>;
  }[] = [];
  const enqueue = (address: EntitlementsAddress) => {
    const work = deferred<BuyerEntitlementsCurrentRead | BuyerEntitlementCurrentRead>();
    pending.push({ address, work });
    return work.promise;
  };
  const listTransport = spyOn(reads, 'readBuyerEntitlementsCurrent').mockImplementation(
    ({ data }) =>
      enqueue({
        kind: 'list',
        locale: data.locale,
        cursor: data.cursor ?? null,
      }) as Promise<BuyerEntitlementsCurrentRead>,
  );
  const detailTransport = spyOn(reads, 'readBuyerEntitlementCurrent').mockImplementation(
    ({ data }) => enqueue({ kind: 'detail', locale: data.locale, id: data.id }) as Promise<BuyerEntitlementCurrentRead>,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  const hydrationErrors: unknown[] = [];
  const tree = () => {
    const Component = (mode === 'list' ? ListRoute.options.component : DetailRoute.options.component) as ComponentType;
    return (
      <StrictMode>
        <QueryClientProvider client={client}>
          <Component />
        </QueryClientProvider>
      </StrictMode>
    );
  };
  type Viewer = { state: 'signed-in' | 'signed-out' | 'unknown'; subject?: string | null; csrfToken: string | null };
  const buyer = (subject: string): Viewer => ({ state: 'signed-in', subject, csrfToken: `csrf-${subject}` });
  const show = async (viewer = buyer('A'), admitted = true) => {
    await act(async () => {
      flushSync(() => {
        client.setQueryData(['session'], viewer);
        client.setQueryData(['exposure', 'viewer'], admitted ? ['purchases'] : []);
        client.setQueryData(['exposure', 'anonymous'], []);
        setLocale(locale, { reload: false });
        if (root) root.render(tree());
      });
    });
  };
  const tick = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const response = (viewer: string) =>
    mode === 'list' ? list(viewer, cursor ?? null, locale) : detail(viewer, pointId, locale);
  const settle = async (index: number, value = response('A')) => {
    await act(async () => pending[index]!.work.resolve(value));
    await tick();
  };
  const retired = (viewer: string) => {
    expect(host.textContent).not.toContain(`Private ${viewer}`);
    expect(host.textContent).not.toContain(`Creator ${viewer}`);
    expect(host.querySelector(`a[href*="next-${viewer}"]`)).toBeNull();
    expect(host.querySelector('a[href*="/orders/01"], a[href*="/editions/"]')).toBeNull();
  };
  const retry = async () => {
    expect(currentRetry).toBeFunction();
    const index = pending.length;
    await act(async () => currentRetry!());
    expect(pending.length).toBe(index + 1);
    return index;
  };
  const readyA = async () => {
    const before = pending.length;
    await show();
    if (pending.length > before) await settle(before);
    expect(host.textContent).toContain('Private A');
  };
  try {
    const loadList = ListRoute.options.loader as (input: {
      deps: { cursor: string };
    }) => Promise<BuyerEntitlementsCurrentRead>;
    const loadedList = loadList({ deps: { cursor: 'loader+/=' } });
    expect(pending[0]!.address).toEqual({ kind: 'list', locale: 'en', cursor: 'loader+/=' });
    pending[0]!.work.resolve(list('A', 'loader+/='));
    expect(await loadedList).toEqual(list('A', 'loader+/='));
    const loadDetail = DetailRoute.options.loader as (input: {
      params: { id: string };
    }) => Promise<BuyerEntitlementCurrentRead>;
    const loadedDetail = loadDetail({ params: { id: pointId } });
    expect(pending[1]!.address).toEqual({ kind: 'detail', locale: 'en', id: pointId });
    pending[1]!.work.resolve(detail('A'));
    expect(await loadedDetail).toEqual(detail('A'));
    pending.length = 0;
    await show();
    const html = renderToString(tree());
    expect(html).toContain('Private A');
    host.innerHTML = html;
    await act(async () => {
      root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
    });
    await tick();
    expect(hydrationErrors).toEqual([]);
    expect(host.textContent).toContain('Private A');
    expect(pending).toHaveLength(0); // The genuine matching loader read seeds only this initial lifetime.

    for (const surface of ['list', 'detail'] as const) {
      mode = surface;
      await readyA();
      for (const boundary of ['B', 'unknown', 'signed-out', 'admission'] as const) {
        await readyA();
        const oldRetry = currentRetry!;
        const oldA = await retry();
        const beforeB = pending.length;
        await show(
          boundary === 'B' ? buyer('B') : boundary === 'admission' ? buyer('A') : { state: boundary, csrfToken: null },
          boundary !== 'admission',
        );
        retired('A');
        if (boundary !== 'B') await show(buyer('B'));
        expect(pending.length).toBe(beforeB + 1);
        await settle(beforeB, response('B'));
        expect(host.textContent).toContain('Private B'); // A's response/enrichment remains unresolved.
        const count = pending.length;
        await act(async () => oldRetry());
        expect(pending).toHaveLength(count);
        const text = host.textContent;
        if (boundary === 'signed-out') {
          await act(async () => pending[oldA]!.work.reject(new Error('Late A failure')));
          await tick();
        } else await settle(oldA, response('A'));
        expect(host.textContent).toBe(text);
      }

      // ABA must create a new private lifetime even at the same buyer and exact address.
      await readyA();
      const originalA = await retry();
      await show(buyer('B'));
      const returnedA = pending.length;
      await show();
      retired('A');
      const preparing = host.textContent;
      await settle(originalA, response('A'));
      expect(host.textContent).toBe(preparing);
      await settle(returnedA, response('A fresh'));
      // The server viewer must still be the actual A, independent of the private title.
      expect(host.textContent).not.toContain('Private A fresh');
      const currentA = await retry();
      const fresh = response('A');
      if (fresh.page.kind === 'ready') {
        if ('entitlements' in fresh.page.data)
          fresh.page.data.entitlements[0]!.summary!.label!.value = 'Private A fresh';
        else fresh.page.data.summary!.label!.value = 'Private A fresh';
      }
      await settle(currentA, fresh);
      expect(host.textContent).toContain('Private A fresh');

      const beforeB = pending.length;
      await show(buyer('B'));
      await settle(beforeB, response('B'));
      const wrong = [response('A'), response('B'), response('B'), response('B')];
      wrong[1]!.requested.locale = 'zh-Hant';
      wrong[2]!.requested =
        mode === 'list' ? { kind: 'list', locale, cursor: 'other-cursor' } : { kind: 'detail', locale, id: id(99) };
      wrong[3]!.requested =
        mode === 'list' ? { kind: 'detail', locale, id: pointId } : { kind: 'list', locale, cursor: null };
      for (const value of wrong) {
        const text = host.textContent;
        const pendingIndex = await retry();
        await settle(pendingIndex, value);
        expect(host.textContent).toBe(text);
      }
      // Retained loader changes are never a new lifetime's authority or an automatic navigation/refetch.
      const count = pending.length;
      initialList = list('A');
      initialDetail = detail('A');
      await show(buyer('B'));
      expect(pending).toHaveLength(count);
      expect(host.textContent).toContain('Private B');

      // Address retirement includes cursor/id and locale, and cannot reuse a prior loader on return.
      for (const addressChange of ['key', 'locale'] as const) {
        const old = await retry();
        const obsoleteRetry = currentRetry!;
        if (addressChange === 'locale') locale = 'zh-Hant';
        else if (mode === 'list') cursor = 'exact+/cursor=';
        else pointId = id(2);
        const index = pending.length;
        await show(buyer('B'));
        retired('B');
        await settle(old, mode === 'list' ? list('B') : detail('B'));
        retired('B');
        const countBeforeRetry = pending.length;
        await act(async () => obsoleteRetry());
        expect(pending).toHaveLength(countBeforeRetry);
        await settle(index, response('B'));
        expect(host.textContent).toContain('Private B');
      }
      cursor = undefined;
      pointId = id(1);
      locale = 'en';
      const index = pending.length;
      await show(buyer('B'));
      retired('B');
      await settle(index, response('B'));

      for (const kind of ['denied', 'preparing', 'cursor-error', 'unavailable'] as const) {
        const index = await retry();
        await settle(index, { ...response('B'), page: { kind } });
        expect(host.textContent).not.toContain('Private B');
        expect(host.textContent).not.toContain(m.entitlements_empty());
        expect(host.textContent).toContain(
          kind === 'denied'
            ? m.entitlements_denied()
            : kind === 'preparing'
              ? m.entitlements_preparing()
              : kind === 'cursor-error'
                ? m.entitlements_cursor_error()
                : m.entitlements_unavailable(),
        );
      }
      const retryButton = host.querySelector('button');
      expect(retryButton).not.toBeNull();
      const retryIndex = pending.length;
      await act(async () => retryButton!.click());
      expect(pending.length).toBe(retryIndex + 1);
      if (mode === 'list') {
        await settle(retryIndex, { ...list('B'), page: { kind: 'ready', data: { entitlements: [], next: null } } });
        expect(host.textContent).toContain(m.entitlements_empty());
        expect(host.textContent).not.toContain(m.entitlements_unavailable());
      } else {
        await settle(retryIndex, detail('B'));
        expect(host.textContent).toContain(fixedEditionTerms.source.licence);
        expect(host.querySelector('a[href*="/editions/"]')).not.toBeNull();
        expect(host.querySelector(`a[href$="/orders/${record('B').orderId}"]`)).not.toBeNull();
        for (const reason of ['refund', 'dispute'] as const) {
          const revoked = detail('B');
          if (revoked.page.kind === 'ready')
            revoked.page.data = {
              ...revoked.page.data,
              active: reason === 'refund',
              revokedAt: '2026-10-29T08:31:42Z',
              revokeReason: reason,
            };
          await settle(await retry(), revoked);
          expect(host.textContent).toContain(`(${reason})`);
          expect(host.querySelector('a[href*="/editions/"]')).toBeNull();
        }
        const unknown = detail('B');
        if (unknown.page.kind === 'ready') {
          unknown.page.data = { ...unknown.page.data, contentEdition: null, summary: null };
          delete unknown.page.creatorName;
        }
        await settle(await retry(), unknown);
        expect(host.textContent).toContain(m.benefit_details_unknown());
        expect(host.querySelector('a[href*="/editions/"], a[href*="/subjects/"]')).toBeNull();
      }
    }
    const afterUnmount = await retry();
    const unmountedRetry = currentRetry!;
    await act(async () => root!.unmount());
    root = undefined;
    const count = pending.length;
    await act(async () => unmountedRetry());
    await act(async () => pending[afterUnmount]!.work.reject(new Error('Unmounted read failure')));
    await tick();
    expect(pending).toHaveLength(count);
    expect(host.textContent).toBe('');
  } finally {
    if (root) await act(async () => root!.unmount());
    client.clear();
    listTransport.mockRestore();
    detailTransport.mockRestore();
    for (const spy of spies) spy.mockRestore();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
