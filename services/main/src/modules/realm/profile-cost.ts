/** Diagnostic public community: one root and author, a two-item discussion
 * page or focused thread. These are round-trip envelopes, not native scan or
 * capacity claims. Header composes its existing 13 graph-read hydrator with
 * the two outer WorkRead position fences. SQL includes BEGIN/fences/COMMIT.
 * The accompanying growth guards require invariant SQL across each background
 * axis and across nonempty authored-rule/banner counts; a generous timing
 * allowance cannot conceal a per-item lookup loop. */
export const COMMUNITY_PROFILE_COST = {
  header: { fusekiRequests: 15, anonymousStatements: 6, memberStatements: 9, otherFetches: 0 },
  'threads-best': { fusekiRequests: 17, anonymousStatements: 96, memberStatements: 113, otherFetches: 0 },
  'threads-new': { fusekiRequests: 17, anonymousStatements: 96, memberStatements: 113, otherFetches: 0 },
  'threads-top': { fusekiRequests: 17, anonymousStatements: 96, memberStatements: 113, otherFetches: 0 },
  thread: { fusekiRequests: 16, anonymousStatements: 97, memberStatements: 130, otherFetches: 0 },
  roster: { fusekiRequests: 2, anonymousStatements: 9, memberStatements: 9, otherFetches: 0 },
  'zone-home': { fusekiRequests: 5, anonymousStatements: 1, memberStatements: 1, otherFetches: 0 },
  'zone-presentation': { fusekiRequests: 8, anonymousStatements: 1, memberStatements: 1, otherFetches: 2 },
  'header-rules': { fusekiRequests: 15, anonymousStatements: 6, memberStatements: 9, otherFetches: 0 },
  'zone-banners': { fusekiRequests: 8, anonymousStatements: 2, memberStatements: 2, otherFetches: 2 },
} as const;
export type CommunityProfileOperation = keyof typeof COMMUNITY_PROFILE_COST;
