import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as start from '../.storybook/react-start';
import type { BrowserSession } from '../src/session/browser-state';
import { recentBucket, readRecentDocument, rememberRecent, writeRecentDocument } from '../src/search/recent-history';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const accountId = '019f0000-0000-7000-8000-734100000001';
let client: QueryClient;
let reads: (string | null)[] = [];
let rows: any[] = [];
let revision = 4;
let resolveFirstRead!: (value: unknown) => void;
let announceFirstRead!: () => void;
let firstReadStarted = new Promise<void>((resolve) => (announceFirstRead = resolve));
let writes: { key: string; expectedRevision: number; csrf: string }[] = [];
mock.module('../src/search/recent', () => ({
  readRecent: async () => {
    reads.push((client.getQueryData(['session']) as BrowserSession).csrfToken);
    if (reads.length === 1) {
      announceFirstRead();
      return new Promise((resolve) => (resolveFirstRead = resolve));
    }
    return { accountId, page: { revision, next: null, recentSearches: [...rows] } };
  },
  writeRecent: async ({ data, headers }: any) => {
    const { pending } = data;
    revision = data.expectedRevision + 1;
    const id = '019f0000-0000-7000-8000-734100000004';
    const lastUsed = '2026-11-03T00:00:00.000Z';
    writes.push({ key: pending.key, expectedRevision: data.expectedRevision, csrf: headers['X-CSRF-Token'] });
    if (pending.change.kind === 'use')
      rows.push({ id, revision, lastUsed, entry: pending.change.entry, display: { name: 'Saved search', href: '/search?q=saved', avatar: null } });
    return { ok: true, value: { id, revision, lastUsed } };
  },
}));
const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const [{ sessionQuery }, { useRecentSearchSyncAdapter }] = await Promise.all([
  import('../src/session/query'),
  import('../src/search/recent-sync-hook'),
]);

test('same-account session replacement retires late work and resumes its pending visit with current reads', async () => {
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  client = new QueryClient();
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  const bucket = recentBucket('signed-in', accountId)!;
  const entries = rememberRecent([], 'Saved search', undefined, Date.now());
  writeRecentDocument(storage, bucket, { entries, removed: [] });
  const published: string[] = [];
  let adapter: ReturnType<typeof useRecentSearchSyncAdapter>;
  function Owner() {
    adapter = useRecentSearchSyncAdapter(bucket, (next) => published.push(...next.map((entry) => entry.query)), storage);
    return null;
  }
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  reads = [];
  revision = 4;
  rows = [{ id: '019f0000-0000-7000-8000-734100000005', revision, lastUsed: '2026-11-02T00:00:00.000Z', entry: { kind: 'query', text: 'Current native history' }, display: { name: 'Current native history', href: '/search?q=current', avatar: null } }];
  writes = [];
  firstReadStarted = new Promise<void>((resolve) => (announceFirstRead = resolve));
  try {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken: 'csrf-old' });
    await act(async () => root.render(<QueryClientProvider client={client}><Owner /></QueryClientProvider>));
    const oldAdapter = adapter!;
    const oldRun = oldAdapter.sync(entries, new AbortController().signal);
    await firstReadStarted;
    const pendingKey = (readRecentDocument(storage, bucket).native as { pending: { key: string }[] }).pending[0]!.key;
    await act(async () => client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken: 'csrf-new' }));
    const freshAdapter = adapter!;
    expect(freshAdapter).not.toBe(oldAdapter);
    expect(readRecentDocument(storage, bucket).native).toMatchObject({ pending: [{ key: pendingKey }] });
    resolveFirstRead({ accountId, page: { revision: 4, next: null, recentSearches: [{ id: '019f0000-0000-7000-8000-734100000006', revision: 4, lastUsed: '2026-11-01T00:00:00.000Z', entry: { kind: 'query', text: 'Stale old session' }, display: { name: 'Stale old session', href: '/search?q=stale', avatar: null } }] } });
    await expect(oldRun).rejects.toHaveProperty('name', 'AbortError');
    await freshAdapter!.sync(entries, new AbortController().signal);
    expect(reads).toEqual(['csrf-old', 'csrf-new', 'csrf-new']);
    expect(writes).toEqual([{ key: pendingKey, expectedRevision: 4, csrf: 'csrf-new' }]);
    expect(published).toContain('Current native history');
    expect(published).toContain('Saved search');
    expect(published).not.toContain('Stale old session');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    client.clear();
  }
});
