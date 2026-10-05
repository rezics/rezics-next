import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { Pool } from 'pg';
import { discoveryRankingHealth, readDiscoveryRankingHealth } from '../src/modules/discovery/public-ranking.ts';
import { RankingBuildWorker } from '../src/modules/recommendation/build-worker.ts';
import type { RankingGenerations } from '../src/modules/recommendation/ranking.ts';
import { RecommendationUnavailable } from '../src/modules/recommendation/derived-generation.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { healthRoutes } from '../src/routes/health.ts';

const source = { dataEpoch: 'restored-epoch', sequence: '7424' };
const id = '00000000-0000-4000-8000-000000001029';
function session(generation: { generation: string; dataEpoch: string; sequence: string } | null) {
  return { position: source, deps: { recommendations: { publicRankingBuildFailure: async () => null, publicRankingStatus: async () => generation } } } as unknown as WorkReadSession;
}

test('G1029: discovery readiness follows its serving ranking and reports lag while a replacement builds', async () => {
  const absent = await readDiscoveryRankingHealth(session(null));
  expect(Value.Check(discoveryRankingHealth, absent)).toBe(true);
  expect(absent).toMatchObject({ status: 'unavailable', generation: null, sequenceLag: null, stale: true });
  const behind = await readDiscoveryRankingHealth(session({ generation: id, dataEpoch: source.dataEpoch, sequence: '7416' }));
  expect(Value.Check(discoveryRankingHealth, behind)).toBe(true);
  expect(behind).toMatchObject({ status: 'ready', generation: id, sequenceLag: '8', stale: true });
  expect(await readDiscoveryRankingHealth(session({ generation: id, ...source })))
    .toMatchObject({ status: 'ready', sequenceLag: '0', stale: false });
  for (const position of [{ dataEpoch: 'old-epoch', sequence: '7416' }, { ...source, sequence: '7425' }]) {
    expect(await readDiscoveryRankingHealth(session({ generation: id, ...position })))
      .toMatchObject({ status: 'unavailable', sequenceLag: null, stale: true });
  }
  await expect(readDiscoveryRankingHealth({ position: source, deps: {} } as WorkReadSession))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G1029: discovery readiness is unavailable when Main has no configured owners', async () => {
  const app = healthRoutes(new FusekiClient('http://unused.invalid/'));
  const response = await app.handle(new Request('http://main.local/health/discovery-ready'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: 'unavailable' });
});

test('G1029: the runner refreshes only when enabled and advances registered builds during a public-source outage', async () => {
  let refreshes = 0, batches = 0, claims = 0;
  const rankings = { dataEpoch: source.dataEpoch,
    refreshPublicRanking: async () => { refreshes++; return 'current'; },
    claim: async () => { claims++; return '2'; },
    runBatch: async () => { batches++; return { snapshotComplete: false }; },
  } as unknown as RankingGenerations;
  const pool = { query: async () => ({ rows: [{ id }] }) } as unknown as Pool;
  const worker = new RankingBuildWorker(pool, rankings);
  await worker.tick();
  expect(refreshes).toBe(0);
  worker.enablePublicRefresh();
  await worker.tick();
  expect(refreshes).toBe(1);
  rankings.refreshPublicRanking = async () => { throw new RecommendationUnavailable('public source offline'); };
  await worker.tick();
  expect(batches).toBe(3);
  expect(claims).toBe(1);
});
