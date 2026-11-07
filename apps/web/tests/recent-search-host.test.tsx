import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RecentSearchTransport } from '../src/search/recent-contract';
import { useRecentSearchOperation } from '../src/search/recent-host';
import { useRecentSearchSyncAdapter } from '../src/search/recent-sync-hook';
import { recentBucket } from '../src/search/recent-history';
import { RecentSearchBinding } from '../src/session/recent-search-binding';

const accountId = '019f0000-0000-7000-8000-734100000001';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

test('Recent Search refuses a missing host and nested sync uses the mounted transport', async () => {
  function Missing() {
    useRecentSearchOperation();
    return null;
  }
  expect(() => renderToStaticMarkup(createElement(Missing))).toThrow('Recent Search requires a mounted host');

  const transport: RecentSearchTransport = {
    read: async () => ({ accountId, page: { revision: 0, next: null, recentSearches: [] } }),
    write: async () => ({
      ok: true,
      value: { id: '019f0000-0000-7000-8000-734100000003', revision: 1, lastUsed: '2026-11-01T00:00:00.000Z' },
    }),
  };
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: accountId, csrfToken: 'csrf' });
  const storage = { getItem: () => null, setItem: () => {} };
  const seen: RecentSearchTransport[] = [];
  function Nested() {
    seen.push(useRecentSearchOperation().host.transport);
    useRecentSearchSyncAdapter(recentBucket('signed-in', accountId), undefined, storage);
    return null;
  }
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const node = window.document.createElement('div');
  window.document.body.append(node);
  const root = createRoot(node as unknown as HTMLElement);
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RecentSearchBinding, { transport }, createElement(Nested)),
        ),
      ),
    );
    expect(seen[0]).toBe(transport);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    client.clear();
  }
});
