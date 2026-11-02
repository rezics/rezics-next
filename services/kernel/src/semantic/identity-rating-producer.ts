import type { CommandEvent } from '../command/command.ts';

export const IDENTITY_RATING_VOTE_EVENT = 'com.rezics.rating.vote.changed.v1';

export type IdentityRatingVoteChange = Readonly<{
  authenticatedVoterId: string;
  questionId: string;
  sourceTargetId: string;
  aggregateTargetId: string;
  previous: number | null;
  units: number | null;
  revision: number;
  populations: readonly string[];
}>;

/**
 * Produce the durable identity-rating input inside the vote command's own outbox transaction.
 * The caller supplies the already-authorized voter and already-resolved target so this producer
 * cannot introduce another redirect lookup or use a caller-provided identity as its owner.
 */
export function produceIdentityRatingVoteChange(input: IdentityRatingVoteChange): CommandEvent {
  return {
    type: IDENTITY_RATING_VOTE_EVENT,
    subject: input.authenticatedVoterId,
    data: {
      voterId: input.authenticatedVoterId,
      questionId: input.questionId,
      targetId: input.sourceTargetId,
      ...(input.sourceTargetId === input.aggregateTargetId ? {} : { aggregateTargetId: input.aggregateTargetId }),
      previous: input.previous,
      units: input.units,
      revision: input.revision,
      populations: [...input.populations],
    },
  };
}
