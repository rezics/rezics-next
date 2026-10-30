import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { MessageSquareIcon } from 'lucide-react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import type { loadBoardPageWithAuthors } from '../../identity/page-loaders';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { threadActivity } from '../activity';
import { BoardSortNav, type BoardSort } from '../board-sort';
import { Byline, fullDateTime, timeText } from '../byline';
import { threadLocation, threadTitle } from '../thread-href';

type BoardPage = Awaited<ReturnType<typeof loadBoardPageWithAuthors>>;
type Props = {
  boardId: string;
  sort: BoardSort;
  page: BoardPage['threads'];
  authors: BoardPage['authors'];
  now: string;
  actions?: ReactNode;
};

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

/**
 * One bounded board page, including its sort and continuation. The existing list rows and navigation compose this
 * domain pattern; shadcn has no board-page presenter. Rendering never requests another page or infers a total.
 */
export function BoardThreads({ boardId, sort, page, authors, now, actions }: Props) {
  const locale = getLocale();
  const refreshedAt = sort !== 'new' && page.rankRefreshedAt && !Number.isNaN(Date.parse(page.rankRefreshedAt))
    ? page.rankRefreshedAt
    : null;
  return (
    <section className="flex flex-col gap-4" aria-labelledby="board-threads-heading">
      <h2 id="board-threads-heading" className="text-xl font-semibold">
        {m.board_threads_heading()}
      </h2>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-3">
        <BoardSortNav boardId={boardId} sort={sort} />
        {actions}
      </div>
      {refreshedAt ? (
        <p className="text-sm text-muted-foreground">
          <time dateTime={refreshedAt} title={fullDateTime(refreshedAt, locale)}>
            {m.board_rank_refreshed({ time: timeText(refreshedAt, now, locale) })}
          </time>
        </p>
      ) : null}
        {page.threads.length ? (
          <ul className="space-y-1">
            {page.threads.map((thread) => {
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
          <p className="text-muted-foreground">{page.next === null ? m.board_threads_empty() : m.board_threads_page_empty()}</p>
        )}
        {page.next !== null ? (
          <nav aria-label={m.board_threads_heading()}>
            <Link
              to="/boards/$id"
              params={{ id: boardId }}
              search={{ cursor: page.next, ...(sort === 'active' ? {} : { sort }) }}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              {m.threads_next_page()}
            </Link>
          </nav>
        ) : null}
    </section>
  );
}
