import type { Blocker } from './types.ts';

/** The message key for each typed blocker Main names, so a new code breaks this build. */
export const blockerKey = {
  stale_revision: 'blockerStaleRevision', stale_base: 'blockerStaleBase', self_review: 'blockerSelfReview',
  review_authority_required: 'blockerReviewAuthority', required_approvals: 'blockerRequiredApprovals',
  terminal_decision: 'blockerTerminal', owner_unavailable: 'blockerOwnerUnavailable', budget_exhausted: 'blockerBudgetExhausted',
  revision_required: 'blockerRevisionRequired', apply_pending: 'blockerApplyPending',
} as const satisfies Record<Blocker['code'], string>;

/** A blocker Main sent with a refused command: its typed body, when the problem carried one. */
export function blockerOf(value: unknown): Blocker | undefined {
  if (typeof value !== 'object' || value === null || !('blocker' in value)) return undefined;
  const { blocker } = value;
  return typeof blocker === 'object' && blocker !== null && 'code' in blocker && typeof blocker.code === 'string'
    && blocker.code in blockerKey ? blocker as Blocker : undefined;
}
