import { expect, test } from 'bun:test';
import { collectUsefulPage } from '../../src/search/useful-page.ts';
import type { SearchHit } from '../../src/search/query.ts';

const hit = (id: string, position: number): SearchHit => ({
  id,
  index: 'unit',
  partition: 0,
  securityRevision: 1,
  matched: [],
  sort: [position],
});

test('useful iteration retains consumed rejects and duplicates before unused canonical lookahead', async () => {
  const hits = [hit('a', 1), hit('hidden', 2), hit('b', 3), hit('alias-a', 4), hit('c', 5)];
  const result = await collectUsefulPage({
    limit: 2,
    read: async ({ size }) => {
      expect(size).toBe(5);
      return { hits };
    },
    check: async () =>
      new Map(hits.filter(({ id }) => id !== 'hidden').map((h) => [h, h.id === 'alias-a' ? 'a' : h.id])),
    canonicalId: (id) => id,
  });
  expect(result).toEqual({
    status: 'filled',
    values: ['a', 'b'],
    frontier: { after: [4] },
    candidates: 5,
    rounds: 1,
  });
});

test('a short raw result needs a complete empty native seek to establish exhaustion', async () => {
  const sizes: number[] = [];
  const result = await collectUsefulPage({
    limit: 3,
    read: async ({ size, after }) => {
      sizes.push(size);
      return { hits: after === undefined ? [hit('last', 1)] : [] };
    },
    check: async (hits) => new Map(hits.map((h) => [h, h.id])),
    canonicalId: (id) => id,
  });
  expect(sizes).toEqual([7, 5]);
  expect(result.status).toBe('exhausted');
  expect(result.values).toEqual(['last']);
  expect(result.frontier.after).toEqual([1]);
});

test('sparse rejected prefixes share three rounds and the literal page candidate budget', async () => {
  const sizes: number[] = [];
  const starts: unknown[] = [];
  let examined = 0;
  const result = await collectUsefulPage({
    limit: 1,
    read: async ({ size, after }) => {
      sizes.push(size);
      starts.push(after);
      return { hits: Array.from({ length: size }, () => hit('hidden', ++examined)) };
    },
    check: async () => new Map<SearchHit, string>(),
    canonicalId: (id) => id,
  });
  expect(result.status).toBe('preparing');
  expect(result.values).toEqual([]);
  expect(result.candidates).toBe(9);
  expect(result.frontier.after).toEqual([9]);
  expect(sizes).toEqual([3, 3, 3]);
  expect(starts).toEqual([undefined, [3], [6]]);
});

test('rating frontier preserves the actual phase and native null tuple', async () => {
  const scored = { ...hit('scored', 1), ratingPhase: 'scored' as const, sort: [9, null, 'scored'] };
  const unscored = { ...hit('unscored', 2), ratingPhase: 'unscored' as const, sort: [null, 'unscored'] };
  const result = await collectUsefulPage({
    limit: 1,
    read: async () => ({ hits: [scored, unscored] }),
    check: async (hits) => new Map(hits.map((h) => [h, h.id])),
    canonicalId: (id) => id,
  });
  expect(result.frontier).toEqual({ after: [9, null, 'scored'], ratingPhase: 'scored' });
});

test('incomplete native work is an error and never exhaustion', async () => {
  const error = new Error('native observation lost');
  await expect(
    collectUsefulPage({
      limit: 1,
      read: async () => {
        throw error;
      },
      check: async () => new Map<SearchHit, string>(),
      canonicalId: (id) => id,
    }),
  ).rejects.toBe(error);
});
