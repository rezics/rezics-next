import { expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import type { ChangesRead, DetailRead } from '../src/features/catalogue/subject-changes';

// Authored UNRUN. Real route, session observation, BFF validators, prepareSession and
// generated native client; the session store and native HTTP responses are controlled seams.
const alice = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const bob = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const csrfA = 'AAAAAAAAAAAAAAAAAAAAAA';
const csrfB = 'BBBBBBBBBBBBBBBBBBBBBB';
let serverReader: string | null = alice;
let serverCsrf = csrfA;
const requests = new AsyncLocalStorage<Request>();
const cacheHeaders: string[] = [];
const envelopes: Array<{ data: Record<string, unknown>; headers: Headers }> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Delivery = 'success' | 'failure' | 'throw';
type Gate = {
  phase: 'queued' | 'delivery';
  poison: boolean;
  entered: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<Delivery>>;
};
let nextGate: Gate | undefined;
const gates: Gate[] = [];
function hold(phase: Gate['phase']) {
  const gate = { phase, poison: true, entered: deferred<void>(), release: deferred<Delivery>() };
  nextGate = gate;
  gates.push(gate);
  return gate;
}
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () =>
          serverReader
            ? { status: 'active', subject: serverReader, accessToken: `access-${serverReader}`, csrfToken: serverCsrf }
            : { status: 'absent' },
      }),
    },
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => requests.getStore()!,
  setResponseHeader: (name: string, value: string) => {
    if (name.toLowerCase() === 'cache-control') cacheHeaders.push(value);
  },
}));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(next: typeof validate) {
        validate = next;
        return chain;
      },
      handler(handler: (input: { data: unknown }) => Promise<ChangesRead | DetailRead>) {
        return async (input: { data?: unknown; headers?: HeadersInit } = {}) => {
          const data = validate ? validate(input.data) : input.data;
          const history = !!data && typeof data === 'object' && 'id' in data;
          const gate = history ? nextGate : undefined;
          if (gate) nextGate = undefined;
          const headers = new Headers(input.headers);
          if (history) envelopes.push({ data: structuredClone(data) as Record<string, unknown>, headers });
          if (gate?.phase === 'queued') {
            gate.entered.resolve();
            await gate.release.promise;
          }
          // The browser's cookie can change while an original envelope is queued.
          if (serverReader) headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          headers.set('origin', 'https://site.test');
          const request = new Request('https://site.test/en/_server/history', { method: 'POST', headers });
          const result = await requests.run(request, () => handler({ data }));
          if (gate?.phase !== 'delivery') return result;
          gate.entered.resolve();
          const delivery = await gate.release.promise;
          if (delivery === 'throw') throw new Error('Late history delivery');
          if (delivery === 'failure') return { kind: 'unavailable' };
          return gate.poison && result.kind === 'ready' ? { ...result, session: 'retired-continuation' } : result;
        };
      },
    };
    return chain;
  },
}));
const { catalogueChangesFixture, changesCursor, changesLastCursor } =
  await import('../src/kernel/fake/catalogue-changes');
const { sourceDefinitions } = await import('../src/kernel/fake/catalogue-sources');
let detailStatus = 200;
let releaseAvailable = true;
let verdict: 'accept' | 'reject' | 'abstain' = 'abstain';
let rank: 'normal' | 'preferred' | 'deprecated' | null = null;
const fixture = catalogueChangesFixture(
  'ready',
  'en',
  undefined,
  (revision) =>
    new Response(
      JSON.stringify(
        detailStatus === 200
          ? {
              subject: fixture.id,
              revision: { revision, kind: 'accept', release: fixture.read.subject.release },
              change: {
                kind: 'decision',
                candidate: alice,
                property: 'schema:datePublished',
                context: bob,
                head: 1,
                verdict,
                reading: { decision: { head: 1, verdict, revision }, selected: false, rank },
              },
            }
          : { code: 'unavailable' },
      ),
      {
        status: detailStatus,
        headers: { 'content-type': 'application/json', 'rezics-session-token': 'detail-session' },
      },
    ),
);
mock.module('../src/kernel/client', () => ({ kernelClient: () => fixture.client }));
mock.module('../src/subject/definitions', () => ({
  readRelease: async () => {
    if (!releaseAvailable) throw new Error('Definitions unavailable');
    return sourceDefinitions;
  },
}));
const { Route } = await import('../src/routes/subjects/$id_.$slug_.changes');
const { loadSubjectChanges, loadSubjectChange } = await import('../src/features/catalogue/subject-changes-actions');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { ChangeExplanation } = await import('../src/features/catalogue/subject-changes-page');
const signedIn = (subject = alice, csrfToken = csrfA) => ({ state: 'signed-in' as const, subject, csrfToken });
const anonymous = { state: 'signed-out' as const, subject: null, csrfToken: null };

async function mount() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/en/subjects/${fixture.id}/title/changes` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedIn());
  const rootRoute = createRootRoute({ component: Outlet });
  const historyRoute = Route.update({ getParentRoute: () => rootRoute, path: '/subjects/$id/$slug/changes' } as never);
  const history = createMemoryHistory({ initialEntries: [`/subjects/${fixture.id}/title/changes`] });
  const router = createRouter({ routeTree: rootRoute.addChildren([historyRoute]), history });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const outside = window.document.createElement('button');
  outside.textContent = 'Independent focus';
  window.document.body.append(outside);
  const { createRoot } = await import('react-dom/client');
  let root = createRoot(host as unknown as HTMLElement);
  const render = async () => {
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))),
    );
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await settle();
    expect(predicate()).toBe(true);
  };
  const button = (text: string) => {
    const node = [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
    expect(node).toBeDefined();
    return node!;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
    await settle();
  };
  const queued = (node: object) => {
    const key = Object.keys(node).find((key) => key.startsWith('__reactProps$'))!;
    const callback = Reflect.get(node, key).onClick as () => void;
    return () => callback();
  };
  const update = async (
    session:
      | ReturnType<typeof signedIn>
      | typeof anonymous
      | { state: 'unknown' | 'unavailable'; subject: null; csrfToken: null },
  ) => {
    serverReader = session.subject;
    serverCsrf = session.csrfToken ?? csrfA;
    await act(async () => client.setQueryData(sessionQuery.queryKey, session));
    await settle();
  };
  await render();
  return {
    window,
    host,
    outside,
    client,
    settle,
    until,
    button,
    click,
    queued,
    update,
    async revisit() {
      await act(async () => root.unmount());
      root = createRoot(host as unknown as HTMLElement);
      await render();
      await settle();
    },
    async close() {
      for (const gate of gates) gate.release.resolve('failure');
      await settle();
      await act(async () => root.unmount());
      client.clear();
      window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Subject history list pagination and revision explanation belong to the original successful session admission and cannot follow changed credentials or revive after A-B-A', async () => {
  const h = await mount();
  const ready = () => !!h.host.querySelector('ol button');
  const revision = m.changes_revision({ revision: '5' });
  try {
    await h.until(ready);
    expect(envelopes.at(-1)!.data.expectedReader).toBe(alice);
    expect(envelopes.at(-1)!.headers.get('x-csrf-token')).toBe(csrfA);
    const currentLink = h.host.querySelector('a')!.getAttribute('href');
    expect(currentLink).toContain(`/subjects/${fixture.id}`);

    // A retained callback must refuse synchronously, even before React renders batched A-B-A.
    const oldMore = h.queued(h.button(m.changes_more()));
    const oldDetail = h.queued(h.button(revision));
    const before = envelopes.length;
    await act(async () => {
      h.client.setQueryData(sessionQuery.queryKey, signedIn(bob, csrfB));
      h.client.setQueryData(sessionQuery.queryKey, signedIn());
      oldMore();
      oldDetail();
    });
    await h.settle();
    await h.until(ready);
    expect(
      envelopes.slice(before).filter((entry) => entry.data.cursor !== undefined || entry.data.revision !== undefined),
    ).toHaveLength(0);
    expect(envelopes.at(-1)!.data.session).toBeUndefined();

    // Same subject, replaced successful session: private selected detail/list and retries are new.
    await h.click(revision);
    expect(h.host.textContent).toContain(m.changes_abstained_detail());
    expect(h.host.textContent).not.toContain(m.changes_rank_deprecated());
    const retiredSelect = h.queued(h.button(revision));
    await h.update(signedIn(alice, csrfB));
    await h.until(ready);
    expect(h.host.textContent).not.toContain(m.changes_abstained_detail());
    expect(h.button(revision).getAttribute('aria-pressed')).toBe('false');
    const replaced = envelopes.length;
    retiredSelect();
    oldMore();
    await h.settle();
    expect(envelopes).toHaveLength(replaced);
    expect(envelopes.at(-1)!.data.session).toBeUndefined();

    // Queued envelopes meet the *prepared* new request before native I/O, both list and detail.
    for (const operation of ['more', 'detail'] as const) {
      const gate = hold('queued');
      await h.click(operation === 'more' ? m.changes_more() : revision);
      await gate.entered.promise;
      const nativeBefore = fixture.calls.length;
      serverReader = bob; // Same CSRF deliberately isolates expected original-reader comparison.
      gate.release.resolve('success');
      await h.settle();
      expect(fixture.calls).toHaveLength(nativeBefore);
      expect(h.host.textContent).toContain(m.changes_denied());
      serverReader = alice;
      await h.revisit();
      await h.until(ready);
    }

    // Same-account replacement must also fail under the old submitted CSRF token.
    const originalCsrf = serverCsrf;
    const queuedSession = hold('queued');
    await h.click(m.changes_more());
    await queuedSession.entered.promise;
    const beforeCsrfReplacement = fixture.calls.length;
    serverCsrf = originalCsrf === csrfA ? csrfB : csrfA;
    queuedSession.release.resolve('success');
    await h.settle();
    expect(fixture.calls).toHaveLength(beforeCsrfReplacement);
    serverCsrf = originalCsrf;
    await h.revisit();
    await h.until(ready);

    // Late native-shaped outcomes cannot settle state, continuation, cache, focus or finally
    // on a freshly admitted visit with its own pending request.
    for (const operation of ['initial', 'more', 'detail', 'retry', 'detail-retry'] as const) {
      for (const delivery of ['success', 'failure', 'throw'] as const) {
        for (const transition of ['session', 'A-B-A', 'reader', 'remount'] as const) {
          if (operation === 'retry') {
            const failed = hold('delivery');
            await h.click(m.changes_more());
            await failed.entered.promise;
            failed.release.resolve('failure');
            await h.settle();
          }
          if (operation === 'detail-retry') {
            detailStatus = 503;
            await h.click(revision);
            detailStatus = 200;
          }
          const oldCallback = h.queued(
            h.button(
              operation === 'retry'
                ? m.changes_retry()
                : operation === 'detail-retry'
                  ? m.changes_retry_detail()
                  : operation === 'detail'
                    ? revision
                    : m.changes_more(),
            ),
          );
          const gate = hold('delivery');
          if (operation === 'initial') await h.revisit();
          else
            await h.click(
              operation === 'retry'
                ? m.changes_retry()
                : operation === 'detail-retry'
                  ? m.changes_retry_detail()
                  : operation === 'detail'
                    ? revision
                    : m.changes_more(),
            );
          await gate.entered.promise;
          const fresh = hold('delivery');
          fresh.poison = false;
          if (transition === 'remount') await h.revisit();
          else if (transition === 'A-B-A') {
            const original = h.client.getQueryData<ReturnType<typeof signedIn>>(sessionQuery.queryKey)!;
            await act(async () => {
              h.client.setQueryData(sessionQuery.queryKey, signedIn(original.subject === alice ? bob : alice, csrfA));
              h.client.setQueryData(sessionQuery.queryKey, original);
            });
            await h.settle();
          } else
            await h.update(
              signedIn(
                transition === 'reader' ? (serverReader === alice ? bob : alice) : serverReader!,
                serverCsrf === csrfA ? csrfB : csrfA,
              ),
            );
          await fresh.entered.promise;
          h.outside.focus();
          const snapshot = h.host.innerHTML;
          const cache = h.client
            .getQueryCache()
            .getAll()
            .map((query) => [query.queryKey, query.state.data]);
          const count = envelopes.length;
          gate.release.resolve(delivery);
          await h.settle();
          oldCallback();
          await h.settle();
          expect(h.host.innerHTML).toBe(snapshot);
          expect(h.host.querySelector('article')!.getAttribute('aria-busy')).toBe('true');
          expect(envelopes).toHaveLength(count);
          expect(h.window.document.activeElement).toBe(h.outside);
          expect(
            h.client
              .getQueryCache()
              .getAll()
              .map((query) => [query.queryKey, query.state.data]),
          ).toEqual(cache);
          fresh.release.resolve('success');
          await h.settle();
          await h.until(ready);
          expect(envelopes.at(-1)!.data.session).toBeUndefined();
          const next = envelopes.length;
          await h.click(revision);
          expect(envelopes[next]!.data.session).not.toBe('retired-continuation');
          expect(h.host.textContent).toContain(m.changes_abstained_detail());
        }
      }
    }

    // Healthy empty refill keeps the original cursor and continuity; a fresh mount gets none.
    await h.revisit();
    await h.until(ready);
    const obsoleteCursor = h.queued(h.button(m.changes_more()));
    await h.click(m.changes_more());
    const afterRefill = envelopes.length;
    obsoleteCursor();
    await h.settle();
    expect(envelopes).toHaveLength(afterRefill);
    expect(envelopes.at(-1)!.data).toMatchObject({ cursor: changesCursor, session: 'changes-session' });
    await h.click(m.changes_more());
    expect(envelopes.at(-1)!.data).toMatchObject({ cursor: changesLastCursor, session: 'changes-session' });
    expect(h.host.querySelectorAll('ol li')).toHaveLength(3);
    expect(h.host.textContent).toContain(m.changes_revision({ revision: '2' }));

    // No original private retry survives unavailable/sign-out/remount; anonymous stays anonymous.
    const retired = h.queued(h.button(revision));
    await h.update({ state: 'unavailable', subject: null, csrfToken: null });
    const count = envelopes.length;
    retired();
    await h.settle();
    expect(envelopes).toHaveLength(count);
    await h.update({ state: 'unknown', subject: null, csrfToken: null });
    expect(h.host.textContent).toContain(m.changes_loading());
    retired();
    await h.settle();
    expect(envelopes).toHaveLength(count);
    await h.update(anonymous);
    await h.until(ready);
    expect(envelopes.at(-1)!.data.expectedReader).toBeNull();
    expect(envelopes.at(-1)!.headers.has('x-csrf-token')).toBe(false);
    await h.click(revision);
    expect(fixture.calls.filter((call) => /revisions\/5$/.test(call.path)).at(-1)!.authorization).toBeNull();
    const anonMore = h.queued(h.button(m.changes_more()));
    await h.update(signedIn());
    await h.until(ready);
    const freshCount = envelopes.length;
    anonMore();
    retired();
    await h.settle();
    expect(envelopes).toHaveLength(freshCount);
    await h.revisit();
    await h.until(ready);
    retired();
    await h.settle();
    expect(envelopes.at(-1)!.data.session).toBeUndefined();

    // Prepared BFF mismatch applies to anonymous envelopes too; explicit absence is required.
    const nativeBefore = fixture.calls.length;
    expect(
      await loadSubjectChanges({
        data: { id: fixture.id, locale: 'en', expectedReader: null },
        headers: { 'x-csrf-token': csrfA },
      }),
    ).toMatchObject({ kind: 'denied' });
    expect(
      await loadSubjectChange({
        data: { id: fixture.id, locale: 'en', revision: 5, expectedReader: bob },
        headers: { 'x-csrf-token': csrfA },
      }),
    ).toMatchObject({ kind: 'denied' });
    expect(fixture.calls).toHaveLength(nativeBefore);
    await expect(
      loadSubjectChanges({ data: { id: fixture.id, locale: 'en' }, headers: { 'x-csrf-token': csrfA } }),
    ).rejects.toThrow();
    expect(fixture.calls).toHaveLength(nativeBefore);

    // Exact native status distinctions and current-subject continuity stay authoritative.
    for (const [status, message] of [
      [403, m.changes_denied()],
      [404, m.changes_missing()],
      [409, m.changes_conflict()],
      [503, m.changes_unavailable()],
    ] as const) {
      detailStatus = status;
      await h.click(revision);
      expect(h.host.textContent).toContain(message);
      detailStatus = 200;
      await h.click(m.changes_retry_detail());
      expect(h.host.textContent).toContain(m.changes_abstained_detail());
    }
    releaseAvailable = false;
    await h.revisit();
    await h.until(ready);
    await h.click(revision);
    expect(h.host.textContent).toContain(m.changes_abstained_detail());
    releaseAvailable = true;
    for (const decision of ['accept', 'reject', 'abstain'] as const) {
      verdict = decision;
      rank = 'deprecated';
      await h.click(revision);
      expect(h.host.textContent).toContain(
        decision === 'accept'
          ? m.changes_accepted_detail()
          : decision === 'reject'
            ? m.changes_rejected_detail()
            : m.changes_abstained_detail(),
      );
      expect(h.host.textContent).toContain(m.changes_rank_deprecated());
    }
    fixture.conceal();
    await h.click(revision);
    expect(h.host.textContent).toContain(m.changes_missing());
    expect(h.host.querySelector('ol')).toBeNull();
    expect(cacheHeaders.every((value) => value === 'private, no-store')).toBe(true);
  } finally {
    await h.close();
    mock.restore();
  }
}, 30_000);

// Every launch locale independently names the review decision and the assertion's rank.
test('history abstention explanation never presents abstention as deprecated rank', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
    const o = { locale };
    const detail = {
      id: fixture.id,
      revision: 5,
      summary: {
        kind: 'decision' as const,
        candidate: alice,
        property: 'schema:datePublished',
        context: bob,
        decision: 'abstain' as const,
        reading: { decision: { verdict: 'abstain' as const, head: 1, revision: 5 }, selected: false, rank: null },
      },
    };
    const html = renderToStaticMarkup(createElement(ChangeExplanation, { detail, locale }));
    expect(html).toContain(m.changes_abstained_detail({}, o).replaceAll('&', '&amp;').replaceAll("'", '&#x27;'));
    expect(html).not.toContain(m.changes_rank_deprecated({}, o));
    const deprecated = renderToStaticMarkup(
      createElement(ChangeExplanation, {
        locale,
        detail: {
          ...detail,
          summary: { ...detail.summary, reading: { ...detail.summary.reading, rank: 'deprecated' } },
        },
      }),
    );
    expect(deprecated).toContain(m.changes_rank_deprecated({}, o));
  }
});
