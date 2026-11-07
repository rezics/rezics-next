import type { RatingVoteSemantic } from '../../rating/index.ts';
import { readableSubjects, resolveSubject } from '../../library/subject-anchor.ts';
import { withRequestDeadline } from '../../request/deadline.ts';
import { globalReadEligibility } from '../eligibility.ts';
import { withReadTransaction } from '../read.ts';
import { identityEpochStore } from '../identity-adapters/index.ts';
import { readIdentityRatingReview } from '../identity-adapters/identity-epoch-read.ts';
import { createIdentityRatingCommitParticipant } from '../identity-rating-commit-participant.ts';
import { admitIdentityRatingEffect, readIdentityRatingEpochs } from '../identity-rating-admission.ts';

/** Native Semantic implementations for Rating's vote and counted-read application ports.
 * Construction is inert. Every operation retains the original Pool, actor and live executor transaction.
 * Disclosure uses the ordinary Subject reader, including both original and terminal authorization.
 */
export function createNativeRatingVoteSemantic(): RatingVoteSemantic {
  return Object.freeze({
    snapshot: withReadTransaction,
    definitionsEligibility: () => globalReadEligibility('definitions:read'),
    mappings: (pool, ids, deadline) =>
      withRequestDeadline(deadline, () => identityEpochStore().readMappings(pool, ids)),
    readable: (context, actor, ids, deadline) =>
      withRequestDeadline(deadline, () => readableSubjects(context, actor, ids)),
    resolve: (context, actor, id, deadline) =>
      resolveSubject(context, actor, id, undefined, { pool: context.pool, deadline }),
    epochs: readIdentityRatingEpochs,
    review: readIdentityRatingReview,
    createCommitParticipant: createIdentityRatingCommitParticipant,
    admit: admitIdentityRatingEffect,
  });
}
