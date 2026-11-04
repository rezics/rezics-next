import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { loadBoardPageWithAuthors } from '../../../identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../../../kernel/fake';
import { emptyBoardId } from '../../../kernel/fake/board-continuation';
import board from '../../../kernel/recorded/board.json';
import realmBoard from '../../../kernel/recorded/board-realm.json';
import realm from '../../../kernel/recorded/board-realm-realm.json';
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
async function presentationFixture(): Promise<CommunityPresentation> {
  const body = fromPlainText('Discuss the book with care. Mark spoilers before sharing them.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeDocument(body)));
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
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
        postId: '01a17ce8-2850-71fd-a965-456700000001',
        revisionId: '01a17ce8-2850-71fe-874d-456700000002',
        body,
        licence: 'MIT',
        sha256,
      },
    },
    join: { membership: 'unknown', action: null },
  };
}

function CommunityExample({ state }: { state: CommunityState }) {
  const realm = state !== 'feed' && state !== 'empty';
  const id = state === 'empty' ? emptyBoardId : realm ? realmBoard.board.id : board.board.id;
  const query = useQuery({
    queryKey: ['board-community-pattern', state],
    queryFn: async () => {
      const recorded = createStoryRecordedKernelFetch();
      const presentation = state === 'presentation' || state === 'no-optionals' ? await presentationFixture() : null;
      return loadBoardPageWithAuthors(
        createKernelClient('https://kernel.story', {
          fetch: Object.assign(
            (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
              const url = new URL(new Request(input, init).url);
              if (presentation && url.pathname === `/v1/boards/${id}`) {
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
            { preconnect: recorded.preconnect },
          ),
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
  if (state === 'source-unavailable') shown.community = { state: 'unavailable', value: null };
  return (
    <BoardCommunity
      page={shown}
      sort="active"
      participation={<BoardParticipation community={shown.community} returnTo={`/${getLocale()}/boards/${id}`} />}
      start={
        <BoardStartThread
          board={shown.board}
          advice={shown.actions.createThread}
          returnTo={`/${getLocale()}/boards/${id}`}
        />
      }
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
