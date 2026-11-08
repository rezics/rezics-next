import { parseDiscoveryFilter } from '@rezics/filter';
import { deadlineClient } from './access-port.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { accessCheck } from './access-port.ts';
import { routeOf } from '../route/route.ts';
import { readVisibleRatingQuestion } from '../rating/question-directory.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import subjectExists from '../semantic/subject-exists.sql';
import type { ReadContext } from './model.ts';
import {
  ContentNotFoundError,
  discloseThreads,
  readPost,
  readCitationDisclosure,
  type ContentReadDependencies,
  type ThreadView,
} from './reads.ts';

export type ReviewContextDependencies = ContentReadDependencies;
export const REVIEW_CONTEXT_MAX_WITNESSES = 160;
/** Producer limits, including both observations. These count native invocations,
 * not SQL statements or a substitute for each reader's authorization/ancestry bound. */
export const REVIEW_CONTEXT_BOUNDS = Object.freeze({
  witnesses: REVIEW_CONTEXT_MAX_WITNESSES,
  questionReads: 2,
  threadDisclosureCandidates: 2 * REVIEW_CONTEXT_MAX_WITNESSES,
  subjectReadChecks: 2 * REVIEW_CONTEXT_MAX_WITNESSES,
  postReads: 2 * REVIEW_CONTEXT_MAX_WITNESSES,
  postChainRows: 2 * 33 * REVIEW_CONTEXT_MAX_WITNESSES,
  nativeReadInvocations: 2 + 6 * REVIEW_CONTEXT_MAX_WITNESSES,
});

declare const selected: unique symbol;
export type RatingQuestionSelection = Readonly<{
  question: Readonly<{
    id: string;
    revision: number;
    label: string;
    grain: string;
    scale: Readonly<{ min: number; max: number; displayStep: number }>;
  }>;
  [selected]: true;
}>;
const selections = new WeakMap<
  RatingQuestionSelection,
  Readonly<{
    deps: ReviewContextDependencies;
    context: ReadContext;
  }>
>();

/** One exact native primary/review pair. Callers own candidate enumeration and
 * must never treat an omitted or refused pair as a negative membership result. */
export type ReviewContextCandidate = Readonly<
  { subjectId: string; threadId: string; voteRevision?: number } & (
    | { kind: 'subject' }
    | { kind: 'thread' }
    | { kind: 'post'; postId: string }
  )
>;

async function currentQuestion(deps: ReviewContextDependencies, id: string, context: ReadContext) {
  // Parse the exact request leaf before authorization, metadata or enumeration.
  parseDiscoveryFilter({ ratingQuestion: { id } });
  const question = await readVisibleRatingQuestion(deps, context.actor, id, context.deadline);
  if (!question) throw new ProblemError('not_found');
  return question;
}

export async function resolveRatingQuestionSelection(
  deps: ReviewContextDependencies,
  id: string,
  context: ReadContext,
): Promise<RatingQuestionSelection> {
  const row = await currentQuestion(deps, id, context);
  const selection = Object.freeze({
    question: Object.freeze({
      id: row.id,
      revision: row.revision,
      label: row.label,
      grain: row.grain,
      scale: Object.freeze({ min: row.minimumUnits, max: row.maximumUnits, displayStep: row.stepUnits }),
    }),
  }) as RatingQuestionSelection;
  selections.set(selection, { deps, context });
  return selection;
}

function assertBinding(deps: ReviewContextDependencies, selection: RatingQuestionSelection, context: ReadContext) {
  const binding = selections.get(selection);
  if (binding?.deps !== deps || binding.context !== context)
    throw new TypeError('Question selection belongs to another request');
}

export async function assertCurrentRatingQuestionSelection(
  deps: ReviewContextDependencies,
  selection: RatingQuestionSelection,
  context: ReadContext,
): Promise<void> {
  assertBinding(deps, selection, context);
  let row;
  try {
    row = await currentQuestion(deps, selection.question.id, context);
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'not_found') throw new ProblemError('invalid_cursor');
    throw error;
  }
  if (row.revision !== selection.question.revision) throw new ProblemError('invalid_cursor');
}

async function readableSubject(deps: ReviewContextDependencies, id: string, context: ReadContext) {
  const route = routeOf(id);
  if (route === null) return false;
  const identity = { route, id };
  const check = await accessCheck(
    deps.access,
    context.actor,
    'subject:read',
    { ...identity, eligibility: subjectReadEligibility(identity) },
    { pool: deps.pool, deadline: context.deadline },
  );
  return withConnection(deps.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    return !!(await subjectExists.run(bounded, { route, subject_id: id })) && (await check(bounded));
  });
}

type ReviewThreadWitness = Readonly<{ state: 'current' | 'absent'; anchor: string }> | Readonly<{ state: 'refused' }>;

function witness(
  thread: ThreadView | null | undefined,
  candidate: ReviewContextCandidate,
  question: string,
): ReviewThreadWitness {
  if (
    !thread ||
    thread.kind !== 'review' ||
    thread.availability !== 'available' ||
    thread.visibility === 'taken_down' ||
    thread.subjectIds.length !== 1 ||
    thread.subjectIds[0] !== candidate.subjectId ||
    thread.firstPost.availability !== 'available' ||
    !('voteCitation' in thread.firstPost)
  )
    return { state: 'refused' };
  const citation = thread.firstPost.voteCitation;
  if (
    readCitationDisclosure(thread) === 'withheld' ||
    (candidate.voteRevision !== undefined && citation?.revision !== candidate.voteRevision)
  )
    return { state: 'refused' };
  // Native disclosure already checked board/place, Realm/ban, author and body.
  // Comparing these anchors refuses an opening/authority change during the read.
  return {
    state: citation?.questionId === question ? 'current' : 'absent',
    anchor: JSON.stringify([
      thread.id,
      thread.boardId,
      thread.securityRevision,
      thread.firstPost.id,
      thread.firstPost.revisionId,
      thread.firstPost.securityRevision,
      citation,
      readCitationDisclosure(thread),
    ]),
  };
}

async function postWitness(
  deps: ReviewContextDependencies,
  pair: ReviewContextCandidate & { kind: 'post' },
  context: ReadContext,
): Promise<string | null> {
  try {
    const post = (await readPost(deps, pair.threadId, pair.postId, context)).value;
    return post?.availability === 'available' && post.visibility !== 'taken_down'
      ? JSON.stringify([post.threadId, post.id, post.revisionId, post.securityRevision])
      : null;
  } catch (error) {
    if (error instanceof ContentNotFoundError || (error instanceof ProblemError && error.code === 'not_found'))
      return null;
    throw error;
  }
}

/** Exact positional witness results. A readable stable citation mismatch is absent;
 * refused pairs supply no negative claim. Votes and aggregates are never read. */
export async function qualifyReviewContextWitnesses(
  deps: ReviewContextDependencies,
  selection: RatingQuestionSelection,
  candidates: readonly ReviewContextCandidate[],
  context: ReadContext,
): Promise<readonly ('current' | 'absent' | 'refused')[]> {
  if (candidates.length > REVIEW_CONTEXT_MAX_WITNESSES) throw new RangeError('At most 160 review witnesses');
  assertBinding(deps, selection, context);
  // Own the input across awaits; a caller cannot replace an admitted anchor.
  const pairs = candidates.map((candidate) => Object.freeze({ ...candidate }));
  for (const candidate of pairs) {
    if (
      !['subject', 'thread', 'post'].includes(candidate.kind) ||
      routeOf(candidate.subjectId) === null ||
      routeOf(candidate.threadId) === null ||
      (candidate.kind === 'post' && routeOf(candidate.postId) !== routeOf(candidate.threadId))
    )
      throw new TypeError('Invalid review witness anchor');
  }
  await assertCurrentRatingQuestionSelection(deps, selection, context);
  if (!pairs.length) return [];
  const subjectIds = [...new Set(pairs.map(({ subjectId }) => subjectId))];
  const subjects = new Map<string, boolean>();
  for (const id of subjectIds) subjects.set(id, await readableSubject(deps, id, context));
  const threadIds = [...new Set(pairs.map(({ threadId }) => threadId))];
  const initial = await discloseThreads(deps, threadIds, context);
  const threads = new Map(threadIds.map((id, index) => [id, initial[index]!.value]));
  const posts = new Map<string, string | null>();
  for (const pair of pairs) {
    if (pair.kind !== 'post') continue;
    const key = `${pair.threadId}:${pair.postId}`;
    if (!posts.has(key)) posts.set(key, await postWitness(deps, pair, context));
  }
  const final = await discloseThreads(deps, threadIds, context);
  const current = new Map(threadIds.map((id, index) => [id, final[index]!.value]));
  const checkedPosts = new Set<string>();
  for (const pair of pairs) {
    if (pair.kind !== 'post') continue;
    const key = `${pair.threadId}:${pair.postId}`;
    if (checkedPosts.has(key)) continue;
    checkedPosts.add(key);
    if (posts.get(key) !== (await postWitness(deps, pair, context))) posts.set(key, null);
  }
  for (const id of subjectIds) subjects.set(id, subjects.get(id)! && (await readableSubject(deps, id, context)));
  await assertCurrentRatingQuestionSelection(deps, selection, context);
  return pairs.map((pair) => {
    const before = witness(threads.get(pair.threadId), pair, selection.question.id);
    const after = witness(current.get(pair.threadId), pair, selection.question.id);
    if (
      !subjects.get(pair.subjectId) ||
      before.state === 'refused' ||
      after.state === 'refused' ||
      before.anchor !== after.anchor
    )
      return 'refused';
    if (before.state === 'absent') return 'absent';
    if (pair.kind === 'post' && !posts.get(`${pair.threadId}:${pair.postId}`)) return 'refused';
    return 'current';
  });
}
