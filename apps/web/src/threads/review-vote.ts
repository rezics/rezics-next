import type { KernelClient } from '@rezics/client';
import type { VoteCitation } from './post-writes';

export const STANDARD_QUESTION_ID = '00000000-0000-7000-8000-000000000001';
export type CurrentReviewVote = VoteCitation;
export type CurrentReviewVoteUnavailable = { kind: 'unavailable' };
export type CurrentReviewVoteReadResult = CurrentReviewVote | null | CurrentReviewVoteUnavailable;
export const CURRENT_REVIEW_VOTE_UNAVAILABLE: CurrentReviewVoteUnavailable = { kind: 'unavailable' };

export function isCurrentReviewVoteUnavailable(
  result: CurrentReviewVoteReadResult,
): result is CurrentReviewVoteUnavailable {
  return result !== null && 'kind' in result && result.kind === 'unavailable';
}

/** Reads only the caller's vote; the question never selects another account's vote. */
export async function loadCurrentReviewVote(
  client: KernelClient,
  subjectId: string,
  authorization: string,
  questionId: string = STANDARD_QUESTION_ID,
  signal?: AbortSignal,
): Promise<CurrentReviewVoteReadResult> {
  try {
    const result = await client
      .subjects({ id: subjectId })
      .ratings({ questionId })
      .vote.get({ headers: { authorization }, ...(signal ? { fetch: { signal } } : {}) });
    if (result.error) return result.status === 404 ? null : CURRENT_REVIEW_VOTE_UNAVAILABLE;
    if (!result.data) return null;
    return { questionId, units: result.data.units, revision: result.data.revision };
  } catch {
    return CURRENT_REVIEW_VOTE_UNAVAILABLE;
  }
}

/** Only include a citation when the reader selected the current vote checkbox. */
export function selectedVoteCitation(vote: CurrentReviewVote | null, checked: boolean): VoteCitation | undefined {
  return checked && vote ? { questionId: vote.questionId, units: vote.units, revision: vote.revision } : undefined;
}
