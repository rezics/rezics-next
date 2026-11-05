import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createContext, useContext, type ReactNode } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { addonProfileFixture, addonProfileId, addonWorkId } from '../src/kernel/fake/catalogue-addon-profile';
import { subjectFactsFixture } from '../src/kernel/fake/subject-facts';
import {
  factsGlobalVisitHref,
  factsPublicCorrectionHref,
  factsPublicIntentFits,
  factsPublicVisitUnsupported,
  parseFactsPublicVisit,
  type FactsPublicOrigin,
} from '../src/features/catalogue/facts-public-visit';
import { SubjectFactsEntry } from '../src/features/catalogue/subject-facts-entry';
import { subjectHref } from '../src/subject/subject-href';
import { candidateContext } from '../src/subject/candidates';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const label = 'Harbor: Northern lights';
const base = `${subjectHref({ id: addonProfileId, label }, 'en').href}/edit`;
const publicHref = subjectHref({ id: addonProfileId, label }, 'en').href;
const observed: FactsPublicOrigin = {
  subject: addonProfileId,
  context: candidateContext,
  returnHref: publicHref,
};

test('Facts public visits keep the address closed and leave exact-review search under its existing owner', () => {
  const href = factsPublicCorrectionHref(base, addonProfileId, 'en', observed);
  const visit = parseFactsPublicVisit(new URL(href, 'https://site.test').search, addonProfileId, 'en', base);
  expect(visit).toEqual({ kind: 'origin', origin: { ...observed, returnHref: `${publicHref}#connections` } });
  expect(factsPublicVisitUnsupported(visit)).toBe(false);
  const normalizedOrigin = { ...observed, returnHref: `${publicHref}#connections` };
  const routerEncodedOrigin = `${base}?${new URLSearchParams({
    origin: JSON.stringify(JSON.stringify(normalizedOrigin)),
  })}`;
  expect(
    parseFactsPublicVisit(new URL(routerEncodedOrigin, 'https://site.test').search, addonProfileId, 'en', base),
  ).toEqual(visit);

  const realmOrigin = {
    ...observed,
    realm: addonWorkId,
    returnHref: `${publicHref}?realm=${addonWorkId}`,
  };
  const realmHref = factsPublicCorrectionHref(base, addonProfileId, 'en', realmOrigin);
  const realmVisit = parseFactsPublicVisit(new URL(realmHref, 'https://site.test').search, addonProfileId, 'en', base);
  expect(factsPublicVisitUnsupported(realmVisit)).toBe(true);
  const freshHref = factsGlobalVisitHref(
    base,
    addonProfileId,
    'en',
    realmVisit.kind === 'origin' ? realmVisit.origin.returnHref : '',
  );
  expect(parseFactsPublicVisit(new URL(freshHref, 'https://site.test').search, addonProfileId, 'en', base)).toEqual({
    kind: 'fresh',
    returnHref: `${publicHref}?realm=${addonWorkId}#connections`,
  });

  const exact = `?reviewProperty=schema%3Aabstract&candidate=${addonWorkId}&context=${addonWorkId}&returnTo=queue`;
  expect(parseFactsPublicVisit(exact, addonProfileId, 'en', base)).toEqual({ kind: 'legacy' });
  const withReview = `${new URL(href, 'https://site.test').search}&context=${addonWorkId}`;
  expect(parseFactsPublicVisit(withReview, addonProfileId, 'en', base)).toEqual({ kind: 'invalid' });
  for (const returnHref of [
    'https://site.test' + publicHref,
    publicHref.replace('/en/', '/ja/'),
    publicHref.replace(addonProfileId, addonWorkId),
    `${publicHref}?via=${encodeURIComponent(publicHref)}`,
    `${publicHref}?realm=${addonProfileId}`,
    `${publicHref}#facts-field-schema%3Aname`,
    `${publicHref}${'界'.repeat(700)}`,
  ]) {
    const invalidHref = factsPublicCorrectionHref(base, addonProfileId, 'en', { ...observed, returnHref });
    expect(parseFactsPublicVisit(new URL(invalidHref, 'https://site.test').search, addonProfileId, 'en', base)).toEqual(
      {
        kind: 'invalid',
      },
    );
  }
  expect(
    parseFactsPublicVisit(new URL(href, 'https://site.test').search + '&origin=!', addonProfileId, 'en', base),
  ).toEqual({
    kind: 'invalid',
  });
  expect(parseFactsPublicVisit('?origin%ZZ=!', addonProfileId, 'en', base)).toEqual({ kind: 'invalid' });
  expect(parseFactsPublicVisit('?origin=%E0%A4%A', addonProfileId, 'en', base)).toEqual({ kind: 'invalid' });
  expect(parseFactsPublicVisit(`?origin=${'x'.repeat(2100)}`, addonProfileId, 'en', base)).toEqual({ kind: 'invalid' });
  expect(factsPublicIntentFits('x'.repeat(2048))).toBe(true);
  expect(factsPublicIntentFits('x'.repeat(2049))).toBe(false);
  expect(factsPublicIntentFits('界'.repeat(700))).toBe(false);
});

test('mounted entry, editorial menu and installed Facts route guard retain and retire only the public origin', async () => {
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
  const { waitFor } = await import(createRequire(require.resolve('storybook/test')).resolve('@testing-library/dom'));
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });

  const profile = addonProfileFixture();
  const kernel = await import('../src/kernel/client');
  const originalKernel = { ...kernel };
  mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => profile.client }));
  const originalActions = await import('../src/features/catalogue/statement-editor-actions');
  const facts = await subjectFactsFixture('ready', 'en').transport.read();
  if (!facts.ok) throw new Error('Expected typed Facts fixture');
  facts.public.subject.id = addonProfileId;
  const correctionReads: unknown[] = [];
  const deferred: Array<() => void> = [];
  let holdReads = false;
  const currentFacts = () => structuredClone(facts);
  mock.module('../src/features/catalogue/statement-editor-actions', () => ({
    ...originalActions,
    readCorrection: async (input: unknown) => {
      correctionReads.push(input);
      if (holdReads) return new Promise((resolve) => deferred.push(() => resolve(currentFacts())));
      return currentFacts();
    },
  }));

  const { Route } = await import('../src/routes/subjects/$id_.$slug_.edit');
  const { collectEditorialEntries, contributionMenu } = await import('../src/features/catalogue/editorial-entry');
  const { sessionQuery } = await import('../src/session/query');
  const { QueryClient: Client } = await import('@tanstack/react-query');
  const client = new Client({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const reader = '00000000-0000-4000-8000-00000000f101';
  const credentials = (csrfToken: string) =>
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken });
  client.setQueryDefaults(sessionQuery.queryKey, { gcTime: Infinity });
  credentials('first');

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
    id: '/subjects/$id_/$slug_/edit',
    path: '/subjects/$id/$slug/edit',
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
    const search = Object.fromEntries(url.searchParams.entries());
    await act(async () =>
      router.navigate({
        to: '/subjects/$id/$slug/edit',
        params: { id: addonProfileId, slug: 'harbor-northern-lights' },
        search,
      } as never),
    );
  };
  const originHref = factsPublicCorrectionHref(base, addonProfileId, 'en', observed);
  const unsupported = factsPublicCorrectionHref(base, addonProfileId, 'en', { ...observed, context: addonWorkId });
  const realmHref = factsPublicCorrectionHref(base, addonProfileId, 'en', {
    ...observed,
    realm: addonWorkId,
    returnHref: `${publicHref}?realm=${addonWorkId}`,
  });
  const loader = Route.options.loader as unknown as (input: {
    params: { id: string; slug: string };
    location: { searchStr: string; hash: string };
  }) => Promise<unknown>;
  const load = (slug: string, href: string) =>
    loader({
      params: { id: addonProfileId, slug },
      location: { searchStr: new URL(href, 'https://site.test').search, hash: '' },
    });

  try {
    const direct = <SubjectFactsEntry id={addonProfileId} label={label} locale="en" origin={observed} />;
    await renderNode(direct);
    expect(host.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(originHref);
    const collected = collectEditorialEntries(direct).entries;
    expect(collected[0]?.href).toBe(originHref);
    const editGroup = contributionMenu(collected, 'en', false).find(
      (entry) => entry.type === 'submenu' && entry.label === m.contribute_edit(),
    );
    expect(editGroup?.type === 'submenu' ? editGroup.entries[0]?.href : undefined).toBe(originHref);
    const directUnsupported = await load(
      'harbor-northern-lights',
      factsPublicCorrectionHref(base, addonProfileId, 'en', { ...observed, context: addonWorkId }),
    );
    expect(directUnsupported).toMatchObject({ visit: { kind: 'origin', origin: { context: addonWorkId } } });
    expect(
      parseFactsPublicVisit(new URL(collected[0]!.href, 'https://site.test').search, addonProfileId, 'en', base),
    ).toMatchObject({ kind: 'origin', origin: { subject: addonProfileId, context: candidateContext } });

    const visitValidator = Route.options.validateSearch as (input: Record<string, unknown>) => Record<string, unknown>;
    expect(
      visitValidator({
        reviewProperty: 'schema:abstract',
        candidate: addonWorkId,
        context: addonWorkId,
        returnTo: 'queue',
      }),
    ).toMatchObject({
      reviewProperty: 'schema:abstract',
      candidate: addonWorkId,
      context: addonWorkId,
      returnTo: 'queue',
    });
    expect(visitValidator({ origin: 'untrusted-raw-origin' })).toMatchObject({ origin: 'untrusted-raw-origin' });
    const changesReview = visitValidator({
      reviewProperty: 'schema:abstract',
      candidate: addonWorkId,
      context: addonWorkId,
      returnTo: 'changes',
    });
    expect(changesReview).toMatchObject({ returnTo: 'changes' });
    expect(changesReview.reviewInvalid).toBeFalsy();
    expect(visitValidator({ property: 'schema:abstract', returnTo: 'sources' })).toMatchObject({ returnTo: 'sources' });
    const visitLoaderDeps = Route.options.loaderDeps as (input: { search: Record<string, unknown> }) => unknown;
    expect(
      visitLoaderDeps({ search: { origin: 'observed', publicReturn: '/en/subjects/example#connections' } }),
    ).toEqual({
      origin: 'observed',
      publicReturn: '/en/subjects/example#connections',
    });

    await load('harbor-northern-lights', originHref);
    const canonicalRedirect = await load('stale-slug', originHref).then(
      () => undefined,
      (error) => error,
    );
    const redirectHref = (canonicalRedirect as { options?: { href?: string } } | undefined)?.options?.href;
    expect(redirectHref).toContain('origin=!');
    expect(
      parseFactsPublicVisit(new URL(redirectHref!, 'https://site.test').search, addonProfileId, 'en', base),
    ).toEqual({ kind: 'invalid' });

    await navigate(unsupported);
    await waitFor(() => expect(host.textContent).toContain(m.facts_public_unsupported()));
    expect(correctionReads).toHaveLength(0);
    expect(host.querySelector('input,select')).toBeNull();
    await navigate(realmHref);
    await waitFor(() => expect(host.textContent).toContain(m.facts_public_unsupported()));
    expect(correctionReads).toHaveLength(0);

    const fresh = host.querySelector<HTMLAnchorElement>('a[href*="publicReturn="]')?.getAttribute('href');
    expect(fresh).toBeTruthy();
    expect(parseFactsPublicVisit(new URL(fresh!, 'https://site.test').search, addonProfileId, 'en', base).kind).toBe(
      'fresh',
    );
    await navigate(fresh!);
    expect(router.state.location.searchStr).toBe(new URL(fresh!, 'https://site.test').search);
    await waitFor(() => expect(correctionReads.length).toBeGreaterThan(0));
    expect(host.textContent).toContain(m.facts_public_fresh_notice());
    await waitFor(() => expect(host.querySelector('input,select')).not.toBeNull());

    await navigate(`${base}?origin=!`);
    await waitFor(() => expect(host.textContent).toContain(m.facts_public_invalid()));
    const beforeMalformed = correctionReads.length;
    expect(host.querySelector('input,select')).toBeNull();
    expect(correctionReads).toHaveLength(beforeMalformed);
    await navigate(`${base}?origin=${'x'.repeat(2100)}`);
    await waitFor(() => expect(host.textContent).toContain(m.facts_public_invalid()));
    expect(correctionReads).toHaveLength(beforeMalformed);

    holdReads = true;
    const beforeABA = correctionReads.length;
    await navigate(originHref);
    await waitFor(() => expect(deferred.length).toBe(1));
    await navigate(unsupported);
    await navigate(originHref);
    await waitFor(() => expect(deferred.length).toBe(2));
    await act(async () => deferred[1]!());
    await waitFor(() => expect(host.querySelector('input,select')).not.toBeNull());
    await act(async () => deferred[0]!());
    expect(correctionReads.length).toBe(beforeABA + 2);
    expect(host.querySelector('input,select')).not.toBeNull();

    holdReads = false;
    const beforeCredentialChange = correctionReads.length;
    await act(async () => credentials('second'));
    await waitFor(() => expect(correctionReads.length).toBeGreaterThan(beforeCredentialChange));
    const returnLink = host.querySelector<HTMLAnchorElement>('a[href*="#connections"]');
    expect(returnLink).not.toBeNull();
    expect(returnLink!.getAttribute('href')).toBe(`${publicHref}#connections`);
    expect(new URL(returnLink!.href).searchParams.toString()).toBe('');
    returnLink!.focus();
    expect(window.document.activeElement).toBe(returnLink);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(previousLocale, { reload: false });
    mock.module('../src/kernel/client', () => originalKernel);
    mock.module('../src/features/catalogue/statement-editor-actions', () => originalActions);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    window.happyDOM.abort();
  }
});
