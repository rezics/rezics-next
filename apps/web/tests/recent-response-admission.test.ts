import { expect, test } from 'bun:test';
import {
  readRecentDocument,
  readRecentHistory,
  rememberRecent,
  writeRecentDocument,
  type RecentEntry,
  type RecentStorage,
} from '../src/search/recent-history';
import { createRecentSearchSyncAdapter, RecentSyncError, type RecentSearchTransport } from '../src/search/recent-sync';
import type { RecentItem, RecentPage, Pending } from '../src/search/recent';

const accountId = '019f0000-0000-7000-8000-734100000001';
const collectionId = '019f0000-0000-7000-8000-734100000002';
const realmId = '019f0000-0000-7000-8000-734100000008';
const otherId = '019f0000-0000-7000-8000-734100000009';
const bucket = `account:${accountId}`;
const signal = () => new AbortController().signal;
function memory(): RecentStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}
function queryHref(path: string, text: string, languages?: readonly string[]) {
  return `${path}?${[`q=${encodeURIComponent(text)}`, ...(languages ?? []).map((tag) => `language=${encodeURIComponent(tag)}`)].join('&')}`;
}
function item(entry: RecentItem['entry'], display: RecentItem['display'], revision = 4): RecentItem {
  return { id: crypto.randomUUID(), revision, lastUsed: new Date().toISOString(), entry, display };
}
function globalQuery(text: string, languages?: readonly string[]): RecentItem {
  return item(
    { kind: 'query', text, ...(languages ? { languages: [...languages] } : {}) },
    { name: text, href: queryHref('/search', text, languages), avatar: null },
  );
}
function page(rows: RecentItem[], next: string | null = null, revision = 4): RecentPage {
  return { recentSearches: rows, next, revision };
}
type Journal = { revision: number | null; pending: Pending[]; rows: Record<string, { id: string }> };

test('Malformed native Recent pages never replace accepted local history or supply revision, identity or scope actions to pending commands', async () => {
  const storage = memory();
  const writes: Parameters<RecentSearchTransport['write']>[0][] = [];
  let visible: readonly RecentEntry[] = [];
  let native: (cursor?: string) => unknown = () => null;
  const adapter = createRecentSearchSyncAdapter({
    accountId,
    bucket,
    currentBucket: () => bucket,
    storage,
    onRemote: (entries) => {
      visible = entries;
    },
    transport: {
      read: async (cursor) => ({ accountId, page: native(cursor) as RecentPage }),
      write: async (input) => {
        writes.push(input);
        const revision = input.expectedRevision + 1;
        return { ok: true, value: { id: crypto.randomUUID(), revision, lastUsed: new Date().toISOString() } };
      },
    },
  });
  const kept = rememberRecent([], 'Kept local');
  writeRecentDocument(storage, bucket, { entries: kept, removed: [] });
  const valid = globalQuery('Kept local');
  const scoped = item(
    { kind: 'query', text: 'Scoped query', scope: { kind: 'collection', id: collectionId } },
    { name: 'Reading', href: queryHref(`/collections/${collectionId}`, 'Scoped query'), avatar: null },
  );
  const foreign: unknown[] = [
    page([{ ...scoped, entry: { kind: 'scope', scope: { kind: 'collection', id: 'not-a-uuid' } } } as RecentItem]),
    page([
      {
        ...scoped,
        display: { name: 'Reading', href: queryHref(`/collections/${otherId}`, 'Scoped query'), avatar: null },
      },
    ]),
    page([
      {
        ...scoped,
        display: { name: 'Reading', href: queryHref(`/realms/${collectionId}`, 'Scoped query'), avatar: null },
      },
    ]),
    page([
      {
        ...scoped,
        display: {
          name: 'Reading',
          href: `https://evil.example/collections/${collectionId}?q=Scoped%20query`,
          avatar: null,
        },
      },
    ]),
    page([{ ...valid, lastUsed: 'not-a-date' }]),
    { ...page([valid]), revision: 1.5 },
    { ...page([valid]), revision: -1 },
    page([
      item(
        { kind: 'query', text: 'Kept local', languages: ['not a tag'] },
        { name: 'Kept local', href: '/search?q=Kept%20local&language=not%20a%20tag', avatar: null },
      ),
    ]),
  ];
  const snapshot = () => ({
    entries: readRecentHistory(storage, bucket),
    journal: readRecentDocument(storage, bucket).native as Journal,
  });
  for (const malformed of foreign) {
    native = () => malformed;
    const before = snapshot();
    await expect(adapter.refresh(before.entries, signal())).rejects.toMatchObject({
      name: 'RecentSyncError',
      code: 'unavailable',
    });
    const after = snapshot();
    expect(after.entries).toEqual(before.entries);
    expect(after.journal.revision).toBeNull();
    expect(after.journal.pending).toHaveLength(1);
    expect(after.journal.pending[0]?.change).toEqual({ kind: 'use', entry: { kind: 'query', text: 'Kept local' } });
    expect(after.journal.pending[0]?.expectedRevision).toBeUndefined();
    expect(after.journal.rows).toEqual({});
    expect(after.entries[0]).not.toHaveProperty('scope.searchAction');
    expect(visible.some((entry) => entry.scope?.searchAction)).toBe(false);
  }
  expect(writes).toEqual([]);

  native = () => page([valid]);
  await adapter.retry(readRecentHistory(storage, bucket), signal());
  expect(readRecentHistory(storage, bucket).map((entry) => entry.query)).toEqual(['Kept local']);
  const accepted = snapshot();
  expect(accepted.journal.revision).toBe(4);
  const twenty = Array.from({ length: 20 }, (_, index) => globalQuery(`Native ${index}`));
  native = (cursor) =>
    cursor
      ? page(
          [
            item(
              { kind: 'query', text: 'Bad date' },
              { name: 'Bad date', href: queryHref('/search', 'Bad date'), avatar: null },
            ),
          ].map((row) => ({ ...row, lastUsed: 'nope' })),
        )
      : page(twenty, 'page-two');
  await expect(adapter.refresh(accepted.entries, signal())).rejects.toBeInstanceOf(RecentSyncError);
  const afterSecond = snapshot();
  expect(afterSecond.entries).toEqual(accepted.entries);
  expect(afterSecond.journal.revision).toBe(accepted.journal.revision);
  expect(afterSecond.journal.pending).toEqual(accepted.journal.pending);
  expect(Object.keys(afterSecond.journal.rows)).toEqual(Object.keys(accepted.journal.rows));
  expect(visible.map((entry) => entry.query)).toEqual(['Kept local']);
  expect(writes).toHaveLength(1);

  const languages = ['fr', 'en'] as const;
  const mixed = [
    globalQuery('Global query', languages),
    item(
      {
        kind: 'query',
        text: 'Collection query',
        languages: [...languages],
        scope: { kind: 'collection', id: collectionId },
      },
      {
        name: 'Reading',
        href: queryHref(`/collections/${collectionId}`, 'Collection query', languages),
        avatar: null,
      },
    ),
    item(
      { kind: 'scope', scope: { kind: 'route', route: 'library' } },
      { name: 'Library', href: '/library', avatar: null },
    ),
    item({ kind: 'scope', scope: { kind: 'realm', id: realmId } }, null),
    item({ kind: 'scope', scope: { kind: 'collection', id: collectionId } }, null),
  ];
  native = () => page(mixed);
  await adapter.refresh(readRecentHistory(storage, bucket), signal());
  const byQuery = (query: string) => visible.find((entry) => entry.query === query);
  const byKind = (kind: string) => visible.find((entry) => entry.scope?.kind === kind && !entry.query);
  expect(byQuery('Global query')).toMatchObject({ query: 'Global query', languages: ['fr', 'en'] });
  expect(byQuery('Global query')?.scope).toBeUndefined();
  expect(byQuery('Collection query')?.scope).toEqual({
    kind: 'Collection',
    id: collectionId,
    name: 'Reading',
    searchAction: `/collections/${collectionId}`,
  });
  expect(byQuery('Collection query')?.languages).toEqual(['fr', 'en']);
  expect(byKind('Library')?.scope).toEqual({
    kind: 'Library',
    id: 'library',
    name: 'Library',
    searchAction: '/library',
  });
  expect(byKind('Realm')?.scope).toEqual({ kind: 'Realm', id: realmId, name: '' });
  expect(byKind('Collection')?.scope).toEqual({ kind: 'Collection', id: collectionId, name: '' });
  expect(readRecentHistory(storage, bucket).every((entry) => !entry.scope?.searchAction)).toBe(true);
  adapter.dispose();
});
