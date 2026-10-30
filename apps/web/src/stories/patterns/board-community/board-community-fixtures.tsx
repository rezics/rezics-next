import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { loadBoardPageWithAuthors } from '../../../identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../../../kernel/fake';
import { emptyBoardId } from '../../../kernel/fake/board-continuation';
import board from '../../../kernel/recorded/board.json';
import realmBoard from '../../../kernel/recorded/board-realm.json';
import { BoardCommunity, BoardCommunityStatus } from '../../../threads/board-community';
import { BoardParticipation, BoardStartThread } from '../../../threads/board-community-actions';
import { PatternStory } from '../../page';
import { getLocale } from '../../../paraglide/runtime.js';

export type CommunityState = 'feed' | 'realm' | 'protected' | 'source-unavailable' | 'empty';

function CommunityExample({ state }: { state: CommunityState }) {
  const realm = state === 'realm' || state === 'protected' || state === 'source-unavailable';
  const id = state === 'empty' ? emptyBoardId : realm ? realmBoard.board.id : board.board.id;
  const query = useQuery({
    queryKey: ['board-community-pattern', state],
    queryFn: () =>
      loadBoardPageWithAuthors(
        createKernelClient('https://kernel.story', { fetch: createStoryRecordedKernelFetch() }),
        { id },
      ),
  });
  if (query.isPending) return <BoardCommunityStatus state="loading" />;
  if (query.isError) return <BoardCommunityStatus state="error" onRetry={() => void query.refetch()} />;
  const page =
    state === 'protected'
      ? { ...query.data, board: { ...query.data.board, visibility: 'protected' as const } }
      : query.data;
  // The unavailable variant removes the optional source; it never turns the Realm board into a Global board.
  const shown = { ...page };
  if (state === 'source-unavailable') delete shown.realm;
  return (
    <BoardCommunity
      page={shown}
      sort="active"
      participation={<BoardParticipation realm={shown.realm} returnTo={`/${getLocale()}/boards/${id}`} />}
      start={<BoardStartThread board={shown.board} realm={shown.realm} returnTo={`/${getLocale()}/boards/${id}`} />}
    />
  );
}

/** Recorded DTOs through the actual loader, with explicit presentation variants rather than invented producers. */
export function CommunityFixture({ state = 'feed' }: { state?: CommunityState }) {
  return (
    <PatternStory>
      <div className="mx-auto max-w-6xl p-4">
        <CommunityExample state={state} />
      </div>
    </PatternStory>
  );
}
