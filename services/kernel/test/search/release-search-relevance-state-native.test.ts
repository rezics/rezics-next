import { expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import {
  createReleaseSearchRelevanceState,
  type ReleaseSearchRelevanceBinding,
} from '../../src/search/release-search-relevance-state.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the installed Search schema');

const binding: ReleaseSearchRelevanceBinding = {
  principal: 'account:00000000-0000-8000-8000-000000000001',
  request: {
    releaseDigest: 'native-release',
    filter: { type: { in: ['edition'] } },
    sort: 'relevance',
    languages: ['en'],
    spoilerThreshold: 0,
    groupLimit: 20,
    childLimit: 20,
    previewLimit: 3,
  },
  generation: 7,
  cut: {
    names: { epoch: 'native-names', pools: [{ id: 'semantic', population: { generation: '1', homes: [] } }] },
    basis: {
      releaseDigest: 'native-release',
      physical: { generation: 7, incarnation: 'native', indexUuid: 'native-index' },
      epoch: 'native-source-cut',
      calendarReadyFor: null,
    },
  },
};

const id = (index: number) => `10000000-0000-8000-8000-${String(index).padStart(12, '0')}`;

test('native relevance membership reads exact resumed branch membership', async () => {
  const pool = createPool(databaseUrl);
  const state = createReleaseSearchRelevanceState({
    pool,
    run: async <T>(operation: () => Promise<T>) => operation(),
    reserve: () => undefined,
    poolId: 'semantic',
  });
  let execution: string | undefined;
  const now = Date.now();
  const seed = id(1),
    leftWork = id(2),
    rightWork = id(3),
    absent = id(4),
    candidates = [seed, leftWork, rightWork, absent];

  try {
    const root = await state.start(binding, now, [seed]);
    execution = root.execution;
    expect(await state.seen(binding, root, candidates, now)).toEqual(new Set([seed]));

    const left = await state.advance(binding, root, '1'.repeat(64), [leftWork], now + 1);
    expect(await state.advance(binding, root, '1'.repeat(64), [leftWork], now + 1)).toEqual(left);
    const right = await state.advance(binding, root, '2'.repeat(64), [rightWork], now + 1);

    await state.resume(binding, left, now + 2);
    expect(await state.seen(binding, left, candidates, now + 2)).toEqual(new Set([seed, leftWork]));
    await state.resume(binding, right, now + 3);
    expect(await state.seen(binding, right, candidates, now + 3)).toEqual(new Set([seed, rightWork]));
  } finally {
    try {
      if (execution)
        await pool.query('DELETE FROM search.release_relevance_execution WHERE id = $1', [execution]);
    } finally {
      await pool.end();
    }
  }
});
