import type { KernelClient } from '@rezics/client';
import type { VoteCitation } from './post-writes';
import { isCurrentReviewVoteUnavailable, loadCurrentReviewVote } from './review-vote';
import { readThreadSubjects, THREAD_SUBJECT_LIMIT, type ThreadSubject } from './subjects';

type PostResource = ReturnType<KernelClient['posts']>;
export type StoredRevision = NonNullable<
  Awaited<ReturnType<PostResource['revisions']['get']>>['data']
>['revisions'][number];

export type RevisionReferences = Pick<StoredRevision, 'id'> &
  Partial<Pick<StoredRevision, 'authorId' | 'subjectIds' | 'voteCitation'>>;
export type RevisionVotes = Record<string, VoteCitation>;

/** One page-level label batch, sharing the existing four-subject cap rather than reading per revision. */
export async function readRevisionSubjects(
  client: KernelClient,
  revisions: readonly RevisionReferences[],
  known: readonly ThreadSubject[] = [],
): Promise<ThreadSubject[]> {
  const ids = [...new Set(revisions.flatMap((revision) => revision.subjectIds ?? []))];
  const existing = known.filter((subject) => ids.includes(subject.id));
  const missing = ids.filter((id) => !existing.some((subject) => subject.id === id));
  const fetched = await readThreadSubjects(
    client,
    missing.slice(0, Math.max(0, THREAD_SUBJECT_LIMIT - existing.length)),
  );
  return [...existing, ...fetched];
}

/** Author identity comes from the session and native content reads, never from a client-supplied owner flag. */
export async function readAuthorRevisionVotes(
  client: KernelClient,
  revisions: readonly RevisionReferences[],
  viewer: { id: string; authorization: string } | null,
  signal?: AbortSignal,
): Promise<RevisionVotes> {
  if (!viewer) return {};
  const reads = new Map<string, ReturnType<typeof loadCurrentReviewVote>>();
  const values = await Promise.all(
    revisions.map(async (revision) => {
      if (revision.authorId !== viewer.id || !revision.voteCitation || revision.subjectIds?.length !== 1) return null;
      const subjectId = revision.subjectIds[0]!;
      const questionId = revision.voteCitation.questionId;
      const key = `${subjectId}:${questionId}`;
      let pending = reads.get(key);
      if (!pending) {
        pending = loadCurrentReviewVote(client, subjectId, viewer.authorization, questionId, signal);
        reads.set(key, pending);
      }
      const vote = await pending;
      return vote && !isCurrentReviewVoteUnavailable(vote) ? ([revision.id, vote] as const) : null;
    }),
  );
  return Object.fromEntries(values.filter((value) => value !== null));
}

/** Missing/cleared private reads and unchanged votes add no comparison to the immutable citation. */
export function differingReviewVote(
  citation: VoteCitation | null | undefined,
  current: VoteCitation | null | undefined,
): VoteCitation | null {
  if (!citation || !current || citation.questionId !== current.questionId) return null;
  return citation.units !== current.units || citation.revision !== current.revision ? current : null;
}
