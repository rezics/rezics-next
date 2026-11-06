import { memoizedValue } from '../memoized.ts';
/** Static cost declarations for one ordinary Collection members page. */
import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import {
  CANONICAL_SOURCE_RAW_KEY_LIMIT,
  COLLECTION_SOURCE_DRIVER_COUNT,
  COLLECTION_SOURCE_WORK_GROUP_LIMIT,
} from './canonical-source-limits.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';

export const ORDINARY_COLLECTION_PAGE_LIMIT = 100;
export const ORDINARY_COLLECTION_PREFIX_ROUNDS = 3;
export const ORDINARY_COLLECTION_PREFIX_GROUP_LIMIT = COLLECTION_SOURCE_WORK_GROUP_LIMIT;
export const ORDINARY_COLLECTION_DRIVER_COUNT = COLLECTION_SOURCE_DRIVER_COUNT;
export const ORDINARY_COLLECTION_ALIAS_LIMIT = CANONICAL_SOURCE_RAW_KEY_LIMIT;

function fixedPageWork() {
  return memoizedValue(fixedPageWork, () =>
    declareBound({
      candidateKeys: 0,
      nativeRows: 64,
      identityMetadataRows: 0,
      emptySeeks: 3,
      nativePoints: 16,
      witnessKeys: 16,
      statements: 12,
      bytes: 80 * 1024,
      engineRequests: 0,
    }),
  );
}

function candidateWork() {
  return memoizedValue(candidateWork, () =>
    declareBound({
      candidateKeys: 1,
      nativeRows: 16,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 8,
      witnessKeys: 8,
      statements: 0,
      bytes: 5120,
      engineRequests: 0,
    }),
  );
}

function fullFactsPerMember() {
  return memoizedValue(fullFactsPerMember, () =>
    declareBound({
      candidateKeys: 1,
      nativeRows: 32,
      identityMetadataRows: 2,
      emptySeeks: 2,
      nativePoints: 8,
      witnessKeys: 2,
      statements: 12,
      bytes: 64 * 1024,
      engineRequests: 0,
    }),
  );
}

function maximumBound() {
  return memoizedValue(maximumBound, () =>
    sumBounds(
      fixedPageWork(),
      repeatBound(candidateWork(), Math.min(600, 6 * ORDINARY_COLLECTION_PAGE_LIMIT + 3)),
      repeatBound(fullFactsPerMember(), ORDINARY_COLLECTION_PAGE_LIMIT),
    ),
  );
}

export type OrdinaryCollectionPagePlan = Readonly<{
  limit: number;
  view: 'BASIC' | 'FULL';
  rounds: number;
  prefixGroupLimit: number;
  driverCount: number;
  aliasLimit: number;
  candidateLimit: number;
  sourceBound: Bound;
  total: Bound;
}>;

/**
 * The finite direct-reader producer uses c=min(600, 6L+3), matching its existing ownerQueryWork ceiling.
 * Its fixed term covers the two Source preparations/currentness passes, identity and authority checks, and
 * transaction controls. Each admitted candidate carries the existing 16-row/8-point/8-witness producer cost.
 * FULL adds one bounded list-facts batch per disclosed member. Prefixes remain at most three rounds of 100;
 * canonical groups and the six Source drivers retain their existing structural caps.
 */
export function ordinaryCollectionPagePlan(
  limit: number,
  view: 'BASIC' | 'FULL' = 'BASIC',
): OrdinaryCollectionPagePlan {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ORDINARY_COLLECTION_PAGE_LIMIT)
    throw new RangeError('Ordinary Collection page limit must be 1..100');
  const candidateLimit = Math.min(600, 6 * limit + 3);
  const sourceBound = sumBounds(fixedPageWork(), repeatBound(candidateWork(), candidateLimit));
  const total = sumBounds(sourceBound, ...(view === 'FULL' ? [repeatBound(fullFactsPerMember(), limit)] : []));
  if (!withinCeiling(total, maximumBound())) throw new TypeError('Ordinary Collection page exceeds its static ceiling');
  return Object.freeze({
    limit,
    view,
    rounds: ORDINARY_COLLECTION_PREFIX_ROUNDS,
    prefixGroupLimit: Math.min(ORDINARY_COLLECTION_PREFIX_GROUP_LIMIT, 2 * limit + 1),
    driverCount: ORDINARY_COLLECTION_DRIVER_COUNT,
    aliasLimit: ORDINARY_COLLECTION_ALIAS_LIMIT,
    candidateLimit,
    sourceBound,
    total,
  });
}

/** Adapter edge for the existing eight-axis native observer. Ordinary pages declare zero engine requests. */
export function ordinaryPageWorkDimensions(bound: Bound): WorkDimensions {
  const declared = declareBound(bound);
  if (declared.engineRequests !== 0)
    throw new TypeError('Ordinary Collection page cannot map engine requests to the native SQL observer');
  return Object.freeze({
    candidateKeys: declared.candidateKeys,
    nativeRows: declared.nativeRows,
    identityMetadataRows: declared.identityMetadataRows,
    emptySeeks: declared.emptySeeks,
    nativePoints: declared.nativePoints,
    witnessKeys: declared.witnessKeys,
    statements: declared.statements,
    bytes: declared.bytes,
  });
}
