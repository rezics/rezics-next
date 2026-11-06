import {
  CONTENT_DEFAULT_REALM_VOTES,
  CONTENT_RANK_HOT_HOURS,
  CONTENT_REACTION_SCORE_MAX,
  CONTENT_REACTION_SCORE_MIN,
  type ContentRankingCandidate,
  type ContentRankingTotal,
  type ContentRealmVotes,
} from '../contract/index.ts';

/**
 * Based on Lemmy 0.19.21 r.hot_rank. With h = age in hours, Lemmy uses
 * log10(max(2, score + 2)) / (h + 2)^1.8 for 0 < h < 168, otherwise 0.
 * REZICS uses last activity for active and creation for hot, clamps h to 0,
 * and retains the positive rank at exactly 168 h.
 */
export function lemmyActiveRank(score: number, activityAt: Date, at: Date): number {
  if (!Number.isInteger(score) || !Number.isFinite(activityAt.getTime()) || !Number.isFinite(at.getTime()))
    throw new TypeError('Invalid active rank input');
  const hours = Math.max(0, (at.getTime() - activityAt.getTime()) / 3_600_000);
  if (at.getTime() - activityAt.getTime() > CONTENT_RANK_HOT_HOURS * 3_600_000) return 0;
  return Math.log10(Math.max(2, score + 2)) / Math.pow(hours + 2, 1.8);
}

export function clampReactionScore(score: number): number {
  if (!Number.isFinite(score)) throw new TypeError('Invalid reaction score');
  return Math.max(CONTENT_REACTION_SCORE_MIN, Math.min(CONTENT_REACTION_SCORE_MAX, Math.trunc(score)));
}

export function weightedRankScore(
  candidate: ContentRankingCandidate,
  totals: readonly ContentRankingTotal[],
  realmVotes: ReadonlyMap<string, ContentRealmVotes>,
): number {
  const weights = candidate.realmId === null ? CONTENT_DEFAULT_REALM_VOTES : (realmVotes.get(candidate.realmId) ?? {});
  const score = totals.reduce((sum, total) => sum + total.count * (weights[total.kind] ?? 0), 0);
  return clampReactionScore(score);
}

export function rankUpdate(candidate: ContentRankingCandidate, score: number, at: Date) {
  return Object.freeze({
    route: candidate.route,
    boardId: candidate.boardId,
    threadId: candidate.threadId,
    score,
    activeRank: lemmyActiveRank(score, parseRankingInstant(candidate.lastActivityAt), at),
    hotRank: lemmyActiveRank(score, parseRankingInstant(candidate.createdAt), at),
  });
}

/** Ranking times are stored UTC instants; parsing them is ordinary computation. */
export function parseRankingInstant(value: string): Date {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('Invalid ranking instant');
  return new Date(time);
}
