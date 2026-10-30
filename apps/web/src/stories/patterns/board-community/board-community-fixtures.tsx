import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { loadBoardPageWithAuthors } from '../../../identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../../../kernel/fake';
import { emptyBoardId } from '../../../kernel/fake/board-continuation';
import board from '../../../kernel/recorded/board.json';
import realmBoard from '../../../kernel/recorded/board-realm.json';
import realm from '../../../kernel/recorded/realm.json';
import threads from '../../../kernel/recorded/board-threads.json';
import { BoardCommunity, BoardCommunityStatus } from '../../../threads/board-community';
import { BoardParticipation, BoardStartThread } from '../../../threads/board-community-actions';
import { PatternStory } from '../../page';
import { getLocale } from '../../../paraglide/runtime.js';
import type { CommunityPresentation } from '../../../threads/board-community-source';

export type CommunityState =
  | 'feed'
  | 'realm'
  | 'protected'
  | 'source-unavailable'
  | 'empty'
  | 'presentation'
  | 'no-optionals';

// Explicit producer-contract fixtures, consumed through the real board loader; never runtime fallback data.
const presentation: CommunityPresentation = {
  realmId: realmBoard.board.realmId,
  spaceId: realm.realm.spaceId,
  contextId: realm.realm.contextId,
  name: realm.realm.title,
  description: realm.realm.summary,
  avatar: { state: 'none', value: null },
  banner: { state: 'unavailable', value: null },
  members: { state: 'current', count: 128, version: 'fixture-version' },
  rules: {
    state: 'available',
    value: {
      postId: threads.threads[0]!.firstPost.id,
      revisionId: threads.threads[0]!.firstPost.revisionId,
      body: fromPlainText('Discuss the book with care. Mark spoilers before sharing them.'),
      licence: 'MIT',
      sha256: threads.threads[0]!.firstPost.sha256,
    },
  },
  join: { membership: 'unknown', action: null },
};

function CommunityExample({ state }: { state: CommunityState }) {
  const realm = state !== 'feed' && state !== 'empty';
  const id = state === 'empty' ? emptyBoardId : realm ? realmBoard.board.id : board.board.id;
  const query = useQuery({
    queryKey: ['board-community-pattern', state],
    queryFn: () => {
      const recorded = createStoryRecordedKernelFetch();
      return loadBoardPageWithAuthors(
        createKernelClient('https://kernel.story', {
          fetch: (input, init) => {
            const url = new URL(new Request(input, init).url);
            if ((state === 'presentation' || state === 'no-optionals') && url.pathname === `/v1/boards/${id}`) {
              const community: CommunityPresentation =
                state === 'presentation'
                  ? presentation
                  : {
                      ...presentation,
                      description: '',
                      avatar: { state: 'none', value: null },
                      banner: { state: 'none', value: null },
                      members: { state: 'unknown', count: null, version: null },
                      rules: { state: 'none', value: null },
                    };
              return Promise.resolve(Response.json({ board: { ...realmBoard.board, community } }));
            }
            return recorded(input, init);
          },
        }),
        { id },
      );
    },
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
      participation={
        <BoardParticipation realm={shown.realm} community={shown.community} returnTo={`/${getLocale()}/boards/${id}`} />
      }
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
