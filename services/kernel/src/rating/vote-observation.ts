import type { RatingQuestion } from './votes.ts';
import { STANDARD_QUESTION_ID } from './standard-question.ts';
import { VoteReviewStaleError, VoteReviewUnavailableError } from './own-votes-review.ts';

/** The immutable Global provider supports a question-bound write; conditional providers require their held guard. */
export type VoteObservation = Readonly<{
  subjectId: string;
  question: Readonly<{
    id: string;
    revision: number;
    grain: string;
    meaning: string;
    scale: Readonly<{ min: number; max: number; displayStep: number }>;
  }>;
}>;
export function parseVoteObservation(value: string | undefined): VoteObservation | undefined {
  if (value === undefined) return;
  if (new TextEncoder().encode(value).byteLength > 2048) throw new TypeError('Invalid vote observation');
  const input = JSON.parse(value);
  const q = input?.question;
  const scale = q?.scale;
  if (
    !input ||
    typeof input.subjectId !== 'string' ||
    input.subjectId.length > 128 ||
    !q ||
    typeof q.id !== 'string' ||
    !Number.isSafeInteger(q.revision) ||
    q.revision < 1 ||
    typeof q.grain !== 'string' ||
    typeof q.meaning !== 'string' ||
    !scale ||
    ![scale.min, scale.max, scale.displayStep].every(Number.isSafeInteger) ||
    scale.min >= scale.max ||
    scale.displayStep < 1
  )
    throw new TypeError('Invalid vote observation');
  return structuredClone(input);
}
export function requireVoteObservationProvider(questionId: string) {
  // Refuse before any unlocked preflight for a conditional provider.
  if (questionId !== STANDARD_QUESTION_ID) throw new VoteReviewUnavailableError('atomic_guard_unavailable');
}
export function assertVoteObservation(observed: VoteObservation, question: RatingQuestion, resolvedId: string) {
  requireVoteObservationProvider(question.id);
  if (observed.subjectId !== resolvedId) throw new VoteReviewStaleError('subject_changed');
  const q = observed.question;
  if (
    q.id !== question.id ||
    q.revision !== question.revision ||
    q.grain !== question.grain ||
    q.meaning !== (question.meaning ?? question.label) ||
    q.scale.min !== question.minimumUnits ||
    q.scale.max !== question.maximumUnits ||
    q.scale.displayStep !== question.stepUnits
  )
    throw new VoteReviewStaleError('question_changed');
}
