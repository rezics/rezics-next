import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, PAGE_GLOBAL_CONTEXT, type CompositionDocument } from '@rezics/composition';
import { createRequire } from 'node:module';
import { Children, act, createContext, createElement, isValidElement, useContext, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoryArcProfileEntry, storyArcEntry } from '../src/features/catalogue/story-arc-profile-entry';
import {
  parseStoryArcProfileSearch,
  storyArcCanonicalSlugTarget,
  storyArcGlobalChoiceHref,
  storyArcPublicOrigin,
} from '../src/features/catalogue/story-arc-public-visit';
import * as start from '../.storybook/react-start';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { storyArcProfileFixture, storyArcProfileId } from '../src/kernel/fake/catalogue-story-arc-profile';
import { storyArcType } from '../src/features/catalogue/story-arc-profile';
import type { SubjectPageData } from '../src/features/pages/subject';
import { subjectHref } from '../src/subject/subject-href';

const subjectId = '5d0a0000-0000-4000-8000-000000000001';
const otherSubjectId = '5d0a0000-0000-4000-8000-000000000002';
const realmId = '5d0a0000-0000-4000-8000-000000000003';

test('StoryArc entry encodes current Context, admitted Realm, Definition and one immediate return', () => {
  const subject = subjectHref({ id: subjectId, label: 'A named arc' }, 'en');
  const via = storyArcPublicOrigin({
    currentHref: `${subject.href}?realm=${realmId}`,
    id: subjectId,
    locale: 'en',
    realm: realmId,
  })!;
  const html = renderToStaticMarkup(
    createElement(StoryArcProfileEntry, {
      id: subjectId,
      label: 'A named arc',
      locale: 'en',
      context: realmId,
      realm: realmId,
      definition: 'sha256:current-release',
      via,
    }),
  );
  const href = html.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  expect(href).toBeDefined();
  const address = new URL(href!, 'https://site.test');
  const parsed = parseStoryArcProfileSearch(address.search, subjectId, 'en');
  expect(parsed).toMatchObject({
    context: realmId,
    realm: realmId,
    definition: 'sha256:current-release',
    via,
  });
  expect(new URL(parsed!.via!, 'https://site.test').pathname).toBe(new URL(subject.href, 'https://site.test').pathname);
});

test('outer route input rejects malformed, duplicate, mismatched and over-budget origins; Global keeps only return', () => {
  const origin = subjectHref({ id: subjectId, label: 'A named arc' }, 'en').href;
  const via = `${origin}#connections`;
  const encoded = encodeURIComponent(via);
  expect(parseStoryArcProfileSearch(`via=${encoded}%`, subjectId, 'en')).toBeUndefined();
  expect(parseStoryArcProfileSearch(`via=${encoded}&via=${encoded}`, subjectId, 'en')).toBeUndefined();
  expect(
    parseStoryArcProfileSearch(
      `via=${encodeURIComponent(`/${'en'}/subjects/${otherSubjectId}/arc#connections`)}`,
      subjectId,
      'en',
    ),
  ).toBeUndefined();
  expect(
    parseStoryArcProfileSearch(
      `via=${encodeURIComponent(`/ja/subjects/${subjectId}/arc#connections`)}`,
      subjectId,
      'en',
    ),
  ).toBeUndefined();
  expect(
    parseStoryArcProfileSearch(`via=${encodeURIComponent(`${origin}/relations#connections`)}`, subjectId, 'en'),
  ).toBeUndefined();
  expect(parseStoryArcProfileSearch(`via=${'😀'.repeat(600)}`, subjectId, 'en')).toBeUndefined();

  const realmVia = storyArcPublicOrigin({
    currentHref: `${origin}?realm=${realmId}`,
    id: subjectId,
    locale: 'en',
    realm: realmId,
  })!;
  const choice = storyArcGlobalChoiceHref({ id: subjectId, slug: 'a-named-arc', locale: 'en', via: realmVia });
  const choiceUrl = new URL(choice, 'https://site.test');
  expect([...choiceUrl.searchParams.keys()]).toEqual(['via']);
  expect(parseStoryArcProfileSearch(choiceUrl.search, subjectId, 'en')).toMatchObject({ via: realmVia });
  expect(
    parseStoryArcProfileSearch(`context=${PAGE_GLOBAL_CONTEXT}&via=${encodeURIComponent(realmVia)}`, subjectId, 'en'),
  ).toBeUndefined();
});

test('canonical slug changes redirect only for the same identity', () => {
  expect(
    storyArcCanonicalSlugTarget({
      id: subjectId,
      slug: 'old-title',
      currentId: subjectId,
      label: 'A named arc',
      locale: 'en',
    }),
  ).toBe(subjectHref({ id: subjectId, label: 'A named arc' }, 'en').href);
  expect(
    storyArcCanonicalSlugTarget({
      id: subjectId,
      slug: 'old-title',
      currentId: otherSubjectId,
      label: 'A named arc',
      locale: 'en',
    }),
  ).toBeUndefined();
});

test('the mounted Subject, canonical route, correction session and existing reader preserve only current admitted intent', async () => {
  const { dirname } = await import('node:path');
  const require = createRequire(import.meta.url);
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({
    url: `https://site.test/en/subjects/${storyArcProfileId}/the-journey-arc/story-arc`,
    width: 390,
  });
  const globalNames =
    'window document navigator HTMLElement HTMLButtonElement HTMLInputElement HTMLSelectElement HTMLFormElement Element Node Document DocumentFragment ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame scrollTo matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const previous = new Map(globalNames.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globalNames)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, key),
    });
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  // Module mocks are process-wide under the combined runner; capture each real module to restore it on exit.
  const realEditorial = await import('../src/features/catalogue/editorial-entry');
  mock.module('../src/features/catalogue/editorial-entry', () => ({
    EditorialEntry: ({ children }: { children: ReactNode }) =>
      Children.toArray(children).find((child) => isValidElement(child) && child.type === StoryArcProfileEntry) ?? null,
  }));
  const fixture = storyArcProfileFixture();
  const profileLoads: unknown[] = [];
  const realProfileActions = await import('../src/features/catalogue/story-arc-profile-actions');
  mock.module('../src/features/catalogue/story-arc-profile-actions', () => ({
    loadStoryArcProfile: async ({ data }: { data: { id?: string; work?: string } }) => {
      profileLoads.push(data);
      return fixture.transport.load(data);
    },
  }));
  const realReaderActions = await import('../src/features/catalogue/story-arc-reader/actions');
  mock.module('../src/features/catalogue/story-arc-reader/actions', () => ({
    loadArcReader: async () => ({ ok: false, reason: 'unavailable' }),
  }));
  const originalKernel = await import('../src/kernel/client');
  mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => fixture.client }));
  const [
    { createRoot },
    { createMemoryHistory, createRootRoute, createRouter, RouterProvider },
    { QueryClient, QueryClientProvider },
    { sessionQuery },
    { StoryArcProfileSession },
    { SubjectPage, loadSubjectPage, pageContext },
    { subjectPageMessages },
    { Route },
    { getLocale, setLocale },
    { m },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-router'),
    import('@tanstack/react-query'),
    import('../src/session/query'),
    import('../src/features/catalogue/story-arc-profile-session'),
    import('../src/features/pages/subject'),
    import('../src/features/pages/route-support'),
    import('../src/routes/subjects/$id_.$slug_.story-arc'),
    import('../src/paraglide/runtime'),
    import('../src/paraglide/messages'),
  ]);
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const reader = '00000000-0000-4000-8000-000000000099';
  const signedIn = { state: 'signed-in' as const, subject: reader, csrfToken: 'session-token' };
  client.setQueryData(sessionQuery.queryKey, signedIn);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const Contents = createContext<ReactNode>(null);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => useContext(Contents) }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const render = async (node: ReactNode) =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(Contents.Provider, { value: node }, createElement(RouterProvider, { router })),
        ),
      );
      await router.load();
    });
  const actualSubject = subjectHref({ id: storyArcProfileId, label: 'The journey arc' }, 'en');
  const selectedContext = '5d0a0000-0000-4000-8000-000000000004';
  const originHref = (realm?: string) => `${actualSubject.href}${realm ? `?realm=${realm}` : ''}#connections`;
  const makePage = (context: string, realm?: string, label = 'The journey arc'): SubjectPageData => {
    const page = structuredClone(recordedPage) as unknown as SubjectPageData;
    page.subject = storyArcProfileId;
    page.catalogue = {
      state: 'released',
      type: storyArcType,
      digest: fixture.arc.subject.release,
      definitions: { types: fixture.release.types, properties: fixture.release.properties },
    };
    page.context = realm ? { id: context, population: { kind: 'realm', id: realm, title: 'Readers' } } : undefined;
    page.requestedRealm = realm;
    const publicRead = structuredClone(fixture.arc);
    publicRead.subject.context = context;
    publicRead.subject.labels = { ...publicRead.subject.labels, en: label };
    const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
    for (const [key, descriptor] of Object.entries(reads))
      if (descriptor.kind === 'subject' && descriptor.id === page.subject)
        page.reads[key] = { status: 200, body: publicRead };
    return page;
  };
  const subjectEntry = async (context: string, realm?: string, label?: string) => {
    await render(
      createElement(SubjectPage, {
        page: makePage(context, realm, label),
        locale: 'en',
        view: 'overview',
        messages: subjectPageMessages(),
        currentHref: originHref(realm),
        renderJsonLd: false,
      }),
    );
    return host.querySelector<HTMLAnchorElement>('a[href*="/story-arc?"]')?.getAttribute('href');
  };
  const routeLoader = Route.options.loader;
  if (typeof routeLoader !== 'function') throw new Error('Expected the installed StoryArc route loader.');
  const loadRoute = (href: string, slug = actualSubject.params.slug) =>
    routeLoader({
      params: { id: storyArcProfileId, slug },
      location: { searchStr: new URL(href, window.location.origin).search, hash: '' },
    } as never);
  const sessionFor = (id: string, visit: NonNullable<ReturnType<typeof parseStoryArcProfileSearch>>) =>
    createElement(StoryArcProfileSession, {
      id,
      locale: 'en',
      ...visit,
      address: JSON.stringify([visit.definition, visit.via]),
      globalChoiceHref: storyArcGlobalChoiceHref({ id, slug: actualSubject.params.slug, locale: 'en', via: visit.via }),
    } as never);
  const waitFor = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 50 && !predicate(); attempt++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(predicate()).toBe(true);
  };
  try {
    const globalEntry = await subjectEntry(PAGE_GLOBAL_CONTEXT);
    expect(globalEntry).toBeDefined();
    const globalRoute = new URL(globalEntry!, window.location.origin);
    const globalVisit = parseStoryArcProfileSearch(globalRoute.search, storyArcProfileId, 'en')!;
    expect(globalVisit).toMatchObject({ context: PAGE_GLOBAL_CONTEXT, definition: fixture.arc.subject.release });
    expect(globalVisit.via).toBe(`${actualSubject.href}#connections`);
    expect(host.querySelector('[data-slot="story-arc-reader"]')).not.toBeNull();

    const nonGlobalEntry = await subjectEntry(selectedContext);
    expect(nonGlobalEntry).toBeDefined();
    const nonGlobalVisit = parseStoryArcProfileSearch(
      new URL(nonGlobalEntry!, window.location.origin).search,
      storyArcProfileId,
      'en',
    )!;
    expect(nonGlobalVisit).toMatchObject({ context: selectedContext, definition: fixture.arc.subject.release });
    expect(nonGlobalVisit).not.toHaveProperty('realm');
    const nonGlobalRoute = await loadRoute(nonGlobalEntry!);
    const beforeRefusal = profileLoads.length;
    await render(sessionFor((nonGlobalRoute as { id: string }).id, nonGlobalVisit));
    expect(host.textContent).toContain(m.story_arc_context_unsupported());
    expect(profileLoads).toHaveLength(beforeRefusal);
    expect(client.getQueryCache().findAll({ queryKey: ['story-arc-profile'] })).toHaveLength(0);

    await render(
      createElement(SubjectPage, {
        page: makePage(selectedContext, realmId),
        locale: 'en',
        view: 'overview',
        messages: subjectPageMessages(),
        currentHref: originHref(realmId),
        renderJsonLd: false,
      }),
    );
    expect(host.querySelector('a[href*="/story-arc?"]')).toBeNull();
    const realmVia = storyArcPublicOrigin({
      currentHref: originHref(realmId),
      id: storyArcProfileId,
      locale: 'en',
      realm: realmId,
    })!;
    const realmEntry = storyArcEntry({
      id: storyArcProfileId,
      label: 'The journey arc',
      locale: 'en',
      context: selectedContext,
      realm: realmId,
      definition: fixture.arc.subject.release,
      via: realmVia,
    }).href;
    const realmVisit = parseStoryArcProfileSearch(
      new URL(realmEntry, window.location.origin).search,
      storyArcProfileId,
      'en',
    )!;
    expect(realmVisit).toMatchObject({ context: selectedContext, realm: realmId, via: originHref(realmId) });
    const realmRoute = await loadRoute(realmEntry!);
    await render(sessionFor((realmRoute as { id: string }).id, realmVisit));
    expect(host.textContent).toContain(m.story_arc_context_unsupported());
    expect(profileLoads).toHaveLength(beforeRefusal);
    const publicReturn = [...host.querySelectorAll('a')].find(
      (link) => link.textContent === m.story_arc_return_public(),
    )!;
    expect(publicReturn.getAttribute('href')).toBe(originHref(realmId));
    const globalChoice = [...host.querySelectorAll('a')].find(
      (link) => link.textContent === m.story_arc_choose_global(),
    )!;
    const globalChoiceUrl = new URL(globalChoice.href, window.location.origin);
    expect([...globalChoiceUrl.searchParams.keys()]).toEqual(['via']);
    expect(globalChoiceUrl.searchParams.get('via')).toBe(originHref(realmId));

    const publicReads: unknown[] = [];
    const returnedPage = makePage(selectedContext, realmId, 'Current returned arc');
    const publicClient = createKernelClient('https://public.invalid', {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        publicReads.push(await request.clone().json());
        return Response.json(returnedPage);
      }) as typeof fetch,
    });
    const returnAddress = new URL(publicReturn.href, window.location.origin);
    const readBack = await loadSubjectPage(publicClient, storyArcProfileId, undefined, 'en', {
      realm: returnAddress.searchParams.get('realm') ?? undefined,
    });
    expect(publicReads).toEqual([{ target: { subject: storyArcProfileId, realm: realmId }, languages: ['en'] }]);
    if (readBack.kind !== 'page') throw new Error('Expected a fresh admitted Subject page on return.');
    await render(
      createElement(SubjectPage, {
        page: readBack.page,
        locale: 'en',
        view: 'overview',
        messages: subjectPageMessages(),
        currentHref: returnAddress.href,
        renderJsonLd: false,
      }),
    );
    expect(host.textContent).toContain('Current returned arc');
    expect(host.querySelector('[data-slot="story-arc-reader"]')).not.toBeNull();

    const validateSearch = Route.options.validateSearch;
    if (typeof validateSearch !== 'function') throw new Error('Expected the installed StoryArc search validator.');
    expect(validateSearch(Object.fromEntries(globalRoute.searchParams))).toMatchObject(globalVisit);
    await expect(
      loadRoute(`${globalRoute.pathname}?realm=${realmId}&via=${encodeURIComponent(originHref(realmId))}`, 'old-label'),
    ).rejects.toMatchObject({ options: { statusCode: 301 } });
    const originalId = fixture.arc.subject.id;
    fixture.arc.subject.id = otherSubjectId;
    expect(await loadRoute(`${globalRoute.pathname}?${globalRoute.search.slice(1)}`, 'old-label')).toEqual({
      id: storyArcProfileId,
    });
    fixture.arc.subject.id = originalId;

    const globalRouteData = (await loadRoute(globalEntry!)) as { id: string };
    const beforeGlobal = profileLoads.length;
    await render(sessionFor(globalRouteData.id, globalVisit));
    await waitFor(() => profileLoads.length > beforeGlobal);
    expect(profileLoads[beforeGlobal]).toEqual({ id: storyArcProfileId, work: undefined });

    client.clear();
    client.setQueryData(sessionQuery.queryKey, signedIn);
    const choiceVisit = parseStoryArcProfileSearch(globalChoiceUrl.search, storyArcProfileId, 'en')!;
    const choiceRoute = (await loadRoute(globalChoice.href)) as { id: string };
    const beforeChoice = profileLoads.length;
    const beforeNativeRead = fixture.calls.length;
    await render(sessionFor(choiceRoute.id, choiceVisit));
    await waitFor(() => profileLoads.length > beforeChoice);
    expect(profileLoads[beforeChoice]).toEqual({ id: storyArcProfileId, work: undefined });
    expect(fixture.calls.slice(beforeNativeRead).map(({ method, path }) => `${method} ${path}`)).toContain(
      `GET /v1/definitions/active`,
    );
    expect(fixture.calls.slice(beforeNativeRead).map(({ method, path }) => `${method} ${path}`)).toContain(
      `GET /v1/subjects/${storyArcProfileId}`,
    );
    expect(fixture.calls.slice(beforeNativeRead).every(({ method }) => method === 'GET')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    mock.module('../src/features/catalogue/editorial-entry', () => realEditorial);
    mock.module('../src/features/catalogue/story-arc-profile-actions', () => realProfileActions);
    mock.module('../src/features/catalogue/story-arc-reader/actions', () => realReaderActions);
    mock.module('../src/kernel/client', () => originalKernel);
    setLocale(oldLocale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
