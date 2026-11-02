import { bindIdentityRatingPage, identityRatingReceiptMatches } from './identity-rating-adapter.ts';
import {
  IDENTITY_RATING_PAGE_LIMIT,
  type IdentityRatingCommitReceipt,
  type IdentityRatingParent,
  type IdentityRatingRepairScope,
} from './identity-rating-parent.ts';

export type IdentityRatingPageResult =
  | Readonly<{ status: 'committed'; pageId: string; terminal: boolean; receipt: IdentityRatingCommitReceipt }>
  | Readonly<{ status: 'pending'; reason: string }>;

/** Process at most one immutable native page. A committed receipt is replayed before selecting new work. */
export async function consumeIdentityRatingPage(
  parent: IdentityRatingParent,
  scope: IdentityRatingRepairScope,
): Promise<IdentityRatingPageResult> {
  const selected = await parent.selectPage(scope, IDENTITY_RATING_PAGE_LIMIT);
  const bound = bindIdentityRatingPage(scope, selected);
  if (!bound) return { status: 'pending', reason: 'invalid-selected-page' };
  const { page, binding } = bound;

  let receipt = await parent.readCommitReceipt(binding);
  if (!receipt) {
    const committed = await parent.commitSelectedPage(scope, page, binding);
    if (committed.status === 'pending') return committed;
    receipt = committed.receipt;
  }

  if (!identityRatingReceiptMatches(binding, receipt)) return { status: 'pending', reason: 'receipt-binding-mismatch' };
  if (!(await parent.verifyCommitReceipt(scope, page, binding, receipt)))
    return { status: 'pending', reason: 'commit-receipt-unverified' };
  if (!(await parent.acknowledgeSelectedPage(scope, page, binding, receipt)))
    return { status: 'pending', reason: 'selected-page-acknowledgement-pending' };

  return { status: 'committed', pageId: page.pageId, terminal: page.terminal, receipt };
}
