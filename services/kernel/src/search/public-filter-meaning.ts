import { releaseDigest } from '@rezics/definitions';
import type { PublicFilterProjectionMeaning } from '../semantic/index.ts';

/** Source meaning pins the complete release; type restrictions belong to the captured filter. */
export function hasExactPublicFilterMeaning(
  meaning: PublicFilterProjectionMeaning,
  verifiedDigest?: (release: PublicFilterProjectionMeaning['release'], digest: string) => boolean,
): boolean {
  return (
    Object.keys(meaning).length === 2 &&
    Object.hasOwn(meaning, 'digest') &&
    Object.hasOwn(meaning, 'release') &&
    Object.keys(meaning.release.types).length > 0 &&
    (verifiedDigest?.(meaning.release, meaning.digest) || meaning.digest === releaseDigest(meaning.release))
  );
}
