import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { candidateContext } from '../src/subject/candidates';
import { subjectHref } from '../src/subject/subject-href';
import {
  conceptPublicIntentFits,
  conceptPublicOriginHref,
  conceptPublicReturnHref,
  parseConceptPublicVisit,
  type ConceptPublicOrigin,
} from '../src/features/catalogue/source-concept-explorer/public-visit';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const id = '00000000-0000-4000-8000-00000000c101';
const other = '00000000-0000-4000-8000-00000000c102';
const routePath = `${subjectHref({ id, label: 'Protagonist' }, 'en').href}/concepts`;
const returnHref = `${subjectHref({ id, label: 'Protagonist' }, 'en').href}?context=${candidateContext}#connections`;
const origin: ConceptPublicOrigin = { subject: id, context: candidateContext, locale: 'en', returnHref };
const parse = (href: string, subject = id) => {
  const url = new URL(href, 'https://site.test');
  return parseConceptPublicVisit(url.search, subject, 'en', url.pathname, url.hash);
};
const reads: unknown[] = [];
mock.module('../src/features/catalogue/source-concept-explorer/actions', () => ({
  readSubjectConcept: mock((request: unknown) => {
    reads.push(request);
    return new Promise<never>(() => {});
  }),
}));
const subjectQueries = await import('../src/features/pages/subject-queries');
mock.module('../src/features/pages/subject-queries', () => ({
  ...subjectQueries,
  subjectReaderQuery: (_id: string, _locale: string, scope: { reader: string; admission: number }) => ({
    queryKey: ['concept-public-origin-reader', scope.reader, scope.admission],
    queryFn: async () => ({ reader: scope.reader, preferences: undefined }),
    retry: false,
  }),
}));

test('public entry and route admission retain only a bounded same-Subject observation and heading return', () => {
  const base = routePath;
  const href = catalogueEntries.concepts({
    id,
    label: 'Protagonist',
    locale: 'en',
    context: candidateContext,
    returnHref,
  }).href;
  expect(parse(href)).toEqual({ kind: 'origin', origin });
  expect(parse(base)).toBeUndefined();
  expect(parse(href, id)).toEqual({ kind: 'origin', origin });
  expect(
    parseConceptPublicVisit(
      new URL(href, 'https://site.test').search,
      id,
      'en',
      routePath.replace('/protagonist/', '/old-label/'),
    ),
  ).toEqual({ kind: 'origin', origin });
  expect(parse(href, other)).toEqual({ kind: 'invalid' });
  expect(parse(href.replace('/en/', '/ja/'))).toEqual({ kind: 'invalid' });
  const nestedReturn = new URL(returnHref, 'https://site.test');
  nestedReturn.searchParams.set('via', returnHref);
  const duplicateReturn = `${returnHref.replace('#connections', '')}&context=${candidateContext}#connections`;
  for (const bad of [
    `${href}&origin=!`,
    `${href}&publicReturn=${encodeURIComponent(returnHref)}`,
    `${base}?context=${candidateContext}`,
    conceptPublicOriginHref(base, {
      ...origin,
      returnHref: `${nestedReturn.pathname}${nestedReturn.search}#connections`,
    }),
    conceptPublicOriginHref(base, { ...origin, returnHref: duplicateReturn }),
    conceptPublicOriginHref(base, { ...origin, returnHref: returnHref.replace(id, other) }),
    conceptPublicOriginHref(base, { ...origin, context: other }),
  ])
    expect(parse(bad)).toEqual({ kind: 'invalid' });
  expect(parse(`${href}&returnTo=${encodeURIComponent(returnHref)}`)).toMatchObject({
    kind: 'unsupported',
    reason: 'return',
  });
  const utf8Return = `/en/subjects/${id}/${'界'.repeat(450)}?context=${candidateContext}#connections`;
  expect(conceptPublicIntentFits(utf8Return)).toBe(true);
  expect(parse(conceptPublicOriginHref(base, { ...origin, returnHref: utf8Return }))).toEqual({ kind: 'invalid' });
  const realmReturn = conceptPublicReturnHref(
    subjectHref({ id, label: 'Protagonist' }, 'en').href,
    id,
    'en',
    candidateContext,
    other,
  )!;
  const realmVisit = parse(conceptPublicOriginHref(base, { ...origin, realm: other, returnHref: realmReturn }));
  expect(realmVisit).toMatchObject({ kind: 'unsupported', reason: 'realm' });
});

test('production route admits public scope before the original session transport mounts', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.test${routePath}`, width: 390 });
  const names =
    'window document navigator HTMLElement HTMLButtonElement HTMLInputElement HTMLSelectElement HTMLFormElement Element Node Document DocumentFragment ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame scrollTo matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
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
  const { within, waitFor } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/dom')
  );
  const { SubjectExploreSlot } = await import('../src/features/pages/subject-slots');
  const { Route } = await import('../src/routes/subjects/$id_.$slug.concepts');
  const { SourceConceptPublicSession } = await import('../src/features/catalogue/source-concept-explorer/session');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const { m } = await import('../src/paraglide/messages');
  const { sessionQuery, useSession } = await import('../src/session/query');
  function SessionShell() {
    const session = useSession();
    return <span hidden data-session-state={session.state} />;
  }
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async (node: ReactNode) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SessionShell />
          {node}
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
  const loader = Route.options.loader;
  if (typeof loader !== 'function') throw new Error('Expected production Concept route loader');
  const load = (href: string, routeId = id) => {
    const url = new URL(href, window.location.origin);
    return loader({
      params: { id: routeId, slug: 'protagonist' },
      location: { pathname: url.pathname, searchStr: url.search, hash: url.hash },
    } as never);
  };
  try {
    const admittedReturn = conceptPublicReturnHref(
      subjectHref({ id, label: 'Protagonist' }, 'en').href,
      id,
      'en',
      candidateContext,
    )!;
    await render(
      <SubjectExploreSlot
        subjectId={id}
        subjectType="skos:Concept"
        label="Protagonist"
        locale="en"
        context={candidateContext}
        publicReturnHref={admittedReturn}
      />,
    );
    const entry = within(host).getByRole('link', { name: m.concept_explore_title() });
    const observedHref = entry.getAttribute('href')!;
    const observed = await load(observedHref);
    expect(observed.publicVisit).toEqual({ kind: 'origin', origin });
    const nonGlobalReturn = conceptPublicReturnHref(
      subjectHref({ id, label: 'Protagonist' }, 'en').href,
      id,
      'en',
      other,
    )!;
    const unsupported = await load(
      catalogueEntries.concepts({ id, label: 'Protagonist', locale: 'en', context: other, returnHref: nonGlobalReturn })
        .href,
    );
    await render(
      <SourceConceptPublicSession id={id} locale="en" pathname={routePath} publicVisit={unsupported.publicVisit} />,
    );
    expect(host.textContent).toContain(m.concept_public_origin_context_unsupported());
    expect(reads).toHaveLength(0);
    const freshHref = within(host).getByRole('link', { name: m.concept_public_origin_global() }).getAttribute('href')!;
    const freshUrl = new URL(freshHref, window.location.origin);
    expect([...freshUrl.searchParams.keys()]).toEqual(['publicReturn']);
    const fresh = await load(freshHref);
    expect(fresh.publicVisit).toEqual({ kind: 'global', returnHref: nonGlobalReturn });
    await render(
      <SourceConceptPublicSession id={id} locale="en" pathname={routePath} publicVisit={fresh.publicVisit} />,
    );
    await waitFor(() => expect(reads.length, 'fresh Global read').toBeGreaterThan(0));
    expect((reads[0] as { data: { id: string; expectedReader: string | null } }).data).toMatchObject({
      id,
      expectedReader: null,
    });
    expect(within(host).getByRole('link', { name: m.concept_public_origin_return() }).getAttribute('href')).toBe(
      nonGlobalReturn,
    );

    const signedInReader = '00000000-0000-4000-8000-00000000c103';
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: signedInReader, csrfToken: 'first' }),
    );
    await waitFor(() =>
      expect(
        reads.some(
          (request) => (request as { data: { expectedReader: string | null } }).data.expectedReader === signedInReader,
        ),
      ).toBe(true),
    );
    const signedInReadCount = reads.length;

    await render(
      <SourceConceptPublicSession id={id} locale="en" pathname={routePath} publicVisit={observed.publicVisit} />,
    );
    await waitFor(() => expect(reads.length, 'observed Global Concept read').toBeGreaterThan(signedInReadCount));
    const returnedReadCount = reads.length;
    expect(within(host).getByRole('link', { name: m.concept_public_origin_return() }).getAttribute('href')).toBe(
      returnHref,
    );
    const realmReturn = conceptPublicReturnHref(
      subjectHref({ id, label: 'Protagonist' }, 'en').href,
      id,
      'en',
      candidateContext,
      other,
    )!;
    const realm = await load(
      catalogueEntries.concepts({
        id,
        label: 'Protagonist',
        locale: 'en',
        context: candidateContext,
        realm: other,
        returnHref: realmReturn,
      }).href,
    );
    await render(
      <SourceConceptPublicSession id={id} locale="en" pathname={routePath} publicVisit={realm.publicVisit} />,
    );
    expect(host.textContent).toContain(m.concept_public_origin_realm_unsupported());
    expect(reads).toHaveLength(returnedReadCount);
    const changedIdentity = await load(observedHref, other);
    expect(changedIdentity.publicVisit).toEqual({ kind: 'invalid' });
    await render(
      <SourceConceptPublicSession id={id} locale="en" pathname={routePath} publicVisit={{ kind: 'invalid' }} />,
    );
    expect(host.textContent).toContain(m.concept_public_origin_invalid());
    expect(reads).toHaveLength(returnedReadCount);
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    client.clear();
    setLocale(previousLocale, { reload: false });
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    window.close();
  }
});
