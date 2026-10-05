import { expect, test } from 'bun:test';
import { memoryFeed, page, post } from './fixtures.ts';
import { appendPosts, recoverProjection, sameProjection, sameSource } from './projection.ts';
import type { FeedPage } from './types.ts';

const advance = (before: FeedPage, sequence = '9007199254740993123'): FeedPage => ({ ...before,
  sourcePosition: { ...before.sourcePosition, sequence },
  projection: { ...before.projection, sequence, reviewSequence: '8' } });

test('a successful Home continuation survives graph writes and empty projection progress in the same epoch', () => {
  const first = page([post(1)]), next = advance(page([post(2)]));
  expect(sameSource(first, next)).toBe(true);
  expect(sameProjection(first, next)).toBe(true);
  const restored = { ...next, sourcePosition: { ...next.sourcePosition, dataEpoch: 'restored' } };
  expect(sameSource(first, restored)).toBe(false);
  expect(sameProjection(first, restored)).toBe(false);
  expect(appendPosts(first.items, [post(1), post(2)]).map(item => item.id)).toEqual([post(1).id, post(2).id]);
});

test('projection recovery replays to the loaded anchor across unrelated graph writes', async () => {
  const old = page([post(1), post(3)]), first = { ...page([post(1), post(2)], { nextCursor: 'next' }),
    sourcePosition: { ...old.sourcePosition, sequence: '42' } };
  const api = memoryFeed();
  api.page = async () => ({ ok: true, data: advance(page([post(3)])) });
  const result = await recoverProjection(api, {}, first, { page: old, items: old.items, pages: 1 }, 3, () => true);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.data.items.map(item => item.id)).toEqual([post(1).id, post(2).id, post(3).id]);
});

test('a fresh recovery chain still rejects new projected activity, changed reviews and a missing anchor', async () => {
  const old = page([post(1), post(3)]), api = memoryFeed();
  const recover = (first: FeedPage) => recoverProjection(api, {}, first,
    { page: old, items: old.items, pages: 1 }, 3, () => true);
  expect(await recover({ ...old, projection: { ...old.projection, sequence: '41' } }))
    .toEqual({ ok: false, failure: 'moved' });
  expect(await recover({ ...old, projection: { ...old.projection, reviewSequence: '8' } }))
    .toEqual({ ok: false, failure: 'moved' });
  expect(await recover(page([post(99)]))).toEqual({ ok: false, failure: 'moved' });
  api.page = async () => ({ ok: false, failure: 'moved' });
  expect(await recover(page([post(1)], { nextCursor: 'changed-population' })))
    .toEqual({ ok: false, failure: 'moved' });
});
