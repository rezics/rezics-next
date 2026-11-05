import { expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createContext, useContext, type ReactNode } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('authored public visit descriptors stay closed, bounded and separate from synopsis selection', async () => {
  const [{ addonProfileId, addonWorkId }, { candidateContext }, { subjectHref }, visitHelpers] = await Promise.all([
    import('../src/kernel/fake/catalogue-addon-profile'),
    import('../src/subject/candidates'),
    import('../src/subject/subject-href'),
    import('../src/features/catalogue/authored-public-visit'),
  ]);
  const {
    authoredGlobalVisitHref,
    authoredPublicCorrectionHref,
    authoredPublicIntentFits,
    authoredPublicVisitUnsupported,
    parseAuthoredPublicVisit,
  } = visitHelpers;
  const label = 'Harbor: Northern lights';
  const publicHref = subjectHref({ id: addonProfileId, label }, 'en').href;
  const base = `${publicHref}/authored`;
  const observed = { subject: addonProfileId, context: candidateContext, locale: 'en', returnHref: publicHref };
  const href = authoredPublicCorrectionHref(base, observed);
  const visit = parseAuthoredPublicVisit(new URL(href, 'https://site.test').search, addonProfileId, 'en', base);
  expect(visit).toEqual({
    kind: 'origin',
    origin: { ...observed, returnHref: `${publicHref}#connections` },
  });
  expect(authoredPublicVisitUnsupported(visit)).toBe(false);

  const realmOrigin = {
    ...observed,
    realm: addonWorkId,
    returnHref: `${publicHref}?realm=${addonWorkId}`,
  };
  const realmHref = authoredPublicCorrectionHref(base, realmOrigin);
  const realmVisit = parseAuthoredPublicVisit(
    new URL(realmHref, 'https://site.test').search,
    addonProfileId,
    'en',
    base,
  );
  expect(authoredPublicVisitUnsupported(realmVisit)).toBe(true);
  const freshHref = authoredGlobalVisitHref(
    base,
    addonProfileId,
    'en',
    realmVisit.kind === 'origin' ? realmVisit.origin.returnHref : '',
  );
  expect(parseAuthoredPublicVisit(new URL(freshHref, 'https://site.test').search, addonProfileId, 'en', base)).toEqual({
    kind: 'fresh',
    returnHref: `${publicHref}?realm=${addonWorkId}#connections`,
  });

  expect(parseAuthoredPublicVisit('', addonProfileId, 'en', base)).toEqual({ kind: 'legacy' });
  for (const search of [
    '?origin=!',
    `?origin=${new URL(href, 'https://site.test').searchParams.get('origin')}&via=${encodeURIComponent(publicHref)}`,
    `?origin=${'界'.repeat(700)}`,
    '?origin%ZZ=!',
  ])
    expect(parseAuthoredPublicVisit(search, addonProfileId, 'en', base)).toEqual({ kind: 'invalid' });
  expect(authoredPublicIntentFits('x'.repeat(2048))).toBe(true);
  expect(authoredPublicIntentFits('x'.repeat(2049))).toBe(false);
  expect(authoredPublicIntentFits('界'.repeat(700))).toBe(false);
});

test('mounted entry, contribution menu and authored route keep public intent out of session and editor reads until supported', async () => {
  const [{ addonProfileFixture, addonProfileId, addonWorkId }, { authoredFixture }] = await Promise.all([
    import('../src/kernel/fake/catalogue-addon-profile'),
    import('../src/kernel/fake/authored-field'),
  ]);
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test', width: 390, height: 844 });
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

  const { createRoot } = await import('react-dom/client');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(storybook.resolve('@testing-library/dom'));
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const menuModule = await import('@rezics/ui/menu');
  const OriginalMenu = menuModule.Menu;
  let contributionMenu: Parameters<typeof OriginalMenu>[0] | undefined;
  const menuSpy = spyOn(menuModule, 'Menu').mockImplementation((props) => {
    if (props.title === m.contribute_title({}, { locale: 'en' })) contributionMenu = props;
    return <OriginalMenu {...props} />;
  });

  const profile = addonProfileFixture();
  const originalKernel = { ...(await import('../src/kernel/client')) };
  mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => profile.client }));
  const originalActions = await import('../src/features/catalogue/authored-field-actions');
  const [
    { authoredPublicCorrectionHref, parseAuthoredPublicVisit },
    { AuthoredFieldEntry },
    { EditorialEntry },
    { subjectHref },
    { candidateContext },
  ] = await Promise.all([
    import('../src/features/catalogue/authored-public-visit'),
    import('../src/features/catalogue/authored-field-entry'),
    import('../src/features/catalogue/editorial-entry'),
    import('../src/subject/subject-href'),
    import('../src/subject/candidates'),
  ]);
  const authored = authoredFixture();
  const result = await authored.transport.read();
  if (!result.ok) throw new Error('Expected authored fixture data');
  result.public.subject.id = addonProfileId;
  const authoredReads: unknown[] = [];
  mock.module('../src/features/catalogue/authored-field-actions', () => ({
    ...originalActions,
    loadAuthoredField: async (input: { data: unknown }) => {
      authoredReads.push(input.data);
      return result;
    },
  }));

  const { Route } = await import('../src/routes/subjects/$id_.$slug_.authored');
  const { sessionQuery } = await import('../src/session/query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const reader = '00000000-0000-4000-8000-00000000f101';
  const label = 'Harbor: Northern lights';
  const publicHref = subjectHref({ id: addonProfileId, label }, 'en').href;
  const base = `${publicHref}/authored`;
  const observed = { subject: addonProfileId, context: candidateContext, locale: 'en', returnHref: publicHref };
  const session = (state: 'signed-in' | 'signed-out') =>
    client.setQueryData(sessionQuery.queryKey, {
      state,
      subject: state === 'signed-in' ? reader : null,
      csrfToken: state === 'signed-in' ? 'token' : null,
    });
  client.setQueryDefaults(sessionQuery.queryKey, { gcTime: Infinity });
  session('signed-in');

  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const Content = createContext<ReactNode>(null);
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {useContext(Content)}
        <Outlet />
      </>
    ),
  });
  Route.update({
    id: '/subjects/$id_/$slug_/authored',
    path: '/subjects/$id/$slug/authored',
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([Route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const renderNode = async (node: ReactNode) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Content.Provider value={node}>
            <RouterProvider router={router} />
          </Content.Provider>
        </QueryClientProvider>,
      );
      await router.load();
    });
  const navigate = async (href: string) => {
    const url = new URL(href, window.location.origin);
    const path = url.pathname.replace(/^\/en(?=\/)/u, '');
    await act(async () => router.history.push(`${path}${url.search}${url.hash}`));
  };
  const loader = Route.options.loader as unknown as (input: {
    params: { id: string; slug: string };
    location: { searchStr: string; hash: string };
  }) => Promise<unknown>;
  const loadCanonical = (slug: string, href: string) =>
    loader({
      params: { id: addonProfileId, slug },
      location: { searchStr: new URL(href, window.location.origin).search, hash: '' },
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <EditorialEntry id={addonProfileId} label={label} locale="en" context={candidateContext}>
            <AuthoredFieldEntry id={addonProfileId} title={label} locale="en" origin={observed} />
          </EditorialEntry>
        </QueryClientProvider>,
      ),
    );
    const editMenu = contributionMenu?.entries?.find(
      (entry) => entry.type === 'submenu' && entry.label === m.contribute_edit({}, { locale: 'en' }),
    );
    expect(editMenu).toMatchObject({
      type: 'submenu',
      entries: expect.arrayContaining([
        expect.objectContaining({
          type: 'link',
          href: authoredPublicCorrectionHref(base, observed),
        }),
      ]),
    });

    const originHref = authoredPublicCorrectionHref(base, observed);
    const slugRepair = await loadCanonical('stale-slug', originHref).then(
      () => undefined,
      (error) => error,
    );
    const slugRepairHref = (slugRepair as { options?: { href?: string } } | undefined)?.options?.href;
    expect(slugRepairHref).toContain('origin=');
    expect(
      parseAuthoredPublicVisit(new URL(slugRepairHref!, 'https://site.test').search, addonProfileId, 'en', base).kind,
    ).toBe('origin');
    const originalSubjectId = profile.current.subject.id;
    profile.current.subject.id = addonWorkId;
    const identityChange = await loadCanonical('harbor-northern-lights', originHref).then(
      () => undefined,
      (error) => error,
    );
    const identityChangeHref = (identityChange as { options?: { href?: string } } | undefined)?.options?.href;
    expect(identityChangeHref).toContain('origin=!');
    profile.current.subject.id = originalSubjectId;
    const canonicalReadsBeforeUnsupported = profile.calls.length;

    await renderNode(null);
    client.removeQueries({ queryKey: sessionQuery.queryKey });
    const unsupportedHref = authoredPublicCorrectionHref(base, { ...observed, context: addonWorkId });
    await navigate(unsupportedHref);
    await waitFor(() => expect(host.textContent).toContain(m.authored_public_unsupported()));
    expect(profile.calls).toHaveLength(canonicalReadsBeforeUnsupported);
    expect(authoredReads).toHaveLength(0);
    expect(client.getQueryState(sessionQuery.queryKey)).toBeUndefined();
    expect(host.querySelector<HTMLAnchorElement>(`a[href="${publicHref}#connections"]`)?.getAttribute('href')).toBe(
      `${publicHref}#connections`,
    );
    const freshHref = host.querySelector<HTMLAnchorElement>('a[href*="publicReturn="]')?.getAttribute('href');
    expect(freshHref).toBeTruthy();
    expect(
      parseAuthoredPublicVisit(new URL(freshHref!, 'https://site.test').search, addonProfileId, 'en', base).kind,
    ).toBe('fresh');

    for (const invalidHref of [
      `${base}?origin=!`,
      `${unsupportedHref}&via=${encodeURIComponent(publicHref)}`,
      `${base}?origin=${'界'.repeat(700)}`,
    ]) {
      await navigate(invalidHref);
      await waitFor(() => expect(host.textContent).toContain(m.authored_public_invalid()));
      expect(profile.calls).toHaveLength(canonicalReadsBeforeUnsupported);
      expect(authoredReads).toHaveLength(0);
      expect(client.getQueryState(sessionQuery.queryKey)).toBeUndefined();
    }

    session('signed-out');
    await navigate(authoredPublicCorrectionHref(base, observed));
    await waitFor(() => expect(host.textContent).toContain(m.authored_public_return()));
    expect(profile.calls.some((call) => call.path === `/v1/subjects/${addonProfileId}`)).toBe(true);
    expect(authoredReads).toHaveLength(0);

    session('signed-in');
    await waitFor(() => expect(authoredReads.length).toBeGreaterThan(0));
    await waitFor(() => expect(host.querySelector('input,select')).not.toBeNull());
    expect(JSON.stringify(authoredReads[0])).not.toContain('origin');
    expect(JSON.stringify(authoredReads[0])).not.toContain('publicReturn');
    const returnLink = host.querySelector<HTMLAnchorElement>(`a[href="${publicHref}#connections"]`);
    expect(returnLink).not.toBeNull();

    await navigate(freshHref!);
    await waitFor(() => expect(host.textContent).toContain(m.authored_public_fresh_notice()));
    await waitFor(() => expect(authoredReads.length).toBeGreaterThan(1));
    expect(host.querySelector<HTMLAnchorElement>(`a[href="${publicHref}#connections"]`)).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(previousLocale, { reload: false });
    menuSpy.mockRestore();
    mock.restore();
    await window.happyDOM.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
