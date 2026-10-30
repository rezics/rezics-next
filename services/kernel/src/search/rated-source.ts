import type { Pool } from 'pg';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { ConfigError } from '../commerce/config.ts';
import { createPublicRatingSource } from '../rating/public-rating-source.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { subjectSource } from '../semantic/search-source.ts';
import type { PublicRatingSource } from './rating-source.ts';
import { withPublicRatings } from './rating-subject-source.ts';
import type { SubjectSource } from './source.ts';

/** One native composition for API disclosure, default indexing and generation replay. */
export function createRatedSubjectSource(
  pool: Pool,
  routeKey: Uint8Array,
): { source: SubjectSource; ratings: PublicRatingSource } {
  if (!(routeKey instanceof Uint8Array) || routeKey.byteLength !== 32) throw new ConfigError('KERNEL_ROUTE_KEY');
  const ratings = createPublicRatingSource(pool);
  const source = withPublicRatings(subjectSource(pool, routeKey), ratings, {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
  });
  return { source, ratings };
}
