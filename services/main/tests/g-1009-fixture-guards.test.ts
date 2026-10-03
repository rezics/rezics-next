import { expect, test } from 'bun:test';
import { fixtureDeadline, fixturePages } from './g-1009-fixture-guards.ts';

test('G-1009: a missing fixture stage fails promptly with its identity', async () => {
  await expect(fixtureDeadline(new Promise<never>(() => {}), 'owned backfill graph read', 10))
    .rejects.toThrow('owned backfill graph read did not finish within 10 ms');
  expect(await fixtureDeadline(Promise.resolve('ready'), 'ready stage', 10)).toBe('ready');
  await expect(fixtureDeadline(Promise.reject(new Error('owner failed')), 'failed stage', 10))
    .rejects.toThrow('owner failed');
});

test('G-1009: traversal refuses non-progressing cursors, duplicates and foreign population', () => {
  const advancing = fixturePages('status/read/title/asc', 3);
  advancing(['one', 'two'], 'next');
  advancing(['three'], null);
  const cursor = fixturePages('shared shelf', 3);
  cursor(['one'], 'stuck');
  expect(() => cursor(['two'], 'stuck')).toThrow('shared shelf repeated a continuation cursor');
  const duplicate = fixturePages('composition parts', 3);
  duplicate(['one'], 'next');
  expect(() => duplicate(['one'], null)).toThrow('composition parts repeated fixture item one');
  expect(() => fixturePages('empty shelf', 0)([], 'next')).toThrow('empty page with a continuation');
  expect(() => fixturePages('owned shelf', 1)(['one', 'foreign'], null)).toThrow('1-item fixture population');
  const empty = fixturePages('empty shelf', 0);
  empty([], null);
  expect(() => empty([], null)).toThrow('1-page fixture bound');
});
