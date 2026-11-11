import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, StrictMode } from 'react';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { Window } from 'happy-dom';
import * as start from '../.storybook/react-start';
import {
  createIllustrativeHostedBook,
  illustrativeBookCursor,
  illustrativeBookIds as ids,
  illustrativePublication,
} from '../src/books/reader/illustrative-source';
import { createHostedCatalogueApi } from '../src/books/reader/native-api';
import { readHostedBook } from '../src/books/reader/native-mapper';
import type { BookAddress, BookReadRequest, BookReadResult, HostedBookSource } from '../src/books/reader/source';

const window = new Window({ url: 'https://reader.test/en/', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const prior = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const actualStart = await import('@tanstack/react-start');
const actualServer = await import('@tanstack/react-start/server');
mock.module('@tanstack/react-start', () => ({ ...actualStart, ...start }));
mock.module('@tanstack/react-start/server', () => ({ ...actualServer, ...start }));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { HostedBookReader } = await import('../src/books/reader/hosted-book-reader');
const { NativeHostedBookReader } = await import('../src/books/reader/native-hosted-book-reader');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

let root: Root | undefined;
let host: HTMLElement;
let client: QueryClient;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  window.document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});
afterAll(async () => {
  mock.module('@tanstack/react-start', () => actualStart);
  mock.module('@tanstack/react-start/server', () => actualServer);
  mock.restore();
  for (const [key, descriptor] of prior) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

async function mount(
  source: HostedBookSource,
  address: BookAddress,
  extra: Partial<Parameters<typeof HostedBookReader>[0]> = {},
) {
  window.history.replaceState(null, '', 'https://reader.test/en/');
  setLocale('en', { reload: false });
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  const render = async (props: Partial<Parameters<typeof HostedBookReader>[0]> = {}) => {
    await act(async () =>
      root!.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <HostedBookReader
              address={address}
              source={source}
              readingIdentity={source}
              locale="en"
              {...extra}
              {...props}
            />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
    await settle();
  };
  await render();
  return render;
}
async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}
function button(label: string, exact = true) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    exact ? element.textContent === label : element.textContent?.startsWith(label),
  );
  expect(result).toBeDefined();
  return result!;
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.focus();
    element.click();
  });
  await settle();
}
function observed(source: HostedBookSource) {
  const read = mock(source.read);
  return { ...source, read };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('nested levels read one window per activation; reused bodies keep distinct exact operands and return focus', async () => {
  const book = createIllustrativeHostedBook();
  await book.ready;
  const source = observed(book.source);
  await mount(source, book.contents());
  expect(source.read).toHaveBeenCalledTimes(1); // Strict Mode retires the first queued call.
  expect(host.textContent).toContain('Part I · The journey');
  expect(host.textContent).not.toContain('Dawn / 黎明');
  await click(button(`${m.book_reader_contents()} · Part I · The journey`));
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(source.read.mock.calls[1]![0].address).toEqual(book.contents(ids.part));
  await click(button(`${m.book_reader_contents()} · The observatory`));
  expect(source.read).toHaveBeenCalledTimes(3);
  const first = await book.chapter();
  const reused = await book.chapter(true);
  expect(first.selection.body).toEqual(reused.selection.body);
  expect(first.selection.occurrenceId).not.toBe(reused.selection.occurrenceId);
  await click(button(`${m.book_reader_open_chapter()} · Dawn, an echo / 再読`));
  expect(source.read).toHaveBeenCalledTimes(4);
  expect(source.read.mock.calls[3]![0]).toEqual({ address: reused, locale: 'en', limit: 40, ancestorLimit: 24 });
  expect(host.querySelector('article')?.textContent).toContain('The keeper opened the eastern shutters.');
  expect(host.querySelector('h1')?.textContent).toBe('Dawn, an echo / 再読');
  expect(document.activeElement).toBe(host.querySelector('h1'));
  expect(host.querySelector('nav')?.textContent).toContain('Part I · The journey');
  expect(host.querySelector('nav')?.textContent).toContain('The observatory');
  await click(button(m.book_reader_contents()));
  expect(source.read).toHaveBeenCalledTimes(5);
  expect(source.read.mock.calls[4]![0].address).toEqual({ ...book.contents(ids.nested), selection: reused.selection });
  const selected = host.querySelector<HTMLElement>('[aria-current="location"]');
  expect(selected?.closest('[data-occurrence]')?.getAttribute('data-occurrence')).toBe(ids.reused);
  expect(document.activeElement).toBe(selected);
  expect(host.querySelector('article')).toBeNull();
  expect(client.isFetching()).toBe(0);
  await click(button(m.book_reader_return_chapter()));
  await act(async () => book.replace());
  expect(host.querySelector('article')).toBeNull();
  await click(button(m.book_reader_retry()));
  expect(source.read.mock.calls.at(-1)![0].address).toEqual(reused);
  expect(host.querySelector('h1')?.textContent).toBe('Dawn, an echo / 再読');
});

test('sparse continuation, failure and retry retain the opaque cursor and the selected exact return', async () => {
  const book = createIllustrativeHostedBook('failed-page');
  const chapter = await book.chapter();
  const source = observed(book.source);
  const address = { ...book.contents(ids.nested), selection: chapter.selection };
  await mount(source, address);
  expect(host.textContent).toContain(m.book_reader_empty());
  expect(host.textContent).not.toContain(m.book_reader_level_end());
  await click(button(m.book_reader_more()));
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain(m.book_reader_unavailable());
  expect(host.textContent).not.toContain('Dawn, an echo / 再読');
  const operand = source.read.mock.calls[1]![0];
  expect(operand.address).toEqual({ ...address, cursor: illustrativeBookCursor });
  await click(button(m.book_reader_retry()));
  expect(source.read).toHaveBeenCalledTimes(3);
  expect(source.read.mock.calls[2]![0]).toEqual(operand);
  expect(host.textContent).toContain('Dawn, an echo / 再読');
  expect(host.textContent).toContain(m.book_reader_level_end());
  await click(button(m.book_reader_return_chapter()));
  expect(source.read.mock.calls[3]![0].address).toEqual(chapter);
  await click(button(m.book_reader_contents()));
  expect(source.read.mock.calls[4]![0].address).toEqual({ ...address, cursor: illustrativeBookCursor });
});

test('host-supplied canonical links remain native links with independent occurrence addresses', async () => {
  const book = createIllustrativeHostedBook();
  const source = observed(book.source);
  const hrefForAddress = (address: BookAddress) =>
    address.kind === 'chapter' ? `/illustrative-exact/${address.selection.occurrenceId}` : null;
  await mount(source, book.contents(ids.nested), { hrefForAddress });
  const first = host.querySelector<HTMLAnchorElement>(`a[href="/illustrative-exact/${ids.first}"]`)!;
  const reused = host.querySelector<HTMLAnchorElement>(`a[href="/illustrative-exact/${ids.reused}"]`)!;
  expect(first).not.toBeNull();
  expect(reused).not.toBeNull();
  expect(first.closest('button')).toBeNull();
  let prevented: boolean | undefined;
  const capture = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', capture);
  try {
    await act(async () =>
      first.dispatchEvent(new window.MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true })),
    );
    expect(prevented).toBe(false);
    expect(source.read).toHaveBeenCalledTimes(1);
    await click(reused);
    expect(prevented).toBe(true);
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(source.read.mock.calls[1]![0].address).toEqual(await book.chapter(true));
  } finally {
    document.removeEventListener('click', capture);
  }
});

test('a moved occurrence keeps its frozen body while current ancestors change; neighbours distinguish end and unavailable', async () => {
  const book = createIllustrativeHostedBook('moved');
  const address = await book.chapter();
  const source = observed(book.source);
  await mount(source, address);
  expect(host.querySelector('article')?.textContent).toContain('The keeper opened the eastern shutters.');
  expect(source.read.mock.calls[0]![0].address).toEqual(address);
  expect(host.querySelector('nav')?.textContent).toContain('Part I · The journey');
  expect(host.querySelector('nav')?.textContent).not.toContain('The observatory');
  expect(host.textContent).toContain(m.book_reader_first());
  await click(button(m.book_reader_contents()));
  expect(host.textContent).toContain(m.book_reader_moved());
  await click(button(m.book_reader_return_chapter()));
  expect(source.read.mock.calls.at(-1)![0].address).toEqual(address);

  const unavailable = createIllustrativeHostedBook('unavailable-navigation');
  await mountReplacement(unavailable.source, await unavailable.chapter());
  expect(host.textContent).toContain(m.book_reader_navigation_unavailable());
  expect(host.textContent).not.toContain(m.book_reader_last());
  expect(host.querySelector('article')).not.toBeNull();
});
async function mountReplacement(source: HostedBookSource, address: BookAddress) {
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <HostedBookReader address={address} source={source} readingIdentity={source} locale="en" />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

test('keyboard navigation mirrors RTL, ignores selection and editable controls, and focuses the new chapter', async () => {
  const book = createIllustrativeHostedBook();
  const source = observed(book.source);
  source.read.mockImplementation(async (request, signal) => {
    const result = await book.source.read(request, signal);
    return result.state === 'ready' && result.page.kind === 'chapter'
      ? { ...result, page: { ...result.page, direction: 'rtl' } }
      : result;
  });
  await mount(source, await book.chapter());
  const article = host.querySelector<HTMLElement>('article')!;
  const key = async (target: Element, key: string, options: KeyboardEventInit = {}) => {
    await act(async () =>
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })),
    );
    await settle();
  };
  const input = document.createElement('input');
  article.append(input);
  await key(input, 'ArrowLeft');
  await key(article, 'ArrowLeft', { ctrlKey: true });
  await key(article, 'ArrowLeft', { isComposing: true });
  await key(article, 'ArrowLeft', { repeat: true });
  const range = document.createRange();
  range.selectNodeContents(article.querySelector('p')!);
  window.getSelection()!.addRange(range);
  await key(article, 'ArrowLeft');
  window.getSelection()!.removeAllRanges();
  await key(article, 'ArrowRight'); // Known beginning in RTL.
  expect(source.read).toHaveBeenCalledTimes(1);
  article.focus();
  await key(article, 'ArrowLeft');
  expect(source.read).toHaveBeenCalledTimes(2);
  expect(source.read.mock.calls[1]![0].address).toEqual(await book.chapter(true));
  expect(document.activeElement).toBe(host.querySelector('h1'));
  expect(host.querySelector('h1')?.textContent).toBe('Dawn, an echo / 再読');
});

test('replacement observations and session ABA remove body and rows; late results and focus cannot revive them', async () => {
  const book = createIllustrativeHostedBook();
  const chapter = await book.chapter();
  const source = observed(book.source);
  const render = await mount(source, chapter);
  const late = deferred<BookReadResult>();
  source.read.mockImplementationOnce(() => late.promise);
  const result = await book.source.read(
    { address: book.contents(ids.nested), locale: 'en', limit: 40, ancestorLimit: 24 },
    new AbortController().signal,
  );
  await click(button(m.book_reader_contents()));
  expect(host.querySelector('article')).toBeNull();
  const outside = document.createElement('button');
  outside.textContent = 'Outside reading';
  document.body.append(outside);
  outside.focus();
  await act(async () => {
    book.replace();
    book.replace();
  });
  expect(host.textContent).toContain(m.book_reader_changed());
  expect(source.read.mock.calls.at(-1)![1].aborted).toBe(true);
  await act(async () => late.resolve(result));
  await settle();
  expect(host.querySelector('[data-occurrence]')).toBeNull();
  expect(document.activeElement).toBe(outside);
  const fresh = createIllustrativeHostedBook();
  await render({ source: fresh.source, readingIdentity: fresh });
  expect(host.querySelector('article')).not.toBeNull();
  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-in', subject: 'other', csrfToken: 'other' });
    client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  });
  expect(host.querySelector('article')).toBeNull();
  expect(host.textContent).toContain(m.book_reader_changed());
});

test('locale, address, viewer and source replacements fence pending readings and preserve later focus', async () => {
  const book = createIllustrativeHostedBook();
  const chapter = await book.chapter();
  const pending = deferred<BookReadResult>();
  const source = observed(book.source);
  source.read.mockImplementationOnce(() => pending.promise);
  const render = await mount(source, chapter);
  expect(host.querySelector('article')).toBeNull();
  const fresh = createIllustrativeHostedBook();
  window.history.replaceState(null, '', 'https://reader.test/fr/');
  setLocale('fr', { reload: false });
  await render({ source: fresh.source, readingIdentity: {}, locale: 'fr', address: await fresh.chapter(true) });
  expect(source.read.mock.calls[0]![1].aborted).toBe(true);
  const currentHeading = host.querySelector('h1');
  const old = await book.source.read(
    { address: chapter, locale: 'en', limit: 40, ancestorLimit: 24 },
    new AbortController().signal,
  );
  await act(async () => pending.resolve(old));
  await settle();
  expect(host.querySelector('h1')).toBe(currentHeading);
  expect(currentHeading?.textContent).toBe('Dawn, an echo / 再読');
  expect(host.querySelector('section')?.lang).toBe('fr');
});

test('a progress owner rendering failure leaves exact reading available; all eight locales cover recovery', async () => {
  const book = createIllustrativeHostedBook();
  const report = console.error;
  console.error = () => {};
  try {
    await mount(book.source, await book.chapter(), {
      renderProgress: () => {
        throw new Error('Illustrative progress failure');
      },
    });
    expect(host.querySelector('article')).not.toBeNull();
    expect(host.textContent).toContain(m.book_reader_progress_unavailable());
  } finally {
    console.error = report;
  }
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
    const options = { locale };
    for (const message of [
      m.book_reader_contents,
      m.book_reader_retry,
      m.book_reader_more,
      m.book_reader_changed,
      m.book_reader_unavailable,
      m.book_reader_navigation_unavailable,
      m.book_reader_selection_unavailable,
      m.book_reader_previous,
      m.book_reader_next,
    ])
      expect(message({}, options).length).toBeGreaterThan(0);
  }
});

test('installed generated operations carry exact release, occurrence and cursor without reflection or fixture transport', async () => {
  const book = createIllustrativeHostedBook();
  const { api } = await book.ready;
  const urls: URL[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    urls.push(url);
    expect(request.headers.get('authorization')).toBe('Bearer prepared-viewer');
    const query = Object.fromEntries(url.searchParams) as Parameters<typeof api.children>[1];
    const occurrence = url.pathname.split('/occurrences/')[1]?.split('/')[0];
    const result = url.pathname.endsWith('/children')
      ? await api.children(ids.catalogue, query)
      : url.pathname.endsWith('/navigation')
        ? await api.navigate(ids.catalogue, occurrence!, {
            ...query,
            direction: url.searchParams.get('direction') as 'previous' | 'next',
          })
        : occurrence
          ? await api.resolve(ids.catalogue, occurrence, query)
          : await api.catalogue(ids.catalogue, query);
    return Response.json(result.state === 'ready' ? result.value : {}, {
      status: result.state === 'ready' ? 200 : 503,
    });
  };
  const native = createHostedCatalogueApi(
    createKernelClient('https://kernel.test', { fetch: transport }),
    'Bearer prepared-viewer',
    new AbortController().signal,
  );
  const chapter = await book.chapter();
  const request: BookReadRequest = { address: chapter, locale: 'en', limit: 40, ancestorLimit: 24 };
  const result = await readHostedBook(native, request, 'Native book', new AbortController().signal);
  expect(result.state).toBe('ready');
  if (result.state !== 'ready' || result.page.kind !== 'chapter') throw new Error('Expected exact chapter');
  expect(result.page.address).toEqual(chapter);
  expect(urls.filter((url) => url.pathname.endsWith(`/occurrences/${ids.first}`))).toHaveLength(1);
  expect(
    urls.filter((url) => url.pathname.endsWith('/navigation')).map((url) => url.searchParams.get('limit')),
  ).toEqual(['1', '1']);
  expect(urls.every((url) => url.searchParams.get('kind') === 'publication')).toBe(true);
  urls.length = 0;
  await native.children(ids.catalogue, {
    kind: 'publication',
    revisionId: ids.release,
    parentId: ids.nested,
    cursor: illustrativeBookCursor,
    limit: '20',
  });
  expect(urls).toHaveLength(1);
  expect(urls[0]!.searchParams.get('cursor')).toBe(illustrativeBookCursor);
  expect(urls[0]!.searchParams.get('revisionId')).toBe(illustrativePublication.releaseRevisionId);
});

test('native mount does not invent host admission or call Content while the host is unavailable', async () => {
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  const unavailable = { state: 'not-installed' as const };
  const book = createIllustrativeHostedBook();
  await act(async () =>
    root!.render(
      <NativeHostedBookReader
        address={book.contents()}
        locale="en"
        admission={{ getSnapshot: () => unavailable, subscribe: () => () => {} }}
      />,
    ),
  );
  await settle();
  expect(host.textContent).toContain(m.book_reader_not_installed({}, { locale: 'en' }));
  expect(host.querySelector('article')).toBeNull();
});

test('native host resolves published defaults and frozen exact targets; route operands cannot select a draft', async () => {
  const { observeHostedBookVisit } = await import('../src/books/reader/visit');
  const { parseHostedBookSearch } = await import('../src/books/reader/address');
  const book = createIllustrativeHostedBook('moved');
  const { api } = await book.ready;
  const catalogue = mock(api.catalogue);
  const resolve = mock(api.resolve);
  const native = { ...api, catalogue, resolve };
  const visit = await observeHostedBookVisit(
    native,
    {
      catalogueId: ids.catalogue,
      locale: 'en',
      search: {
        release: ids.release,
        occurrence: ids.first,
        view: 'chapter',
        returnParent: ids.nested,
        returnCursor: illustrativeBookCursor,
      },
    },
    { kind: 'session', subject: ids.author },
    m.book_reader_title(),
  );
  expect(visit.state).toBe('ready');
  if (visit.state !== 'ready') throw new Error('Expected a native admitted visit');
  expect(visit.address).toEqual(await book.chapter());
  expect(visit.admission.viewer).toEqual({ kind: 'session', subject: ids.author });
  expect(visit.admission.currentReleaseRevisionId).toBe(ids.currentRelease);
  expect(visit.admission.currentStructureRevisionId).toBe(ids.currentStructure);
  expect(visit.contentsReturn).toEqual({
    ...book.contents(ids.nested, illustrativeBookCursor),
    selection: (await book.chapter()).selection,
  });
  expect(catalogue.mock.calls.map((call) => call[1])).toEqual([
    { kind: 'publication' },
    { kind: 'publication', revisionId: ids.release },
  ]);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(resolve.mock.calls[0]![1]).toBe(ids.first);
  const denied = await observeHostedBookVisit(
    { ...api, catalogue: async () => ({ state: 'denied' }) },
    {
      catalogueId: ids.catalogue,
      locale: 'en',
      search: { release: ids.structure },
    },
    { kind: 'anonymous' },
    m.book_reader_title(),
  );
  expect(denied).toEqual({ state: 'denied' });
  expect(parseHostedBookSearch({ kind: 'structure', authorization: 'untrusted', viewer: ids.author })).toEqual({});
  expect(() => parseHostedBookSearch({ release: 'not-an-id' })).toThrow();
  expect(() => parseHostedBookSearch({ cursor: 'x'.repeat(4097) })).toThrow();
  const rootVisit = await observeHostedBookVisit(
    api,
    { catalogueId: ids.catalogue, locale: 'en', search: {} },
    { kind: 'anonymous' },
    m.book_reader_title(),
  );
  expect(rootVisit.state === 'ready' && rootVisit.address.publication.releaseRevisionId).toBe(ids.currentRelease);
});

test('canonical reader links preserve native occurrence, frozen release and bounded opaque return in all locales', async () => {
  const { hostedBookAddressHref, hostedBookSearch, parseHostedBookSearch } =
    await import('../src/books/reader/address');
  const { HostedBookReaderLink } = await import('../src/books/reader/link');
  const book = createIllustrativeHostedBook();
  const chapter = await book.chapter(true);
  const origin = book.contents(ids.nested, illustrativeBookCursor);
  const { locales } = await import('../src/paraglide/runtime.js');
  for (const locale of locales) {
    const href = hostedBookAddressHref(chapter, locale, origin);
    const url = new URL(href, 'https://reader.test');
    expect(url.pathname).toBe(`/${locale}/books/${ids.catalogue}/read`);
    expect(parseHostedBookSearch(Object.fromEntries(url.searchParams))).toEqual(hostedBookSearch(chapter, origin));
    expect(url.searchParams.get('returnCursor')).toBe(illustrativeBookCursor);
    expect(url.searchParams.get('occurrence')).toBe(ids.reused);
    expect(url.searchParams.get('release')).toBe(ids.release);
    expect(url.searchParams.has('postId')).toBe(false); // The host resolves the target from the frozen publication.
  }
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<HostedBookReaderLink catalogueId={ids.catalogue} releaseRevisionId={ids.release} locale="de" />),
  );
  expect(host.querySelector('a')?.getAttribute('href')).toBe(`/de/books/${ids.catalogue}/read?release=${ids.release}`);
});

test('the default production route reads native contents and exact chapters, then rereads on browser Back and Forward', async () => {
  const { createRootRoute, createRouter, createMemoryHistory, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { observeHostedBookVisit } = await import('../src/books/reader/visit');
  const actualVisit = { ...(await import('../src/books/reader/native-visit')) };
  const actualRead = { ...(await import('../src/books/reader/native-read')) };
  const book = createIllustrativeHostedBook('failed-page');
  const { api } = await book.ready;
  const sourceReads: BookReadRequest[] = [];
  const hostReads: unknown[] = [];
  mock.module('../src/books/reader/native-visit', () => ({
    readHostedBookVisit: async ({ data }: Parameters<typeof actualVisit.readHostedBookVisit>[0]) => {
      hostReads.push(data);
      return observeHostedBookVisit(api, data, { kind: 'anonymous' }, m.book_reader_title());
    },
  }));
  mock.module('../src/books/reader/native-read', () => ({
    ...actualRead,
    readNativeHostedBook: async ({ data }: Parameters<typeof actualRead.readNativeHostedBook>[0]) => {
      sourceReads.push(data.request);
      return readHostedBook(api, data.request, data.publicationTitle, new AbortController().signal);
    },
  }));
  const canonical = document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = 'https://reader.test/en/';
  document.head.append(canonical);
  try {
    const { Route } = await import('../src/routes/books.$id.read');
    setLocale('en', { reload: false });
    window.history.replaceState(null, '', 'https://reader.test/en/');
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
    const parent = createRootRoute({
      component: () => (
        <QueryClientProvider client={client}>
          <Outlet />
        </QueryClientProvider>
      ),
    });
    const child = Route.update({ getParentRoute: () => parent, path: '/books/$id/read', id: '/books/$id/read' });
    const history = createMemoryHistory({ initialEntries: [`/en/books/${ids.catalogue}/read`] });
    const { deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
    const router = createRouter({
      routeTree: parent.addChildren([child]),
      history,
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
    host = document.createElement('main');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      await router.load();
      root!.render(<RouterProvider router={router} />);
    });
    await settle();
    expect(host.textContent).toContain('Part I · The journey');
    const link = (text: string) => {
      const anchor = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((element) => element.textContent === text);
      expect(anchor).toBeDefined();
      return anchor!;
    };
    await click(link(`${m.book_reader_contents()} · Part I · The journey`));
    await click(link(`${m.book_reader_contents()} · The observatory`));
    await click(link(m.book_reader_more()));
    expect(host.querySelector('article')).toBeNull();
    expect(host.textContent).toContain(m.book_reader_unavailable());
    await click(button(m.book_reader_retry()));
    const chapterLink = link(`${m.book_reader_open_chapter()} · Dawn, an echo / 再読`);
    expect(new URL(chapterLink.href).searchParams.get('returnParent')).toBe(ids.nested);
    expect(new URL(chapterLink.href).searchParams.get('returnCursor')).toBe(illustrativeBookCursor);
    await click(chapterLink);
    expect(host.querySelector('article')?.textContent).toContain('The keeper opened the eastern shutters.');
    expect(sourceReads.at(-1)?.address).toEqual(await book.chapter(true));
    expect(document.activeElement).toBe(host.querySelector('h1'));
    const beforeBack = sourceReads.length;
    await act(async () => {
      history.back();
    });
    await settle();
    expect(sourceReads).toHaveLength(beforeBack + 1);
    expect(sourceReads.at(-1)?.address).toEqual(book.contents(ids.nested, illustrativeBookCursor));
    expect(host.querySelector('article')).toBeNull();
    await act(async () => {
      history.forward();
    });
    await settle();
    expect(sourceReads).toHaveLength(beforeBack + 2);
    expect(sourceReads.at(-1)?.address).toEqual(await book.chapter(true));
    await click(button(m.book_reader_contents()));
    expect(sourceReads.at(-1)?.address).toEqual({
      ...book.contents(ids.nested, illustrativeBookCursor),
      selection: (await book.chapter(true)).selection,
    });
    expect(document.activeElement?.getAttribute('aria-current')).toBe('location');
    expect(hostReads).toHaveLength(sourceReads.length);
  } finally {
    canonical.remove();
    mock.module('../src/books/reader/native-visit', () => actualVisit);
    mock.module('../src/books/reader/native-read', () => actualRead);
  }
});

test('a new native host incarnation can reopen the same address after pagehide without reviving the retired visit', async () => {
  const book = createIllustrativeHostedBook();
  const chapter = await book.chapter();
  const oldSource = observed(book.source);
  const render = await mount(oldSource, chapter);
  await act(async () => window.dispatchEvent(new window.Event('pagehide')));
  expect(host.querySelector('article')).toBeNull();
  const freshSource = observed(book.source);
  await render({ source: freshSource, readingIdentity: freshSource });
  expect(freshSource.read).toHaveBeenCalledTimes(1);
  expect(host.querySelector('article')?.textContent).toContain('The keeper opened the eastern shutters.');
  expect(oldSource.read).toHaveBeenCalledTimes(1);
});
