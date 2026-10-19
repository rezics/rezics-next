import { expect, test } from 'bun:test';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import type { SearchState } from './state.ts';
import { searchPagesOptions, type SearchLoader } from './query.ts';
import type { SearchContinuation, SearchResultPage } from './types.ts';

const token = (nextOffset: number) => ({ queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
  sourcePosition: { datasetId: 'product', dataEpoch: 'test', sequence: '1' }, indexGeneration: 'index',
  nextOffset, expiresAt: 9999999999999 }) satisfies SearchContinuation;
const page = (next: SearchContinuation | null): SearchResultPage => ({ next, hits: [], total: 100,
  titles: true, sequence: '1', indexGeneration: 'index' });
const state: SearchState = { phrase: 'lantern', scope: { kind: 'global' }, language: null, term: null };

test.each([
  ['same opaque token', [1]],
  ['two-token cycle', [2, 1]],
  ['fourth page', [2, 3, 4, 1]],
  ['after one four-page action', [2, 3, 4, 5, 1]],
] as const)('search refuses a repeated continuation before accepting the page: %s', async (_name, offsets) => {
  const client = new QueryClient(), calls: (SearchContinuation | undefined)[] = [];
  const load: SearchLoader = async continuation => {
    calls.push(continuation);
    // An equivalent JSON object need not retain its key insertion order or identity.
    const { nextOffset, ...rest } = token(offsets[calls.length - 1]!);
    return { ok: true, page: page({ nextOffset, ...rest }) };
  };
  const observer = new InfiniteQueryObserver(client, { ...searchPagesOptions(state,
    'en', undefined, page(token(1)), load), staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  try {
    for (let index = 1; index < offsets.length; index += 1) await observer.fetchNextPage({ throwOnError: true });
    await expect(observer.fetchNextPage({ throwOnError: true })).rejects.toMatchObject({ failure: 'restart' });
    expect(calls).toEqual([token(1), ...offsets.slice(0, -1).map(token)]);
    expect(observer.getCurrentResult().data?.pages).toHaveLength(offsets.length);
  } finally { unsubscribe(); observer.destroy(); client.clear(); }
});

test('a valid refetch reuses its original continuations without treating later cached pages as a cycle', async () => {
  const client = new QueryClient();
  const load: SearchLoader = async continuation => ({ ok: true, page: page(!continuation ? token(1)
    : JSON.stringify(continuation) === JSON.stringify(token(1)) ? token(2) : null) });
  const observer = new InfiniteQueryObserver(client, { ...searchPagesOptions(state,
    'en', undefined, page(token(1)), load), staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.fetchNextPage({ throwOnError: true });
    await observer.fetchNextPage({ throwOnError: true });
    const refreshed = await observer.refetch({ throwOnError: true });
    expect(refreshed.data?.pages.map(item => item.next)).toEqual([token(1), token(2), null]);
    expect(refreshed.hasNextPage).toBe(false);
  } finally { unsubscribe(); observer.destroy(); client.clear(); }
});

test('a refetch also refuses a new cycle while keeping its previously useful pages', async () => {
  const client = new QueryClient();
  let refetching = false;
  const load: SearchLoader = async continuation => ({ ok: true, page: page(refetching
    ? token(3) : !continuation ? token(1) : null) });
  const observer = new InfiniteQueryObserver(client, { ...searchPagesOptions(state,
    'en', undefined, page(token(1)), load), staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.fetchNextPage({ throwOnError: true });
    refetching = true;
    await expect(observer.refetch({ throwOnError: true })).rejects.toMatchObject({ failure: 'restart' });
    expect(observer.getCurrentResult().data?.pages.map(item => item.next)).toEqual([token(1), null]);
  } finally { unsubscribe(); observer.destroy(); client.clear(); }
});
