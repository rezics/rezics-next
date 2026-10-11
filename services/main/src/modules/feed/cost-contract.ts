/**
 * Home request work. A feed page does not take more statements as it
 * returns more items. Anonymous is 24 Postgres and 8 Fuseki. Signed is 30
 * Postgres and 8 Fuseki. Some signed Best corpus scales have no shelf read and
 * measure 28; the cap is the page that includes that pair.
 * The earlier 18/24 (and ranking 12) predate summary disclosure and the
 * source-binding lookup. Each line below is a check the page must keep, so the
 * cap was rebaselined to it (program decision, 2026-10-10); growth with items stays forbidden.
 *
 * Anonymous Postgres:
 * 1-6 opening Access control read;
 * 7 candidate page seek;
 * 8 member seek;
 * 9 source-binding lookup, on the content pool;
 * 10 follow/actor card;
 * 11 opening summary disclosure, so a hidden row is dropped before avatars;
 * 12 avatar hydration;
 * 13 summary disclosure after hydration, covering names, covers and the
 * anonymous-name decision;
 * 14 canonical names;
 * 15 feed body disclosure, using the work head the summary already read;
 * 16 avatar fence;
 * 17-22 closing Access control read;
 * 23 author-reference fence for works the binding read proved unbound;
 * 24 closing recovery check.
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
 * Trending: page P=5; each ranked seek examines <=min(5, free slots),
 * plus one unhydrated lookahead. Rejected admissions, missing placements,
 * hides, mutes and Realm diversity all advance the same cursor. The hard cap
 * is P*16=80 examined entries, never an unbounded refill. Each chunk hydrates
 * <=5 Works, reads <=100 placements, <=5 follow-match batches and <=3 muted
 * tag predicates per placement. See TRENDING_WORK_COST for the fixed cost per
 * rejected chunk; no rejected identities or counts are published. A sparse
 * page at the cap answers hasMore and retains the cursor beyond the prefix.
 * Follow/membership inventory size adds no round trip. Native graph visits,
 * PostgreSQL rows/buffers and backup/restore remain qualification gaps: HTTP
 * timing and an ARQ plan cannot establish their physical bound.
 *
 * Preferences, Saved Filter tabs, suggested follows and moderation each have
 * an independent owner; their costs must be composed before qualifying page
 * fan-out. Anonymous requests perform no private Home/follow/viewer reads.
 */
export const HOME_REQUEST_COST = {
  anonymousFeed: { fusekiRequests: 8, postgresStatements: 24 },
  signedFeed: { fusekiRequests: 8, postgresStatements: 30 },
  continue: { fusekiRequests: 30, postgresStatements: 110 },
  suggestions: { fusekiRequests: 25, postgresStatements: 60 },
} as const;

// Sixteen page-sized opportunities allow useful refill without letting a
// viewer's rejected population turn one Home request into a catalogue scan.
const TRENDING_PAGE_SIZE = 5;
const TRENDING_EXAMINED_PER_ITEM = 16;
/** Linear in examined chunks, capped independently of rejected population.
 * Global Work-hide bounds compose as base + perRejectedChunk * chunks,
 * including the first chunk. Two summary queries send about 24 KiB;
 * admission, serial, types and placements bring a five-Work chunk below 40 KiB.
 * WorkProfile currently lacks a Works/rejected-chunk workload dimension;
 * growth QA applies the existing verdict to these composed absolute bounds. */
export const TRENDING_WORK_COST = {
  workload: 'global-work-hide',
  growthClass: 'linear',
  pageSize: TRENDING_PAGE_SIZE,
  chunkSize: TRENDING_PAGE_SIZE,
  examinedPerItem: TRENDING_EXAMINED_PER_ITEM,
  examinedLimit: TRENDING_PAGE_SIZE * TRENDING_EXAMINED_PER_ITEM,
  base: { mainCalls: 1, fusekiRequests: 12, postgresStatements: 40,
    fusekiSentBytes: 32_768, fusekiReceivedBytes: 65_536 },
  perRejectedChunk: { mainCalls: 0, fusekiRequests: 12, postgresStatements: 40,
    fusekiSentBytes: 40 * 1024, fusekiReceivedBytes: 65_536 },
} as const;
