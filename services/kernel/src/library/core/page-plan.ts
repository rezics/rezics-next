/** Ordinary Collection page arithmetic. Caps match the Library README formula c = min(600, 6L + 3). */

import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import {
  CANONICAL_SOURCE_RAW_KEY_LIMIT,
  COLLECTION_SOURCE_DRIVER_COUNT,
  COLLECTION_SOURCE_WORK_GROUP_LIMIT,
  ORDINARY_COLLECTION_PAGE_LIMIT,
  ORDINARY_COLLECTION_PREFIX_ROUNDS,
} from '../contract/index.ts';
import type { WorkDimensions } from '../contract/work-dimensions.ts';

function fixedPageWork(): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 64,
    identityMetadataRows: 0,
    emptySeeks: 3,
    nativePoints: 16,
    witnessKeys: 16,
    statements: 12,
    bytes: 80 * 1024,
    engineRequests: 0,
  });
}

function candidateWork(): Bound {
  return declareBound({
    candidateKeys: 1,
    nativeRows: 16,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 8,
    witnessKeys: 8,
    statements: 0,
    bytes: 5120,
    engineRequests: 0,
  });
}

function fullFactsPerMember(): Bound {
  return declareBound({
    candidateKeys: 1,
    nativeRows: 32,
    identityMetadataRows: 2,
    emptySeeks: 2,
    nativePoints: 8,
    witnessKeys: 2,
    statements: 12,
    bytes: 64 * 1024,
    engineRequests: 0,
  });
}

function maximumBound(): Bound {
  return sumBounds(
    fixedPageWork(),
    repeatBound(candidateWork(), Math.min(600, 6 * ORDINARY_COLLECTION_PAGE_LIMIT + 3)),
    repeatBound(fullFactsPerMember(), ORDINARY_COLLECTION_PAGE_LIMIT),
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
    prefixGroupLimit: Math.min(COLLECTION_SOURCE_WORK_GROUP_LIMIT, 2 * limit + 1),
    driverCount: COLLECTION_SOURCE_DRIVER_COUNT,
    aliasLimit: CANONICAL_SOURCE_RAW_KEY_LIMIT,
    candidateLimit,
    sourceBound,
    total,
  });
}

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
