import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { BOARD_RECENT_THREAD_LIMIT, type ContentBoardDependencies } from './boards.ts';
import type { CommunityComments } from './community-projection/index.ts';
import { contentRealmApplication } from './adapters/realm-binding.ts';
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
export function RealmCommunityRecentSchema() {
  return memoizedValue(RealmCommunityRecentSchema, () =>
    t.Object(
      {
        state: t.Literal('current'),
        threads: t.Array(t.Pick(BoardOpeningCardSchema(), ['thread', 'target', 'comments'], closed), {
          maxItems: BOARD_RECENT_THREAD_LIMIT,
        }),
        complete: t.Boolean(),
      },
      closed,
    ),
  );
}

/** Native compatibility entry; the installed application owns orchestration. */
export function observeRealmCommunity(
  deps: ContentBoardDependencies,
  boards: readonly BoardRecord[],
  context: ReadContext,
) {
  return contentRealmApplication().community.observe(deps, boards, context);
}
