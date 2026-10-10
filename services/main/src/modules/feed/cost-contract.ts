/**
 * Home request work. A feed page does not take more statements as it
 * returns more items. Anonymous is 22 Postgres and 8 Fuseki. Signed is 28
 * Postgres and 8 Fuseki. Some signed Best corpus scales have no shelf read and
 * measure 26; the cap is the page that includes that pair.
 *
 * Anonymous Postgres:
 * 1-6 opening Access control read;
 * 7 candidate page seek;
 * 8 member seek;
 * 9 source-binding lookup, on the content pool;
 * 10 follow/actor card;
 * 11 avatar hydration;
 * 12 summary disclosure, one statement after hydration, covering names, covers
 * and the anonymous-name decision;
 * 13 canonical names;
 * 14 feed body disclosure, using the work head the summary already read;
 * 15 avatar fence;
 * 16-21 closing Access control read;
 * 22 closing recovery check.
 * Signed opening and closing control reads add two statements each, and the
 * selected shelf pair adds two more.
 * Graph calls: two position cuts, source, metadata parts, actor names, public
 * summaries, global comment contexts and compositions: eight. Batch row/byte
 * work still grows with emitted references; these are round-trip bounds.
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
  anonymousFeed: { fusekiRequests: 8, postgresStatements: 22 },
  signedFeed: { fusekiRequests: 8, postgresStatements: 28 },
  continue: { fusekiRequests: 30, postgresStatements: 110 },
  suggestions: { fusekiRequests: 25, postgresStatements: 60 },
} as const;
