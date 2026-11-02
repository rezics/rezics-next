import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  applyRecentSearch,
  readRecentDocument,
  readRecentHistory,
  writeRecentDocument,
  rememberRecent,
  recentBucket,
  type RecentEntry,
  type RecentHistory,
  type RecentStorage,
} from '../src/search/recent-history';
import {
  createRecentSearchSyncAdapter,
  nativeRecentEntry,
  RecentSyncError,
  type RecentSearchTransport,
} from '../src/search/recent-sync';
import { RecentPanel } from '../src/search/recent-panel';
import { RecentHistoryView, type RecentItem, type Pending } from '../src/search/recent';
import { m } from '../src/paraglide/messages.js';

const accountId = '019f0000-0000-7000-8000-734100000001';
const collectionId = '019f0000-0000-7000-8000-734100000002';
const bucket = recentBucket('signed-in', accountId)!;
const signal = () => new AbortController().signal;
function memory(): RecentStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function remote(text = 'Native visit', scoped = false): RecentItem {
  return {
    id: '019f0000-0000-7000-8000-734100000003',
    revision: 4,
    lastUsed: new Date().toISOString(),
    entry: { kind: 'query', text, ...(scoped ? { scope: { kind: 'collection', id: collectionId } } : {}) },
    display: {
      name: scoped ? 'Current title' : text,
      href: scoped
        ? `/collections/${collectionId}?q=${encodeURIComponent(text)}`
        : `/search?q=${encodeURIComponent(text)}`,
      avatar: null,
    },
  };
}
function local(storage: RecentStorage, entries: RecentEntry[], removed: string[] = [], clear?: string) {
  const document = readRecentDocument(storage, bucket);
  writeRecentDocument(storage, bucket, { ...document, entries, removed, ...(clear ? { clear } : {}) });
}

test('one existing local store serves PhoneShell Recent and History, hydrates native account rows without a new visit and never uploads anonymous entries', async () => {
  const storage = memory();
  writeRecentDocument(storage, 'anonymous', { entries: rememberRecent([], 'Anonymous only'), removed: [] });
  let owner: string | null = bucket;
  const writes: Pending[] = [];
  let visible: readonly RecentEntry[] = [];
  const adapter = createRecentSearchSyncAdapter({
    accountId,
    bucket,
    currentBucket: () => owner,
    storage,
    onRemote: (entries) => {
      visible = entries;
    },
    transport: {
      read: async () => ({
        accountId,
        page: { revision: 4, next: null, recentSearches: [remote('Scoped query', true)] },
      }),
      write: async (input) => {
        writes.push(input.pending);
        throw new Error('No visit is expected');
      },
    },
  });
  await adapter.sync([], signal());
  await adapter.sync(visible, signal());
  expect(writes).toEqual([]);
  expect(visible[0]?.scope?.name).toBe('Current title');
  const history: RecentHistory = { entries: visible, persistence: 'local', sync: 'synced', remember() {}, remove() {} };
  const phone = renderToStaticMarkup(createElement(RecentPanel, { history }));
  const page = renderToStaticMarkup(createElement(RecentHistoryView, { ...history, history: true }));
  for (const markup of [phone, page]) {
    expect(markup).toContain('Scoped query');
    expect(markup).toContain('Current title');
  }
  expect(readRecentHistory(storage, 'anonymous')[0]?.query).toBe('Anonymous only');
  expect(readRecentHistory(storage, bucket).some((e) => e.query === 'Anonymous only')).toBe(false);
  expect(readRecentHistory(storage, bucket)[0]?.scope).not.toHaveProperty('searchAction');
  owner = 'anonymous';
  await expect(adapter.sync(visible, signal())).rejects.toHaveProperty('name', 'AbortError');
  expect(writes).toEqual([]);
  expect(recentBucket('unknown', accountId)).toBeNull();
  expect(recentBucket('signed-in')).toBeNull();
  adapter.dispose();
});

test('ordered language selections stay distinct through local sync and resume with the same scoped search; old entries keep locale fallback', async () => {
  const storage = memory(),
    now = Date.now(),
    scope = {
      kind: 'Collection' as const,
      id: collectionId,
      name: 'Reading',
      searchAction: `/collections/${collectionId}`,
    };
  const first = rememberRecent([], 'same query', scope, now, ['fr', 'en']);
  const second = rememberRecent(first, 'same query', scope, now + 1, ['ja']);
  const legacy = rememberRecent(second, 'old query', undefined, now + 2);
  expect(first[0]?.id).not.toBe(second[0]?.id);
  expect(legacy[0]?.id).toBe(JSON.stringify([null, null, 'old query']));

  const entries = legacy;
  let revision = 0,
    rows: RecentItem[] = [],
    visible: readonly RecentEntry[] = [];
  const writes: Pending[] = [];
  const transport: RecentSearchTransport = {
    read: async () => ({ accountId, page: { revision, next: null, recentSearches: [...rows] } }),
    write: async ({ pending }) => {
      writes.push(structuredClone(pending));
      if (pending.change.kind === 'remove') {
        const removed = rows.find((row) => row.id === pending.change.id);
        expect(removed?.entry).toMatchObject({ kind: 'query', text: 'same query', languages: ['fr', 'en'] });
        rows = rows.filter((row) => row.id !== pending.change.id);
        return { ok: true, value: { id: null, revision: ++revision, lastUsed: new Date().toISOString() } };
      }
      if (pending.change.kind !== 'use') throw new Error('Expected a recent query visit');
      const entry = pending.change.entry;
      expect(entry.kind).toBe('query');
      const lastUsed = new Date(now + revision).toISOString();
      const id = crypto.randomUUID();
      const params = new URLSearchParams();
      if (entry.kind === 'query') applyRecentSearch(params, entry.text, entry.languages);
      const row: RecentItem = {
        id,
        revision: ++revision,
        lastUsed,
        entry,
        display: {
          name: entry.scope ? 'Current title' : entry.kind === 'query' ? entry.text : '',
          href: `${entry.scope ? `/collections/${collectionId}` : '/search'}?${params}`,
          avatar: null,
        },
      };
      rows = [row, ...rows];
      return { ok: true, value: { id, revision, lastUsed } };
    },
  };
  const makeAdapter = () => createRecentSearchSyncAdapter({
    accountId,
    bucket,
    currentBucket: () => bucket,
    storage,
    onRemote: (next) => {
      visible = next;
    },
  });
  let adapter = makeAdapter();
  local(storage, entries);
  await adapter.sync(entries, signal());

  const stored = readRecentHistory(storage, bucket).filter((entry) => entry.query === 'same query');
  expect(stored.map((entry) => entry.languages).sort()).toEqual([['fr', 'en'], ['ja']]);
  expect(new Set(stored.map((entry) => entry.id)).size).toBe(2);
  const synced = visible.filter((entry) => entry.query === 'same query');
  expect(writes.map((write) => (write.change.kind === 'use' ? write.change.entry.languages : undefined))).toEqual([
    undefined,
    ['ja'],
    ['fr', 'en'],
  ]);
  expect(synced.map((entry) => entry.languages).sort()).toEqual([['fr', 'en'], ['ja']]);
  expect(synced.every((entry) => entry.scope?.id === collectionId)).toBe(true);

  const history: RecentHistory = {
    entries: visible,
    persistence: 'local',
    sync: 'synced',
    remember() {},
    remove() {},
  };
  const markup = renderToStaticMarkup(createElement(RecentHistoryView, { ...history, history: true }));
  expect(markup).toContain(`/en/collections/${collectionId}?q=same%20query&amp;language=fr&amp;language=en`);
  expect(markup).toContain(`/en/collections/${collectionId}?q=same%20query&amp;language=ja`);
  expect(markup).toContain('/en/search?q=old%20query');
  expect(markup).not.toContain('old%20query&amp;language=');

  const resumed = new URL(
    '/collections/current?collection=reading&language=de&q=stale&cursor=old',
    'https://test.invalid',
  );
  applyRecentSearch(resumed.searchParams, 'same query', ['fr', 'en']);
  expect(resumed.searchParams.get('collection')).toBe('reading');
  expect(resumed.searchParams.getAll('language')).toEqual(['fr', 'en']);
  expect(resumed.searchParams.get('q')).toBe('same query');
  expect(resumed.searchParams.has('cursor')).toBe(false);
  const old = new URL('/search?language=de&q=stale', 'https://test.invalid');
  applyRecentSearch(old.searchParams, 'old query');
  expect(old.searchParams.getAll('language')).toEqual([]);

  adapter.dispose();
  adapter = makeAdapter();
  await adapter.sync(readRecentHistory(storage, bucket), signal());
  expect(writes.filter((write) => write.change.kind === 'use')).toHaveLength(3);
  const removed = stored.find((entry) => entry.languages?.[0] === 'fr')!;
  local(storage, readRecentHistory(storage, bucket).filter((entry) => entry.id !== removed.id), [removed.id]);
  await adapter.sync(readRecentHistory(storage, bucket), signal());
  expect(writes.filter((write) => write.change.kind === 'remove')).toHaveLength(1);
  expect(
    readRecentHistory(storage, bucket)
      .filter((entry) => entry.query === 'same query')
      .map((entry) => entry.languages),
  ).toEqual([['ja']]);
  expect(visible.filter((entry) => entry.query === 'same query').map((entry) => entry.languages)).toEqual([['ja']]);
  adapter.dispose();
});

test('offline visits keep query and supported scope references, replay the same receipt/revision, and remove an in-flight visit before clear', async () => {
  const storage = memory();
  let revision = 7,
    rows: RecentItem[] = [],
    fail = false;
  const writes: Parameters<RecentSearchTransport['write']>[0][] = [];
  const adapter = createRecentSearchSyncAdapter({
    accountId,
    bucket,
    currentBucket: () => bucket,
    storage,
    transport: {
      read: async () => ({ accountId, page: { revision, next: null, recentSearches: rows } }),
      write: async (input) => {
        writes.push(structuredClone(input));
        if (fail) throw new Error('offline');
        const change = input.pending.change;
        if (change.kind === 'use') {
          // A local removal made while the request is in flight must survive its receipt and following read.
          local(storage, [], [readRecentHistory(storage, bucket)[0]!.id]);
          rows = [{ ...remote(), entry: change.entry, revision: ++revision }];
          return { ok: true, value: { id: rows[0]!.id, revision, lastUsed: rows[0]!.lastUsed } };
        }
        if (change.kind === 'remove') expect(change.id).toBe(remote().id);
        rows = [];
        return { ok: true, value: { id: null, revision: ++revision, lastUsed: new Date().toISOString() } };
      },
    },
  });
  await adapter.sync([], signal());
  const entries = rememberRecent([], 'query + scope', {
    kind: 'Collection',
    id: collectionId,
    name: 'Forged name',
    image: '/media/forged',
    searchAction: '/forged',
  });
  local(storage, entries);
  fail = true;
  await expect(adapter.sync(entries, signal())).rejects.toBeInstanceOf(RecentSyncError);
  const failed = writes[0]!;
  expect(failed.expectedRevision).toBe(7);
  expect(failed.pending.change).toEqual({
    kind: 'use',
    entry: { kind: 'query', text: 'query + scope', scope: { kind: 'collection', id: collectionId } },
  });
  fail = false;
  await adapter.retry(entries, signal());
  expect(writes[1]!.pending.key).toBe(failed.pending.key);
  expect(writes[1]!.expectedRevision).toBe(7);
  expect(writes[2]!.pending.change.kind).toBe('remove');
  expect(readRecentHistory(storage, bucket)).toEqual([]);
  local(storage, [], [], crypto.randomUUID());
  await adapter.sync([], signal());
  expect(writes.at(-1)!.pending.change.kind).toBe('clear');
  expect(writes.at(-1)!.expectedRevision).toBe(9);
  expect(
    nativeRecentEntry(rememberRecent([], 'local', { kind: 'Zone', id: collectionId, name: 'Zone' })[0]!),
  ).toBeUndefined();
  expect(
    nativeRecentEntry(rememberRecent([], 'realm', { kind: 'Realm', id: collectionId, name: 'Realm' })[0]!),
  ).toHaveProperty('scope.kind', 'realm');
  expect(
    nativeRecentEntry(rememberRecent([], 'library', { kind: 'Library', id: 'library', name: 'Library' })[0]!),
  ).toHaveProperty('scope.route', 'library');
  adapter.dispose();
});

test('conflicts require an explicit reload, stale reads respect removals, and late account results never reach local state', async () => {
  const storage = memory();
  let owner: string | null = bucket,
    revision = 4,
    rows = [remote()],
    conflict = false;
  let finishRead: (() => void) | undefined, started: (() => void) | undefined;
  let readStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let hold = false,
    applied = 0;
  const adapter = createRecentSearchSyncAdapter({
    accountId,
    bucket,
    currentBucket: () => owner,
    storage,
    onRemote: () => {
      applied++;
    },
    transport: {
      read: async () => {
        const page = { revision, next: null, recentSearches: [...rows] };
        if (hold)
          await new Promise<void>((resolve) => {
            finishRead = resolve;
            started!();
          });
        return { accountId, page };
      },
      write: async (input) => {
        if (conflict) return { ok: false, code: 'conflict' };
        expect(input.pending.change.kind).toBe('remove');
        rows = [];
        return { ok: true, value: { id: null, revision: ++revision, lastUsed: new Date().toISOString() } };
      },
    },
  });
  await adapter.sync([], signal());
  const id = readRecentHistory(storage, bucket)[0]!.id;
  local(storage, [], [id]);
  conflict = true;
  await expect(adapter.sync([], signal())).rejects.toHaveProperty('code', 'conflict');
  await expect(adapter.sync([], signal())).rejects.toHaveProperty('code', 'conflict');
  conflict = false;
  await adapter.retry([], signal());
  expect(readRecentHistory(storage, bucket)).toHaveLength(1);
  hold = true;
  const reading = adapter.refresh([], signal());
  await readStarted;
  local(storage, [], [id]);
  hold = false;
  finishRead!();
  await reading;
  expect(readRecentHistory(storage, bucket)).toEqual([]);
  hold = true;
  readStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const late = adapter.refresh([], signal());
  await readStarted;
  const before = applied;
  owner = recentBucket('signed-in', collectionId);
  finishRead!();
  await expect(late).rejects.toHaveProperty('name', 'AbortError');
  expect(applied).toBe(before);
  const unavailable: RecentHistory = {
    entries: rememberRecent([], '', { kind: 'Collection', id: collectionId, name: '' }),
    persistence: 'local',
    sync: 'pending',
    failure: 'unavailable',
    remember() {},
    remove() {},
  };
  const markup = renderToStaticMarkup(createElement(RecentHistoryView, { ...unavailable, history: true }));
  expect(markup).toContain(m.search_history_unavailable());
  expect(markup).toContain(m.search_history_offline());
  expect(markup).not.toContain('href=');
  adapter.dispose();
});
