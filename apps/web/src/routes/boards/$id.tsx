import { useSession } from '../../session/query';
import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { boardPageHead } from '../../threads/thread-head';
import { rememberThreadSlug, threadTitle } from '../../threads/thread-href';
import { boardPageQuery } from '../../threads/thread-queries';
import { boardSortFromSearch } from '../../threads/board-sort';
import { BoardCommunity, BoardCommunityMenu, BoardCommunityStatus } from '../../threads/board-community';
import { BoardParticipation, BoardStartThread } from '../../threads/board-community-actions';
import { isPlatformClosedError } from '../../kernel/platform-closed';

function boardSearch(search: Record<string, unknown>): { cursor?: string; sort?: 'hot' | 'new' } {
  const cursor = v.parse(v.fallback(v.optional(v.string()), undefined), search.cursor);
  const sort = boardSortFromSearch(v.parse(v.fallback(v.optional(v.string()), undefined), search.sort));
  return {
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(sort ? { sort } : {}),
  };
}

export const Route = createFileRoute('/boards/$id')({
  staticData: { publicCache: true },
  validateSearch: boardSearch,
  // The router passes unvalidated keys through, so read the sort through the same check again.
  loaderDeps: ({ search }) => {
    const parsed = boardSearch(search);
    return { cursor: parsed.cursor, sort: parsed.sort };
  },
  loader: async ({ params, deps, context }) => {
    const page = await context.queryClient.ensureQueryData(
      boardPageQuery(params.id, deps.cursor, deps.sort, context.credentialMode),
    );
    for (const thread of page.threads.threads) rememberThreadSlug(thread.id, threadTitle(thread));
    return { ...page, indexable: deps.cursor === undefined && page.threads.threads.length > 0 };
  },
  head: ({ loaderData }) => (loaderData ? boardPageHead(loaderData) : { meta: [{ title: m.threads_untitled() }] }),
  pendingComponent: () => <BoardCommunityStatus state="loading" />,
  errorComponent: BoardPageError,
  component: BoardPage,
});

function BoardPage() {
  const page = Route.useLoaderData();
  const { state: session } = useSession();
  const location = useLocation();
  const id = Route.useParams().id;
  const sort = boardSortFromSearch(Route.useSearch().sort);
  const returnTo = location.publicHref.split(/[?#]/, 1)[0]!;
  return (
    <BoardCommunity
      page={page}
      sort={sort ?? 'active'}
      participation={<BoardParticipation realm={page.realm} community={page.community} returnTo={returnTo} />}
      start={<BoardStartThread board={page.board} realm={page.realm} returnTo={returnTo} />}
      overflow={<BoardCommunityMenu boardId={id} signedIn={session === 'signed-in'} />}
    />
  );
}

function BoardPageError({ error }: { error: unknown }) {
  const router = useRouter();
  return (
    <BoardCommunityStatus
      state={isPlatformClosedError(error) ? 'closed' : 'error'}
      onRetry={() => void router.invalidate()}
    />
  );
}
