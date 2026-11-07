import type { IdentityRatingAdmissionReason, IdentityRatingEpochObservation } from '../semantic/contract/index.ts';
import { VoteReviewStaleError } from './own-votes-review.ts';

/** Rating translates closed Semantic outcomes into its existing command/readback behavior. */
export class IdentityRatingAdmissionPendingError extends Error {
  readonly code = 'identity_rating_pending';

  constructor(
    readonly targetId: string,
    readonly reason: IdentityRatingAdmissionReason,
  ) {
    super(`Identity rating admission is pending for ${targetId}: ${reason}`);
    this.name = 'IdentityRatingAdmissionPendingError';
  }
}

export function compareVoteIdentityEpochs(
  expected: readonly IdentityRatingEpochObservation[],
  actual: readonly IdentityRatingEpochObservation[],
): void {
  if (
    expected.length !== actual.length ||
    expected.some(
      (entry, index) => entry.partition !== actual[index]?.partition || entry.epoch !== actual[index]?.epoch,
    )
  )
    throw new VoteReviewStaleError('identity_epoch_changed');
}
