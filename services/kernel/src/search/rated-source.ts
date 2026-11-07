import type {
  SubjectCanonicalNames,
  SubjectSourceKeyTraversal as SubjectSourceKeyPages,
} from '../semantic/subject-source-key-pages.ts';
import type { Pool } from 'pg';
import { SEARCH_GLOBAL_CONTEXT as GLOBAL_CONTEXT } from './global-context.ts';
import { ConfigError } from '../commerce/config.ts';
import { createPublicRatingSource } from '../rating/public-rating-source.ts';
import { STANDARD_QUESTION_ID } from '../rating/standard-question.ts';
import { searchNativePorts } from './native-bindings.ts';
import type { SearchNativePorts } from './native-ports.ts';
import type { PublicRatingSource } from './rating-source.ts';
import { withPublicRatings } from './rating-subject-source.ts';
import type { SubjectSource } from './source.ts';
import type { CreditSearchSource } from './credit-search.ts';

/** One native composition for API disclosure, default indexing and generation replay. */
export function createRatedSubjectSource(
  pool: Pool,
  routeKey: Uint8Array,
  creditSearch?: CreditSearchSource,
  nativePorts: SearchNativePorts = searchNativePorts(),
): {
  source: SubjectSource & SubjectSourceKeyPages & { canonicalNames: SubjectCanonicalNames };
  ratings: PublicRatingSource;
} {
  if (!(routeKey instanceof Uint8Array) || routeKey.byteLength !== 32) throw new ConfigError('KERNEL_ROUTE_KEY');
  const ratings = createPublicRatingSource(pool);
  const semantic = nativePorts.subjectSource(pool, routeKey);
  const native = creditSearch === undefined ? semantic : { ...semantic, creditSearch };
  const rated = withPublicRatings(native, ratings, {
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
  });
  return {
    source: {
      ...rated,
      canonicalNames: native.canonicalNames,
      readSubjectKeyPage: native.readSubjectKeyPage.bind(native),
      ...(native.creditSearch ? { creditSearch: native.creditSearch } : {}),
    },
    ratings,
  };
}
