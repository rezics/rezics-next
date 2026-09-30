import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName } from '../work/read-contract.ts';

/** At most 64 candidate Works receive public-selection and release checks per attempt.
 * The native head-key ordering can cost O(W log W); coverage checks cost O(window x R x coverage),
 * independent of catalogue size. A sparse window continues after its last examined Work,
 * including on empty pages. This bound is never a population cap.
 * Twelve graph calls per attempt plus the shared Work read's fences; retries retain the
 * Work read's 10 s deadline and aggregate 160-call/4 MiB ledger. */
export const RELEASE_QUERY_COST = { pageSize: 20, candidateRows: 64, matchedReleases: 8,
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
