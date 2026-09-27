/** Additive log vote signal and linear age penalty. At read time the common
 * -now/24h term cancels, preserving the base order before Realm percentile
 * comparison. Zero is neutral; a downvote always lowers rank, including
 * 0 -> -1. This is our monotone variant, not Reddit's old hot formula.
 * Primary comparison: https://github.com/reddit-archive/reddit/blob/master/r2/r2/lib/db/_sorts.pyx
 * (reviewed 2026-09-28). Twenty-four hours is the home-feed product policy. */
export const FEED_DECAY_MS = 24 * 60 * 60 * 1000;
export function bestKey(score: number, time: number): number {
  if (!Number.isSafeInteger(score) || !Number.isFinite(time)) throw new Error('Invalid feed rank input');
  return Math.sign(score) * Math.log10(1 + Math.abs(score)) + time / FEED_DECAY_MS;
}
export function bestScore(score: number, time: number, now: number): number {
  return bestKey(score, time) - now / FEED_DECAY_MS;
}
export function activityTime(id: string, fallback: Date) {
  const uuid = id.slice(-36);
  // Earlier graph writers have no explicit event timestamp. UUIDv7 carries
  // creation milliseconds; legacy UUIDs use the relay's durable delivery time.
  const time = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)
    ? new Date(Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16)) : fallback;
  return { time, basis: time === fallback ? 'relay' as const : 'revision' as const };
}

/** Rank the bounded candidate cohort by each item's percentile within its own
 * Realm (global activities form one cohort). Thus the best small-Realm item
 * competes with the best large-Realm item. Tied percentiles use time then id.
 * Available signal: one net vote per verified person. Shelves, consumption,
 * trust weights and rating eligibility belong to their owners/follow-up work. */
export const FEED_RANKING = { version: 'home-best-v1', decayHours: 24, candidatePool: 256,
  normalization: 'realm-percentile-in-candidate-pool', signals: { upvote: 1, downvote: -1 },
  diversityWindow: 10, realmCap: 3, thinFollowing: 3 } as const;
export function rankCandidates<T extends { id: string; score: number; realm: string | null; time: number }>(
  candidates: readonly T[], sort: 'best' | 'top') {
  const weighted = candidates.map(item => ({ ...item, base: bestKey(item.score, item.time) }));
  const realms = new Map<string | null, number[]>();
  for (const item of weighted) {
    const scores = realms.get(item.realm) ?? [];
    scores.push(item.base); realms.set(item.realm, scores);
  }
  return weighted.map(item => {
    const scores = realms.get(item.realm)!;
    const rank = sort === 'top' ? item.score : scores.filter(score => score <= item.base).length / scores.length;
    return { ...item, rank };
  }).sort((a, b) => b.rank - a.rank || b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
/** Carries the last nine emitted Realm identities across pages. Null/global
 * cards advance the window but do not count as a single giant Realm. */
export function diversityAllows(realm: string | null, previous: readonly (string | null)[]): boolean {
  return !realm || previous.slice(-(FEED_RANKING.diversityWindow - 1)).filter(value => value === realm).length < FEED_RANKING.realmCap;
}
export function recommendationAllowed(scope: 'following' | 'all', sort: 'best' | 'new' | 'top', followed: number) {
  return scope === 'all' || sort === 'best' && followed < FEED_RANKING.thinFollowing;
}
