import type { KernelClient } from '@rezics/client';
import type { VoteCitation } from './post-writes';

export const STANDARD_QUESTION_ID = '00000000-0000-7000-8000-000000000001';
export type CurrentReviewVote = VoteCitation;

/** Reads the signed-in author's current standard review vote once for a selected subject. */
export async function loadCurrentReviewVote(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<CurrentReviewVote | null> {
  try {
    const result = await client
      .subjects({ id: subjectId })
      .ratings({ questionId: STANDARD_QUESTION_ID })
      .vote.get({ headers: { authorization } });
    if (result.error || !result.data) return null;
    return { questionId: STANDARD_QUESTION_ID, units: result.data.units, revision: result.data.revision };
  } catch {
    return null;
  }
}

/** Only include a citation when the reader selected the current vote checkbox. */
export function selectedVoteCitation(vote: CurrentReviewVote | null, checked: boolean): VoteCitation | undefined {
  return checked && vote ? { questionId: vote.questionId, units: vote.units, revision: vote.revision } : undefined;
}
