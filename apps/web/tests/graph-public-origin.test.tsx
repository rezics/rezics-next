import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { useSyncExternalStore } from 'react';

const subject = '00000000-0000-4000-8000-00000000d101';
const otherSubject = '00000000-0000-4000-8000-00000000d102';
const context = '00000000-0000-4000-8000-00000000d103';
const realm = '00000000-0000-4000-8000-00000000d104';

async function graphFixtures() {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const [{ candidateContext }, publicVisit, { subjectHref }] = await Promise.all([
    import('../src/subject/candidates'),
    import('../src/features/pages/graph-browser/public-visit'),
    import('../src/subject/subject-href'),
  ]);
  const base = `${subjectHref({ id: subject, label: 'Origin' }, 'en').href}/graph`;
  const publicReturn = `${subjectHref({ id: subject, label: 'Origin' }, 'en').href}#subject-heading`;
  const observed = { subject, context: candidateContext, locale: 'en', returnHref: publicReturn };
  const parse = (href: string, id = subject, locale = 'en') => {
    const url = new URL(href, 'https://site.test');
    return publicVisit.parseGraphPublicVisit(url.search, url.hash, id, locale, url.pathname);
  };
  return { ...publicVisit, candidateContext, subjectHref, base, publicReturn, observed, parse };
}

test('the public entry preserves admitted Global and selected Context observations with one bounded Subject return', async () => {
  const {
    candidateContext,
    graphPublicOriginHref,
    graphPublicSourceReturnHref,
    graphPublicVisitUnsupported,
    subjectHref,
    base,
    observed,
    parse,
  } = await graphFixtures();
  const { catalogueEntries } = await import('../src/features/catalogue/catalogue-entry');
  const { SubjectExploreSlot } = await import('../src/features/pages/subject-slots');
  const { createElement: h } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');

  const globalHref = catalogueEntries.graph({ id: subject, label: 'Origin', locale: 'en', origin: observed }).href;
  expect(parse(globalHref)).toEqual({ kind: 'origin', origin: observed });
  expect(catalogueEntries.graph({ id: subject, label: 'Origin', locale: 'en' }).href).toBe(base);

  const selectedReturn = graphPublicSourceReturnHref({
    path: subjectHref({ id: subject, label: 'Origin' }, 'en').href,
    id: subject,
    locale: 'en',
    context,
    realm,
  });
  const selectedHref = graphPublicOriginHref(base, {
    subject,
    context,
    realm,
    locale: 'en',
    returnHref: selectedReturn!,
  });
  expect(parse(selectedHref)).toMatchObject({ kind: 'origin', origin: { subject, context, realm, locale: 'en' } });
  expect(graphPublicVisitUnsupported(parse(selectedHref))).toBe(true);

  const markup = renderToStaticMarkup(
    h(SubjectExploreSlot, {
      subjectId: subject,
      subjectType: 'wd:Q42',
      label: 'Origin',
      locale: 'en',
      context: candidateContext,
    }),
  );
  const renderedHref = /<a [^>]*href="([^"]*\/graph[^"]*)"/.exec(markup)?.[1]?.replaceAll('&amp;', '&');
  expect(renderedHref).toBe(globalHref);
});

test('the production graph route gates unsupported origins and a fresh Global choice uses only the original transport', async () => {
  const {
    graphPublicSourceReturnHref,
    graphPublicPath,
    parseGraphPublicVisit,
    subjectHref,
    base,
    publicReturn,
    observed,
    parse,
  } = await graphFixtures();
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const originalSession = await import('../src/session/query');
  type SessionObservation =
    | { state: 'signed-out'; subject: null; csrfToken: null }
    | { state: 'signed-in'; subject: string; csrfToken: string };
  let observedSession: SessionObservation = { state: 'signed-out', subject: null, csrfToken: null };
  const sessionListeners = new Set<() => void>();
  const setObservedSession = (next: SessionObservation) => {
    observedSession = next;
    for (const listener of sessionListeners) listener();
  };
  mock.module('../src/session/query', () => ({
    sessionQuery: { queryKey: ['session'] },
    sessionCsrfToken: () => (observedSession.state === 'signed-in' ? observedSession.csrfToken : null),
    useSession: () =>
      useSyncExternalStore(
        (listener) => {
          sessionListeners.add(listener);
          return () => sessionListeners.delete(listener);
        },
        () => observedSession,
        () => observedSession,
      ),
  }));

  const calls: { data: Record<string, unknown>; signal: AbortSignal }[] = [];
  const staleResults: ((result: { ok: false; reason: 'denied' }) => void)[] = [];
  const read = mock((input: { data: Record<string, unknown>; signal: AbortSignal }) => {
    calls.push(input);
    if (calls.length === 1)
      return new Promise<{ ok: false; reason: 'denied' }>((resolve) => staleResults.push(resolve));
    return Promise.resolve({ ok: false as const, reason: 'unavailable' as const });
  });
  const originalActions = await import('../src/features/pages/graph-browser/actions');
  mock.module('../src/features/pages/graph-browser/actions', () => ({ readSubjectGraphBrowser: read }));

  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test' + base });
  const names =
    'window document navigator HTMLElement HTMLButtonElement HTMLInputElement HTMLSelectElement Element Node Document DocumentFragment ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame scrollTo matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, name),
    });

  const { act, createElement: h, createContext, useContext } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { waitFor } = await import(createRequire(require.resolve('storybook/test')).resolve('@testing-library/dom'));
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { Outlet, createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { setLocale } = await import('../src/paraglide/runtime');
  const { Route } = await import('../src/routes/subjects/$id_.$slug.graph');
  setLocale('en', { reload: false });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const content = createContext(null as import('react').ReactNode);
  const rootRoute = createRootRoute({ component: () => useContext(content) ?? h(Outlet) });
  const graphRoute = Route.update({
    id: '/subjects/$id_/$slug/graph',
    path: '/subjects/$id/$slug/graph',
    getParentRoute: () => rootRoute,
  } as never);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);

  const mount = async (href: string) => {
    const url = new URL(href, 'https://site.test');
    const router = createRouter({
      routeTree: rootRoute.addChildren([graphRoute] as never),
      history: createMemoryHistory({
        initialEntries: [`${url.pathname.replace(/^\/en(?=\/)/, '')}${url.search}`],
      }),
    });
    await act(async () => {
      root.render(h(QueryClientProvider, { client: queryClient }, h(RouterProvider, { router })));
      await router.load();
    });
    return router;
  };

  try {
    const { catalogueEntries } = await import('../src/features/catalogue/catalogue-entry');
    const unsupportedReturn = graphPublicSourceReturnHref({
      path: subjectHref({ id: subject, label: 'Origin' }, 'en').href,
      id: subject,
      locale: 'en',
      context,
      realm,
    })!;
    const unsupportedHref = catalogueEntries.graph({
      id: subject,
      label: 'Origin',
      locale: 'en',
      origin: { subject, context, realm, locale: 'en', returnHref: unsupportedReturn },
    }).href;
    expect(parse(unsupportedHref)).toMatchObject({ kind: 'origin', origin: { context, realm } });
    const selectedAddress = new URL(unsupportedHref, 'https://site.test');
    selectedAddress.searchParams.set('property', 'wdt:P31');
    selectedAddress.searchParams.set('direction', 'both');
    selectedAddress.searchParams.set('depth', '2');
    selectedAddress.searchParams.set('node', otherSubject);
    const router = await mount(`${selectedAddress.pathname}${selectedAddress.search}`);
    const routeLocale = (await import('../src/paraglide/runtime.js')).getLocale();
    const routeId = router.state.matches.at(-1)?.params.id;
    expect(routeId).toBe(subject);
    expect(routeLocale).toBe('en');
    expect(
      parseGraphPublicVisit(
        router.state.location.searchStr,
        router.state.location.hash,
        String(routeId),
        routeLocale,
        graphPublicPath(router.state.location.pathname, routeLocale),
      ),
    ).toMatchObject({
      kind: 'origin',
      origin: { context, realm },
    });
    expect(host.textContent).toContain('selected Context or Realm');
    expect(calls).toHaveLength(0);

    const fresh = host.querySelector<HTMLAnchorElement>('a[href*="publicReturn="]');
    expect(fresh).not.toBeNull();
    const freshParams = new URL(fresh!.href).searchParams;
    expect([...freshParams.keys()]).toEqual(['publicReturn']);
    const globalHref = catalogueEntries.graph({ id: subject, label: 'Origin', locale: 'en', origin: observed }).href;
    const globalAddress = new URL(globalHref, 'https://site.test');
    const routeAddress = (url: URL) => `${url.pathname.replace(/^\/en(?=\/)/, '')}${url.search}`;
    await act(async () => router.history.push(routeAddress(globalAddress)));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const firstGlobalCount = calls.length;
    expect(calls.every((call) => !('context' in call.data) && !('realm' in call.data))).toBe(true);
    await act(async () => router.history.push(routeAddress(selectedAddress)));
    await waitFor(() => expect(host.textContent).toContain('selected Context or Realm'));
    expect(calls).toHaveLength(firstGlobalCount);
    expect(calls[0]!.signal.aborted).toBe(true);
    const afterUnsupported = calls.length;
    await act(async () => router.history.push(routeAddress(globalAddress)));
    await waitFor(() => expect(calls.length).toBeGreaterThan(afterUnsupported));
    await act(async () => staleResults[0]!({ ok: false, reason: 'denied' }));
    expect(host.textContent).not.toContain('not available for the current session');

    const beforeFresh = calls.length;
    await act(async () => router.history.push(routeAddress(new URL(fresh!.href, 'https://site.test'))));
    await waitFor(() => expect(calls.length).toBeGreaterThan(beforeFresh));
    const freshCalls = calls.slice(beforeFresh);
    for (const call of freshCalls) {
      expect(call.data).toMatchObject({ id: subject, locale: 'en', expectedReader: null });
      expect(call.data).not.toHaveProperty('context');
      expect(call.data).not.toHaveProperty('realm');
      expect(call.data.node).toBeUndefined();
      expect(call.data.edge).toBeUndefined();
    }
    expect(host.textContent).toContain('current Global catalogue');
    expect(host.textContent).not.toContain('selected Context or Realm');
    expect([...host.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toContain(unsupportedReturn);

    const beforeSignIn = calls.length;
    await act(async () => {
      setObservedSession({
        state: 'signed-in',
        subject: otherSubject,
        csrfToken: 'reader',
      });
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(beforeSignIn));
    expect(calls.slice(beforeSignIn).some((call) => typeof call.data.expectedReader === 'string')).toBe(true);
  } finally {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    mock.module('../src/features/pages/graph-browser/actions', () => originalActions);
    mock.module('../src/session/query', () => originalSession);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    window.happyDOM.abort();
  }
});

test('the graph route rejects conflicting, foreign, recursive and encoded-overflow intent before mounting a visit', async () => {
  const {
    graphPublicIntentFits,
    graphPublicOriginHref,
    parseGraphPublicVisit,
    subjectHref,
    base,
    publicReturn,
    observed,
    parse,
  } = await graphFixtures();
  const { graphBrowserReturnHref } = await import('../src/features/pages/graph-browser/view');
  const href = graphPublicOriginHref(base, observed);
  const query = new URL(href, 'https://site.test').search;
  const path = new URL(href, 'https://site.test').pathname;
  for (const suffix of [
    `&origin=${encodeURIComponent(JSON.stringify(observed))}`,
    `&publicReturn=${encodeURIComponent(publicReturn)}`,
    `&unexpected=x`,
  ])
    expect(parseGraphPublicVisit(query + suffix, '', subject, 'en', path)).toEqual({ kind: 'invalid' });

  const foreign = { ...observed, returnHref: publicReturn.replace(subject, otherSubject) };
  expect(parse(graphPublicOriginHref(base, foreign))).toEqual({ kind: 'invalid' });
  expect(parse(href, otherSubject)).toEqual({ kind: 'invalid' });
  expect(parse(href, subject, 'ja')).toEqual({ kind: 'invalid' });
  expect(parseGraphPublicVisit(query, '', subject, 'en', path.replace('/en/', '/ja/'))).toEqual({ kind: 'invalid' });
  expect(
    parse(
      graphPublicOriginHref(base, {
        ...observed,
        returnHref: `${publicReturn}?via=${encodeURIComponent(publicReturn)}`,
      }),
    ),
  ).toEqual({
    kind: 'invalid',
  });
  expect(graphPublicIntentFits('界'.repeat(700))).toBe(false);
  expect(parse(graphPublicOriginHref(base, { ...observed, returnHref: publicReturn + '界'.repeat(700) }))).toEqual({
    kind: 'invalid',
  });
  expect(parseGraphPublicVisit(`${query}&node=${subject}&edge=${subject}`, '', subject, 'en', path)).toEqual({
    kind: 'invalid',
  });
  expect(parseGraphPublicVisit(`${query}&edge=${subject}`, '', subject, 'en', path)).toEqual({
    kind: 'invalid',
  });

  let longOrigin: ReturnType<typeof parseGraphPublicVisit> = undefined;
  for (let size = 1000; size < 1800; size += 20) {
    const longReturn = `/en/subjects/${subject}/${'a'.repeat(size)}#subject-heading`;
    const candidate = parse(
      graphPublicOriginHref(base, {
        ...observed,
        returnHref: longReturn,
      }),
    );
    if (
      candidate?.kind === 'origin' &&
      !graphBrowserReturnHref(
        base,
        { property: ['wdt:P31'], direction: 'both', depth: 2 },
        { kind: 'edge', statement: subject, from: otherSubject, to: subject, property: 'wdt:P31' },
        candidate,
      )
    ) {
      longOrigin = candidate;
      break;
    }
  }
  expect(longOrigin?.kind).toBe('origin');
});
