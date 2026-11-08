import type { Actor } from '../request/access.ts';
import { deadlineClient } from './access-port.ts';
import { withConnection } from '../database/pool.ts';
import {
  qualifyReviewContextWitnesses,
  resolveRatingQuestionSelection,
  assertCurrentRatingQuestionSelection,
  type RatingQuestionSelection,
  type ReviewContextCandidate,
} from './review-context-eligibility.ts';
import type { ContentReadDependencies } from './reads.ts';
import type { FeedItem, FeedLaneCandidate, FeedQuestionAdmission, FeedQuestionSession } from './contract/feed.ts';

type FeedQuestionDependencies = ContentReadDependencies;
type SubjectReviewCandidate = Readonly<{ subjectId: string; threadId: string }>;
const MAX_FEED_QUESTION_CANDIDATES = 160;

const subjectReviewCandidatesSql = `
WITH selected(subject_id, ordinal) AS MATERIALIZED (
  SELECT subject_id, ordinal
  FROM unnest($1::uuid[]) WITH ORDINALITY AS source(subject_id, ordinal)
)
SELECT selected.subject_id::text AS "subjectId",
       candidates.thread_id::text AS "threadId"
FROM selected
CROSS JOIN LATERAL (
  SELECT dependency.route, dependency.thread_id
  FROM content.review_discovery_dependency AS dependency
  WHERE dependency.gate_kind = 'subject'
    AND dependency.gate_key = selected.subject_id
  ORDER BY dependency.route, dependency.thread_id
  LIMIT $2::integer
) AS candidates
ORDER BY selected.ordinal, candidates.route, candidates.thread_id`;

function subjectId(item: FeedItem | null): string | undefined {
  return item?.destination.kind === 'subject' ? item.destination.id : undefined;
}

/** Read an indexed per-Subject prefix and one overflow key; never read citation or vote data here. */
async function readSubjectReviewCandidates(
  dependencies: FeedQuestionDependencies,
  subjectIds: readonly string[],
  perSubjectLimit: number,
  deadline: number,
): Promise<Readonly<{ candidates: ReadonlyMap<string, readonly string[]>; overflow: ReadonlySet<string> }>> {
  if (subjectIds.length === 0) return { candidates: new Map(), overflow: new Set() };
  const unique = [...new Set(subjectIds)];
  const result = await withConnection(dependencies.pool, async (client) =>
    deadlineClient(client, deadline).query<SubjectReviewCandidate>(subjectReviewCandidatesSql, [
      unique,
      perSubjectLimit + 1,
    ]),
  );
  const candidates = new Map<string, string[]>();
  for (const { subjectId, threadId } of result.rows) {
    const group = candidates.get(subjectId) ?? [];
    group.push(threadId);
    candidates.set(subjectId, group);
  }
  const overflow = new Set<string>();
  for (const [id, group] of candidates) {
    if (group.length > perSubjectLimit) {
      overflow.add(id);
      group.length = perSubjectLimit;
    }
  }
  return { candidates, overflow };
}

/** Resolve the question before lane reads and retain its native selection through final admission. */
export async function createFeedQuestionSession(
  dependencies: FeedQuestionDependencies,
  actor: Actor,
  ratingQuestionId: string,
  deadline: number,
): Promise<FeedQuestionSession> {
  const context = { actor, deadline };
  const selection = await resolveRatingQuestionSelection(dependencies, ratingQuestionId, context);
  const question = selection.question;

  async function qualify(candidates: readonly FeedLaneCandidate[]): Promise<readonly FeedQuestionAdmission[]> {
    if (candidates.length > MAX_FEED_QUESTION_CANDIDATES) throw new RangeError('At most 160 mixed feed candidates');
    const admissions: FeedQuestionAdmission[] = candidates.map(() => 'absent');
    const subjectPositions = new Map<string, number[]>();
    const directWitnessPositions: number[] = [];
    const directWitnesses: ReviewContextCandidate[] = [];

    for (const [index, candidate] of candidates.entries()) {
      const id = subjectId(candidate.item);
      if (id !== undefined) subjectPositions.set(id, [...(subjectPositions.get(id) ?? []), index]);
    }
    const subjectIds = [...subjectPositions.keys()];
    const suppliedBudget = candidates.reduce((total, candidate) => total + (candidate.questionWitness ? 1 : 0), 0);
    const subjectBudget = MAX_FEED_QUESTION_CANDIDATES - suppliedBudget;
    const perSubjectLimit = subjectIds.length ? Math.floor(subjectBudget / subjectIds.length) : 0;
    if (subjectIds.length && perSubjectLimit < 1)
      throw new RangeError('Question witness budget must admit one candidate per Subject');
    const located = await readSubjectReviewCandidates(dependencies, subjectIds, perSubjectLimit, deadline);
    const witnesses: ReviewContextCandidate[] = [];
    const subjectWitnessPositions = new Map<string, number[]>();

    for (const id of subjectIds) {
      const positions: number[] = [];
      for (const threadId of located.candidates.get(id) ?? []) {
        positions.push(witnesses.length);
        witnesses.push({ kind: 'subject', subjectId: id, threadId });
      }
      subjectWitnessPositions.set(id, positions);
    }

    for (const [index, candidate] of candidates.entries()) {
      const item = candidate.item;
      if (!item) continue;
      const id = subjectId(item);
      if (id !== undefined) continue;

      if (candidate.questionWitnessState === 'refused') {
        admissions[index] = 'refused';
        continue;
      }
      const supplied = candidate.questionWitness;
      if (!supplied) {
        if (
          candidate.questionWitnessState !== 'absent' &&
          item.key.owner === 'content' &&
          (item.key.kind === 'review' || item.key.kind === 'post')
        )
          admissions[index] = 'refused';
        continue;
      }
      const matchesPrimary =
        (item.key.owner === 'content' &&
          supplied.kind === 'thread' &&
          (item.key.kind === 'review' || item.key.kind === 'thread') &&
          item.destination.kind === 'thread' &&
          item.destination.id === supplied.threadId &&
          supplied.postId === undefined) ||
        (item.key.owner === 'content' &&
          supplied.kind === 'post' &&
          item.key.kind === 'post' &&
          item.destination.kind === 'post' &&
          item.destination.id === supplied.postId &&
          item.destination.threadId === supplied.threadId);
      if (!matchesPrimary) {
        admissions[index] = 'refused';
        continue;
      }
      directWitnessPositions.push(index);
      directWitnesses.push(
        supplied.kind === 'thread'
          ? {
              kind: 'thread',
              subjectId: supplied.subjectId,
              threadId: supplied.threadId,
              ...(supplied.voteRevision === undefined ? {} : { voteRevision: supplied.voteRevision }),
            }
          : {
              kind: 'post',
              subjectId: supplied.subjectId,
              threadId: supplied.threadId,
              postId: supplied.postId,
              ...(supplied.voteRevision === undefined ? {} : { voteRevision: supplied.voteRevision }),
            },
      );
    }

    const directOffset = witnesses.length;
    witnesses.push(...directWitnesses);
    let qualified: readonly ('current' | 'absent' | 'refused')[];
    if (witnesses.length) {
      qualified = await qualifyReviewContextWitnesses(dependencies, selection, witnesses, context);
    } else {
      await assertCurrentRatingQuestionSelection(dependencies, selection, context);
      qualified = [];
    }

    const currentLocated = await readSubjectReviewCandidates(dependencies, subjectIds, perSubjectLimit, deadline);
    for (const [subjectId, candidatePositions] of subjectWitnessPositions) {
      const results = candidatePositions.map((position) => qualified[position]!);
      const locatorChanged =
        located.overflow.has(subjectId) !== currentLocated.overflow.has(subjectId) ||
        JSON.stringify(located.candidates.get(subjectId) ?? []) !==
          JSON.stringify(currentLocated.candidates.get(subjectId) ?? []);
      admissionsForSubject(
        admissions,
        subjectPositions.get(subjectId)!,
        results,
        located.overflow.has(subjectId) || locatorChanged,
      );
    }
    for (const [index, position] of directWitnessPositions.entries())
      admissions[position] = qualified[directOffset + index]!;

    return admissions;
  }

  function admissionsForSubject(
    admissions: FeedQuestionAdmission[],
    positions: readonly number[],
    results: readonly ('current' | 'absent' | 'refused')[],
    overflow: boolean,
  ) {
    const result: FeedQuestionAdmission = results.includes('current')
      ? 'current'
      : overflow || results.includes('refused')
        ? 'refused'
        : 'absent';
    for (const position of positions) admissions[position] = result;
  }

  return {
    id: question.id,
    revision: question.revision,
    qualify,
    finish() {
      return assertCurrentRatingQuestionSelection(dependencies, selection, context);
    },
  };
}
