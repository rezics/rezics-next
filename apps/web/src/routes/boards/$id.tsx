import { CommunityRouteNotFound, readCommunityRoute } from '../../community/protected-route';
import { realmReadingReturn } from '../../community/realm-reading-return';
import { useSession } from '../../session/query';
import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { boardPageHead } from '../../threads/thread-head';
import { rememberThreadSlug, threadTitle } from '../../threads/thread-href';
import { boardPageQuery } from '../../threads/thread-queries';
import { boardSortFromSearch } from '../../threads/board-sort';
import { BoardCommunity, BoardCommunityMenu, BoardCommunityStatus } from '../../threads/board-community';
import { BoardParticipation, BoardStartThread } from '../../threads/board-community-actions';
import { BoardWatchControl } from '../../threads/board-watch/control';
import { SlowModeSetting } from '../../threads/slow-mode';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { isBoardPageCursorError } from '../../threads/board-reading';
import { boardSearch, boardRequestHref } from '../../threads/board-navigation';
import {
  BoardPageCallerHost,
  createBoardPageCaller,
  useBoardPageErrorLifecycle,
  type BoardPageLoadResult,
} from '../../threads/board-page-caller';

export { boardSearch } from '../../threads/board-navigation';

export const Route = createFileRoute('/boards/$id')({
  staticData: { publicCache: true },
  validateSearch: boardSearch,
  // The router passes unvalidated keys through, so read the sort through the same check again.
  loaderDeps: ({ search }) => {
    const parsed = boardSearch(search);
    return { cursor: parsed.cursor, sort: parsed.sort };
  },
  loader: ({ params, deps, abortController, context }) =>
    readCommunityRoute(context.queryClient, context.credentialMode, async (credentialMode) => {
      const caller = createBoardPageCaller(
        context.queryClient,
        {
          id: params.id,
          ...(deps.cursor === undefined ? {} : { cursor: deps.cursor }),
          ...(deps.sort === undefined ? {} : { sort: deps.sort }),
          locale: getLocale(),
          credentialMode,
        },
        abortController.signal,
      );
      try {
        const read = await context.queryClient.ensureQueryData(
          caller.queryOptions(boardPageQuery(params.id, deps.cursor, deps.sort, credentialMode)),
        );
        caller.assertLoadCurrent();
        const result = await caller.resultFor(
          read,
          credentialMode === 'anonymous' &&
            deps.cursor === undefined &&
            deps.sort === undefined &&
            read.page.threads.threads.length > 0,
        );
        caller.assertLoadCurrent();
        if (credentialMode === 'anonymous') {
          for (const thread of [...(read.page.threads.pinnedThreads ?? []), ...read.page.threads.threads]) {
            caller.assertLoadCurrent();
            rememberThreadSlug(thread.id, threadTitle(thread));
          }
        }
        caller.assertLoadCurrent();
        return result;
      } catch (error) {
        caller.captureError(error);
        throw error;
      }
    }),
  head: ({ loaderData }) =>
    loaderData?.caller.credentialMode === 'anonymous'
      ? boardPageHead(loaderData)
      : { meta: [{ name: 'robots', content: 'noindex, follow' }] },
  pendingComponent: () => <BoardCommunityStatus state="loading" />,
  errorComponent: BoardPageError,
  notFoundComponent: CommunityRouteNotFound,
  component: BoardPage,
});

function BoardPage() {
  const page = Route.useLoaderData() as BoardPageLoadResult;
  const session = useSession();
  const location = useLocation();
  const router = useRouter();
  const id = Route.useParams().id;
  const search = Route.useSearch();
  const sort = boardSortFromSearch(search.sort);
  const credentialMode = page.caller.credentialMode;
  const returnTo = boardRequestHref(getLocale(), id, boardSearch(search));
  return (
    <BoardPageCallerHost
      result={page}
      input={{
        id,
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
        ...(sort === undefined ? {} : { sort }),
        locale: getLocale(),
        credentialMode,
      }}
    >
      {(currentPage, reactionOrigin, slowModeSource) => (
        <>
          {search.returnTo ? (
            <a
              href={search.returnTo}
              className="inline-flex max-w-full items-center text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {realmReadingReturn(search.returnTo) ? m.realm_reading_return() : m.subject_connections_return()}
            </a>
          ) : null}
          <BoardCommunity
            page={currentPage}
            sort={sort ?? 'active'}
            reactionOrigin={reactionOrigin}
            navigation={{ href: returnTo }}
            {...(search.cursor === undefined ? {} : { cursor: search.cursor })}
            participation={(page) => <BoardParticipation community={page.community} returnTo={returnTo} />}
            watch={<BoardWatchControl boardId={id} returnTo={returnTo} session={session} authority={reactionOrigin} />}
            start={(page) => (
              <BoardStartThread
                board={page.board}
                advice={page.actions.createThread}
                viewer={page.viewer}
                returnTo={returnTo}
                {...(search.returnTo ? { preparedReturnTo: search.returnTo } : {})}
              />
            )}
            overflow={<BoardCommunityMenu boardId={id} signedIn={session.state === 'signed-in'} />}
            postingInterval={
              session.state === 'signed-in' ? (
                <SlowModeSetting
                  boardId={id}
                  scopeKey={JSON.stringify([location.publicHref, getLocale(), credentialMode])}
                  credentialMode={credentialMode}
                  source={slowModeSource}
                  onApplied={() => void router.invalidate()}
                />
              ) : null
            }
          />
        </>
      )}
    </BoardPageCallerHost>
  );
}

function BoardPageError({ error }: { error: unknown }) {
  const router = useRouter();
  const id = Route.useParams().id;
  const search = Route.useSearch();
  const sort = boardSortFromSearch(search.sort);
  const lifecycle = useBoardPageErrorLifecycle(error, {
    id,
    ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    ...(sort === undefined ? {} : { sort }),
    locale: getLocale(),
    credentialMode: router.options.context.credentialMode,
  });
  const canRetry = lifecycle.caller && lifecycle.current;
  const restart = isBoardPageCursorError(error);
  return (
    <BoardCommunityStatus
      state={
        lifecycle.caller && !lifecycle.current
          ? 'loading'
          : restart
            ? 'restart'
            : isPlatformClosedError(error)
              ? 'closed'
              : 'error'
      }
      {...(restart ? { restart: { boardId: id, sort: sort ?? 'active', returnTo: search.returnTo } } : {})}
      {...(canRetry && !restart ? { onRetry: () => void lifecycle.retry(() => void router.invalidate()) } : {})}
    />
  );
}
