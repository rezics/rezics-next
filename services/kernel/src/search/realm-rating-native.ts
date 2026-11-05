import type { Pool } from 'pg';
import { ProblemError } from '../http/problem.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { OpenSearch } from './opensearch.ts';
import type { RealmRatingSource } from './realm-rating-order.ts';

type Dependencies = { pool: Pool; search: OpenSearch; prefix: string; tokens: KeyRing };

/**
 * Production readiness boundary for complete Realm rating traversal.
 *
 * Content's createRealmRankOrderSource currently exposes score/UUID seeks and
 * exact figure probes. It does not expose canonical-name seeks or an admitted
 * complete Subject predicate. Filtering its scored preview, or walking Search
 * names and probing figures, cannot establish complete useful ordered pages.
 *
 * Keep the installed caller and selected population while that capability is
 * unavailable. In particular, native absence cannot become an unscored result,
 * an empty successful page, or a Global fallback. The scored-only Content API
 * remains available to its existing callers.
 */
export function createRealmRatingNativeSource(_deps: Dependencies): RealmRatingSource {
  const unavailable = async (): Promise<never> => {
    throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  };
  return {
    observe: unavailable,
    readScoredFrontiers: unavailable,
    readUnscored: unavailable,
  };
}
