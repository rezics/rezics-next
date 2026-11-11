import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { PersonalLibraryEntry, LibraryMutationResult } from '../src/library/entries-read';
import type { PersonalLibraryCurrentRead } from '../src/library/personal-library-server';
import type { SearchPageData } from '../src/search/search';
import { literaryGrainExample } from '../src/features/catalogue/literary-reader/examples';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/books' });
const globals: Record<string, unknown> = {
  window,
  document: window.document,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const key of [
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Document',
  'DocumentFragment',
  'MutationObserver',
  'ResizeObserver',
  'sessionStorage',
])
  globals[key] = Reflect.get(window, key);
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { BookCataloguePage } = await import('../src/books/catalogue/page');
const { bookCatalogueTypes, bookDiscoveryHref, readBookCatalogue } = await import('../src/books/catalogue/model');
const { defaultNavigation } = await import('../src/shell/navigation-view');
const { resolveNavigation } = await import('../src/shell/navigation');
const { locales, setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const { discoverySearchHref, searchLoaderDeps } = await import('../src/search/search-params');
const { discoveryRequest } = await import('../src/search/search-request');
const { readSearchOutcome, searchUnavailablePage } = await import('../src/search/search-recovery');
const { SearchResultsRegion } = await import('../src/search/search-regions/results');
const { useSearchWindow } = await import('../src/search/search-window');
const { discoveryExample } = await import('../src/kernel/fake/search-discovery');
const { rememberSearchDestination, restoreSearchDestination } = await import('../src/search/search-destination-return');
const { LiteraryReaderEntry } = await import('../src/features/catalogue/literary-reader/entry');
const { shelfHref, validateShelfSearch } = await import('../src/library/shelf-params');
const { resolveShelfPresentation } = await import('../src/library/shelf-preferences');
const { requirePrivatePageAccess } = await import('../src/session/guard');
const { PersonalLibraryCurrent } = await import('../src/library/personal-library-current');
const server = await import('../src/library/personal-library-server');
const rows = await import('../src/library/shelf-rows');
const actions = await import('../src/library/entries-actions');
const { libraryContinueQuery } = await import('../src/library/continue-read');

const host = document.createElement('main');
document.body.append(host);
let root = createRoot(host);
let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ['/en/books'] }),
});
await router.load();
const tick = () => new Promise<void>((done) => setTimeout(done, 0));
async function render(children: ReactNode) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>{children}</RouterContextProvider>
      </QueryClientProvider>,
    );
    await tick();
  });
}
const viewer = (subject: string) => ({ state: 'signed-in', subject, csrfToken: `csrf-${subject}` });
const readyChoices = bookCatalogueTypes.map((type) => ({ type, state: 'ready' as const, label: type, language: 'en' }));
function Results({ data }: { data: SearchPageData }) {
  const state = data.queryState!;
  const visit = useSearchWindow({
    cursor: state.cursor,
    href: (cursor) => discoverySearchHref('ja', { ...state, cursor }),
    locale: 'ja',
    session: null,
    ready: data.recovery?.status === 'ready',
    settled: data.recovery?.status !== 'loading',
    recoverable: data.recovery?.status === 'unavailable',
  });
  return (
    <SearchResultsRegion
      query={state.query}
      locale="ja"
      selectedFacets={state.facets}
      data={data}
      windowNavigation={visit}
    />
  );
}
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.sessionStorage.clear();
});
afterAll(async () => {
  await act(async () => root.unmount());
  client.clear();
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('entry resolves exactly three released Types, preserves partial metadata and offers no missing destinations', async () => {
  const reads: string[] = [];
  const data = await readBookCatalogue('ja', async (type, locale) => {
    reads.push(`${locale}:${type}`);
    return type === 'schema:Book'
      ? { ok: true, descriptor: { label: '港', language: 'ja', description: null, descriptionLanguage: null } }
      : { ok: false, reason: type === 'schema:BookSeries' ? 'missing' : 'unavailable' };
  });
  expect(reads).toEqual(bookCatalogueTypes.map((type) => `ja:${type}`));
  await render(<BookCataloguePage {...data} />);
  expect(host.querySelector('[data-book-type="schema:Book"] h2')?.getAttribute('lang')).toBe('ja');
  expect(host.querySelector('[data-book-type="schema:Book"] h2')?.textContent).toBe('港');
  for (const type of ['schema:BookSeries', 'bf:Instance'])
    expect(host.querySelector(`[data-book-type="${type}"] a`)).toBeNull();
  expect(host.querySelector('a[href="/ja/books"]')?.textContent).toBe(m.books_catalogue_retry({}, { locale: 'ja' }));
  expect(host.querySelector('form')?.getAttribute('action')).toBe('/ja/search');
  expect(host.querySelector('input[name="type"]')?.getAttribute('value')).toBe('schema:Book');
  await render(
    <BookCataloguePage locale="ja" choices={readyChoices.map((choice) => ({ ...choice, state: 'missing' }))} />,
  );
  expect(host.querySelector('form')).toBeNull();
  expect(host.querySelector('a[href="/ja/library/continue"]')).not.toBeNull();
});

test.each(locales)(
  'localized public entry and all three exact shelf destinations preserve native defaults: %s',
  async (locale) => {
    setLocale(locale, { reload: false });
    const nav = resolveNavigation(defaultNavigation, { locale, pathname: `/${locale}/books` });
    expect(nav.find((entry) => entry.id === 'books.catalogue')).toMatchObject({
      href: `/${locale}/books`,
      current: true,
      label: m.books_catalogue_title({}, { locale }),
    });
    await render(<BookCataloguePage locale={locale} choices={readyChoices} />);
    for (const type of bookCatalogueTypes) {
      const card = host.querySelector(`[data-book-type="${type}"]`)!;
      const links = [...card.querySelectorAll<HTMLAnchorElement>('a')];
      expect(links.map((link) => link.getAttribute('href'))).toEqual([
        bookDiscoveryHref(locale, type),
        shelfHref(locale, { type }),
      ]);
      expect(links.every((link) => link.target === '_blank' && link.rel.includes('noopener'))).toBe(true);
      const destination = new URL(links[1]!.href);
      expect([...destination.searchParams]).toEqual([['type', type]]);
      const search = validateShelfSearch(Object.fromEntries(destination.searchParams));
      expect(
        resolveShelfPresentation(search, { layouts: { [type]: 'table' }, gridSize: 'small' }).display,
      ).toMatchObject({ layout: 'table', size: 's', layoutExplicit: false });
    }
    expect(host.querySelector('form')?.target).toBe('_blank');
    expect(new URL(host.querySelector<HTMLAnchorElement>('a[href$="/library/continue"]')!.href).search).toBe('');
    expect(libraryContinueQuery(locale).queryKey).toEqual(['library-continue', locale, '']);
  },
);

test('bounded Search renders sparse/empty continuation, repeats the exact failed page and restores its full address', async () => {
  const state = searchLoaderDeps({
    q: '港',
    type: 'schema:Book',
    'f.schema:inLanguage': ['ja'],
    language: ['ja', 'en'],
    cursor: 'opaque+/= book page',
  });
  const href = discoverySearchHref('ja', state);
  const requests: ReturnType<typeof discoveryRequest>[] = [];
  const read = (hits: typeof discoveryExample.hits, status = 200) =>
    readSearchOutcome(discoveryRequest(state, ['ja']), async (request) => {
      requests.push(request);
      return { status, data: { ...discoveryExample, hits, next: 'sparse+/= frontier' } };
    });
  const sparseRows = await read(discoveryExample.hits.slice(-1));
  await render(<Results data={{ ...searchUnavailablePage(state), ...sparseRows }} />);
  const next = host.querySelector<HTMLAnchorElement>('a[data-window-action="next"]')!;
  expect(new URL(next.href).searchParams.get('cursor')).toBe('sparse+/= frontier');
  const empty = await read([]);
  await render(<Results data={{ ...searchUnavailablePage(state), ...empty }} />);
  expect(host.querySelector('[data-search-recovery="sparse"] a')?.getAttribute('href')).toBe(
    discoverySearchHref('ja', { ...state, cursor: undefined }),
  );
  const outcome = await read([], 503);
  await render(<Results data={{ ...searchUnavailablePage(state), ...outcome }} />);
  const retry = host.querySelector<HTMLAnchorElement>('[data-search-recovery] a');
  expect(retry?.getAttribute('href')).toBe(href);
  await read([]);
  expect(requests).toHaveLength(4);
  expect(requests.every((request) => request.cursor === state.cursor && request.limit === 100)).toBe(true);
  expect(requests[0]?.filter).toEqual({
    and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:inLanguage', in: ['ja'] } }],
  });
  rememberSearchDestination({ href, locale: 'ja', reader: null, cursor: state.cursor });
  expect(restoreSearchDestination({ href, locale: 'ja', reader: null })?.href).toBe(href);
  expect(restoreSearchDestination({ href, locale: 'ja', reader: 'replacement' })).toBeNull();
});

test.each(bookCatalogueTypes)(
  'literary reader keeps %s identity, directed bibliography and exact-type shelf, then retires it',
  async (type) => {
    client.setQueryData(['session'], viewer('A'));
    const input = literaryGrainExample(type);
    await render(<LiteraryReaderEntry {...input} />);
    const shelf = host.querySelector<HTMLAnchorElement>('a[href*="/library?"]')!;
    expect(shelf.getAttribute('href')).toBe(shelfHref('en', { type }));
    expect(shelf.target).toBe('_blank');
    expect(host.querySelector('[data-type]')?.getAttribute('data-type')).toBe(type);
    expect(host.querySelectorAll('[data-slot="literary-window"] li[data-statement-id]').length).toBeLessThanOrEqual(
      input.windows.reduce((total, window) => total + (window.limit ?? 0), 0),
    );
    await act(async () => {
      client.setQueryData(['session'], viewer('B'));
    });
    expect(host.querySelector('a[href*="/library?"]')).toBeNull();
    expect(host.querySelector('[data-slot="literary-window"]')).toBeNull();
    await act(async () => {
      client.setQueryData(['session'], viewer('A'));
    });
    expect(host.querySelector('a[href*="/library?"]')).toBeNull();
  },
);

test('book shelf safe sign-in, native page bound, existing entry action/readback and viewer retirement', async () => {
  setLocale('en', { reload: false });
  const href = shelfHref('en', { type: 'schema:Book' });
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  const denied = await requirePrivatePageAccess({
    context: { queryClient: client },
    location: { publicHref: href },
  }).catch((error: unknown) => error);
  expect(denied).toMatchObject({ options: { href: `/auth/sign-in?return_to=${encodeURIComponent(href)}` } });
  client.setQueryData(['session'], viewer('A'));
  client.setQueryData(['exposure', 'viewer'], ['personal_library', 'reading_progress']);
  client.setQueryData(['exposure', 'anonymous'], []);
  const entry: PersonalLibraryEntry = {
    subjectId: id(1),
    state: 'planned',
    revision: 7,
    incarnationId: id(2),
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    changeKey: id(3),
    removeKey: id(4),
    stateOptions: ['planned', 'completed'].map((id) => ({ id, label: { text: id, lang: 'en' } })),
    subject: { id: id(1), type: 'schema:Book', types: ['schema:Book'], label: 'The harbour', cover: null },
  };
  const search = validateShelfSearch(Object.fromEntries(new URL(href, 'https://site.test').searchParams));
  const initial: PersonalLibraryCurrentRead = {
    sessionSubject: 'A',
    requested: server.personalLibraryAddress(search, 'en'),
    page: { signedIn: true, entries: [entry], next: null },
    continueEntries: { state: 'unavailable' },
    navigation: { pins: { state: 'closed' }, collections: [], collectionsState: 'loaded' },
  };
  let controls!: ReturnType<typeof rows.useShelfRows>;
  const useRows = rows.useShelfRows;
  const observed = spyOn(rows, 'useShelfRows').mockImplementation((...args) => (controls = useRows(...args)));
  const pendingReads: ReturnType<typeof deferred<PersonalLibraryCurrentRead>>[] = [];
  const reads = spyOn(server, 'readPersonalLibraryCurrent').mockImplementation(() => {
    const pending = deferred<PersonalLibraryCurrentRead>();
    pendingReads.push(pending);
    return pending.promise;
  });
  const saved = deferred<LibraryMutationResult>();
  const write = spyOn(actions, 'savePersonalLibraryEntry').mockImplementation(() => saved.promise);
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 503 }));
  try {
    await render(
      <PersonalLibraryCurrent initial={initial} search={search} locale="en" display={{ layout: 'list', size: 'm' }} />,
    );
    expect(host.textContent).toContain('The harbour');
    expect(reads).toHaveBeenCalledTimes(0);
    await act(async () => {
      void controls.changeState(id(1), 'completed');
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].data).toMatchObject({ subjectId: id(1), state: 'completed', revision: 7 });
    await act(async () => {
      saved.resolve({
        ok: true,
        entry: { subjectId: id(1), state: 'completed', revision: 8, incarnationId: id(2), updatedAt: '2026-02-01' },
      });
    });
    expect(controls.rows[0]?.entry).toMatchObject({ state: 'completed', revision: 8 });
    await act(async () => {
      void client.refetchQueries({ queryKey: ['personal-library-current'], type: 'active' });
      await tick();
    });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[0].data).toMatchObject({ type: 'schema:Book' });
    const editionSearch = { type: 'bf:Instance' };
    await render(
      <PersonalLibraryCurrent
        initial={initial}
        search={editionSearch}
        locale="en"
        display={{ layout: 'list', size: 'm' }}
      />,
    );
    expect(reads).toHaveBeenCalledTimes(2);
    expect(reads.mock.calls[1]?.[0].data).toMatchObject({ type: 'bf:Instance' });
    await act(async () => {
      pendingReads[0]!.resolve(initial);
      await tick();
    });
    expect(host.textContent).not.toContain('The harbour');
    await act(async () => {
      client.setQueryData(['session'], viewer('B'));
      await tick();
    });
    await act(async () => {
      pendingReads[1]!.resolve({ ...initial, requested: server.personalLibraryAddress(editionSearch, 'en') });
      await tick();
    });
    expect(host.textContent).not.toContain('The harbour');
  } finally {
    observed.mockRestore();
    reads.mockRestore();
    write.mockRestore();
    fetch.mockRestore();
  }
});
