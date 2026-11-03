import { expect, test } from 'bun:test';
import { ownVotesQuery } from '../src/ratings/own-votes/current-origin';

test('private reader identity includes viewer, exposure lifetime, address, locale and native source with no retention or polling', () => {
  const cursor = 'sealed/+opaque=';
  const first = ownVotesQuery('viewer-a', cursor, 'en', 'exposure-a', () => true);
  const variants = [
    ownVotesQuery('viewer-b', cursor, 'en', 'exposure-a', () => true),
    ownVotesQuery('viewer-a', 'next-cursor', 'en', 'exposure-a', () => true),
    ownVotesQuery('viewer-a', cursor, 'ja', 'exposure-a', () => true),
    ownVotesQuery('viewer-a', cursor, 'en', 'exposure-b', () => true),
    ownVotesQuery('viewer-a', cursor, 'en', 'exposure-a', () => false),
  ];
  expect(
    new Set([first.queryKey, ...variants.map(({ queryKey }) => queryKey)].map((key) => JSON.stringify(key))).size,
  ).toBe(5);
  expect(first.queryKey).toContain(cursor);
  expect(first).toMatchObject({
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
});
