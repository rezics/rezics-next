import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { candidateContext } from '../src/subject/candidates';
import { MangaProfileEntry } from '../src/features/catalogue/manga-profile-entry';
import { collectEditorialEntries } from '../src/features/catalogue/editorial-entry';
import { mangaGlobalVisitHref, mangaObservedOrigin, mangaPublicCorrectionHref, mangaPublicIntentFits,
  parseMangaPublicVisit, type MangaPublicOrigin } from '../src/features/catalogue/manga-public-visit';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const id = '00000000-0000-4000-8000-00000000d101';
const other = '00000000-0000-4000-8000-00000000d102';
const publicHref = `/en/subjects/${id}/comic`;
const base = `${publicHref}/manga`;
const origin: MangaPublicOrigin = { subject: id, type: 'schema:ComicSeries', context: candidateContext, returnHref: publicHref };
const parse = (href: string) => parseMangaPublicVisit(new URL(href, 'https://site.test').search, id, 'en', base);

test('actual Manga entry and contribution collector retain observed origin without reading producers or changing creation', () => {
  const entry = <MangaProfileEntry id={id} label="Comic" locale="en" origin={origin} />;
  const href = collectEditorialEntries(entry).entries[0]!.href;
  expect(renderToStaticMarkup(entry)).toContain('origin=');
  expect(parse(href)).toEqual({ kind: 'origin', origin });
  expect(renderToStaticMarkup(<MangaProfileEntry locale="en" />)).toContain('/en/catalogue/manga');
  expect(parse(base)).toBeUndefined();
});

test('HTTP origin admission rejects ambiguous, foreign, chained and encoded overbudget intent', () => {
  for (const value of [
    { ...origin, subject: other }, { ...origin, type: 'schema:Book' },
    { ...origin, context: 'invalid' }, { ...origin, assertion: other },
    { ...origin, returnHref: publicHref.replace('/en/', '/ja/') },
    { ...origin, returnHref: publicHref.replace(id, other) },
    { ...origin, returnHref: `https://site.test${publicHref}` },
    { ...origin, returnHref: `${publicHref}?via=${encodeURIComponent(publicHref)}` },
    { ...origin, returnHref: `${publicHref}?realm=${other}&realm=${other}` },
    { ...origin, returnHref: publicHref + '界'.repeat(700) },
  ]) expect(parse(`${base}?${new URLSearchParams({ origin: JSON.stringify(value) })}`)).toEqual({ kind: 'invalid' });
  const href = mangaPublicCorrectionHref(base, origin);
  for (const suffix of ['&origin=!', '&publicReturn=x', '&context=' + other, '#secret'])
    expect(parseMangaPublicVisit(new URL(href, 'https://site.test').search + suffix, id, 'en', base)).toEqual({ kind: 'invalid' });
  expect(parse(base + '?origin=%E0%A4%A')).toEqual({ kind: 'invalid' });
  expect(mangaPublicIntentFits('界'.repeat(700))).toBe(false);
  expect(mangaPublicIntentFits('x'.repeat(2048))).toBe(true);
  expect(mangaPublicCorrectionHref(base + '界'.repeat(180), origin)).toEndWith('?origin=!');
});

test('selected Context without Realm has honest unsupported exact return; deliberate Global keeps only compatible return', () => {
  const selected = mangaObservedOrigin({ ...origin, context: other });
  expect(selected.returnHref).toBeUndefined();
  expect(parse(mangaPublicCorrectionHref(base, selected))).toEqual({ kind: 'origin', origin: selected });
  const realm = { ...origin, context: other, realm: other, returnHref: `${publicHref}?realm=${other}` };
  expect(parse(mangaPublicCorrectionHref(base, realm))).toEqual({ kind: 'origin', origin: realm });
  const fresh = mangaGlobalVisitHref(id, 'en', realm.returnHref);
  expect(fresh).not.toContain('origin=');
  expect(parse(fresh)).toEqual({ kind: 'global', returnHref: realm.returnHref });
});

test('installed session refuses unsupported and malformed intent before mounting Global profile and nested transports', async () => {
  const { MangaProfileSession } = await import('../src/features/catalogue/manga-profile-session');
  const { m } = await import('../src/paraglide/messages');
  const client = new QueryClient();
  for (const visit of [parse(mangaPublicCorrectionHref(base, mangaObservedOrigin({ ...origin, context: other }))), { kind: 'invalid' } as const]) {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MangaProfileSession id={id} locale="en" visit={visit} /></QueryClientProvider>);
    expect(html).toContain('role="alert"');
    expect(html).toContain(m.manga_origin_global({}, { locale: 'en' }));
    expect(html).not.toContain('<input');
    expect(client.getQueryCache().getAll().filter(q => q.queryKey[0] === 'manga-profile')).toHaveLength(0);
  }
  client.clear();
});

test('mounted installed route and session retain canonical origin, acquire fresh Global reads and retire source/caller visits', async () => {
  const { createRequire } = await import('node:module');
  const { act, createContext, useContext } = await import('react');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test' + base });
  const names = 'window document navigator HTMLElement HTMLButtonElement HTMLInputElement HTMLSelectElement Element Node Document DocumentFragment ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame matchMedia IS_REACT_ACT_ENVIRONMENT'.split(' ');
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true,
    value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, name) });
  const { createRoot } = await import('react-dom/client');
  const { waitFor } = await import(createRequire(require.resolve('storybook/test')).resolve('@testing-library/dom'));
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
  const credentials = (csrfToken: string) => client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: other, csrfToken });
  credentials('first');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const Content = createContext<import('react').ReactNode>(null);
  const router = createRouter({ routeTree: createRootRoute({ component: () => useContext(Content) }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  const render = async (visit: ReturnType<typeof parse>) => act(async () => {
    root.render(<QueryClientProvider client={client}><Content.Provider value={<MangaProfileSession id={id} locale="en" visit={visit} />}><RouterProvider router={router} /></Content.Provider></QueryClientProvider>);
    await router.load();
  });
  const loader = Route.options.loader;
  if (typeof loader !== 'function') throw new Error('Missing canonical Manga loader');
  const href = mangaPublicCorrectionHref(base, origin);
  const load = (slug: string, search = new URL(href, window.location.origin).search) => loader({ params: { id, slug }, location: { searchStr: search, hash: '' } } as never);
  try {
    await expect(load('old-slug')).rejects.toMatchObject({ options: { statusCode: 301, href: expect.stringContaining('/the-paper-observatory/manga?origin=') } });
    expect(await load('the-paper-observatory')).toMatchObject({ id, visit: { kind: 'origin', origin } });
    await expect(load('x'.repeat(129))).rejects.toBeDefined();
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
    await act(async () => { credentials('second'); });
    await waitFor(() => expect(fixture.calls.length).toBeGreaterThan(beforeCredentials));
    const beforeReturn = fixture.calls.length;
    await act(async () => { credentials('first'); });
    await waitFor(() => expect(fixture.calls.length).toBeGreaterThan(beforeReturn));
    await render(parse(mangaPublicCorrectionHref(base, { ...origin, definition: 'sha256:' + 'f'.repeat(64) })));
    await waitFor(() => expect(host.textContent).toContain(m.manga_origin_changed()));
    expect(host.querySelector('input, select')).toBeNull();
    const fresh = host.querySelector<HTMLAnchorElement>('a[href*="publicReturn="]')!;
    expect(fresh).not.toBeNull();
    await render(parse(fresh.getAttribute('href')!));
    await waitFor(() => expect(host.textContent).toContain(m.manga_membership()));
    expect(fixture.calls.filter(call => call.method === 'POST')).toHaveLength(0);
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
});
