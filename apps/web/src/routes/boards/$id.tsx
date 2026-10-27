import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Item, ItemActions, ItemContent, ItemTitle } from '@rezics/ui/shadcn/item';
import { createFileRoute, Link, useLoaderData, useLocation } from '@tanstack/react-router';
import { MessageSquareIcon } from 'lucide-react';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { boardPageHead } from '../../threads/thread-head';
import { rememberThreadSlug, threadHref, threadTitle } from '../../threads/thread-href';
import { boardPageQuery, credentialMode } from '../../threads/thread-queries';
import { threadActivity } from '../../threads/activity';
import { SignInPrompt } from '../../threads/composer';
import { Byline, fullDateTime, timeText } from '../../threads/byline';
import { BoardContext } from '../../threads/thread-context';
import { BoardSortNav, boardSortFromSearch } from '../../threads/board-sort';
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
  validateSearch: boardSearch,
  // The router passes unvalidated keys through, so read the sort through the same check again.
  loaderDeps: ({ search }) => {
    const parsed = boardSearch(search);
    return { cursor: parsed.cursor, sort: parsed.sort };
  },
  loader: async ({ params, deps, context }) => {
    const page = await context.queryClient.ensureQueryData(
      boardPageQuery(params.id, deps.cursor, deps.sort, credentialMode()),
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
  const { session } = useLoaderData({ from: '__root__' });
  const location = useLocation();
  const id = Route.useParams().id;
  const locale = getLocale();
  const sort = boardSortFromSearch(Route.useSearch().sort);
  const returnTo = location.publicHref.split(/[?#]/, 1)[0]!;
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <BoardContext realm={realm} />
        <PageHeading>{board.title ?? m.threads_untitled()}</PageHeading>
      </header>
      <section className="space-y-4" aria-labelledby="board-threads-heading">
        <h2 id="board-threads-heading" className="text-xl font-semibold">
          {m.board_threads_heading()}
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <BoardSortNav boardId={id} sort={sort ?? 'active'} />
          {session === 'signed-in' ? (
            <a className={buttonVariants({ size: 'lg' })} href={`/${locale}/boards/${id}/new`}>
              {m.board_start_thread()}
            </a>
          ) : session === 'signed-out' ? (
            <SignInPrompt returnTo={returnTo} label={m.board_sign_in_to_start()} compact />
          ) : null}
        </div>
        {threads.threads.length ? (
          <ul className="divide-y divide-border/60 border-y border-border/60">
            {threads.threads.map((thread) => {
              const { replyCount, lastActivityAt } = threadActivity(thread);
              return (
                <li key={thread.id}>
                  <Item className="gap-x-4 gap-y-1 rounded-none px-1 py-3" size="sm">
                    <ItemContent className="min-w-0 basis-72 gap-1.5">
                      <ItemTitle className="max-w-full text-base">
                        <a
                          href={`/${locale}${threadHref({ id: thread.id, title: threadTitle(thread) })}`}
                          className="truncate text-primary hover:underline"
                        >
                          {thread.title ?? m.threads_untitled()}
                        </a>
                      </ItemTitle>
                      <Byline
                        author={authors?.[thread.authorId]}
                        createdAt={thread.createdAt}
                        now={now}
                        showAuthor={authors !== null}
                        size="sm"
                      />
                    </ItemContent>
                    {replyCount !== null || lastActivityAt ? (
                      <ItemActions className="flex-wrap gap-x-4 text-sm text-muted-foreground">
                        {replyCount !== null ? (
                          <span className="inline-flex items-center gap-1.5 tabular-nums">
                            <MessageSquareIcon aria-hidden="true" className="size-4" />
                            {m.board_thread_replies({ count: replyCount })}
                          </span>
                        ) : null}
                        {lastActivityAt ? (
                          <time dateTime={lastActivityAt} title={fullDateTime(lastActivityAt, locale)}>
                            {m.board_thread_last_activity({ time: timeText(lastActivityAt, now, locale) })}
                          </time>
                        ) : null}
                      </ItemActions>
                    ) : null}
                  </Item>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.board_threads_empty()}</p>
        )}
        {threads.next && (
          <nav aria-label={m.board_threads_heading()}>
            <Link
              to="/boards/$id"
              params={{ id }}
              search={{ cursor: threads.next, ...(sort ? { sort } : {}) }}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              {m.threads_next_page()}
            </Link>
          </nav>
        )}
      </section>
    </article>
  );
}
