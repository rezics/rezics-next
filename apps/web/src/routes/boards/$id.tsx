import { useSession } from '../../session/query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { createFileRoute, Link, useLocation } from '@tanstack/react-router';
import { MessageSquareIcon } from 'lucide-react';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { boardPageHead } from '../../threads/thread-head';
import { rememberThreadSlug, threadLocation, threadSlug, threadTitle } from '../../threads/thread-href';
import { boardPageQuery } from '../../threads/thread-queries';
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

function threadOpeningWords(body: unknown): string | undefined {
  const pending: unknown[] = [body];
  let visited = 0;
  while (pending.length > 0 && visited < 64) {
    const value = pending.pop();
    visited += 1;
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.trim()) {
      const words = record.text.trim().split(/\s+/u).slice(0, 12).join(' ');
      return Array.from(words).slice(0, 80).join('');
    }
    for (const child of Object.values(record).reverse()) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return undefined;
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
      <section className="space-y-4" aria-labelledby="board-threads-heading">
        <h2 id="board-threads-heading" className="text-xl font-semibold">
          {m.board_threads_heading()}
        </h2>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
          <BoardSortNav boardId={id} sort={sort ?? 'active'} />
          {session === 'signed-in' ? (
            <a className={buttonVariants({ size: 'lg' })} href={`/${locale}/boards/${id}/new`}>
              {m.board_start_thread()}
            </a>
          ) : session !== 'unavailable' ? (
            <SignInPrompt returnTo={returnTo} label={m.board_sign_in_to_start()} compact />
          ) : null}
        </div>
        {threads.threads.length ? (
          <ul className="space-y-1">
            {threads.threads.map((thread) => {
              const { replyCount, lastActivityAt } = threadActivity(thread);
              const title = thread.title ?? threadOpeningWords(thread.firstPost.body) ?? m.threads_untitled();
              return (
                <ListRow key={thread.id} className="flex flex-col items-start gap-2 py-4 sm:flex-row sm:items-center">
                  <ListRowLink href={threadLocation(locale, { id: thread.id, title: threadTitle(thread) })}>
                    {title}
                  </ListRowLink>
                  <div className="min-w-0 flex-1">
                    <h3 aria-hidden="true" className="text-lg font-semibold tracking-tight text-balance">
                      {title}
                    </h3>
                    <ListRowControl className="w-fit">
                      <Byline
                        author={authors?.[thread.authorId]}
                        createdAt={thread.createdAt}
                        now={now}
                        showAuthor={authors !== null}
                        size="sm"
                      />
                    </ListRowControl>
                  </div>
                  {replyCount !== null || lastActivityAt ? (
                    <ListRowControl className="flex flex-wrap gap-x-4 text-sm text-muted-foreground sm:justify-end">
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
                    </ListRowControl>
                  ) : null}
                </ListRow>
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
