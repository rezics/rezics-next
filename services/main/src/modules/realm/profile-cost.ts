/** Diagnostic public community: one root and author, a two-item discussion
 * page or focused thread. These are round-trip envelopes, not native scan or
 * capacity claims. Header admits the Realm once and batches its profile and
 * selected media hydration. SQL includes BEGIN/fences/COMMIT.
 * The accompanying growth guards require invariant SQL across each background
 * axis and across nonempty authored-rule/banner counts; a generous timing
 * allowance cannot conceal a per-item lookup loop.
 *
 * Linked Zones now expose one current Space address and admit one attached
 * Realm. Compared with the original Zone envelope, the address capture/close
 * takes two SQL statements, Realm record capture/close takes two, and the
 * second authority session closes recovery once. Signed-in reads additionally
 * close both principal identities. Graph admission and the post-owner position
 * probe add three calls. These are per-page constants for one Space/Realm,
 * covered by the closure outcomes and every community growth dimension. */
const linkedZoneAdmission = { graph: 3, anonymousStatements: 5, memberStatements: 7 } as const;
export const COMMUNITY_PROFILE_COST = {
  header: { fusekiRequests: 15, anonymousStatements: 6, memberStatements: 9, otherFetches: 0 },
  'threads-best': { fusekiRequests: 17, anonymousStatements: 96, memberStatements: 113, otherFetches: 0 },
  'threads-new': { fusekiRequests: 17, anonymousStatements: 96, memberStatements: 113, otherFetches: 0 },
  'threads-top': { fusekiRequests: 17, anonymousStatements: 96, memberStatements: 113, otherFetches: 0 },
  thread: { fusekiRequests: 16, anonymousStatements: 97, memberStatements: 130, otherFetches: 0 },
  roster: { fusekiRequests: 2, anonymousStatements: 9, memberStatements: 9, otherFetches: 0 },
  'zone-home': { fusekiRequests: 5 + linkedZoneAdmission.graph,
    anonymousStatements: 1 + linkedZoneAdmission.anonymousStatements,
    memberStatements: 1 + linkedZoneAdmission.memberStatements, otherFetches: 0 },
  'zone-presentation': { fusekiRequests: 8 + linkedZoneAdmission.graph,
    anonymousStatements: 1 + linkedZoneAdmission.anonymousStatements,
    memberStatements: 1 + linkedZoneAdmission.memberStatements, otherFetches: 2 },
  'header-rules': { fusekiRequests: 15, anonymousStatements: 6, memberStatements: 9, otherFetches: 0 },
  'zone-banners': { fusekiRequests: 8 + linkedZoneAdmission.graph,
    anonymousStatements: 2 + linkedZoneAdmission.anonymousStatements,
    memberStatements: 2 + linkedZoneAdmission.memberStatements, otherFetches: 2 },
} as const;
export type CommunityProfileOperation = keyof typeof COMMUNITY_PROFILE_COST;
