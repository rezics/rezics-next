import { t } from 'elysia';
import { isDeepStrictEqual } from 'node:util';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { BOARD_RECENT_THREAD_LIMIT, observeBoardRecentThreads, type ContentBoardDependencies } from './boards.ts';
import { createConversationActivityBatch } from './conversation-activity.ts';
import {
  projectCommunityActivitySelection,
  projectCommunityCommentsBatch,
  type CommunityComments,
} from './community-projection/index.ts';
import type { BoardRecord, ReadContext } from './model.ts';
import type { ThreadView } from './reads.ts';
import { BoardOpeningCardSchema } from './schemas.ts';

export type RealmCommunityThread = Readonly<{
  thread: ThreadView;
  target: Readonly<{ kind: 'thread'; id: string; boardId: string }>;
  comments: CommunityComments;
}>;
export type RealmCommunityRecent = Readonly<{
  state: 'current';
  threads: readonly RealmCommunityThread[];
  complete: boolean;
}>;
const closed = { additionalProperties: false } as const;
export const RealmCommunityRecentSchema = t.Object(
  {
    state: t.Literal('current'),
    threads: t.Array(t.Pick(BoardOpeningCardSchema, ['thread', 'target', 'comments'], closed), {
      maxItems: BOARD_RECENT_THREAD_LIMIT,
    }),
    complete: t.Boolean(),
  },
  closed,
);

/** One activity batch for the entire admitted Board window: 20 × 3 keys fits
 * the producer's 100-key bound. Missing coverage stays unavailable, never zero.
 * The three-card projection carries reading destinations only, without actions,
 * author-account hydration, reactions or a complete Board opening per row.
 */
export async function observeRealmCommunity(
  deps: ContentBoardDependencies,
  boards: readonly BoardRecord[],
  context: ReadContext,
) {
  if (boards.length > 20) throw new RangeError('Realm community accepts at most twenty Boards');
  const observations = new Map<string, Awaited<ReturnType<typeof observeBoardRecentThreads>>>();
  for (const board of boards) {
    if (board.availability !== 'available') continue;
    observations.set(board.id, await observeBoardRecentThreads(deps, board.id, context));
  }
  const threads = [...observations.values()].flatMap((observation) => observation.threads);
  const activity = createConversationActivityBatch(deps.pool);
  const selected = await activity.select(
    threads.map((thread) => thread.id),
    context.deadline,
  );
  const boardById = new Map(boards.map((board) => [board.id, board]));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  for (const item of selected) {
    if (item.status !== 'current') continue;
    const thread = threadById.get(item.threadId);
    const board = thread && boardById.get(thread.boardId);
    if (
      !thread ||
      !board ||
      item.witness.boardId !== board.id ||
      item.witness.realmId !== board.realmId ||
      item.witness.threadSecurityRevision !== thread.securityRevision ||
      item.witness.boardSecurityRevision !== board.securityRevision
    )
      throw new AccessUnavailableError('contention');
  }
  const threadIds = threads.map((thread) => thread.id);
  const comments = projectCommunityCommentsBatch(
    threadIds,
    projectCommunityActivitySelection(selected).items,
    context.actor,
  );
  const recent = new Map<string, RealmCommunityRecent>();
  for (const [boardId, observation] of observations) {
    recent.set(boardId, {
      state: 'current',
      complete: observation.complete,
      threads: observation.threads.map((thread) => ({
        thread,
        target: { kind: 'thread', id: thread.id, boardId },
        comments: comments.get(thread.id) ?? { state: 'unavailable' },
      })),
    });
  }
  return {
    recent,
    async current() {
      for (const observation of observations.values()) if (!(await observation.current())) return false;
      const confirmed = await activity.confirm(selected, context.deadline);
      if (confirmed.some((item) => item.status === 'withheld' && item.reason === 'stale')) return false;
      return isDeepStrictEqual(
        comments,
        projectCommunityCommentsBatch(threadIds, projectCommunityActivitySelection(confirmed).items, context.actor),
      );
    },
  };
}
