import { type ContentRankingCandidate, type ContentRankingTotal, type ContentRealmVotes } from '../contract/index.ts';
/**
 * Based on Lemmy 0.19.21 r.hot_rank. With h = age in hours, Lemmy uses
 * log10(max(2, score + 2)) / (h + 2)^1.8 for 0 < h < 168, otherwise 0.
 * REZICS uses last activity for active and creation for hot, clamps h to 0,
 * and retains the positive rank at exactly 168 h.
 */
export declare function lemmyActiveRank(score: number, activityAt: Date, at: Date): number;
export declare function clampReactionScore(score: number): number;
export declare function weightedRankScore(candidate: ContentRankingCandidate, totals: readonly ContentRankingTotal[], realmVotes: ReadonlyMap<string, ContentRealmVotes>): number;
export declare function rankUpdate(candidate: ContentRankingCandidate, score: number, at: Date): Readonly<{
    route: number;
    boardId: string;
    threadId: string;
    score: number;
    activeRank: number;
    hotRank: number;
}>;
/** Ranking times are stored UTC instants; parsing them is ordinary computation. */
export declare function parseRankingInstant(value: string): Date;
