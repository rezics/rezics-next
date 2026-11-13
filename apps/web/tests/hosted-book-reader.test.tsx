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
import type { HostedDiscoveryPage } from '../src/books/reader/discovery';
import { decodeHostedBookDocument, readHostedBook } from '../src/books/reader/native-mapper';
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
      m.book_reader_open_books,
      m.book_reader_checkpoint_title,
      m.book_reader_checkpoint_save,
      m.book_reader_checkpoint_clear,
      m.book_reader_checkpoint_resume,
      m.book_reader_checkpoint_none,
      m.book_reader_checkpoint_saved,
      m.book_reader_checkpoint_cleared,
      m.book_reader_checkpoint_uncertain,
      m.book_reader_checkpoint_withheld,
    ])
      expect(message({}, options).length).toBeGreaterThan(0);
  }
});

test.each(['nested', 'moved'] as const)(
  'installed generated operations keep %s structure body-free and open exact bytes once',
  async (state) => {
    const book = createIllustrativeHostedBook(state);
    const { api } = await book.ready;
    const urls: URL[] = [];
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      urls.push(url);
      expect(request.headers.get('authorization')).toBe('Bearer prepared-viewer');
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('manual');
      const query = Object.fromEntries(url.searchParams) as Parameters<typeof api.children>[1];
      const occurrence = url.pathname.split('/occurrences/')[1]?.split('/')[0];
      const result = url.pathname.endsWith('/children')
        ? await api.children(ids.catalogue, query)
        : url.pathname.endsWith('/navigation')
          ? await api.navigate(ids.catalogue, occurrence!, {
              ...query,
              direction: url.searchParams.get('direction') as 'previous' | 'next',
            })
          : url.pathname.endsWith('/metadata')
            ? await api.metadata(ids.catalogue, occurrence!, query)
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
    const contents = await readHostedBook(
      native,
      {
        ...request,
        address: { ...book.contents(ids.nested), selection: chapter.selection },
      },
      'Native book',
      new AbortController().signal,
    );
    expect(contents.state === 'ready' && contents.page.kind === 'contents' && contents.page.selected?.state).toBe(
      state === 'moved' ? 'moved' : 'here',
    );
    expect(urls.filter((url) => /\/occurrences\/[^/]+$/.test(url.pathname))).toHaveLength(0);
    expect(
      urls
        .filter((url) => url.pathname.endsWith(`/occurrences/${ids.first}/metadata`))
        .map((url) => url.searchParams.get('revisionId')),
    ).toEqual(state === 'moved' ? [ids.release, ids.currentRelease] : [ids.release]);
    urls.length = 0;
    const result = await readHostedBook(native, request, 'Native book', new AbortController().signal);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready' || result.page.kind !== 'chapter') throw new Error('Expected exact chapter');
    expect(result.page.address).toEqual(chapter);
    const exact = await api.resolve(ids.catalogue, ids.first, { kind: 'publication', revisionId: ids.release });
    if (exact.state !== 'ready' || !exact.value.document) throw new Error('Expected exact bytes');
    expect(result.page.body.document).toEqual(
      JSON.parse(Buffer.from(exact.value.document.canonicalBytes, 'base64').toString('utf8')),
    );
    expect(
      await decodeHostedBookDocument(
        { ...exact.value, document: { ...exact.value.document, canonicalBytes: btoa('{}') } },
        chapter.selection,
      ),
    ).toBeNull();
    expect(
      urls.filter((url) => /\/occurrences\/[^/]+$/.test(url.pathname)).map((url) => url.searchParams.get('revisionId')),
    ).toEqual([ids.release]);
    expect(
      urls
        .filter((url) => url.pathname.endsWith(`/occurrences/${ids.first}/metadata`))
        .map((url) => url.searchParams.get('revisionId')),
    ).toEqual(state === 'moved' ? [ids.currentRelease] : []);
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
  },
);

test('Book read decoders accept safe positions and strictly reject malformed wire responses', async () => {
  const { api } = await createIllustrativeHostedBook().ready;
  const result = await api.metadata(ids.catalogue, ids.first, { kind: 'publication' });
  if (result.state !== 'ready') throw new Error('Expected metadata');
  let response: unknown;
  const client = createKernelClient('https://kernel.test', { fetch: async () => Response.json(response) });
  const native = createHostedCatalogueApi(client, null, new AbortController().signal);
  const query = { kind: 'publication', revisionId: ids.release } as const;
  const { occurrence: _occurrence, ...revision } = result.value;
  for (const label of [undefined, '', 'Current opening', 'x'.repeat(512), null, 42, {}, 'x'.repeat(513)]) {
    response = { ...revision, ...(label === undefined ? {} : { title: label }) };
    expect((await native.catalogue(ids.catalogue, { ...query, includeTitle: '1' })).state).toBe(
      label === undefined || (typeof label === 'string' && label.length <= 512) ? 'ready' : 'unavailable',
    );
  }
  response = { ...revision, title: 'Current opening', extra: true };
  expect((await native.catalogue(ids.catalogue, query)).state).toBe('unavailable');
  response = { ...result.value, title: 'Point labels do not widen occurrence responses' };
  expect((await native.metadata(ids.catalogue, ids.first, query)).state).toBe('unavailable');
  response = { ...result.value, document: null, title: 'Point label' };
  expect((await native.resolve(ids.catalogue, ids.first, query)).state).toBe('unavailable');
  response = { ...revision, items: [], nextCursor: null, title: 'Point label' };
  expect((await native.children(ids.catalogue, query)).state).toBe('unavailable');
  expect((await native.navigate(ids.catalogue, ids.first, { ...query, direction: 'next' })).state).toBe('unavailable');
  // External decoder fixtures, not evidence of native large-Book acceptance.
  for (const position of [
    0,
    511,
    512,
    Number.MAX_SAFE_INTEGER,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    '512',
    null,
    {},
  ]) {
    const state = [0, 511, 512, Number.MAX_SAFE_INTEGER].includes(position as number) ? 'ready' : 'unavailable';
    const { occurrence: original, ...revision } = result.value;
    for (const occurrence of [
      { ...original, position },
      { ...original, position, kind: 'part', target: null },
      {
        occurrenceId: original.occurrenceId,
        parentId: original.parentId,
        position,
        kind: 'chapter',
        availability: 'unavailable',
      },
    ]) {
      response = { ...revision, occurrence };
      const metadata = await native.metadata(ids.catalogue, ids.first, query);
      expect(metadata.state).toBe(state);
      if (metadata.state === 'ready') expect(metadata.value.occurrence.position).toBe(position);
      response = { ...revision, occurrence, document: null };
      expect((await native.resolve(ids.catalogue, ids.first, query)).state).toBe(state);
      response = { ...revision, items: [occurrence], nextCursor: null };
      expect((await native.children(ids.catalogue, query)).state).toBe(state);
      expect((await native.navigate(ids.catalogue, ids.first, { ...query, direction: 'next' })).state).toBe(state);
    }
  }
  for (const payload of [
    { ...result.value, document: null },
    { ...result.value, occurrence: { ...result.value.occurrence, target: null } },
  ]) {
    response = payload;
    expect(await native.metadata(ids.catalogue, ids.first, { kind: 'publication' })).toEqual({ state: 'unavailable' });
  }
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

test('native host uses the admitted current title with frozen exact targets and rejects mismatched authority', async () => {
  const { observeHostedBookVisit } = await import('../src/books/reader/visit');
  const { parseHostedBookSearch } = await import('../src/books/reader/address');
  const book = createIllustrativeHostedBook('moved');
  const { api } = await book.ready;
  let title: string | undefined = 'The currently public opening';
  const catalogue = mock(async (...args: Parameters<typeof api.catalogue>) => {
    const result = await api.catalogue(...args);
    const label = args[1].revisionId ? 'Ignore a historical response label' : title;
    return result.state === 'ready'
      ? { ...result, value: { ...result.value, ...(label === undefined ? {} : { title: label }) } }
      : result;
  });
  const resolve = mock(api.resolve);
  const metadata = mock(api.metadata);
  const native = { ...api, catalogue, resolve, metadata };
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
  expect(visit.admission.publicationTitle).toBe(title!);
  expect(visit.contentsReturn).toEqual({
    ...book.contents(ids.nested, illustrativeBookCursor),
    selection: (await book.chapter()).selection,
  });
  expect(catalogue.mock.calls.map((call) => call[1])).toEqual([
    { kind: 'publication', includeTitle: '1' },
    { kind: 'publication', revisionId: ids.release },
  ]);
  expect(resolve).not.toHaveBeenCalled();
  expect(metadata.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    [ids.first, { kind: 'publication', revisionId: ids.release }],
  ]);
  await mount(
    {
      ...book.source,
      read: (request, signal) => readHostedBook(api, request, visit.admission.publicationTitle, signal),
    },
    visit.address,
  );
  expect(host.querySelector('header > p')?.textContent).toBe(title!);
  expect(host.querySelector('article')?.textContent).toContain('The keeper opened the eastern shutters.');
  const current = await api.catalogue(ids.catalogue, { kind: 'publication' });
  if (current.state !== 'ready') throw new Error('Expected current publication');
  for (const refused of [
    { state: 'denied' as const },
    { ...current, value: { ...current.value, catalogueId: ids.author, title } },
    { ...current, value: { ...current.value, kind: 'structure' as const, title } },
    { ...current, value: { ...current.value, sourceRevisionId: null, title } },
  ]) {
    const deniedCatalogue = mock(async () => refused);
    metadata.mockClear();
    expect(
      await observeHostedBookVisit(
        { ...native, catalogue: deniedCatalogue },
        { catalogueId: ids.catalogue, locale: 'en', search: { release: ids.release, occurrence: ids.first } },
        { kind: 'anonymous' },
        m.book_reader_title(),
      ),
    ).toEqual({ state: refused.state === 'denied' ? 'denied' : 'unavailable' });
    expect(deniedCatalogue).toHaveBeenCalledTimes(1);
    expect(metadata).not.toHaveBeenCalled();
  }
  expect(parseHostedBookSearch({ kind: 'structure', authorization: 'untrusted', viewer: ids.author })).toEqual({});
  expect(() => parseHostedBookSearch({ release: 'not-an-id' })).toThrow();
  expect(() => parseHostedBookSearch({ cursor: 'x'.repeat(4097) })).toThrow();
  for (title of [undefined, '', 'x'.repeat(512)]) {
    for (const release of [undefined, ids.release]) {
      catalogue.mockClear();
      const rootVisit = await observeHostedBookVisit(
        native,
        { catalogueId: ids.catalogue, locale: 'ja', search: { release } },
        { kind: 'anonymous' },
        m.book_reader_title({}, { locale: 'ja' }),
      );
      expect(rootVisit.state === 'ready' && rootVisit.address.publication.releaseRevisionId).toBe(
        release ?? ids.currentRelease,
      );
      expect(rootVisit.state === 'ready' && rootVisit.admission.publicationTitle).toBe(
        title || m.book_reader_title({}, { locale: 'ja' }),
      );
      expect(catalogue.mock.calls.map((call) => call[1])).toEqual([
        { kind: 'publication', includeTitle: '1' },
        ...(release ? [{ kind: 'publication', revisionId: release }] : []),
      ]);
    }
  }
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
  let title: string | undefined = 'The public opening';
  const pointReads: URL[] = [];
  const point = createHostedCatalogueApi(
    createKernelClient('https://kernel.test', {
      fetch: async (input) => {
        const url = new URL(String(input));
        pointReads.push(url);
        const result = await api.catalogue(ids.catalogue, { kind: 'publication' });
        if (result.state !== 'ready') throw new Error('Expected publication');
        return Response.json({
          ...result.value,
          ...(url.searchParams.get('includeTitle') === '1' && title !== undefined ? { title } : {}),
        });
      },
    }),
    null,
    new AbortController().signal,
  );
  const sourceReads: BookReadRequest[] = [];
  const hostReads: unknown[] = [];
  mock.module('../src/books/reader/native-visit', () => ({
    readHostedBookVisit: async ({ data }: Parameters<typeof actualVisit.readHostedBookVisit>[0]) => {
      hostReads.push(data);
      return observeHostedBookVisit(
        { ...api, catalogue: point.catalogue },
        data,
        { kind: 'anonymous' },
        m.book_reader_title(),
      );
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
    expect(host.querySelector('header > p')?.textContent).toBe(title!);
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
    title = undefined;
    await act(async () => {
      history.back();
    });
    await settle();
    expect(sourceReads).toHaveLength(beforeBack + 1);
    expect(host.querySelector('header > p')?.textContent).toBe(m.book_reader_title());
    title = 'A freshly admitted opening';
    expect(sourceReads.at(-1)?.address).toEqual(book.contents(ids.nested, illustrativeBookCursor));
    expect(host.querySelector('article')).toBeNull();
    await act(async () => {
      history.forward();
    });
    await settle();
    expect(sourceReads).toHaveLength(beforeBack + 2);
    expect(host.querySelector('header > p')?.textContent).toBe(title);
    expect(sourceReads.at(-1)?.address).toEqual(await book.chapter(true));
    await click(button(m.book_reader_contents()));
    expect(sourceReads.at(-1)?.address).toEqual({
      ...book.contents(ids.nested, illustrativeBookCursor),
      selection: (await book.chapter(true)).selection,
    });
    expect(document.activeElement?.getAttribute('aria-current')).toBe('location');
    expect(hostReads).toHaveLength(sourceReads.length);
    expect(pointReads).toHaveLength(hostReads.length);
    expect(
      pointReads.every(
        (url) =>
          url.pathname === `/v1/hostedCatalogues/${ids.catalogue}` &&
          url.searchParams.get('kind') === 'publication' &&
          url.searchParams.get('includeTitle') === '1' &&
          !url.searchParams.has('revisionId'),
      ),
    ).toBe(true);
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

test('Subject discovery keeps sparse continuation and a current publication link in the existing reader route', async () => {
  const { readHostedDiscovery } = await import('../src/books/reader/discovery');
  const { HostedBookVisitView, hostedBookSubjectHref } = await import('../src/books/reader/route');
  const requests: Request[] = [];
  const controller = new AbortController();
  const page: HostedDiscoveryPage = { subjectId: ids.post, items: [], nextCursor: illustrativeBookCursor };
  let response: unknown = page;
  let status = 200;
  const native = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(response, { status });
    },
  });
  async function read(cursor: string | undefined) {
    const before = requests.length;
    const result = await readHostedDiscovery(native, null, ids.post, cursor, controller.signal);
    expect(requests).toHaveLength(before + 1);
    const request = requests.at(-1)!;
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.pathname).toBe(`/v1/subjects/${ids.post}/hostedCatalogues`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      includeTitle: '1',
      limit: '20',
      ...(cursor === undefined ? {} : { cursor }),
    });
    expect(request.cache).toBe('no-store');
    return result;
  }
  const result = await read(undefined);
  expect(result).toEqual({ state: 'ready', value: page });
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  async function render(value: HostedDiscoveryPage, locale: 'en' | 'zh-Hant' = 'en') {
    await act(async () =>
      root!.render(
        <HostedBookVisitView
          visit={{ state: 'catalogues', page: value }}
          locale={locale}
          navigate={() => {}}
          reload={() => {}}
        />,
      ),
    );
  }
  if (result.state !== 'ready') throw new Error('Expected sparse discovery');
  await render(result.value);
  expect(host.querySelector('a')?.getAttribute('href')).toBe(
    hostedBookSubjectHref(ids.post, 'en', illustrativeBookCursor),
  );
  const row = {
    catalogueId: ids.catalogue,
    revisionId: ids.release,
    sourceRevisionId: ids.structure,
    kind: 'publication' as const,
    threadId: ids.thread,
  };
  const title = '<img src=x onerror=alert(1)> & The public opening';
  const populated: HostedDiscoveryPage = {
    ...page,
    items: [
      { ...row, title },
      { ...row, catalogueId: ids.nested },
      { ...row, catalogueId: ids.part, title: '' },
    ],
  };
  response = populated;
  const continued = await read(illustrativeBookCursor);
  expect(continued).toEqual({ state: 'ready', value: populated });
  if (continued.state !== 'ready') throw new Error('Expected continued discovery');
  for (const locale of ['en', 'zh-Hant'] as const) {
    await render(continued.value, locale);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('li a')];
    expect(links.map((link) => link.textContent)).toEqual([
      title,
      m.book_reader_publication({ number: 2 }, { locale }),
      m.book_reader_publication({ number: 3 }, { locale }),
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      populated.items.map(
        (item) => `/${locale}/books/${item.catalogueId}/read?subject=${ids.post}&release=${ids.release}`,
      ),
    );
    expect(links.every((link) => link.classList.contains('min-h-11'))).toBe(true);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('ol')?.nextElementSibling?.getAttribute('href')).toBe(
      hostedBookSubjectHref(ids.post, locale, illustrativeBookCursor),
    );
  }
  await render(continued.value);
  const chapterLink = new URL(host.querySelector('a')!.href);
  expect(chapterLink.pathname).toBe(`/en/books/${ids.catalogue}/read`);
  expect(chapterLink.searchParams.get('subject')).toBe(ids.post);
  expect(chapterLink.searchParams.get('release')).toBe(ids.release);

  status = 503;
  expect(await read(illustrativeBookCursor)).toEqual({ state: 'unavailable' });
  status = 200;
  response = { ...page, items: [{ ...row, title: 'A new current opening' }], nextCursor: null };
  const retried = await read(illustrativeBookCursor);
  expect(retried).toEqual({ state: 'ready', value: response });
  if (retried.state !== 'ready') throw new Error('Expected retried discovery');
  await render(retried.value);
  expect(host.querySelector('li a')?.textContent).toBe('A new current opening');
  expect(host.querySelectorAll('a')).toHaveLength(1);

  response = { ...page, items: [{ ...row, title: 'x'.repeat(512) }] };
  expect(await read(illustrativeBookCursor)).toEqual({ state: 'ready', value: response });
  for (const invalidTitle of ['x'.repeat(513), null, 42]) {
    response = { ...page, items: [{ ...row, title: invalidTitle }] };
    expect(await read(illustrativeBookCursor)).toEqual({ state: 'unavailable' });
  }
  for (const [code, state] of [
    [400, 'changed'],
    [412, 'changed'],
    [401, 'denied'],
    [403, 'denied'],
    [404, 'not-found'],
  ] as const) {
    status = code;
    expect(await read(illustrativeBookCursor)).toEqual({ state });
  }
  controller.abort();
  expect(requests.every((request) => request.signal.aborted)).toBe(true);
});

test('native checkpoints use body-free metadata for observation and CAS readback', async () => {
  const { readHostedCheckpoint, writeHostedCheckpoint } = await import('../src/books/reader/checkpoint-api');
  const sha256 = 'a'.repeat(64);
  const address = {
    catalogueId: ids.catalogue,
    publicationRevisionId: ids.release,
    occurrenceId: ids.first,
    targetRevisionId: ids.revision,
    targetSha256: sha256,
    documentPosition: { blockId: 'saved-native-block', offset: 37 },
  };
  const saved = {
    state: 'saved' as const,
    subjectId: ids.post,
    revision: '2',
    address,
    metadata: {
      availability: 'available' as const,
      occurrenceId: ids.first,
      parentId: ids.nested,
      position: 0,
      kind: 'chapter' as const,
      title: 'Dawn / 黎明',
      target: { threadId: ids.thread, postId: ids.post, revisionId: ids.revision, sha256 },
    },
  };
  let response: unknown = { state: 'none', subjectId: ids.post };
  const requests: Request[] = [];
  const native = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.headers.get('authorization')).toBe('Bearer member');
      const url = new URL(request.url);
      if (request.method === 'GET') {
        expect(url.pathname).toBe('/v1/libraryHostedReading/metadata');
        expect([...url.searchParams.entries()]).toEqual([['subjectId', ids.post]]);
        expect(request.cache).toBe('no-store');
        expect(request.redirect).toBe('manual');
        return Response.json(response);
      }
      if (request.method === 'PUT') return Response.json({ subjectId: ids.post, revision: '2', address });
      if (request.method === 'POST') {
        response = { state: 'none', subjectId: ids.post };
        return Response.json({ subjectId: ids.post, cleared: true });
      }
      throw new Error(`Unexpected checkpoint request: ${request.method} ${url.pathname}`);
    },
  });
  const signal = new AbortController().signal;
  const metadataReads = () =>
    requests.filter(
      (request) => request.method === 'GET' && new URL(request.url).pathname === '/v1/libraryHostedReading/metadata',
    );
  const expectMetadataReads = (count: number) => {
    expect(metadataReads()).toHaveLength(count);
    expect(
      requests.some(
        (request) => request.method === 'GET' && new URL(request.url).pathname === '/v1/libraryHostedReading',
      ),
    ).toBe(false);
  };
  expect(await readHostedCheckpoint(native, 'Bearer member', ids.post, signal)).toEqual({
    state: 'ready',
    value: { state: 'none', subjectId: ids.post },
  });
  expectMetadataReads(1);
  response = saved;
  const available = await readHostedCheckpoint(native, 'Bearer member', ids.post, signal);
  expect(available.state === 'ready' && available.value.state === 'saved' && available.value.resume.availability).toBe(
    'available',
  );
  expect(JSON.stringify(available)).not.toContain('canonicalBytes');
  expect(available.state === 'ready' && available.value.state === 'saved' && available.value.resume).toEqual({
    availability: 'available',
    title: 'Dawn / 黎明',
  });
  expect(available.state === 'ready' && available.value.state === 'saved' && available.value.address).toEqual(address);
  expectMetadataReads(2);
  response = {
    ...saved,
    metadata: { availability: 'unavailable', occurrenceId: ids.first, kind: 'chapter' },
  };
  const withheld = await readHostedCheckpoint(native, 'Bearer member', ids.post, signal);
  expect(withheld.state === 'ready' && withheld.value.state === 'saved' && withheld.value.address).toEqual(address);
  expect(withheld.state === 'ready' && withheld.value.state === 'saved' && withheld.value.resume.availability).toBe(
    'unavailable',
  );
  expectMetadataReads(3);
  response = { state: 'none', subjectId: ids.post };
  expect(await readHostedCheckpoint(native, 'Bearer member', ids.post, signal)).toEqual({
    state: 'ready',
    value: { state: 'none', subjectId: ids.post },
  });
  expectMetadataReads(4);
  response = saved;
  const command = { kind: 'save' as const, subjectId: ids.post, expectedRevision: '1', address };
  const written = await writeHostedCheckpoint(native, 'Bearer member', command, 'save-same-key', signal);
  expect(written).toEqual({
    state: 'ready',
    value: {
      state: 'saved',
      subjectId: ids.post,
      revision: '2',
      address,
      resume: { availability: 'available', title: 'Dawn / 黎明' },
    },
  });
  const put = requests.find((request) => request.method === 'PUT')!;
  expect(put.headers.get('idempotency-key')).toBe('save-same-key');
  expect(await put.json()).toEqual({ ...address, subjectId: ids.post, expectedRevision: '1' });
  expectMetadataReads(5);
  const cleared = await writeHostedCheckpoint(
    native,
    'Bearer member',
    { kind: 'clear', subjectId: ids.post, expectedRevision: '2' },
    'clear-key',
    signal,
  );
  expect(cleared).toEqual({ state: 'ready', value: { state: 'none', subjectId: ids.post } });
  const clear = requests.find((request) => request.method === 'POST')!;
  expect(await clear.json()).toEqual({ subjectId: ids.post, expectedRevision: '2' });
  expectMetadataReads(6);
  response = {
    ...saved,
    metadata: { ...saved.metadata, target: { ...saved.metadata.target, revisionId: ids.currentRelease } },
  };
  expect(await readHostedCheckpoint(native, 'Bearer member', ids.post, signal)).toEqual({ state: 'unavailable' });
  expectMetadataReads(7);
  // Receiver compatibility only: the Library server schema is separately owned.
  for (const position of [511, 512, Number.MAX_SAFE_INTEGER]) {
    response = { ...saved, metadata: { ...saved.metadata, position } };
    expect(await readHostedCheckpoint(native, 'Bearer member', ids.post, signal)).toEqual(available);
  }
  for (const position of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '512', null, {}]) {
    response = { ...saved, metadata: { ...saved.metadata, position } };
    expect(await readHostedCheckpoint(native, 'Bearer member', ids.post, signal)).toEqual({ state: 'unavailable' });
  }
});

test('checkpoint controls retry an uncertain command unchanged and retire late private results', async () => {
  const actual = { ...(await import('../src/books/reader/native-checkpoint')) };
  const book = createIllustrativeHostedBook();
  const source = book.source;
  const reads = mock(async () => ({
    state: 'ready' as const,
    csrfToken: 'csrf',
    value: { state: 'none' as const, subjectId: ids.post },
  }));
  let writeCount = 0;
  const writes = mock(async (input: Parameters<typeof actual.writeNativeHostedCheckpoint>[0]) => {
    if (++writeCount === 1) throw new TypeError('network unavailable');
    if (input.data.command.kind !== 'save') return { state: 'conflict' as const };
    return {
      state: 'ready' as const,
      value: {
        state: 'saved' as const,
        subjectId: ids.post,
        revision: '1',
        address: input.data.command.address,
        resume: { availability: 'unavailable' as const },
      },
    };
  });
  mock.module('../src/books/reader/native-checkpoint', () => ({
    ...actual,
    readNativeHostedCheckpoint: reads,
    writeNativeHostedCheckpoint: writes,
  }));
  try {
    const { HostedBookCheckpoint } = await import('../src/books/reader/checkpoint');
    await mount(source, await book.chapter(), {
      renderCheckpoint: (page, isCurrent, position) => (
        <HostedBookCheckpoint
          page={page}
          position={position}
          isCurrent={isCurrent}
          subjectId={ids.post}
          viewer={ids.author}
          locale="en"
          reload={() => {}}
        />
      ),
    });
    const visible = host.querySelector<HTMLElement>('article [data-block-id]')!;
    visible.getBoundingClientRect = () => new window.DOMRect(0, 120, 300, 80) as DOMRect;
    await click(button(m.book_reader_checkpoint_save()));
    const command = writes.mock.calls[0]![0].data.command;
    expect(command.kind === 'save' && command.address.documentPosition).toEqual({
      blockId: visible.getAttribute('data-block-id'),
      offset: 0,
    });
    visible.getBoundingClientRect = () => new window.DOMRect(0, -200, 300, 80) as DOMRect;
    expect(host.textContent).toContain(m.book_reader_checkpoint_uncertain());
    await click(button(m.book_reader_retry()));
    expect(writes.mock.calls[1]![0].data).toEqual(writes.mock.calls[0]![0].data);
    expect(writes.mock.calls[1]![0].headers).toEqual({ 'X-CSRF-Token': 'csrf' });
    expect(host.textContent).toContain(m.book_reader_checkpoint_saved());
    expect(host.textContent).toContain(m.book_reader_checkpoint_withheld());
    expect([...host.querySelectorAll('a')].some((link) => link.textContent === m.book_reader_checkpoint_resume())).toBe(
      false,
    );
    await click(button(m.book_reader_checkpoint_clear()));
    expect(host.textContent).toContain(m.book_reader_changed());
    expect(writes.mock.calls[2]![0].data.command).toEqual({
      kind: 'clear',
      subjectId: ids.post,
      expectedRevision: '1',
    });
    let complete!: (value: Awaited<ReturnType<typeof reads>>) => void;
    reads.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await click(button(m.book_reader_contents()));
    await act(async () => book.replace());
    await settle();
    await act(async () =>
      complete({ state: 'ready', csrfToken: 'csrf', value: { state: 'none', subjectId: ids.post } }),
    );
    expect(host.textContent).not.toContain(m.book_reader_checkpoint_title());
  } finally {
    mock.module('../src/books/reader/native-checkpoint', () => actual);
  }
});

test('block positions are article-scoped, exact, once-only and cancelled by scrolling or retirement', async () => {
  const { createCheckpointPosition, captureCheckpointBlock } = await import('../src/books/reader/checkpoint-position');
  const book = createIllustrativeHostedBook();
  const chapter = await book.chapter();
  const result = await book.source.read(
    { address: chapter, locale: 'en', limit: 40, ancestorLimit: 24 },
    new AbortController().signal,
  );
  if (result.state !== 'ready' || result.page.kind !== 'chapter') throw new Error('Expected admitted chapter');
  const page = result.page;
  const article = document.createElement('article');
  const controls = document.createElement('section');
  controls.getBoundingClientRect = () => new window.DOMRect(0, 0, 390, 80) as DOMRect;
  document.body.append(controls, article);
  const add = (id: string, top: number, parent = article) => {
    const block = document.createElement('p');
    block.setAttribute('data-block-id', id);
    block.getBoundingClientRect = () => new window.DOMRect(0, top, 300, 100) as DOMRect;
    parent.append(block);
    return block;
  };
  add('outside', 100, document.body);
  add('above', -200);
  add('visible', 100);
  const savedBlock = add('saved', 600);
  expect(captureCheckpointBlock(article, controls)).toEqual({ blockId: 'visible', offset: 0 });
  const address = {
    catalogueId: chapter.publication.id,
    publicationRevisionId: chapter.publication.releaseRevisionId!,
    occurrenceId: chapter.selection.occurrenceId,
    targetRevisionId: chapter.selection.body.revisionId,
    targetSha256: chapter.selection.body.sha256,
    documentPosition: { blockId: 'saved', offset: 37 },
  };
  const saved = {
    state: 'saved' as const,
    subjectId: ids.post,
    revision: '1',
    address,
    resume: { availability: 'available' as const, title: 'Saved' },
  };
  const original = window.scrollBy;
  const scroll = mock(() => {});
  window.scrollBy = scroll;
  try {
    let live = true;
    const position = createCheckpointPosition(page, { current: article }, () => live);
    const disconnect = position.connect();
    await settle();
    const focused = document.activeElement;
    position.restore(saved, controls);
    await settle();
    expect(scroll.mock.calls).toEqual([[{ top: 504, behavior: 'instant' }]]);
    expect(document.activeElement).toBe(focused);
    expect(saved.address.documentPosition.offset).toBe(37);
    position.restore(saved, controls);
    await settle();
    expect(scroll.mock.calls).toHaveLength(1);
    disconnect();
    // Every exact coordinate matters, including two occurrences reusing identical bytes.
    for (const field of [
      'catalogueId',
      'publicationRevisionId',
      'occurrenceId',
      'targetRevisionId',
      'targetSha256',
    ] as const) {
      const other = createCheckpointPosition(page, { current: article }, () => true);
      const stop = other.connect();
      other.restore({ ...saved, address: { ...address, [field]: 'different' } }, controls);
      await settle();
      stop();
    }
    for (const reason of ['null', 'missing', 'withheld', 'viewer', 'scroll', 'pending-scroll', 'retired'] as const) {
      live = true;
      const other = createCheckpointPosition(page, { current: article }, () => live);
      const stop = other.connect();
      await settle();
      if (reason === 'viewer') live = false;
      if (reason === 'scroll') window.dispatchEvent(new window.WheelEvent('wheel'));
      if (reason === 'retired') stop();
      other.restore(
        {
          ...saved,
          address: {
            ...address,
            documentPosition:
              reason === 'null' ? null : { blockId: reason === 'missing' ? 'outside' : 'saved', offset: 37 },
          },
          resume: reason === 'withheld' ? { availability: 'unavailable' } : saved.resume,
        },
        controls,
      );
      if (reason === 'pending-scroll') window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'PageDown' }));
      await settle();
      stop();
    }
    expect(scroll.mock.calls).toHaveLength(1);
    savedBlock.remove();
  } finally {
    window.scrollBy = original;
  }
});

test('a fresh exact reading restores the private block after admission and leaves its public link unchanged', async () => {
  const actual = { ...(await import('../src/books/reader/native-checkpoint')) };
  const book = createIllustrativeHostedBook();
  const chapter = await book.chapter();
  const read = deferred<Awaited<ReturnType<typeof actual.readNativeHostedCheckpoint>>>();
  mock.module('../src/books/reader/native-checkpoint', () => ({
    ...actual,
    readNativeHostedCheckpoint: () => read.promise,
  }));
  const original = window.scrollBy;
  const scroll = mock(() => {});
  window.scrollBy = scroll;
  try {
    const { HostedBookCheckpoint } = await import('../src/books/reader/checkpoint');
    await mount(book.source, chapter, {
      renderCheckpoint: (page, isCurrent, position) => (
        <HostedBookCheckpoint
          page={page}
          isCurrent={isCurrent}
          position={position}
          subjectId={ids.post}
          viewer={ids.author}
          locale="en"
          reload={() => {}}
        />
      ),
    });
    const block = host.querySelector<HTMLElement>('article [data-block-id]')!;
    block.getBoundingClientRect = () => new window.DOMRect(0, 600, 300, 100) as DOMRect;
    await act(async () =>
      read.resolve({
        state: 'ready',
        csrfToken: 'csrf',
        value: {
          state: 'saved',
          subjectId: ids.post,
          revision: '1',
          resume: { availability: 'available', title: 'Saved' },
          address: {
            catalogueId: chapter.publication.id,
            publicationRevisionId: chapter.publication.releaseRevisionId!,
            occurrenceId: chapter.selection.occurrenceId,
            targetRevisionId: chapter.selection.body.revisionId,
            targetSha256: chapter.selection.body.sha256,
            documentPosition: { blockId: block.dataset.blockId!, offset: 73 },
          },
        },
      }),
    );
    await settle();
    expect(scroll.mock.calls).toHaveLength(1);
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === m.book_reader_checkpoint_resume())!;
    const url = new URL(link.href);
    expect([...url.searchParams.keys()].sort()).toEqual(['occurrence', 'release', 'subject', 'view']);
    expect(url.hash).toBe('');
    await settle();
    expect(scroll.mock.calls).toHaveLength(1);
  } finally {
    window.scrollBy = original;
    mock.module('../src/books/reader/native-checkpoint', () => actual);
  }
});
