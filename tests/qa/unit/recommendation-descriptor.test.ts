import { randomBytes } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { RecommendationDenied } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { RANKING_PROFILE, RankingGenerations, type RankingBasis, type RankingViewer }
  from '../../../services/main/src/modules/recommendation/ranking.ts';

test('REC01: ranking descriptor rejects undeclared signal populations before storage access', async () => {
  const ranking = new RankingGenerations({ access: null as unknown as Pool, relay: null as unknown as Pool,
    dataEpoch: 'epoch', cursorKey: randomBytes(32), canReadWork: async () => true });
  const basis = { profile: RANKING_PROFILE, population: { kind: 'unknown' },
    candidateGrain: 'work', semantic: null } as unknown as RankingBasis;
  await expect(ranking.registerBuild({} as RankingViewer, basis, 1,
    { idempotencyKey: 'key', requestDigest: 'digest' })).rejects.toBeInstanceOf(RecommendationDenied);
  await expect(ranking.page({} as RankingViewer, basis, 1)).rejects.toBeInstanceOf(RecommendationDenied);
});
