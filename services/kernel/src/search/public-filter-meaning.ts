import { releaseDigest } from '@rezics/definitions';
import type { PublicFilterProjectionMeaning } from '../semantic/index.ts';

/** Source meaning pins the complete release; type restrictions belong to the captured filter. */
export function hasExactPublicFilterMeaning(meaning: PublicFilterProjectionMeaning): boolean {
  return (
    Object.keys(meaning).length === 2 &&
    Object.hasOwn(meaning, 'digest') &&
    Object.hasOwn(meaning, 'release') &&
    Object.keys(meaning.release.types).length > 0 &&
    meaning.digest === releaseDigest(meaning.release)
  );
}
