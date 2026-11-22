import type {
  SubjectCanonicalNames,
  SubjectSourceKeyTraversal as SubjectSourceKeyPages,
} from '../semantic/subject-source-key-pages.ts';
import type { Pool } from 'pg';
import { SEARCH_GLOBAL_CONTEXT as GLOBAL_CONTEXT } from './global-context.ts';
import { ConfigError } from '../commerce/config.ts';
import { createPublicRatingSource, readPublicRatingSnapshotInTransaction } from '../rating/public-rating-source.ts';
import { STANDARD_QUESTION_ID } from '../rating/standard-question.ts';
import { searchNativePorts } from './native-bindings.ts';
import type { SearchNativePorts } from './native-ports.ts';
import type { PublicRatingSnapshot, PublicRatingSource } from './rating-source.ts';
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
  const rated = withPublicRatings(
    native,
    ratings,
    { questionId: STANDARD_QUESTION_ID, populationId: GLOBAL_CONTEXT.id },
    async (partition, ids) => {
      let rating: PublicRatingSnapshot | undefined;
      const subjects = await semantic.read(partition, ids, async (client) => {
        if (nativePorts.currentReadSnapshot(pool) !== client) return;
        rating = await readPublicRatingSnapshotInTransaction(client, partition, ids);
      });
      // Historical producers can deliver a complete snapshot without an in-transaction observer.
      return [subjects, rating ?? (await ratings.read(partition, ids))];
    },
  );
  return {
    source: {
      ...rated,
      canonicalNames: native.canonicalNames,
      readSubjectKeyPage: native.readSubjectKeyPage.bind(native),
      ...(native.readCatalogueTextCandidate
        ? { readCatalogueTextCandidate: native.readCatalogueTextCandidate.bind(native) }
        : {}),
      ...(native.readBookCandidateNames ? { readBookCandidateNames: native.readBookCandidateNames.bind(native) } : {}),
      ...(native.creditSearch ? { creditSearch: native.creditSearch } : {}),
    },
    ratings,
  };
}
