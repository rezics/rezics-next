import { VISIBLE_PAGE_COST } from '../collection/visible-page.ts';

/** Bounded Structure traversal and hydration, independent of total population.
 * Published route lookup scans bounded immutable ranges; legacy mount/member
 * queries may scan a graph generation. Discovery is O(N), while returned
 * hydration is O(P), with one shared deadline and graph-response budget. */
export const ZONE_ROUTE_COST = { pageSize: 24, maxNavigation: 50,
  immutableRangeRows: VISIBLE_PAGE_COST.immutableRangeRows,
  membershipQueries: 1, mountRows: 2, typeRowsPerResource: 8,
  typeQueriesPerPage: 1, summaryBatch: 50,
  maxGraphReads: 2048, maxGraphBytes: 8 * 1024 * 1024, deadlineMs: 10_000 } as const;
