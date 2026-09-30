import { VISIBLE_PAGE_COST } from '../collection/visible-page.ts';

/** Bounded Structure traversal and hydration, independent of total population.
 * Jena may still scan a generation for the exact mount/member relation; its
 * conservative discovery cost is O(N), while returned hydration is O(P). */
export const ZONE_ROUTE_COST = { pageSize: 24, maxNavigation: 50,
  maxPages: VISIBLE_PAGE_COST.maxPages, maxLookaheadLimit: VISIBLE_PAGE_COST.maxLookaheadLimit,
  membershipQueries: 1, mountRows: 2, typeRowsPerResource: 8,
  maxGraphReads: 2048, maxGraphBytes: 8 * 1024 * 1024, deadlineMs: 10_000 } as const;
