import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createContext, useContext, type ReactNode } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { candidateContext } from '../src/subject/candidates';
import { subjectHref } from '../src/subject/subject-href';
import { subjectContributionEntries, contributionHref } from '../src/features/catalogue/catalogue-entry';
import {
  parseRelationPublicVisit,
  relationPublicFreshHref,
  relationPublicIntentFits,
  relationPublicVisitUnsupported,
} from '../src/features/catalogue/relation-public-visit';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const id = '00000000-0000-4000-8000-00000000c001';
const otherId = '00000000-0000-4000-8000-00000000c004';
const context = '00000000-0000-4000-8000-00000000c002';
const realm = '00000000-0000-4000-8000-00000000c003';
const label = 'Harbor: Northern lights';
const subject = subjectHref({ id, label }, 'en').href;
const routePath = `${subject}/relation-edit`;

function parseSearch(searchString: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = Object.create(null);
  for (const [key, value] of new URLSearchParams(searchString)) {
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

test('relation public intent is closed, bounded, and separate from legacy route operands', () => {
  const entry = subjectContributionEntries({ id, label, locale: 'en', context: candidateContext })[0]!;
  const visit = parseRelationPublicVisit(new URL(entry.href, 'https://site.test').search, id, 'en', routePath);
  expect(visit).toMatchObject({ kind: 'origin', origin: { subject: id, context: candidateContext, locale: 'en' } });
  expect(relationPublicVisitUnsupported(visit)).toBe(false);

  const realmEntry = subjectContributionEntries({ id, label, locale: 'en', context, realm })[0]!;
  const realmVisit = parseRelationPublicVisit(
    new URL(realmEntry.href, 'https://site.test').search,
    id,
    'en',
    routePath,
  );
  expect(relationPublicVisitUnsupported(realmVisit)).toBe(true);
  if (realmVisit.kind !== 'origin') throw new Error('Expected the admitted public origin');
  const freshHref = relationPublicFreshHref(routePath, realmVisit.origin.returnHref);
  expect(parseRelationPublicVisit(new URL(freshHref, 'https://site.test').search, id, 'en', routePath)).toEqual({
    kind: 'fresh',
    returnHref: `${subject}?realm=${realm}#connections`,
  });

  const invalid = [
    `${new URL(entry.href, 'https://site.test').search}&origin=!`,
    `${new URL(entry.href, 'https://site.test').search}&creditHandoff=${realm}`,
    '?origin%ZZ=!',
    `?origin=${encodeURIComponent(JSON.stringify({ subject: id, context, locale: 'ja', returnHref: subject }))}`,
    `?origin=${encodeURIComponent(JSON.stringify({ subject: otherId, context, locale: 'en', returnHref: subject }))}`,
    `?origin=${encodeURIComponent(JSON.stringify({ subject: id, context, locale: 'en', returnHref: subject.replace('/en/', '/ja/') + '#connections' }))}`,
    `?origin=${encodeURIComponent(JSON.stringify({ subject: id, context, locale: 'en', returnHref: `https://site.test${subject}` }))}`,
    `?origin=${encodeURIComponent(JSON.stringify({ subject: id, context, locale: 'en', returnHref: `${subject}?via=${encodeURIComponent(subject)}` }))}`,
    `?origin=${encodeURIComponent(JSON.stringify({ subject: id, context, locale: 'en', returnHref: `${subject}?realm=${realm}#connections` }))}`,
    `?origin=${'界'.repeat(700)}`,
    `?origin=${'x'.repeat(2100)}`,
  ];
  for (const search of invalid)
    expect(parseRelationPublicVisit(search, id, 'en', routePath)).toEqual({ kind: 'invalid' });
  expect(parseRelationPublicVisit('?via=%2Fen%2Fsubjects%2Fexample%23connections', id, 'en', routePath)).toEqual({
    kind: 'legacy',
  });
  expect(relationPublicIntentFits(`${routePath}?origin=${'界'.repeat(700)}`)).toBe(false);
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es']) {
    const localeSubject = subjectHref({ id, label }, locale).href;
    const localeEntry = subjectContributionEntries({ id, label, locale, context: candidateContext })[0]!;
    expect(
      parseRelationPublicVisit(
        new URL(localeEntry.href, 'https://site.test').search,
        id,
        locale,
        `${localeSubject}/relation-edit`,
      ),
    ).toMatchObject({ kind: 'origin', origin: { locale } });
  }

  const signedOut = new URL(contributionHref(entry, true), 'https://site.test');
  expect(signedOut.searchParams.get('return_to')).toBe(entry.href);
});

test('mounted menu and production relation route gate unsupported origins before reads and retire A/B/A sessions', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test', width: 1280, height: 900 });
  const globalNames =
    'window document navigator HTMLElement HTMLButtonElement HTMLInputElement HTMLSelectElement Element Node Document DocumentFragment ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame scrollTo matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of globalNames)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, name),
    });

  const subjectPages = await import('../src/features/pages/subject');
  const subjectFrame = await import('../src/features/pages/subject-frame');
  const routeSupport = await import('../src/features/pages/route-support');
  const views = await import('../src/features/pages/views');
  const kernel = await import('../src/kernel/client');
  const relationActions = await import('../src/features/catalogue/relation-editor-actions');
  const loadSubjectModule = await import('../src/subject/load-subject');
  const { relationFixture } = await import('../src/kernel/fake/catalogue-relations');
  const fixture = relationFixture('ready', 'en');
  const relationRead = await fixture.transport.read();
  if (!relationRead.ok) throw new Error('Expected the fixture relation reading');
  const subjectId = relationRead.public.subject.id;
  const subjectPath = subjectHref({ id: subjectId, label }, 'en').href;
  const editPath = `${subjectPath}/relation-edit`;
  const slug = new URL(subjectPath, 'https://site.test').pathname.split('/')[4]!;
  const rootReads: unknown[] = [];
  const pageReads: unknown[] = [];
  const sessionReads: unknown[] = [];
  const pending: Array<(value: typeof relationRead) => void> = [];
  let holdSessionReads = false;
  let canonicalId = subjectId;
  let canonicalSlug = slug;
  let pageContext = candidateContext;

  mock.module('../src/features/pages/subject', () => ({
    ...subjectPages,
    loadSubjectPage: async (
      _client: unknown,
      requestedId: string,
      _view: string,
      _locale: string,
      options: { realm?: string },
    ) => {
      pageReads.push({ id: requestedId, realm: options.realm });
      return {
        kind: 'page',
        page: {
          subject: requestedId,
          context: options.realm
            ? { id: context, population: { kind: 'realm', id: options.realm, title: 'Realm' } }
            : { id: pageContext, population: { kind: 'global' } },
          catalogue: { digest: 'sha256:current' },
        },
      };
    },
  }));
  mock.module('../src/features/pages/subject-frame', () => ({
    ...subjectFrame,
    subjectFrame: (page: { subject: string }) => ({ id: page.subject, title: { text: label }, summary: null }),
    SubjectFrame: () => <h1>Subject heading</h1>,
  }));
  mock.module('../src/features/pages/route-support', () => ({
    ...routeSupport,
    SubjectLink: () => null,
    viewTabLabels: () => ({}),
  }));
  mock.module('../src/features/pages/views', () => ({ ...views, subjectTabs: () => [] }));
  mock.module('../src/kernel/client', () => ({ ...kernel, kernelClient: () => ({}) }));
  mock.module('../src/subject/load-subject', () => ({
    ...loadSubjectModule,
    loadSubject: async () => {
      rootReads.push(canonicalId);
      return { kind: 'page', value: { id: canonicalId, slug: canonicalSlug } };
    },
  }));
  mock.module('../src/features/catalogue/relation-editor-actions', () => ({
    ...relationActions,
    readSubjectRelationEditor: async (input: { data: unknown }) => {
      sessionReads.push(input.data);
      return holdSessionReads ? new Promise<typeof relationRead>((resolve) => pending.push(resolve)) : relationRead;
    },
  }));

  const { createRoot } = await import('react-dom/client');
  const { waitFor, within } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/dom')
  );
  const { default: userEvent } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event')
  );
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const sessionModule = await import('../src/session/query');
  mock.module('../src/session/query', () => ({
    ...sessionModule,
    useSession: () => ({ state: 'signed-in', subject: 'relation-origin-reader', csrfToken: 'relation-origin-test' }),
  }));
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const user = userEvent.setup({ document: window.document });
  const { EditorialEntry } = await import('../src/features/catalogue/editorial-entry');
  const { sessionQuery } = sessionModule;
  const { Route } = await import('../src/routes/subjects/$id_.$slug_.relation-edit');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: '00000000-0000-4000-8000-00000000c099',
    csrfToken: 'relation-origin-test',
  });
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
  const localeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$locale', component: Outlet });
  Route.update({
    id: '/subjects/$id_/$slug_/relation-edit',
    path: '/subjects/$id/$slug/relation-edit',
    getParentRoute: () => localeRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([localeRoute.addChildren([Route])]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    parseSearch,
    stringifySearch,
  });
  const menu = (
    <EditorialEntry id={subjectId} label={label} locale="en" context={candidateContext}>
      {null}
    </EditorialEntry>
  );
  const renderMenu = async () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Content.Provider value={menu}>
            <RouterProvider router={router} />
          </Content.Provider>
        </QueryClientProvider>,
      ),
    );
  const navigate = async (href: string) => {
    await act(async () => router.navigate({ href }));
  };
  const openEditor = async () => {
    await act(async () => user.click(within(host).getByRole('button', { name: m.relation_open() })));
  };
  const relationEntry = subjectContributionEntries({
    id: subjectId,
    label,
    locale: 'en',
    context: candidateContext,
  })[0]!;
  const originHref = relationEntry.href;
  const unsupportedHref = subjectContributionEntries({ id: subjectId, label, locale: 'en', context })[0]!.href;
  const realmHref = subjectContributionEntries({ id: subjectId, label, locale: 'en', context, realm })[0]!.href;

  try {
    expect(getLocale()).toBe('en');
    await renderMenu();
    await act(async () => user.click(within(host).getByRole('button', { name: m.contribute_title() })));
    await act(async () => user.hover(within(window.document.body).getByText(m.contribute_edit())));
    const menuRelation = await waitFor(() =>
      within(window.document.body).getByRole('menuitem', { name: m.relation_title() }),
    );
    expect(menuRelation.getAttribute('href')).toBe(originHref);
    await navigate(menuRelation.getAttribute('href')!);
    await waitFor(() => expect(host.textContent).toContain('Subject heading'));
    const menuButton = within(host).getByRole('button', { name: m.relation_open() });
    expect(menuButton).toBeTruthy();

    holdSessionReads = true;
    await openEditor();
    await waitFor(() => expect(sessionReads).toHaveLength(1));
    const outerCounts = [rootReads.length, pageReads.length];
    await navigate(unsupportedHref);
    await waitFor(() => expect(host.textContent).toContain(m.relation_public_unsupported()));
    expect(rootReads).toHaveLength(outerCounts[0]!);
    expect(pageReads).toHaveLength(outerCounts[1]!);
    expect(sessionReads).toHaveLength(1);
    expect(host.querySelector('input,select')).toBeNull();
    await navigate(realmHref);
    await waitFor(() => expect(host.textContent).toContain(m.relation_public_unsupported()));
    expect(rootReads).toHaveLength(outerCounts[0]!);
    expect(pageReads).toHaveLength(outerCounts[1]!);
    expect(sessionReads).toHaveLength(1);

    await navigate(originHref);
    await openEditor();
    await waitFor(() => expect(sessionReads).toHaveLength(2));
    const current = structuredClone(relationRead);
    const stale = structuredClone(relationRead);
    current.fields[0]!.label = 'Current relation field';
    stale.fields[0]!.label = 'Stale relation field';
    await act(async () => pending[1]!(current));
    await waitFor(() => expect(host.textContent).toContain('Current relation field'));
    await act(async () => pending[0]!(stale));
    expect(host.textContent).toContain('Current relation field');
    expect(host.textContent).not.toContain('Stale relation field');

    await navigate(unsupportedHref);
    const fresh = host.querySelector<HTMLAnchorElement>('a[href*="publicReturn="]')?.getAttribute('href');
    expect(fresh).toBeTruthy();
    await navigate(fresh!);
    await waitFor(() => expect(host.textContent).toContain(m.relation_public_fresh_notice()));
    const returnLink = host.querySelector<HTMLAnchorElement>('a[href*="#connections"]');
    expect(returnLink?.getAttribute('href')).toBe(`${subjectPath}#connections`);
    expect(rootReads.length).toBeGreaterThan(outerCounts[0]!);
    expect(pageReads.length).toBeGreaterThan(outerCounts[1]!);

    canonicalSlug = 'current-harbor-slug';
    const loader = Route.options.loader as unknown as (input: {
      params: { id: string; slug: string };
      deps: { realm?: string };
      location: { searchStr: string; hash: string };
    }) => Promise<unknown>;
    const slugRepair = await loader({
      params: { id: subjectId, slug: 'old-harbor-slug' },
      deps: {},
      location: { searchStr: new URL(originHref, 'https://site.test').search, hash: '' },
    }).catch((error) => error);
    expect((slugRepair as { options?: { href?: string } }).options?.href).toContain('origin=');
    canonicalSlug = slug;
    canonicalId = otherId;
    const identityReplacement = await loader({
      params: { id: subjectId, slug },
      deps: {},
      location: { searchStr: new URL(originHref, 'https://site.test').search, hash: '' },
    }).catch((error) => error);
    expect((identityReplacement as { options?: { href?: string } }).options?.href).toContain('origin=!');
    canonicalId = subjectId;

    expect(
      parseRelationPublicVisit(new URL(originHref, 'https://site.test').search, subjectId, 'en', editPath).kind,
    ).toBe('origin');
  } finally {
    holdSessionReads = false;
    await act(async () => root.unmount());
    client.clear();
    setLocale(previousLocale, { reload: false });
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    window.happyDOM.abort();
  }
});
