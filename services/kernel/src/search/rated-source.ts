import type {
  SubjectCanonicalNames,
  SubjectSourceKeyTraversal as SubjectSourceKeyPages,
} from '../semantic/subject-source-key-pages.ts';
import type { Pool } from 'pg';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { ConfigError } from '../commerce/config.ts';
import { createPublicRatingSource } from '../rating/public-rating-source.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { createCreditSearchSource } from '../semantic/credit-search.ts';
import { subjectSource } from '../semantic/search-source.ts';
import type { PublicRatingSource } from './rating-source.ts';
import { withPublicRatings } from './rating-subject-source.ts';
import type { SubjectSource } from './source.ts';

/** One native composition for API disclosure, default indexing and generation replay. */
export function createRatedSubjectSource(
  pool: Pool,
  routeKey: Uint8Array,
): {
  source: SubjectSource & SubjectSourceKeyPages & { canonicalNames: SubjectCanonicalNames };
  ratings: PublicRatingSource;
} {
  if (!(routeKey instanceof Uint8Array) || routeKey.byteLength !== 32) throw new ConfigError('KERNEL_ROUTE_KEY');
  const ratings = createPublicRatingSource(pool);
  const native = subjectSource(pool, routeKey);
  const creditSearch = createCreditSearchSource(pool, routeKey);
  const rated = withPublicRatings(native, ratings, {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
  });
  return {
    source: {
      ...rated,
      canonicalNames: native.canonicalNames,
      readSubjectKeyPage: native.readSubjectKeyPage.bind(native),
      creditSearch,
    },
    ratings,
  };
}
