import { t } from 'elysia';
import type { RankingBasis } from '../recommendation/ranking.ts';
import { readPosition } from '../work/read-contract.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { discoveryRefreshHealth } from './refresh-health.ts';

export const PUBLIC_DISCOVERY_RANKING: RankingBasis = {
  profile: 'ranking-rating-latest-per-slot-v1', population: { kind: 'public' }, candidateGrain: 'work', semantic: null,
};

/** Server-only authority for this fixed public population. JSON cannot carry
 * the symbol, and it grants no manager, Realm or personal-ranking authority. */
export const publicRankingAutomation = Symbol('discovery-public-ranking-refresh');
export interface PublicRankingAutomation { [publicRankingAutomation]: true }
export const automaticPublicRanking: PublicRankingAutomation = { [publicRankingAutomation]: true };

export const DISCOVERY_RANKING_REFRESH_COST = {
  generationsPerTick: 1, partitions: 16, sourceProbes: 6, pendingGenerations: 1,
  accessStatements: 30, relayQueries: 4,
} as const;
export const DISCOVERY_RANKING_HEALTH_COST = {
  servingGenerations: 1, accessStatements: 13, erasureWindow: 64, workPayloads: 0, candidateProbes: 0,
} as const;
export const discoveryRankingHealth = t.Object({
  status: t.Union([t.Literal('ready'), t.Literal('unavailable')]),
  sourcePosition: readPosition,
  generation: t.Nullable(t.String({ format: 'uuid' })),
  projectionPosition: t.Nullable(readPosition),
  sequenceLag: t.Nullable(t.String({ pattern: '^(0|[1-9][0-9]*)$' })),
  stale: t.Boolean(),
  refresh: t.Nullable(discoveryRefreshHealth),
});

/** Availability follows the serving public ranking, not the separate standing
 * rating projection. A retained generation serves throughout a later build;
 * lag describes the older of its signal checkpoint and candidate snapshot. */
export async function readDiscoveryRankingHealth(session: WorkReadSession) {
  if (!session.deps.recommendations) throw new WorkReadUnavailable('Public ranking owner is unavailable');
  const generation = await session.deps.recommendations.publicRankingStatus();
  // A diagnostic owner outage must not take a serving public ranking offline.
  const refresh = await session.deps.discovery?.refreshHealth().catch(() => null) ?? null;
  const lag = generation?.dataEpoch === session.position.dataEpoch
    ? BigInt(session.position.sequence) - BigInt(generation.sequence) : null;
  return {
    status: generation && lag !== null && lag >= 0n ? 'ready' as const : 'unavailable' as const,
    sourcePosition: session.position, generation: generation?.generation ?? null,
    projectionPosition: generation ? { dataEpoch: generation.dataEpoch, sequence: generation.sequence } : null,
    sequenceLag: lag !== null && lag >= 0n ? String(lag) : null,
    stale: lag !== 0n,
    refresh,
  };
}
