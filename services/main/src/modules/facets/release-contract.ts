import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName } from '../work/read-contract.ts';

/** Logical returned-row/round-trip bounds; native Jena orders the matching catalogue.
 * No candidate bound is a population cap: every page continues by the same stable key.
 * Worst-case graph work is O(W log W + R x coverage), not a latency measurement. */
export const RELEASE_QUERY_COST = { pageSize: 20, candidateRows: 21, matchedReleases: 8,
  explanationRows: 9, groups: 3, graphCalls: 12, graphBytes: 2 * 1024 * 1024,
  deadlineMs: 10_000 } as const;

export const releaseWorksPage = t.Object({ profile: t.Literal('release-works-v1'),
  resultGrain: t.Literal('work'),
  items: t.Array(t.Object({ id: readId, revision: readId, mainVersion: readId,
    title: readName, cover: readAvatar,
    matchedReleases: t.Array(readId, { minItems: 1, maxItems: RELEASE_QUERY_COST.matchedReleases }),
    /** More satisfying releases exist; IDs are a bounded explanation, never the matching population. */
    moreMatchedReleases: t.Boolean(),
  }), { maxItems: RELEASE_QUERY_COST.pageSize }), ...pageFields });
