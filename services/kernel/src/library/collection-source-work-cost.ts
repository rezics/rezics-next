/** Static Collection Source work costs. This file has no native IO so declaration modules can read it at init. */
import { memoizedValue } from '../memoized.ts';
import { declareBound, type Bound } from '@rezics/bounds';
import { CANONICAL_SOURCE_RECEIVING_COST } from './canonical-source-bounds.ts';

export { COLLECTION_SOURCE_WORK_GROUP_LIMIT } from './canonical-source-limits.ts';

/** Upper bounds follow the exact indexed statements in the canonical Source plan. */
export const COLLECTION_SOURCE_WORK_COST = CANONICAL_SOURCE_RECEIVING_COST;

/**
 * One saved-Collection membership probe: current metadata (including a prior public output head), one entry
 * check, copy and session points, and the complete 32-label native window. The saved-rule contract excludes
 * the state-builtin compressed-pin branch. This bound is paired with the separate canonical group cap.
 */
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
