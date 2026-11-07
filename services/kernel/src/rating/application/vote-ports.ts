import type {
  IdentityMapping,
  IdentityRatingEpochObservation,
  IdentityRatingAdmissionResult,
  IdentityRatingCommitParticipant,
  IdentityRatingReviewResult,
} from '../../semantic/contract/index.ts';

export type RatingSubjectContext<Pool, Access> = Readonly<{ pool: Pool; access: Access }>;
export type RatingVoteTarget = Readonly<{ subjectId: string; requestedSubjectId: string | null }>;

/** Rating's required Semantic capabilities. Observations are released advice; only admit and the
 * participant run on the executor's original transaction. No port supplies vote authorization.
 * Pool, actor, deadline, ordered originals and exact canonical pair belong to the caller.
 */
export type RatingVoteSemantic<Pool, Client, Tx, Access, Actor, Eligibility> = Readonly<{
  snapshot<T>(pool: Pool, read: (client: Client) => Promise<T>, deadline: number): Promise<T>;
  definitionsEligibility(): Eligibility;
  mappings(pool: Pool, originalIds: readonly string[], deadline: number): Promise<IdentityMapping[]>;
  readable(
    context: RatingSubjectContext<Pool, Access>,
    actor: Actor,
    originalIds: readonly string[],
    deadline: number,
  ): Promise<string[]>;
  resolve(
    context: RatingSubjectContext<Pool, Access>,
    actor: Actor,
    originalId: string,
    deadline: number,
  ): Promise<RatingVoteTarget | null>;
  epochs(pool: Pool, homes: readonly number[], deadline: number): Promise<IdentityRatingEpochObservation[]>;
  review(
    pool: Pool,
    input: Readonly<{
      requestedOriginalId: string;
      canonicalTerminalId: string;
      deadline: number;
    }>,
  ): Promise<IdentityRatingReviewResult>;
  createCommitParticipant(): IdentityRatingCommitParticipant<Tx>;
  admit(
    tx: Tx,
    input: Readonly<{
      requestedTargetId: string;
      resolvedTargetId: string;
      expectedEpochs?: readonly IdentityRatingEpochObservation[];
    }>,
  ): Promise<IdentityRatingAdmissionResult>;
}>;
