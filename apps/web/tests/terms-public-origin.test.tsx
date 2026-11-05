import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import * as start from '../.storybook/react-start';
import { catalogueTermsFixture, termsSubjectId } from '../src/kernel/fake/catalogue-terms';
import { candidateContext } from '../src/subject/candidates';
import { subjectHref } from '../src/subject/subject-href';
import {
  parseTermsPublicVisit,
  termsGlobalVisitHref,
  termsPublicCorrectionHref,
  termsPublicIntentFits,
  termsPublicVisitUnsupported,
  type TermsPublicOrigin,
} from '../src/features/catalogue/terms-public-visit';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const id = termsSubjectId;
const locale = 'en';
const label = 'Current film';
const unsupportedContext = '00000000-0000-4000-8000-00000000c099';
const realm = '00000000-0000-4000-8000-00000000c098';
const subject = subjectHref({ id, label }, locale).href;
const base = `${subject}/terms`;

function publicReturn(context = candidateContext, selectedRealm?: string) {
  const url = new URL(subject, 'https://rezics.invalid');
  url.searchParams.set('context', context);
  if (selectedRealm) url.searchParams.set('realm', selectedRealm);
  url.hash = 'connections';
  return `${url.pathname}${url.search}${url.hash}`;
}

function origin(context = candidateContext, selectedRealm?: string): TermsPublicOrigin {
  return {
    subject: id,
    context,
    ...(selectedRealm ? { realm: selectedRealm } : {}),
    locale,
    returnHref: publicReturn(context, selectedRealm),
  };
}

function searchOf(href: string) {
  return new URL(href, 'https://site.test').search;
}

test('Terms public origin admits one bounded observation and keeps legacy and Names returns distinct', () => {
  const observed = origin();
  const href = termsPublicCorrectionHref(base, id, locale, observed);
  const visit = parseTermsPublicVisit(searchOf(href), id, locale);
  expect(visit).toEqual({ kind: 'origin', origin: observed });
  expect(termsPublicVisitUnsupported(visit)).toBe(false);

  const names = `${observed.returnHref.slice(0, -'#connections'.length)}#supplied-names`;
  const via = `${searchOf(href)}&via=${encodeURIComponent(names)}`;
  expect(parseTermsPublicVisit(via, id, locale)).toMatchObject({ kind: 'origin', via: names });
  expect(parseTermsPublicVisit('', id, locale)).toEqual({ kind: 'legacy' });
  expect(parseTermsPublicVisit(`?via=${encodeURIComponent(names)}`, id, locale)).toEqual({ kind: 'legacy' });

  const unsupported = parseTermsPublicVisit(
    searchOf(termsPublicCorrectionHref(base, id, locale, origin(unsupportedContext))),
    id,
    locale,
  );
  expect(termsPublicVisitUnsupported(unsupported)).toBe(true);
  const realmVisit = parseTermsPublicVisit(
    searchOf(termsPublicCorrectionHref(base, id, locale, origin(candidateContext, realm))),
    id,
    locale,
  );
  expect(termsPublicVisitUnsupported(realmVisit)).toBe(true);

  const freshHref = termsGlobalVisitHref(base, id, locale, observed.returnHref, names);
  expect(parseTermsPublicVisit(searchOf(freshHref), id, locale)).toEqual({
    kind: 'fresh',
    returnHref: observed.returnHref,
    via: names,
  });
  expect(
    parseTermsPublicVisit(`${searchOf(href)}&publicReturn=${encodeURIComponent(observed.returnHref)}`, id, locale),
  ).toEqual({
    kind: 'invalid',
  });
  expect(parseTermsPublicVisit(`${searchOf(href)}&returnTo=changes`, id, locale)).toEqual({ kind: 'invalid' });
  expect(parseTermsPublicVisit(`${searchOf(href)}&origin=%7B%7D`, id, locale)).toEqual({ kind: 'invalid' });
  expect(parseTermsPublicVisit(searchOf(href), '00000000-0000-4000-8000-00000000c001', locale)).toEqual({
    kind: 'invalid',
  });
  expect(parseTermsPublicVisit(searchOf(href), id, 'ja')).toEqual({ kind: 'invalid' });

  const malformedRealm = termsPublicCorrectionHref(base, id, locale, { ...observed, realm: 'not-a-realm' });
  expect(parseTermsPublicVisit(searchOf(malformedRealm), id, locale)).toEqual({ kind: 'invalid' });
  expect(termsPublicIntentFits('x'.repeat(2048))).toBe(true);
  expect(termsPublicIntentFits(`${'界'.repeat(683)}`)).toBe(false);
  const longReturn = publicReturn(candidateContext).replace('/current-film', `/${'界'.repeat(250)}`);
  const overflow = termsPublicCorrectionHref(base, id, locale, { ...observed, returnHref: longReturn });
  expect(parseTermsPublicVisit(searchOf(overflow), id, locale)).toEqual({ kind: 'invalid' });
});

test('mounted public entry and menu gate the production Terms session until a deliberate Global visit', async () => {
  const termsReads: unknown[] = [];
  const authorityReads: unknown[] = [];
  const definitionReads: unknown[] = [];
  const fixture = catalogueTermsFixture('ready', locale);
  mock.module('../src/features/catalogue/subject-terms-actions', () => ({
    loadCatalogueTerms: async (input: unknown) => {
      termsReads.push(input);
      return fixture.transport.read(id);
    },
    readCatalogueTermsAuthority: async (input: unknown) => {
      authorityReads.push(input);
      return fixture.transport.readAuthority();
    },
    saveCatalogueTerms: async () => ({ ok: false }),
  }));
  mock.module('../src/features/catalogue/create-subject-actions', () => ({
    readCreateDefinitions: async (input: unknown) => {
      definitionReads.push(input);
      return { ok: true, types: [] };
    },
  }));

  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { SubjectTermsEntry } = await import('../src/features/catalogue/subject-terms-entry');
  const { EditorialEntry } = await import('../src/features/catalogue/editorial-entry');
  const { Route } = await import('../src/routes/subjects/$id_.$slug_.terms');
  const { sessionQuery } = await import('../src/session/query');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const testRequire = createRequire(import.meta.url);
  const storybookRequire = createRequire(testRequire.resolve('storybook/test'));
  const { within, waitFor } = await import(storybookRequire.resolve('@testing-library/dom'));
  const previousLocale = getLocale();
  setLocale(locale, { reload: false });

  const observed = origin();
  const directHref = termsPublicCorrectionHref(base, id, locale, observed);
  const unsupported = origin(unsupportedContext);
  const unsupportedHref = termsPublicCorrectionHref(base, id, locale, unsupported);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const reader = '00000000-0000-4000-8000-00000000c077';
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: 'csrf' });
  client.setQueryDefaults(sessionQuery.queryKey, { gcTime: Infinity });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <SubjectTermsEntry id={id} label={label} locale={locale} origin={observed} />
        <EditorialEntry id={id} label={label} locale={locale} context={candidateContext}>
          <SubjectTermsEntry id={id} label={label} locale={locale} origin={observed} />
        </EditorialEntry>
        <Outlet />
      </>
    ),
  });
  Route.update({
    id: '/subjects/$id_/$slug_/terms',
    path: '/subjects/$id/$slug/terms',
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([Route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async () =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await router.load();
    });
  const routeHref = (href: string) => {
    const url = new URL(href, window.location.origin);
    return `${url.pathname.replace(/^\/en(?=\/)/u, '')}${url.search}${url.hash}`;
  };
  const navigate = async (href: string) =>
    act(async () => {
      await router.navigate({ href: routeHref(href) });
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  try {
    await render();
    const direct = [...host.querySelectorAll<HTMLAnchorElement>('a[href*="/terms?origin="]')][0]!;
    expect(direct.getAttribute('href')).toBe(directHref);
    await act(async () => within(window.document.body).getByRole('button', { name: m.contribute_title() }).click());
    await act(async () => within(window.document.body).getByText(m.contribute_edit(), { exact: true }).click());
    const menuTerms = [...host.querySelectorAll<HTMLAnchorElement>('a[href*="/terms?origin="]')];
    expect(menuTerms.some((link) => link.getAttribute('href') === directHref)).toBe(true);

    const conflict = `${searchOf(directHref)}&publicReturn=${encodeURIComponent(observed.returnHref)}`;
    await navigate(`${base}${conflict}`);
    await waitFor(() => expect(host.textContent).toContain(m.subject_terms_public_invalid()));
    expect(termsReads).toHaveLength(0);
    expect(authorityReads).toHaveLength(0);
    expect(definitionReads).toHaveLength(0);

    await navigate(unsupportedHref);
    await waitFor(() => expect(host.textContent).toContain(m.subject_terms_public_unsupported()));
    expect(host.querySelector('input, textarea, fieldset')).toBeNull();
    expect(termsReads).toHaveLength(0);
    expect(authorityReads).toHaveLength(0);
    expect(definitionReads).toHaveLength(0);
    const publicReturnLink = within(host).getByRole('link', { name: m.subject_terms_public_return() });
    expect(publicReturnLink.getAttribute('href')).toBe(unsupported.returnHref);
    const freshLink = within(host).getByRole('link', { name: m.subject_terms_public_fresh_global() });
    await navigate(freshLink.getAttribute('href')!);
    await waitFor(() => expect(termsReads.length).toBeGreaterThan(0));
    expect((termsReads[0] as { data: { id: string } }).data.id).toBe(id);
    expect(authorityReads.length).toBeGreaterThan(0);
    expect(definitionReads.length).toBeGreaterThan(0);

    const readsAfterFresh = termsReads.length;
    await navigate(directHref);
    await waitFor(() => expect(termsReads.length).toBeGreaterThan(readsAfterFresh));
    expect(within(host).getByRole('link', { name: m.subject_terms_public_return() }).getAttribute('href')).toBe(
      observed.returnHref,
    );
    const readsAfterA = termsReads.length;
    await navigate(unsupportedHref);
    expect(termsReads).toHaveLength(readsAfterA);
    await navigate(directHref);
    await waitFor(() => expect(termsReads.length).toBeGreaterThan(readsAfterA));
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
