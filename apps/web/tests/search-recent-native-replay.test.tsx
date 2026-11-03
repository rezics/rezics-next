import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { admitRecentPage } from '../src/search/recent-response';
import { recentHistoryDestination, recentReplayDestination } from '../src/search/recent-replay';
import { localRecentEntry } from '../src/search/recent-sync';
import { readRecentHistory, writeRecentHistory, type RecentHistory } from '../src/search/recent-history';
import { searchLoaderDeps } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';
import { searchRequiresCurrentReader } from '../src/search/scoped-search-lifetime';
import { RecentHistoryView, type RecentItem } from '../src/search/recent';
import { RecentPanel } from '../src/search/recent-panel';

const id = '019f0000-0000-7000-8000-734100000002';
const text = '地図 + maps & /?';
function row(kind: 'realm' | 'collection', languages?: string[]): RecentItem {
  const entry = { kind: 'query' as const, text, scope: { kind, id }, ...(languages ? { languages } : {}) };
  return {
    id: crypto.randomUUID(),
    revision: 4,
    lastUsed: new Date().toISOString(),
    entry,
    display: { name: 'Current name', href: recentReplayDestination(entry)!, avatar: null },
  };
}
const page = (item: RecentItem) => ({ recentSearches: [item], next: null, revision: 4 });
function request(href: string) {
  const params = new URL(href, 'https://site.test').searchParams;
  const state = searchLoaderDeps({
    q: params.get('q'),
    filter: params.get('filter') ?? undefined,
    ...(params.has('language') ? { language: params.getAll('language') } : {}),
  });
  expect(state.invalidInput).toBeUndefined();
  expect(searchRequiresCurrentReader(state)).toBe(true);
  return discoveryRequest(state, ['fr']);
}

test('native admission and local replay preserve exactly the installed Search request and reject changed evidence', () => {
  for (const kind of ['realm', 'collection'] as const)
    for (const languages of [undefined, [], ['ja', 'en']]) {
      const item = row(kind, languages);
      expect(admitRecentPage(page(item))).toBeDefined();
      const local = localRecentEntry(item);
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      };
      writeRecentHistory(storage, 'account:reader', [local]);
      expect(recentHistoryDestination(readRecentHistory(storage, 'account:reader')[0]!)).toBeUndefined();
      const href = recentHistoryDestination(local)!;
      expect(href).toBe(item.display!.href);
      expect(request(href)).toMatchObject({
        text,
        languages: languages?.length ? languages : ['fr'],
        filter: { and: [{ [kind]: { id } }] },
      });
      const equivalent = href.replaceAll('%20', '+').replaceAll('%2F', '%2f');
      expect(admitRecentPage(page({ ...item, display: { ...item.display!, href: equivalent } }))).toBeDefined();
      const url = new URL(href, 'https://site.test');
      const corrupt = [
        href + '&q=other',
        href + '&cursor=opaque',
        href + '&language=de',
        href + '&filter=%7B%7D',
        href.replace('/search?', '/library?'),
        `https://evil.test${href}`,
        href.replace(encodeURIComponent(id), '019f0000-0000-7000-8000-734100000003'),
        href.replace('q=', 'foreign='),
        href + '#fragment',
        href + '&foreign=%FF',
        '/search?q=x&filter=' + encodeURIComponent('['.repeat(2000) + ']'.repeat(2000)),
      ];
      url.searchParams.set('filter', JSON.stringify({ and: [{ [kind]: { id } }, { kind: { in: ['account'] } }] }));
      corrupt.push(url.pathname + url.search);
      for (const href of corrupt) {
        expect(admitRecentPage(page({ ...item, display: { ...item.display!, href } }))).toBeUndefined();
        expect(recentHistoryDestination({ ...local, scope: { ...local.scope!, searchAction: href } })).toBeUndefined();
      }
    }
  const library = {
    ...row('realm'),
    entry: { kind: 'query' as const, text, scope: { kind: 'route' as const, route: 'library' as const } },
    display: null,
  };
  expect(admitRecentPage(page(library))).toBeDefined();
  expect(recentHistoryDestination(localRecentEntry(library))).toBeUndefined();
});

test('both mounted Recent interfaces expose the same scoped replay and prevent activation after ownership retires', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  let current = true;
  const history: RecentHistory = {
    entries: [localRecentEntry(row('realm', ['ja', 'en'])), localRecentEntry(row('collection', []))],
    owner: () => current,
    persistence: 'memory',
    sync: 'synced',
    remember() {},
    remove() {},
  };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(RecentPanel, { history, global: false }),
          createElement(RecentHistoryView, { ...history, history: true }),
        ),
      ),
    );
    const links = [...host.querySelectorAll<HTMLAnchorElement>('a[href*="filter="]')];
    expect(links).toHaveLength(4);
    expect(links.slice(0, 2).map((link) => link.getAttribute('href'))).toEqual(
      links.slice(2).map((link) => link.getAttribute('href')),
    );
    for (const link of links) expect(request(link.href).text).toBe(text);
    current = false;
    for (const link of links) {
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => {
        link.dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(true);
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
