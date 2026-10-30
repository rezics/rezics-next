import { useSession } from '../../session/query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { boardPageHead } from '../../threads/thread-head';
import { rememberThreadSlug, threadTitle } from '../../threads/thread-href';
import { boardPageQuery } from '../../threads/thread-queries';
import { SignInPrompt } from '../../threads/composer';
import { BoardContext } from '../../threads/thread-context';
import { boardSortFromSearch } from '../../threads/board-sort';
import { BoardThreads } from '../../threads/board-continuation';
import { ClosedErrorPage } from '../../shell/closed';
import { PageHeading } from '../../shell/page-heading';

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
  errorComponent: ClosedErrorPage,
  component: BoardPage,
});

function BoardPage() {
  const { board, realm, threads, authors, now } = Route.useLoaderData();
  const { state: session } = useSession();
  const location = useLocation();
  const id = Route.useParams().id;
  const locale = getLocale();
  const sort = boardSortFromSearch(Route.useSearch().sort);
  const returnTo = location.publicHref.split(/[?#]/, 1)[0]!;
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <BoardContext realm={realm} />
        <div className="flex items-start justify-between gap-4">
          <PageHeading>{board.title ?? m.threads_untitled()}</PageHeading>
          {session === 'signed-in' ? (
            <details className="relative shrink-0">
              <summary
                aria-label={m.board_more_actions()}
                className="flex size-10 cursor-pointer list-none items-center justify-center rounded-md border hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                ⋯
              </summary>
              <div className="absolute right-0 z-10 mt-1 min-w-48 rounded-md border bg-popover p-1 shadow-md">
                <a
                  className="block rounded-sm px-3 py-2 text-sm hover:bg-muted"
                  href={`/${locale}/boards/${id}/moderation`}
                >
                  {m.moderation_reports_heading()}
                </a>
              </div>
            </details>
          ) : null}
        </div>
      </header>
      <BoardThreads
        boardId={id}
        sort={sort ?? 'active'}
        page={threads}
        authors={authors}
        now={now}
        actions={
          session === 'signed-in' ? (
            <a className={buttonVariants({ size: 'lg' })} href={`/${locale}/boards/${id}/new`}>
              {m.board_start_thread()}
            </a>
          ) : session !== 'unavailable' ? (
            <SignInPrompt returnTo={returnTo} label={m.board_sign_in_to_start()} compact />
          ) : null
        }
      />
    </article>
  );
}
