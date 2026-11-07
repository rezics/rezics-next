import { deadlineClient, within } from './access-port.ts';
import type { RealmParticipationReadDecision, RealmParticipationCheck } from '../community/participation.ts';
import { ProblemError } from '../http/problem.ts';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import { readRealmBoard, selectRealmBoardPage, type ContentBoardDependencies } from './boards.ts';
import { ContentNotFoundError, readBoardPageActionEvidence, readBoards } from './reads.ts';
import { prepareSubjectThreadContext } from './subject-threads-context.ts';
import type { AnchoredPosition, BoardView, ReadContext } from './model.ts';
import type { SubjectThreadContext } from './subject-threads-context.ts';

export const REVIEW_DESTINATION_RAW_LIMIT = 20;
export const REVIEW_DESTINATION_LOOKAHEAD = 1;
export const REVIEW_DESTINATION_MAX_RESPONSE_BYTES = 96 * 1024;
const REVIEW_DESTINATION_CURSOR_POLICY = 'review-destinations-v1';
const REVIEW_DESTINATION_POLICY_HORIZON_MS = 15 * 60_000;

export type ReviewDestinationState = 'choices' | 'sparse' | 'no-destinations' | 'exhausted' | 'denied' | 'expired';
export type ReviewDestinationItem = Readonly<{
  id: string;
  title: string | null;
  purpose: 'reviews';
  actions: Readonly<{ createReview: 'allowed' }>;
  native: Readonly<{
    kind: 'review';
    boardId: string;
    subjectIds: readonly [string];
    subjectSource: Readonly<{ partition: number; epoch: number; position: string }>;
    realmHeadRevisionId: string;
    boardSecurityRevision: string;
  }>;
}>;
export type ReviewDestinationContext = Readonly<{
  subject: Readonly<{
    id: string;
    label: Readonly<{ value: string; language: string }> | null;
    source: Readonly<{ partition: number; epoch: number; position: string }>;
  }>;
  realm: Readonly<{ id: string; title: string; spaceId: string; headRevisionId: string }>;
}>;
export type ReviewDestinationPage = Readonly<{
  state: ReviewDestinationState;
  viewer: Readonly<{ state: 'current' | 'denied' }>;
  context: ReviewDestinationContext | null;
  items: readonly ReviewDestinationItem[];
  next: string | null;
}>;
export type ReviewDestinationResult = Readonly<{
  page: ReviewDestinationPage;
  anchors: readonly AnchoredPosition[];
}>;

export type ReviewDestinationsDependencies = ContentBoardDependencies &
  Readonly<{ realmParticipation?: RealmParticipationCheck }>;

function denied(context: ReviewDestinationContext | null = null): ReviewDestinationPage {
  return { state: 'denied', viewer: { state: 'denied' }, context, items: [], next: null };
}

function contextProjection(context: SubjectThreadContext): ReviewDestinationContext {
  if (context.place.kind !== 'realm') throw new ContentNotFoundError();
  return {
    subject: context.subject,
    realm: {
      id: context.place.id,
      title: context.place.title,
      spaceId: context.place.spaceId,
      headRevisionId: context.place.headRevisionId,
    },
  };
}

function cursorBinding(actor: Exclude<Actor, { kind: 'anonymous' }>, context: ReviewDestinationContext): CursorBinding {
  return {
    operation: 'content.review-destinations.list',
    parameters: {
      actor: actor.accountId,
      client: actor.clientId,
      delegator: actor.requestedBy,
      scopes: [...actor.scopes].sort().join('\0'),
      authenticationEpisode: actor.authnEpoch,
      realmId: context.realm.id,
      realmHeadRevisionId: context.realm.headRevisionId,
      subjectId: context.subject.id,
      subjectSource: `${context.subject.source.partition}:${context.subject.source.epoch}:${context.subject.source.position}`,
      filter: 'purpose=reviews',
      order: 'native-board-keyset',
      limit: REVIEW_DESTINATION_RAW_LIMIT,
      policy: REVIEW_DESTINATION_CURSOR_POLICY,
    },
  };
}

async function participation(
  dependencies: ReviewDestinationsDependencies,
  actor: Exclude<Actor, { kind: 'anonymous' }>,
  realmId: string,
  deadline: number,
): Promise<boolean> {
  const check = dependencies.realmParticipation;
  if (!check) throw new ProblemError('dependency_unavailable');
  const readDecision: RealmParticipationReadDecision = {};
  const allowed = await within(deadline, () =>
    check(deadlineClient(dependencies.pool, deadline), { realmId, actor, readDecision }),
  );
  if (readDecision.readable === false) throw new ContentNotFoundError();
  return allowed;
}

function item(board: BoardView, context: ReviewDestinationContext): ReviewDestinationItem {
  return {
    id: board.id,
    title: board.title,
    purpose: 'reviews',
    actions: { createReview: 'allowed' },
    native: {
      kind: 'review',
      boardId: board.id,
      subjectIds: [context.subject.id],
      subjectSource: context.subject.source,
      realmHeadRevisionId: context.realm.headRevisionId,
      boardSecurityRevision: board.securityRevision,
    },
  };
}

function assertResponseBound(page: ReviewDestinationPage): ReviewDestinationPage {
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > REVIEW_DESTINATION_MAX_RESPONSE_BYTES)
    throw new ProblemError('dependency_unavailable');
  return page;
}

/** One bounded Realm destination page. Every raw key advances the native frontier,
 * whether the Board is hidden, non-review, or lacks current create authority. */
export async function readReviewDestinationPage(
  dependencies: ReviewDestinationsDependencies,
  actor: Actor,
  realmId: string,
  subjectId: string,
  context: ReadContext,
  cursor?: string,
): Promise<ReviewDestinationResult> {
  if (routeOf(realmId) === null || routeOf(subjectId) === null) throw new ContentNotFoundError();
  if (actor.kind !== 'account') return { page: denied(), anchors: [] };

  const nativeContext = await prepareSubjectThreadContext(dependencies, subjectId, realmId, 'review', context);
  const current = contextProjection(nativeContext.initial);
  const binding = cursorBinding(actor, current);
  const now = dependencies.cursorNow();
  if (!Number.isSafeInteger(now)) throw new TypeError('Invalid content cursor');

  let innerCursor: string | undefined;
  let policyHorizon = now;
  const expiredPage = async (): Promise<ReviewDestinationResult> => {
    await nativeContext.finish();
    return {
      page: assertResponseBound({
        state: 'expired',
        viewer: { state: 'current' },
        context: current,
        items: [],
        next: null,
      }),
      anchors: [],
    };
  };
  if (cursor !== undefined) {
    const decoded = decodeCursor(dependencies.tokens, binding, cursor, now);
    if (!decoded.ok || decoded.epoch !== current.subject.source.epoch || decoded.after.length !== 2)
      return expiredPage();
    const [value, horizon] = decoded.after;
    if (typeof value !== 'string' || typeof horizon !== 'string') return expiredPage();
    const prefix = `${REVIEW_DESTINATION_CURSOR_POLICY}:`;
    if (!horizon.startsWith(prefix) || !/^\d+$/.test(horizon.slice(prefix.length))) return expiredPage();
    policyHorizon = Number(horizon.slice(prefix.length));
    if (
      !Number.isSafeInteger(policyHorizon) ||
      policyHorizon > now ||
      now - policyHorizon > REVIEW_DESTINATION_POLICY_HORIZON_MS
    ) {
      return expiredPage();
    }
    innerCursor = value;
  }

  if (!(await participation(dependencies, actor, realmId, context.deadline))) {
    const finalContext = contextProjection(await nativeContext.finish());
    return { page: assertResponseBound(denied(finalContext)), anchors: [] };
  }

  let selected: Awaited<ReturnType<typeof selectRealmBoardPage>>;
  try {
    selected = await selectRealmBoardPage(dependencies, realmId, context, {
      limit: REVIEW_DESTINATION_RAW_LIMIT,
      ...(innerCursor === undefined ? {} : { cursor: innerCursor }),
    });
  } catch (error) {
    // The inner Realm keyset is bound to the current Realm source epoch. A
    // changed Realm generation closes this page as expired so the browser can
    // preserve the frontier and offer an explicit restart.
    if (innerCursor !== undefined && error instanceof TypeError && error.message === 'Invalid content cursor')
      return expiredPage();
    throw error;
  }
  const boards = await readBoards(dependencies, selected.ids, context);
  const items: ReviewDestinationItem[] = [];
  const anchors = [selected.anchor, ...boards.map(({ anchor }) => anchor)];
  let reviewBoards = 0;
  for (const { value: board } of boards) {
    if (!board || board.realmId !== realmId || board.availability !== 'available' || board.purpose !== 'reviews')
      continue;
    reviewBoards++;
    try {
      const advice = await readBoardPageActionEvidence(dependencies, board.id, board, [], context);
      anchors.push(...advice.anchors);
      if (advice.createThread) items.push(item(board, current));
    } catch (error) {
      if (!(error instanceof ContentNotFoundError)) throw error;
    }
  }

  // Re-evaluate Realm admission after candidate, Board and action work. The
  // command repeats the same policy inside its write transaction.
  const stillParticipates = await participation(dependencies, actor, realmId, context.deadline);
  const finalContext = contextProjection(await nativeContext.finish());
  if (JSON.stringify(finalContext) !== JSON.stringify(current)) throw new ProblemError('dependency_unavailable');
  if (!stillParticipates) return { page: assertResponseBound(denied(finalContext)), anchors };

  const next = selected.next
    ? encodeCursor(
        dependencies.tokens,
        binding,
        {
          epoch: current.subject.source.epoch,
          after: [selected.next, `${REVIEW_DESTINATION_CURSOR_POLICY}:${policyHorizon}`],
        },
        now,
      )
    : null;
  const state: ReviewDestinationState =
    items.length > 0
      ? 'choices'
      : next !== null
        ? 'sparse'
        : reviewBoards > 0
          ? 'denied'
          : cursor !== undefined
            ? 'exhausted'
            : 'no-destinations';
  return {
    page: assertResponseBound({ state, viewer: { state: 'current' }, context: finalContext, items, next }),
    anchors,
  };
}

/** Fresh exact inspection before the browser carries the original operands into the composer. */
export async function inspectReviewDestination(
  dependencies: ReviewDestinationsDependencies,
  actor: Actor,
  realmId: string,
  subjectId: string,
  boardId: string,
  context: ReadContext,
): Promise<ReviewDestinationResult> {
  if (actor.kind !== 'account') return { page: denied(), anchors: [] };
  if ([realmId, subjectId, boardId].some((id) => routeOf(id) === null)) throw new ContentNotFoundError();
  const nativeContext = await prepareSubjectThreadContext(dependencies, subjectId, realmId, 'review', context);
  const current = contextProjection(nativeContext.initial);
  if (!(await participation(dependencies, actor, realmId, context.deadline))) {
    return { page: assertResponseBound(denied(contextProjection(await nativeContext.finish()))), anchors: [] };
  }

  const selected = await readRealmBoard(dependencies, boardId, context);
  const board = selected.value;
  if (!board || board.realmId !== realmId || board.availability !== 'available' || board.purpose !== 'reviews')
    throw new ContentNotFoundError();
  const advice = await readBoardPageActionEvidence(dependencies, board.id, board, [], context);
  const stillParticipates = await participation(dependencies, actor, realmId, context.deadline);
  const finalContext = contextProjection(await nativeContext.finish());
  if (JSON.stringify(finalContext) !== JSON.stringify(current)) throw new ProblemError('dependency_unavailable');
  if (!stillParticipates || !advice.createThread)
    return { page: assertResponseBound(denied(finalContext)), anchors: [selected.anchor, ...advice.anchors] };
  return {
    page: assertResponseBound({
      state: 'choices',
      viewer: { state: 'current' },
      context: finalContext,
      items: [item(board, finalContext)],
      next: null,
    }),
    anchors: [selected.anchor, ...advice.anchors],
  };
}
