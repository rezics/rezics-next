import { expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { admitRecentPage } from '../src/search/recent-response';
import { recentHistoryDestination, recentReplayDestination } from '../src/search/recent-replay';
import { localRecentEntry, nativeRecentEntry } from '../src/search/recent-sync';
import {
  readRecentHistory,
  writeRecentHistory,
  rememberRecent,
  type RecentHistory,
} from '../src/search/recent-history';
import { searchLoaderDeps, type SearchLoaderDeps } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';
import { searchRequiresCurrentReader } from '../src/search/scoped-search-lifetime';
import { RecentHistoryView, type RecentItem } from '../src/search/recent';
import { RecentPanel } from '../src/search/recent-panel';

const id = '019f0000-0000-7000-8000-734100000002';
const text = '地図 + maps & /?';
function row(kind: 'realm' | 'collection' | 'library', languages?: string[]): RecentItem {
  const scope = kind === 'library' ? { kind: 'route' as const, route: 'library' as const } : { kind, id };
  const entry = { kind: 'query' as const, text, scope, ...(languages ? { languages } : {}) };
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
  const owner = { owner: { presence: true } };
  for (const filter of [owner, { and: [owner] }, { or: [{ type: { in: ['schema:Book'] } }, owner] }, { not: owner }])
    expect(searchRequiresCurrentReader(searchLoaderDeps({ filter: JSON.stringify(filter) }))).toBe(true);
  expect(searchRequiresCurrentReader(searchLoaderDeps({ condition: JSON.stringify(owner) }))).toBe(true);
  for (const filter of [undefined, '{', JSON.stringify({ type: { in: ['schema:Book'] } })])
    expect(searchRequiresCurrentReader(searchLoaderDeps({ filter }))).toBe(false);
  for (const kind of ['realm', 'collection', 'library'] as const)
    for (const languages of [undefined, [], ['ja', 'en']]) {
      const item = row(kind, languages);
      expect(admitRecentPage(page(item))).toBeDefined();
      const local = localRecentEntry(item);
      expect(recentHistoryDestination({ ...local, scope: null as never })).toBeUndefined();
      expect(nativeRecentEntry({ ...local, scope: null as never })).toBeUndefined();
      expect(nativeRecentEntry(local)).toEqual(item.entry);
      expect(rememberRecent([], text, null as never)).toEqual([]);
      const values = new Map<string, string>();
      const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      };
      writeRecentHistory(storage, 'account:reader', [local]);
      expect(recentHistoryDestination(readRecentHistory(storage, 'account:reader')[0]!)).toBeUndefined();
      writeRecentHistory(storage, 'anonymous', [local]);
      expect(recentHistoryDestination(readRecentHistory(storage, 'anonymous')[0]!)).toBe(item.display!.href);
      const href = recentHistoryDestination(local)!;
      expect(href).toBe(item.display!.href);
      expect(request(href)).toMatchObject({
        text,
        languages: languages?.length ? languages : ['fr'],
        filter: { and: [kind === 'library' ? { owner: { presence: true } } : { [kind]: { id } }] },
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
        ...(kind === 'library' ? [] : [href.replace(id, '019f0000-0000-7000-8000-734100000003')]),
        href.replace('q=', 'foreign='),
        href + '#fragment',
        href + '&foreign=%FF',
        '/search?q=x&filter=' + encodeURIComponent('['.repeat(2000) + ']'.repeat(2000)),
      ];
      url.searchParams.set('filter', JSON.stringify({ and: [{ [kind]: { id } }, { kind: { in: ['account'] } }] }));
      corrupt.push(url.pathname + url.search);
      for (const owner of [{ presence: false }, { presence: true, accountId: id }]) {
        url.searchParams.set('filter', JSON.stringify({ owner }));
        corrupt.push(url.pathname + url.search);
      }
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
  const remembered: Parameters<RecentHistory['remember']>[] = [];
  const history: RecentHistory = {
    entries: [
      localRecentEntry(row('realm', ['ja', 'en'])),
      localRecentEntry(row('collection', [])),
      localRecentEntry(row('library')),
    ],
    owner: () => current,
    persistence: 'memory',
    sync: 'synced',
    remember(...args) {
      remembered.push(args);
    },
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
    expect(links).toHaveLength(6);
    expect(links.slice(0, 3).map((link) => link.getAttribute('href'))).toEqual(
      links.slice(3).map((link) => link.getAttribute('href')),
    );
    for (const link of links) expect(request(link.href).text).toBe(text);
    host.addEventListener('click', (event) => event.preventDefault(), { capture: true, once: true });
    await act(async () => {
      links[0]!.click();
    });
    expect(remembered).toEqual([[text, history.entries[0]!.scope, ['ja', 'en']]]);
    current = false;
    for (const link of links) {
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      await act(async () => {
        link.dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(true);
    }
    expect(remembered).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});

test('Library activation uses the installed session reader and HTTP result path; retirement cancels publication', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const start = await import('../.storybook/react-start');
  const requests = new AsyncLocalStorage<Request>();
  let principal = id;
  const credentialReads: string[] = [];
  mock.module('cloudflare:workers', () => ({
    env: {
      KERNEL_ORIGIN: 'https://kernel.test',
      SITE_ORIGINS: 'https://site.test',
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://api.test',
      WEBSITE_SCOPES: 'openid subject:read',
      WEBSITE_CLIENT_ID: 'web',
      WEBSITE_CLIENT_KEY: 'unused',
      SESSIONS: {
        idFromName: (name: string) => name,
        get: () => ({
          credential: async () => {
            credentialReads.push(principal);
            return { status: 'active', subject: principal, accessToken: `token-${principal}` };
          },
        }),
      },
    },
  }));
  mock.module('@tanstack/react-start', () => ({
    ...start,
    createServerFn: () => {
      const original = start.createServerFn();
      const chain = {
        validator(validate: (input: unknown) => unknown) {
          original.validator(validate);
          return chain;
        },
        handler<T extends (...args: never[]) => unknown>(handler: T): T {
          const invoke = original.handler(handler);
          return ((input: { signal?: AbortSignal }) =>
            requests.run(
              new Request('https://site.test/en/search', {
                headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
                signal: input.signal,
              }),
              () => invoke(input as never),
            )) as unknown as T;
        },
      };
      return chain;
    },
  }));
  mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => requests.getStore()! }));
  const pending: { request: Request; resolve: (response: Response) => void }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const request = new Request(url, init);
    if (!request.url.endsWith('/subjects:search')) return Response.json({}, { status: 503 });
    expect(request.headers.get('authorization')).toBe(`Bearer token-${id}`);
    expect(await request.clone().json()).toMatchObject({ text, filter: { and: [{ owner: { presence: true } }] } });
    return new Promise<Response>((resolve) => pending.push({ request, resolve }));
  }) as typeof fetch;
  const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
  const { createRoot } = await import('react-dom/client');
  const { useSearchQuery } = await import('../src/search/use-search-query');
  const { searchQueryOptions } = await import('../src/search/search-queries');
  const { searchSessionOwner } = await import('../src/search/search-session-owner');
  const { discoveryExample } = await import('../src/kernel/fake/search-discovery');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  notifyManager.setScheduler((callback) => callback());
  const client = new QueryClient();
  const reader = searchSessionOwner({ state: 'signed-in', subject: id })!;
  let current = true;
  let selected: SearchLoaderDeps | undefined;
  const history: RecentHistory = {
    entries: [localRecentEntry(row('library'))],
    owner: () => current,
    persistence: 'memory',
    sync: 'synced',
    remember() {},
    remove() {},
  };
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  function Results() {
    const { data } = useSearchQuery('en', selected!, reader);
    return (
      <output>
        {data.discovery?.status === 'ready' ? JSON.stringify(data.discovery.page.hits) : data.recovery?.status}
      </output>
    );
  }
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <RecentPanel history={history} global={false} />
        <RecentHistoryView {...history} history />
        {selected && <Results />}
      </QueryClientProvider>,
    );
  // Follow the anchor destination into the installed Search query; no replay callback performs the read.
  host.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const link = (event.target as HTMLElement).closest('a');
    if (!link) return;
    event.preventDefault();
    selected = searchLoaderDeps(Object.fromEntries(new URL(link.href).searchParams));
    render();
  });
  try {
    await act(async () => render());
    const links = [...host.querySelectorAll<HTMLAnchorElement>('a[href*="filter="]')];
    expect(links).toHaveLength(2);
    expect(pending).toHaveLength(0);
    for (const link of links) {
      await act(async () => link.click());
      expect(selected!.resourceScope).toBeUndefined();
      expect(searchQueryOptions('en', selected!, reader).gcTime).toBe(0);
      expect(pending).toHaveLength(1);
      expect(credentialReads).toEqual([id]);
      await act(async () => pending[0]!.resolve(Response.json(discoveryExample)));
      expect(host.querySelector('output')!.textContent).toContain('Mira’s Atlas');
      selected = undefined;
      await act(async () => render());
      expect(
        client
          .getQueryCache()
          .getAll()
          .every((query) => query.getObserversCount() === 0),
      ).toBe(true);
      client.clear();
      pending.length = credentialReads.length = 0;
    }
    for (const retirement of ['reader', 'account', 'abort']) {
      current = true;
      principal = id;
      await act(async () => links[0]!.click());
      expect(pending).toHaveLength(1);
      const state = selected!;
      current = false;
      if (retirement !== 'abort') principal = '019f0000-0000-7000-8000-734100000003';
      selected = undefined;
      await act(async () => render());
      expect(pending[0]!.request.signal.aborted).toBe(true);
      await act(async () => pending[0]!.resolve(Response.json(discoveryExample)));
      for (const link of links) await act(async () => link.click());
      expect(pending).toHaveLength(1);
      expect(host.textContent).not.toContain('Mira’s Atlas');
      if (retirement !== 'abort') {
        const stale = await client.fetchQuery(searchQueryOptions('en', state, reader));
        expect(stale.recovery?.status).toBe('session');
        expect(pending).toHaveLength(1);
      }
      client.clear();
      pending.length = credentialReads.length = 0;
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
