import { consumeIdentityRatingPage } from './identity-rating-consumer.ts';
import {
  IDENTITY_RATING_REPAIR_PAGE_LIMIT,
  type IdentityRatingParent,
  type IdentityRatingRepairScope,
  type IdentityRatingProvenanceResult,
} from './identity-rating-parent.ts';

export type IdentityRatingRepairResult =
  | Readonly<{ status: 'complete'; pages: number; provenance: Exclude<IdentityRatingProvenanceResult, 'stale'> }>
  | Readonly<{ status: 'pending'; pages: number; reason: string }>
  | Readonly<{ status: 'continuing'; pages: number }>;

/** Finish a visibility repair in bounded page steps; the parent releases provenance only after its final obligation. */
export async function repairIdentityRatingVisibility(
  parent: IdentityRatingParent,
  scope: IdentityRatingRepairScope,
  pageLimit = IDENTITY_RATING_REPAIR_PAGE_LIMIT,
): Promise<IdentityRatingRepairResult> {
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > IDENTITY_RATING_REPAIR_PAGE_LIMIT)
    throw new RangeError('Identity rating repair page limit is outside its bound');

  let pages = 0;
  while (pages < pageLimit) {
    const result = await consumeIdentityRatingPage(parent, scope);
    if (result.status === 'pending') return { status: 'pending', pages, reason: result.reason };
    pages += 1;
    if (!result.terminal) continue;

    const provenance = await parent.reclaimFinalProvenance(scope, result.receipt);
    if (provenance === 'stale') return { status: 'pending', pages, reason: 'provenance-owner-changed' };
    return { status: 'complete', pages, provenance };
  }

  return { status: 'continuing', pages };
}
