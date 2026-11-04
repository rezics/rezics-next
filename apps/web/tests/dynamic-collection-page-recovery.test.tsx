import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { DynamicMembersResult } from '../src/library/collection-load';
import type { DynamicCollectionPage as Page } from '../src/library/dynamic-collection';
import { m } from '../src/paraglide/messages.js';

// UNRUN: actual page and shared feedback/member components; native, browser and Storybook
// acceptance remain controller obligations. No fixture replaces the reader's authority boundary.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/original' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { DynamicCollectionPage } = await import('../src/library/dynamic-collection-page');
const { libraryNavigationQuery } = await import('../src/library/pins-read');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  setLocale('en', { reload: false });
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const cursor = ' requested/+==?f.=old&cursor=other#二% ';
const next = ' native-next/+==?f.=next&cursor=other#三% ';
const filter: NonNullable<Page['filter']> = { statement: { property: 'schema:keywords', in: ['concept-b'] } };
const subject = (id: string, label: string): Page['members'][number] => ({
  subject: { id, label, type: 'schema:Book', types: ['schema:Book'], cover: null },
});
function page(change: Partial<Page> = {}): Page {
  return {
    id: 'collection /%二?&',
    title: 'Dynamic Collection',
    builtinKind: 'everything',
    description: null,
    curator: null,
    members: [],
    next: null,
    preparing: false,
    unavailable: false,
    retryAfterMs: 1000,
    ...change,
  };
}
type Search = Record<string, string | string[]>;
async function mount(locale: Parameters<typeof setLocale>[0] = 'en') {
  window.history.replaceState(null, '', `/${locale}/collections/original`);
  setLocale(locale, { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, gcTime: Infinity } },
  });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
  client.setQueryData(exposureQuery.queryKey, []);
  client.setQueryData(libraryNavigationQuery(locale, 100).queryKey, { pins: { state: 'closed' }, collections: [] });
  const read = mock(async () => {
    throw new Error('Ready-page navigation must not read automatically');
  });
  return {
    host,
    read,
    async render(data: Page, search?: Search, reader?: (id: string, cursor?: string) => Promise<DynamicMembersResult>) {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              <DynamicCollectionPage
                page={data}
                {...(search ? { search } : {})}
                {...(reader ? { readMembers: reader } : !data.preparing ? { readMembers: read } : {})}
              />
            </RouterContextProvider>
          </QueryClientProvider>,
        );
      });
    },
    async close() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      window.history.replaceState(null, '', '/en/collections/original');
      setLocale('en', { reload: false });
    },
  };
}
function memberNavigation(host: HTMLElement) {
  return host.querySelector<HTMLElement>(`nav[aria-label="${m.library_collection_members()}"]`);
}
function link(host: HTMLElement, label: string) {
  const matches = [...host.querySelectorAll<HTMLAnchorElement>('a')].filter(
    (node) => node.textContent?.trim() === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
function noGlobalEmpty(host: HTMLElement) {
  for (const label of [
    m.library_dynamic_empty_everything(),
    m.library_dynamic_empty_liked(),
    m.library_collection_empty(),
    m.collection_filter_no_match(),
  ])
    expect(host.textContent).not.toContain(label);
}

test('Only an exhausted ready first page asserts builtin, state or admitted-filter emptiness', async () => {
  const h = await mount();
  try {
    for (const [builtinKind, expected] of [
      ['everything', m.library_dynamic_empty_everything()],
      ['liked', m.library_dynamic_empty_liked()],
      ['state', m.library_collection_empty()],
      ['other', m.library_collection_empty()],
    ] as const) {
      await h.render(page({ builtinKind }));
      expect(h.host.textContent).toContain(expected);
      expect(h.host.textContent).not.toContain(m.library_dynamic_page_reader_empty());
      expect(memberNavigation(h.host)).toBeNull();
    }
    await h.render(page({ filter, filterType: 'schema:Book' }));
    expect(h.host.textContent).toContain(m.collection_filter_no_match());
    expect(h.host.textContent).not.toContain(m.library_dynamic_empty_everything());
    expect(link(h.host, m.collection_filter_clear())).toBeDefined();
    expect(memberNavigation(h.host)).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Empty later pages, including sparse continuations, assert only page-local absence', async () => {
  const h = await mount();
  try {
    for (const builtinKind of ['everything', 'liked', 'state']) {
      for (const admitted of [undefined, filter]) {
        for (const continuation of [null, next]) {
          await h.render(page({ builtinKind, cursor, next: continuation, ...(admitted ? { filter: admitted } : {}) }));
          noGlobalEmpty(h.host);
          expect(h.host.textContent).toContain(m.library_dynamic_page_reader_empty());
          const nav = memberNavigation(h.host)!;
          expect(link(nav, m.library_dynamic_page_reader_first_page())).toBeDefined();
          expect(nav.querySelectorAll('a')).toHaveLength(continuation ? 2 : 1);
          expect(h.host.textContent).not.toContain(m.collection_filter_clear());
        }
      }
    }
    await h.render(page({ next, filter }));
    noGlobalEmpty(h.host);
    expect(h.host.textContent).toContain(m.library_dynamic_page_reader_empty());
    expect(memberNavigation(h.host)!.querySelectorAll('a')).toHaveLength(1);
    expect(link(memberNavigation(h.host)!, m.library_collection_more())).toBeDefined();
    expect(h.read).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('First members page removes only cursor from the admitted protocol; Next carries the exact native cursor', async () => {
  const h = await mount('fr');
  const search: Search = {
    type: ['schema:Book', 'schema:Book'],
    'f.schema:keywords': ['concept-b', 'concept-a', 'concept-b'],
    'r.schema:wordCount': ['0,0010', ' 2,3 '],
    'l.schema:keywords': ['  Original + & ? / 二  ', 'Repeated', 'Repeated'],
    cursor: 'untrusted search cursor',
    layout: 'grid',
    q: 'excluded',
    'f.bad/key': 'excluded',
  };
  const expected = [
    ['type', 'schema:Book'],
    ['type', 'schema:Book'],
    ['f.schema:keywords', 'concept-b'],
    ['f.schema:keywords', 'concept-a'],
    ['f.schema:keywords', 'concept-b'],
    ['r.schema:wordCount', '0,0010'],
    ['r.schema:wordCount', ' 2,3 '],
    ['l.schema:keywords', '  Original + & ? / 二  '],
    ['l.schema:keywords', 'Repeated'],
    ['l.schema:keywords', 'Repeated'],
  ];
  const original = structuredClone(search);
  try {
    const data = page({ cursor, next, filter });
    await h.render(data, search);
    const nav = memberNavigation(h.host)!;
    const first = link(nav, m.library_dynamic_page_reader_first_page());
    const more = link(nav, m.library_collection_more());
    for (const anchor of [first, more]) {
      const url = new URL(anchor.href);
      expect(url.pathname).toBe(`/fr/collections/${encodeURIComponent(data.id)}`);
      expect(url.hash).toBe('');
      expect([...url.searchParams]).toEqual(anchor === first ? expected : [...expected, ['cursor', next]]);
      expect(anchor.tabIndex).toBe(0);
      anchor.focus();
      expect(document.activeElement).toBe(anchor);
    }
    expect(search).toEqual(original);
    await h.render(page({ cursor }));
    expect(link(memberNavigation(h.host)!, m.library_dynamic_page_reader_first_page()).getAttribute('href')).toBe(
      `/fr/collections/${encodeURIComponent(data.id)}`,
    );
    expect(h.read).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Nonempty later recovery preserves shared rows, native order, duplicate destinations and unavailable subjects', async () => {
  const h = await mount();
  try {
    const members: Page['members'] = [
      subject('b', 'Second'),
      {
        subject: null,
        facts: { 'schema:author': [{ kind: 'item', id: 'hidden-author', labels: { en: 'Hidden author' } }] },
      },
      subject('a', 'First'),
      subject('b', 'Second'),
    ];
    await h.render(page({ cursor, next, members, filter }));
    noGlobalEmpty(h.host);
    expect(h.host.textContent).not.toContain(m.library_dynamic_page_reader_empty());
    const list = h.host.querySelector('[data-collection-members]')!;
    expect([...list.querySelectorAll('a')].map((anchor) => anchor.textContent)).toEqual(['Second', 'First', 'Second']);
    expect(list.textContent).toContain(m.library_subject_unavailable());
    expect(list.textContent).not.toContain('Hidden author');
    expect(list.querySelectorAll('li')).toHaveLength(4);
    expect([...list.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))).toEqual([
      '/en/subjects/b/second',
      '/en/subjects/a/first',
      '/en/subjects/b/second',
    ]);
    expect(memberNavigation(h.host)!.querySelectorAll('a')).toHaveLength(2);
    await h.render(page({ members }));
    expect(memberNavigation(h.host)).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Unavailable, preparing and filter failure feedback never becomes ready emptiness or retained-member authority', async () => {
  const h = await mount();
  try {
    for (const [change, expected] of [
      [{ unavailable: true }, m.library_dynamic_unavailable()],
      [{ preparing: true }, m.library_dynamic_preparing()],
      [{ filterStatus: 'unsupported' }, m.collection_filter_unsupported()],
      [{ filterStatus: 'failed' }, m.collection_filter_failed()],
      [{ filterStatus: 'preparing' }, m.collection_filter_preparing()],
    ] as const) {
      for (const requested of [undefined, cursor]) {
        for (const retained of [[], [subject('old', 'Retained member')]]) {
          await h.render(
            page({ ...(requested ? { cursor: requested } : {}), next, filter, members: retained, ...change }),
          );
          expect(h.host.textContent).toContain(expected);
          noGlobalEmpty(h.host);
          expect(h.host.textContent).not.toContain(m.library_dynamic_page_reader_empty());
          expect(h.host.textContent).not.toContain('Retained member');
          expect(memberNavigation(h.host)).toBeNull();
        }
      }
    }
    await h.render(page({ cursor, next, filterIgnored: ['f.unavailable'] }));
    expect(h.host.textContent).toContain(m.collection_filter_ignored({ filter: 'f.unavailable' }));
    expect(h.host.textContent).not.toContain(m.library_dynamic_page_reader_empty());
    expect(h.host.textContent).toContain(m.collection_filter_address_rejected());
    expect(memberNavigation(h.host)).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('All eight locale variants supply named recovery and page-local absence', async () => {
  const h = await mount();
  try {
    for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      for (const key of [
        'library_dynamic_retry_unavailable',
        'library_dynamic_retry_unavailable_help',
        'library_dynamic_retry_preparing_help',
        'library_dynamic_retry_pending',
        'library_dynamic_retry_ready',
      ])
        expect(messages[key].trim().length).toBeGreaterThan(0);
      expect(messages.library_dynamic_page_reader_empty.trim().length).toBeGreaterThan(0);
      expect(messages.library_dynamic_page_reader_first_page.trim().length).toBeGreaterThan(0);
      window.history.replaceState(null, '', `/${locale}/collections/original`);
      setLocale(locale, { reload: false });
      await h.render(page({ cursor, next }));
      expect(h.host.textContent).toContain(messages.library_dynamic_page_reader_empty);
      expect(
        link(memberNavigation(h.host)!, messages.library_dynamic_page_reader_first_page).getAttribute('href'),
      ).toStartWith(`/${locale}/collections/`);
    }
  } finally {
    await h.close();
  }
});

test('A failed preparing read can retry its exact saved/filter/cursor reader and pauses after bounded exhaustion', async () => {
  const h = await mount();
  const timers = new Map<number, () => void>();
  let sequence = -1;
  const nativeSet = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (typeof delay !== 'number' || delay < 1000 || delay > 30_000) return nativeSet(run, delay, ...args);
    const key = sequence--;
    timers.set(key, () => run(...args));
    return key;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClear(id);
  }) as typeof clearTimeout);
  const calls: Array<[string, string | undefined, string]> = [];
  let response: DynamicMembersResult | Error = new Error('Preparing read failed');
  const reader = async (id: string, cursor?: string): Promise<DynamicMembersResult> => {
    calls.push([id, cursor, JSON.stringify(filter)]);
    if (response instanceof Error) throw response;
    return response;
  };
  const fire = () =>
    act(async () => {
      expect(timers.size).toBe(1);
      const [key, run] = [...timers][0]!;
      timers.delete(key);
      run();
    });
  const click = (label: string) =>
    act(async () => {
      const button = [...h.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent === label,
      )!;
      expect(button).toBeDefined();
      button.focus();
      button.click();
      button.click(); // The synchronous lock admits one request.
    });
  const original = page({ builtinKind: undefined, preparing: true, filter, cursor, filterStatus: 'preparing' });
  try {
    await h.render(original, { 'f.schema:keywords': ['concept-b'] }, reader);
    await fire();
    expect(h.host.textContent).toContain(m.library_dynamic_unavailable());
    expect(h.host.textContent).not.toContain(m.collection_filter_preparing());
    expect(timers.size).toBe(0);
    expect(h.host.textContent).toContain(m.library_dynamic_retry_unavailable());
    // Callback replacement at the same observation cannot retarget the captured recovery request.
    const foreignReader = mock(async (): Promise<DynamicMembersResult> => {
      throw new Error('Wrong reader');
    });
    await h.render(original, { 'f.schema:keywords': ['concept-b'] }, foreignReader);
    response = { members: [], next: null, preparing: true, retryAfterMs: 1000, unavailable: false };
    await click(m.library_dynamic_retry_unavailable());
    await fire();
    await fire();
    expect(calls).toHaveLength(4);
    expect(timers.size).toBe(0);
    expect(h.host.textContent).toContain(m.library_dynamic_try_later());
    response = {
      members: [subject('current', 'Current result')],
      next: null,
      preparing: false,
      retryAfterMs: 1000,
      unavailable: false,
    };
    await click(m.library_collection_reload());
    expect(calls).toHaveLength(5);
    expect(
      calls.every((call) => JSON.stringify(call) === JSON.stringify([original.id, cursor, JSON.stringify(filter)])),
    ).toBe(true);
    expect(foreignReader).not.toHaveBeenCalled();
    expect(h.host.textContent).toContain('Current result');
    expect(h.host.textContent).not.toContain(m.library_dynamic_unavailable());
    expect(h.host.textContent).not.toContain(m.library_dynamic_try_later());
    expect(timers.size).toBe(0);
    expect(document.activeElement?.textContent).toBe(m.library_dynamic_retry_ready());
  } finally {
    await h.close();
    set.mockRestore();
    clear.mockRestore();
  }
});
