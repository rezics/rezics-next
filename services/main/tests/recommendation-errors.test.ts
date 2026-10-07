import { expect, spyOn, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import {
  inAccess, RecommendationStale, RecommendationUnavailable, recommendationFailureCause,
} from '../src/modules/recommendation/derived-generation.ts';
import { RankingGenerations } from '../src/modules/recommendation/ranking.ts';
import { RankingBuildWorker } from '../src/modules/recommendation/build-worker.ts';
import { automaticPublicRanking, PUBLIC_DISCOVERY_RANKING } from '../src/modules/discovery/public-ranking.ts';

test('Access connection and transaction failures retain the original cause through rollback', async () => {
  const cause = Object.assign(new Error('retirement references a purged generation'), { code: '23503' });
  const unavailable = new RecommendationUnavailable('Access owner is unavailable', { cause });
  const connection = { connect: async () => { throw cause; } } as unknown as Pool;
  await expect(inAccess(connection, async () => undefined)).rejects.toMatchObject({ cause });
  const calls: string[] = [];
  const client = { query: async (sql: string) => {
    calls.push(sql);
    if (sql === 'ROLLBACK') throw new Error('connection lost during rollback');
  }, release: () => { calls.push('release'); } } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  await expect(inAccess(pool, async () => { throw cause; })).rejects.toMatchObject({ cause });
  expect(calls.slice(-2)).toEqual(['ROLLBACK', 'release']);
  await expect(inAccess(pool, async () => { throw unavailable; })).rejects.toBe(unavailable);
  const stale = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  await expect(inAccess(pool, async () => { throw stale; })).rejects.toMatchObject({ cause: stale });
  await expect(inAccess(pool, async () => { throw stale; })).rejects.toBeInstanceOf(RecommendationStale);
  await expect(inAccess(pool, async () => { throw null; })).rejects.toMatchObject({ cause: null });
  expect(recommendationFailureCause(new RecommendationUnavailable('adapter', { cause: unavailable })))
    .toEqual({ code: '23503', message: cause.message });
});

test('ranking build reports the original relay, erasure and candidate source failures', async () => {
  for (const provider of ['relay', 'erasure', 'candidates']) {
    const cause = Object.assign(new Error(`${provider} interrupted`), { code: '08006' });
    const relay = { query: async (sql: string) => {
      if (provider === 'relay' || provider === 'erasure' && sql.includes('relay.erasure')) throw cause;
      return { rows: [{ head: '0' }] };
    } } as unknown as Pool;
    const rankings = new RankingGenerations({ access: {} as Pool, relay, dataEpoch: 'epoch',
      cursorKey: new Uint8Array(32), canReadWork: async () => true,
      zeroSnapshot: async () => { throw cause; } });
    await expect(rankings.registerBuild(automaticPublicRanking, PUBLIC_DISCOVERY_RANKING, 1,
      { idempotencyKey: 'build', requestDigest: 'a'.repeat(64) })).rejects.toMatchObject({ cause });
  }
});

test('ranking workers log the provider class and code without the message', async () => {
  const cause = Object.assign(new Error('provider connection lost'), { code: '08006' });
  const unavailable = new RecommendationUnavailable('Access owner is unavailable', { cause });
  for (const phase of ['refresh', 'batch']) {
    const pool = { query: async () => ({ rows: phase === 'batch' ? [{ id: 'generation' }] : [] }) } as unknown as Pool;
    const rankings = { dataEpoch: 'epoch', claim: async () => '1',
      refreshPublicRanking: async () => { throw unavailable; },
      runBatch: async () => { throw unavailable; } } as unknown as RankingGenerations;
    const worker = new RankingBuildWorker(pool, rankings);
    if (phase === 'refresh') worker.enablePublicRefresh();
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await worker.tick();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({
        level: 'error',
        event: 'worker_fault',
        'rezics.worker.name': 'main.ranking.build',
        'error.class': 'RecommendationUnavailable',
        'error.code': '08006',
      });
      expect(String(logged.mock.calls[0]?.[0])).not.toContain(cause.message);
    } finally { logged.mockRestore(); }
  }
});
