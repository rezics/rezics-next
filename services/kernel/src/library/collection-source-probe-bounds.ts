import { memoizedValue } from '../memoized.ts';
import { declareBound, type Bound } from '@rezics/bounds';

export function COLLECTION_SOURCE_NATIVE_SAVED_PROBE_COST(): Bound {
  return memoizedValue(COLLECTION_SOURCE_NATIVE_SAVED_PROBE_COST, () =>
    declareBound({
      candidateKeys: 35,
      engineRequests: 0,
      identityMetadataRows: 0,
      nativeRows: 512,
      emptySeeks: 16,
      nativePoints: 64,
      witnessKeys: 35,
      statements: 16,
      bytes: 2_200_000,
    }),
  );
}
