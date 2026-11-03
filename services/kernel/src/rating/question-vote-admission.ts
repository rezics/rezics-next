import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { currentCommand, currentCommandResources, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { VoteReviewStaleError, VoteReviewUnavailableError, type VoteReviewGuard } from './own-votes-review.ts';
import type { QuestionLifecycleState } from './question-lifecycle.ts';
import lock from './question-vote-admission-lock.sql';
import lifecycle from './question-vote-admission-lifecycle.sql';

declare const preparation: unique symbol;
/** Factory-local, immutable input only. It conveys neither authorization nor a held lock. */
export type QuestionVoteAdmissionPreparation = Readonly<{ [preparation]: true }>;
export type QuestionVoteAdmissionInput = Readonly<{
  questionId: string;
  question: VoteReviewGuard['question'];
}>;
export type HeldQuestionVoteAdmission = Readonly<{
  questionId: string;
  revision: number;
  lifecycleRevision: number;
  lifecycleState: QuestionLifecycleState;
}>;
export type QuestionVoteAdmission = Readonly<{
  prepare(input: QuestionVoteAdmissionInput): QuestionVoteAdmissionPreparation;
  /** Fresh body only, after receipt lookup and before no-op, cleanup or effects. */
  admit(tx: CommandTransaction, prepared: QuestionVoteAdmissionPreparation): Promise<HeldQuestionVoteAdmission>;
}>;

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}

/** One actual question home, on the executor's original connection. No checkout,
 * foreign read, vote write, receipt, consent or independently releasable handle.
 */
export function createQuestionVoteAdmission(): QuestionVoteAdmission {
  const inputs = new WeakMap<QuestionVoteAdmissionPreparation, QuestionVoteAdmissionInput>();
  return Object.freeze({
    prepare(input: QuestionVoteAdmissionInput) {
      if (
        !input ||
        routeOf(input.questionId) === null ||
        !input.question ||
        !validRevision(input.question.revision) ||
        !validRevision(input.question.lifecycleRevision)
      )
        throw new TypeError('Invalid question vote admission input');
      const prepared = Object.freeze({}) as QuestionVoteAdmissionPreparation;
      inputs.set(
        prepared,
        Object.freeze({
          questionId: input.questionId,
          question: Object.freeze({
            revision: input.question.revision,
            lifecycleRevision: input.question.lifecycleRevision,
          }),
        }),
      );
      return prepared;
    },
    async admit(tx: CommandTransaction, prepared: QuestionVoteAdmissionPreparation) {
      const input = inputs.get(prepared);
      if (!input) throw new TypeError('Unknown question vote admission preparation');
      const command = currentCommand(tx);
      const { deadline } = currentCommandResources(tx);
      requireAccessDeadline(deadline);
      // A local transaction must not claim a foreign-home commit fence, even when
      // both homes happen to be visible on the same physical database today.
      if (partitionOf(routeOf(input.questionId)!) !== command.partition)
        throw new VoteReviewUnavailableError('atomic_guard_unavailable');
      const client = deadlineClient(tx, deadline);
      // Lock the owning question even when the lifecycle row does not exist.
      // Lifecycle commands update this same tuple before changing the head, so a
      // pre-existing SERIALIZABLE snapshot cannot admit a lifecycle ABA winner.
      const question = await lock.run(client, { question_id: input.questionId });
      if (!question || question.revision !== input.question.revision)
        throw new VoteReviewStaleError('question_changed');
      const head = await lifecycle.run(client, { question_id: input.questionId });
      const lifecycleRevision = head?.revision ?? 1;
      const lifecycleState = head?.state ?? 'active';
      if (lifecycleState !== 'active' && lifecycleState !== 'retired')
        throw new VoteReviewUnavailableError('question_observation_unavailable');
      if (lifecycleRevision !== input.question.lifecycleRevision) throw new VoteReviewStaleError('question_changed');
      requireAccessDeadline(deadline);
      // This value describes this live attempt only. PostgreSQL retains the lock
      // through the executor's COMMIT/ROLLBACK, including no-effect completion.
      return Object.freeze({
        questionId: question.id,
        revision: question.revision,
        lifecycleRevision,
        lifecycleState,
      });
    },
  });
}
