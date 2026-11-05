import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';

const work = '00000000-0000-4000-8000-000000000931';
const other = '00000000-0000-4000-8000-000000000932';
const contextA = '00000000-0000-4000-8000-000000000933';
const contextB = '00000000-0000-4000-8000-000000000934';
const nativeReads: { data: { context?: string } }[] = [];

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/features/catalogue/quotation/actions', () => ({
  readSubjectQuotations: async ({ data }: { data: { context?: string } }) => {
    nativeReads.push({ data });
    return { ok: false as const, reason: 'unavailable' as const };
  },
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: `https://site.invalid/en/subjects/${work}/the-harbor` });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: window.matchMedia.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const { candidateContext } = await import('../src/subject/candidates');
const { sessionQuery } = await import('../src/session/query');
const { SubjectFrame } = await import('../src/features/pages/subject-frame');
const { SubjectExploreSlot } = await import('../src/features/pages/subject-slots');
const { viewTabLabels } = await import('../src/features/pages/route-support');
const { catalogueEntries } = await import('../src/features/catalogue/catalogue-entry');
const { Route: QuotationsRoute } = await import('../src/routes/subjects/$id_.$slug.quotations');

afterAll(async () => {
  await window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function slot(props: { subjectType?: string; context?: string; realm?: string; returnTo?: string; label?: string }) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <SubjectExploreSlot
      subjectId={work}
      subjectType={props.subjectType ?? 'schema:Book'}
      label={props.label ?? 'The Harbor'}
      locale="en"
      {...(props.context === undefined ? {} : { context: props.context })}
      {...(props.realm === undefined ? {} : { realm: props.realm })}
      {...(props.returnTo === undefined ? {} : { returnTo: props.returnTo })}
    />,
  );
  return host;
}

function link(host: HTMLElement, name: string): HTMLAnchorElement | undefined {
  return [...host.querySelectorAll('a')].find((item) => item.textContent?.trim() === name);
}

test('SubjectFrame carries its observed Context through the installed quotation route and keeps unsupported entry choices explicit', async () => {
  setLocale('en', { reload: false });
  nativeReads.length = 0;
  const origin = `/en/subjects/${work}/the-harbor/relations?context=${contextB}`;
  const acceptedOrigin = `${origin}#connections`;
  const rootRoute = createRootRoute({ component: Outlet });
  const sourceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/en/subjects/$id/$slug',
    component: () => (
      <SubjectFrame
        frame={{ id: work, type: 'schema:Book', context: contextA, title: { text: 'The Harbor' }, summary: null }}
        context={contextB}
        returnTo={origin}
        locale="en"
        unlabelled="Unlabelled subject"
        tabs={[]}
        tabLabels={viewTabLabels()}
        view="overview"
      />
    ),
  });
  QuotationsRoute.update({
    id: '/subjects/$id_/$slug/quotations',
    path: '/en/subjects/$id/$slug/quotations',
    getParentRoute: () => rootRoute,
  } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([sourceRoute, QuotationsRoute]),
    history: createMemoryHistory({ initialEntries: [`/en/subjects/${work}/the-harbor`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    const entry = link(host, m.quotation_title());
    expect(entry).toBeTruthy();
    const entryAddress = new URL(entry!.href);
    expect(entryAddress.pathname).toBe(`/en/subjects/${work}/the-harbor/quotations`);
    expect(entryAddress.searchParams.get('context')).toBe(contextB);
    expect(entryAddress.searchParams.get('returnTo')).toBe(acceptedOrigin);
    expect(entryAddress.searchParams.has('quote')).toBe(false);
    await act(async () => {
      await router.navigate({ href: entry!.getAttribute('href')! } as never);
    });
    await act(async () => {});
    expect(nativeReads.at(-1)?.data.context).toBe(contextB);
    await act(async () => {
      await router.navigate({ href: `${entryAddress.pathname}?context=${candidateContext}` } as never);
    });
    await act(async () => {});
    expect(nativeReads.at(-1)?.data.context).toBe(candidateContext);
    await act(async () => {
      await router.navigate({ href: entryAddress.pathname } as never);
    });
    await act(async () => {});
    expect(nativeReads.at(-1)?.data.context).toBe(candidateContext);

    const global = new URL(
      link(slot({ context: candidateContext }), m.quotation_title())!.href,
      window.location.origin,
    );
    expect(global.searchParams.get('context')).toBe(candidateContext);
    const legacy = new URL(link(slot({}), m.quotation_title())!.href, window.location.origin);
    expect(legacy.searchParams.has('context')).toBe(false);

    const malformed = slot({ context: 'not-a-context' });
    expect(malformed.querySelector('[role="status"]')?.textContent).toBe(m.quotation_entry_context_unsupported());
    expect(link(malformed, m.quotation_title())).toBeUndefined();
    expect(new URL(link(malformed, m.quotation_entry_general())!.href, window.location.origin).search).toBe('');

    const realm = slot({ context: contextB, realm: other });
    expect(realm.querySelector('[role="status"]')?.textContent).toBe(m.quotation_entry_realm_unsupported());
    expect(link(realm, m.quotation_title())).toBeUndefined();
    expect(new URL(link(realm, m.quotation_entry_general())!.href, window.location.origin).search).toBe('');

    const validOrigin = slot({ context: contextB, returnTo: origin });
    expect(
      new URL(link(validOrigin, m.quotation_title())!.href, window.location.origin).searchParams.get('returnTo'),
    ).toBe(acceptedOrigin);
    const conflictingOrigin = slot({ context: contextB, returnTo: `${origin.split('?')[0]}?context=${contextA}` });
    expect(conflictingOrigin.querySelector('[role="status"]')?.textContent).toBe(
      m.quotation_entry_origin_unsupported(),
    );
    expect(link(conflictingOrigin, m.quotation_title())).toBeUndefined();
    const wrongOrigin = slot({ returnTo: `/en/subjects/${other}/other/relations` });
    expect(wrongOrigin.querySelector('[role="status"]')?.textContent).toBe(m.quotation_entry_origin_unsupported());
    expect(link(wrongOrigin, m.quotation_title())).toBeUndefined();

    const concept = slot({ subjectType: 'skos:Concept' });
    expect(link(concept, m.graph_explore_title())).toBeTruthy();
    expect(link(concept, m.concept_explore_title())).toBeTruthy();
    expect(link(concept, m.quotation_title())).toBeUndefined();
    const music = slot({ subjectType: 'schema:Place' });
    expect(link(music, m.music_context_title())).toBeTruthy();
    expect(link(music, m.quotation_title())).toBeTruthy();
    expect(link(slot({ subjectType: 'schema:Quotation' }), m.quotation_title())).toBeTruthy();
    expect(link(slot({ subjectType: 'wd:Q95074' }), m.quotation_title())).toBeTruthy();

    const oversized = catalogueEntries.quotations({
      id: work,
      label: 'The Harbor',
      locale: 'en',
      returnTo: `/en/subjects/${work}/the-harbor/relations?note=${'漢'.repeat(400)}`,
    });
    expect('unsupported' in oversized ? oversized.unsupported : undefined).toBe('address');
    expect('generalHref' in oversized ? oversized.generalHref : undefined).toBeTruthy();
    const oversizedOrigin = catalogueEntries.quotations({
      id: work,
      label: 'The Harbor',
      locale: 'en',
      returnTo: `/en/subjects/${work}/the-harbor/relations?note=${'漢'.repeat(700)}`,
    });
    expect('unsupported' in oversizedOrigin ? oversizedOrigin.unsupported : undefined).toBe('origin');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
