/**
 * Home request work, G-1025. These are the existing G-383 mixed-card bounds,
 * not new latency/timeout allowances. Counts include the opening and closing
 * graph/Access fences and every helper invoked by the operation.
 *
 * Feed: New/Top seek P+1 anchors; Best seeks at most K=256 and ranks by Realm
 * percentile. Hydration visits M<=8 member references (<=2 tagged groups),
 * batching names, summaries, credits, types and follow matches. Card-specific
 * body/placement reads grow with M, not total Works, follows or memberships.
 * Following's inventory count is stored; matches seek the page's identities.
 * Saved Filters add their owner read and <=3 classification predicates, not a
 * second feed. Sparse pages retain a cursor rather than rescanning prefixes.
 *
 * Continue: two candidate seeks (8+8), one status/progress batch, and <=3
 * position seeks per admitted Book. History depth and completed chapter
 * prefixes do not add round trips; object-tree seeks depend on tree height.
 *
 * Trending: hydrate <=20 admitted Works, <=100 placements, <=5 follow match
 * batches, <=3 muted-tag predicates per Work/Realm. The ranking reader seeks
 * further candidate batches after rejected admissions: total visits depend on
 * that rejected prefix and still need qualification. Follow/membership
 * inventory size must not add a round trip. Native graph visits, PostgreSQL
 * rows/buffers and backup/restore costs remain separate qualification gaps:
 * HTTP duration and an ARQ algebra plan cannot establish their physical bound.
 *
 * Preferences, Saved Filter tabs, suggested follows and moderation each have
 * an independent owner; their costs must be composed before qualifying page
 * fan-out. Anonymous requests perform no private Home/follow/viewer reads.
 */
export const HOME_REQUEST_COST = {
  anonymousFeed: { fusekiRequests: 85, postgresStatements: 100 },
  signedFeed: { fusekiRequests: 105, postgresStatements: 204 },
  continue: { fusekiRequests: 30, postgresStatements: 110 },
  suggestions: { fusekiRequests: 25, postgresStatements: 60 },
} as const;
