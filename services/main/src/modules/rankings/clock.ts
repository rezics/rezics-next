export interface RankingClock {
  /** Source event time for projection, current time for reads and retention. */
  at(occurredAt?: Date): Date;
}

export const wallRankingClock: RankingClock = { at: occurredAt => occurredAt ?? new Date() };

/** A retained QA source and its consumers share bucket time, independently of
 * build duration or queue time. Authentication and authority keep wall time. */
export function rankingClock(env: Record<string, string | undefined>): RankingClock {
  const value = env.REZICS_QA_RANKING_AT;
  if (value === undefined) return wallRankingClock;
  if (env.NODE_ENV === 'production' || env.REZICS_STACK_PROFILE !== 'qa' || !env.REZICS_QA_RUN_ID) {
    throw new Error('REZICS_QA_RANKING_AT requires an admitted QA stack');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error('REZICS_QA_RANKING_AT must be a canonical UTC timestamp');
  }
  return { at: () => new Date(time) };
}
