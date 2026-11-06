import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { candidateContext } from '../src/subject/candidates';
import {
  mangaGlobalVisitHref,
  mangaObservedOrigin,
  mangaPublicCorrectionHref,
  mangaPublicIntentFits,
  parseMangaPublicVisit,
  type MangaPublicOrigin,
} from '../src/features/catalogue/manga-public-visit';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const id = '00000000-0000-4000-8000-00000000d101';
const other = '00000000-0000-4000-8000-00000000d102';
const publicHref = `/en/subjects/${id}/comic`;
const base = `${publicHref}/manga`;
const origin: MangaPublicOrigin = {
  subject: id,
  type: 'schema:ComicSeries',
  context: candidateContext,
  returnHref: publicHref,
};
const parse = (href: string) => parseMangaPublicVisit(new URL(href, 'https://site.test').search, id, 'en', base);

test('actual Manga entry and contribution collector retain observed origin without reading producers or changing creation', async () => {
  const { catalogueEntries } = await import('../src/features/catalogue/catalogue-entry');
  const href = catalogueEntries.manga({ id, label: 'Comic', locale: 'en', origin }).href;
  expect(parse(href)).toEqual({ kind: 'origin', origin });
  expect(catalogueEntries.manga({ locale: 'en' }).href).toBe('/en/catalogue/manga');
  expect(parse(base)).toBeUndefined();
});

test('HTTP origin admission rejects ambiguous, foreign, chained and encoded overbudget intent', () => {
  for (const value of [
    { ...origin, subject: other },
    { ...origin, type: 'schema:Book' },
    { ...origin, context: 'invalid' },
    { ...origin, assertion: other },
    { ...origin, returnHref: publicHref.replace('/en/', '/ja/') },
    { ...origin, returnHref: publicHref.replace(id, other) },
    { ...origin, returnHref: `https://site.test${publicHref}` },
    { ...origin, returnHref: `${publicHref}?via=${encodeURIComponent(publicHref)}` },
    { ...origin, returnHref: `${publicHref}?realm=${other}&realm=${other}` },
    { ...origin, returnHref: publicHref + '界'.repeat(700) },
  ])
    expect(parse(`${base}?${new URLSearchParams({ origin: JSON.stringify(value) })}`)).toEqual({ kind: 'invalid' });
  const href = mangaPublicCorrectionHref(base, origin);
  for (const suffix of ['&origin=!', '&publicReturn=x', '&context=' + other, '#secret'])
    expect(parseMangaPublicVisit(new URL(href, 'https://site.test').search + suffix, id, 'en', base)).toEqual({
      kind: 'invalid',
    });
  expect(parse(base + '?origin=%E0%A4%A')).toEqual({ kind: 'invalid' });
  expect(mangaPublicIntentFits('界'.repeat(700))).toBe(false);
  expect(mangaPublicIntentFits('x'.repeat(2048))).toBe(true);
  expect(mangaPublicCorrectionHref(base + '界'.repeat(220), origin)).toEndWith('?origin=!');
});

test('selected Context without Realm has honest unsupported exact return; deliberate Global keeps only compatible return', () => {
  const selected = mangaObservedOrigin({ ...origin, context: other });
  expect(selected.returnHref).toBeUndefined();
  expect(parse(mangaPublicCorrectionHref(base, selected))).toEqual({ kind: 'origin', origin: selected });
  const realm = { ...origin, context: other, realm: other, returnHref: `${publicHref}?realm=${other}` };
  expect(parse(mangaPublicCorrectionHref(base, realm))).toEqual({ kind: 'origin', origin: realm });
  const japanese = mangaObservedOrigin({
    ...origin,
    returnHref: publicHref.replace('comic', '紙の天文台') + '#manga-reader',
  });
  expect(parse(mangaPublicCorrectionHref(base, japanese))).toEqual({ kind: 'origin', origin: japanese });
  const fresh = mangaGlobalVisitHref(id, 'en', realm.returnHref);
  expect(fresh).not.toContain('origin=');
  expect(parse(fresh)).toEqual({ kind: 'global', returnHref: realm.returnHref });
});

test('mounted installed route and session retain canonical origin, acquire fresh Global reads and retire source/caller visits', async () => {
  const { createRequire } = await import('node:module');
  const { act, createContext, useContext } = await import('react');
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
  const { createRoot } = await import('react-dom/client');
  const { waitFor: waitForCondition, within } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/dom')
  );
  // Route transitions and native reads settle after the default second on a loaded check host.
  const waitFor = (callback: () => unknown) => waitForCondition(callback, { timeout: 8000 });
  const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
  const { mangaFixture } = await import('../src/kernel/fake/catalogue-manga-profile');
  const fixture = mangaFixture();
  const kernel = await import('../src/kernel/client');
  const originalKernel = { ...kernel };
  mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => fixture.client }));
  const { MangaProfileSession } = await import('../src/features/catalogue/manga-profile-session');
  const { Route } = await import('../src/routes/subjects/$id_.$slug_.manga');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages');
  const { setLocale } = await import('../src/paraglide/runtime');
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const credentials = (csrfToken: string) =>
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: other, csrfToken });
  client.setQueryDefaults(sessionQuery.queryKey, { gcTime: Infinity });
  credentials('first');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const Content = createContext<import('react').ReactNode>(null);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => useContext(Content) }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const renderNode = async (node: import('react').ReactNode) =>
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
  const render = (visit: ReturnType<typeof parse>) =>
    renderNode(<MangaProfileSession id={id} locale="en" visit={visit} />);
  const loader = Route.options.loader;
  if (typeof loader !== 'function') throw new Error('Missing canonical Manga loader');
  const href = mangaPublicCorrectionHref(base, origin);
  const load = async (slug: string, search = new URL(href, window.location.origin).search) =>
    loader({ params: { id, slug }, location: { searchStr: search, hash: '' } } as never);
  try {
    const { MangaProfileEntry } = await import('../src/features/catalogue/manga-profile-entry');
    const { collectEditorialEntries } = await import('../src/features/catalogue/editorial-entry');
    await renderNode(<MangaProfileEntry id={id} label="Comic" locale="en" origin={origin} />);
    expect(host.querySelector('a')!.getAttribute('href')).toBe(href);
    expect(
      collectEditorialEntries(<MangaProfileEntry id={id} label="Comic" locale="en" origin={origin} />).entries[0]!.href,
    ).toBe(href);
    for (const visit of [
      parse(mangaPublicCorrectionHref(base, mangaObservedOrigin({ ...origin, context: other }))),
      parse(mangaPublicCorrectionHref(base, { ...origin, realm: other, returnHref: `${publicHref}?realm=${other}` })),
      { kind: 'invalid' } as const,
    ]) {
      await render(visit);
      expect(host.textContent).toContain(m.manga_origin_global());
      expect(host.querySelector('input,select')).toBeNull();
      expect(fixture.calls).toHaveLength(0);
    }
    const { SubjectPage, pageContext } = await import('../src/features/pages/subject');
    const { subjectPageMessages } = await import('../src/features/pages/route-support');
    const { planReads, platformRegistry } = await import('@rezics/composition');
    const recorded = await import('../src/kernel/recorded/subject-page.json');
    for (const subjectId of [id, other]) {
      const read = fixture.reads.get(subjectId)!;
      const page = structuredClone(
        recorded.default,
      ) as unknown as import('../src/features/pages/subject').SubjectPageData;
      page.subject = subjectId;
      page.catalogue = {
        state: 'released',
        type: read.subject.type,
        digest: read.subject.release,
        definitions: fixture.release,
      };
      const plan = planReads(
        platformRegistry,
        page.document as import('@rezics/composition').CompositionDocument,
        pageContext(page),
      );
      for (const [key, planned] of Object.entries(plan.reads))
        if (planned.kind === 'subject' && planned.id === subjectId)
          page.reads[key] = { status: 200, body: structuredClone(read) };
      await renderNode(<SubjectPage page={page} locale="en" messages={subjectPageMessages()} renderJsonLd={false} />);
      await act(async () => within(window.document.body).getByRole('button', { name: m.contribute_title() }).click());
      // The collector consumes the real action slot; open its edit group to inspect the actual producer.
      // The menu mounts after its open effects, which a loaded host may finish after the click returns.
      await waitFor(() => within(window.document.body).getByText(m.contribute_edit(), { exact: true }));
      await act(async () => within(window.document.body).getByText(m.contribute_edit(), { exact: true }).click());
      const actual = window.document.querySelector<HTMLAnchorElement>('a[href*="/manga?origin="]');
      expect(actual).not.toBeNull();
      const address = new URL(actual!.getAttribute('href')!, window.location.origin);
      expect(parseMangaPublicVisit(address.search, subjectId, 'en', address.pathname)).toMatchObject({
        kind: 'origin',
        origin: { subject: subjectId, type: read.subject.type, context: read.subject.context },
      });
    }
    await expect(load('old-slug')).rejects.toMatchObject({
      options: { statusCode: 301, href: expect.stringContaining('/the-paper-observatory/manga?origin=') },
    });
    expect(await load('the-paper-observatory')).toMatchObject({ id, visit: { kind: 'origin', origin } });
    await expect(load('x'.repeat(129))).rejects.toBeDefined();
    fixture.reads.get(id)!.subject.id = other;
    await expect(load('the-paper-observatory')).rejects.toMatchObject({
      options: { href: expect.stringContaining(`/subjects/${other}/the-paper-observatory/manga?origin=!`) },
    });
    fixture.reads.get(id)!.subject.id = id;
    await render(parse(href));
    await waitFor(() => expect(host.textContent).toContain(m.manga_membership()));
    const reads = fixture.calls.length;
    await render(parse(mangaPublicCorrectionHref(base, mangaObservedOrigin({ ...origin, context: other }))));
    expect(host.textContent).toContain(m.manga_origin_unsupported());
    expect(fixture.calls).toHaveLength(reads);
    expect(host.querySelector('input, select')).toBeNull();
    await render(parse(href));
    await waitFor(() => expect(fixture.calls.length).toBeGreaterThan(reads));
    const beforeCredentials = fixture.calls.length;
    await act(async () => {
      credentials('second');
    });
    await waitFor(() => expect(fixture.calls.length).toBeGreaterThan(beforeCredentials));
    const beforeReturn = fixture.calls.length;
    await act(async () => {
      credentials('first');
    });
    await waitFor(() => expect(fixture.calls.length).toBeGreaterThan(beforeReturn));
    await render(parse(mangaPublicCorrectionHref(base, { ...origin, definition: 'sha256:' + 'f'.repeat(64) })));
    await waitFor(() => expect(host.textContent).toContain(m.manga_origin_changed()));
    expect(host.querySelector('input, select')).toBeNull();
    const fresh = host.querySelector<HTMLAnchorElement>('a[href*="publicReturn="]')!;
    expect(fresh).not.toBeNull();
    await render(parse(fresh.getAttribute('href')!));
    await waitFor(() => expect(host.textContent).toContain(m.manga_membership()));
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.module('../src/kernel/client', () => originalKernel);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    window.happyDOM.abort();
  }
}, 30_000);
