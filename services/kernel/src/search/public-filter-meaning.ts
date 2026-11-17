import { releaseDigest } from '@rezics/definitions';
import type { PublicFilterProjectionMeaning } from '../semantic/index.ts';

type VerifiedReleaseDigest = (release: PublicFilterProjectionMeaning['release'], digest: string) => boolean;
const nativeMeanings = new WeakSet<PublicFilterProjectionMeaning>();

export function hasNativePublicFilterMeaning(meaning: PublicFilterProjectionMeaning): boolean {
  return nativeMeanings.has(meaning);
}

/** The Definitions owner attests to the exact immutable body, independent of current database availability. */
export function retainNativePublicFilterMeaning(
  meaning: PublicFilterProjectionMeaning,
  verifiedDigest: VerifiedReleaseDigest,
): PublicFilterProjectionMeaning {
  const retained = Object.freeze({ ...meaning });
  if (hasMeaningShape(retained) && verifiedDigest(retained.release, retained.digest)) {
    nativeMeanings.add(retained);
    return retained;
  }
  return meaning;
}

function hasMeaningShape(meaning: PublicFilterProjectionMeaning): boolean {
  return (
    Object.keys(meaning).length === 2 &&
    Object.hasOwn(meaning, 'digest') &&
    Object.hasOwn(meaning, 'release') &&
    Object.keys(meaning.release.types).length > 0
  );
}

/** Source meaning pins the complete release; type restrictions belong to the captured filter. */
export function hasExactPublicFilterMeaning(
  meaning: PublicFilterProjectionMeaning,
  verifiedDigest?: VerifiedReleaseDigest,
): boolean {
  return (
    hasMeaningShape(meaning) &&
    (verifiedDigest?.(meaning.release, meaning.digest) || meaning.digest === releaseDigest(meaning.release))
  );
}
