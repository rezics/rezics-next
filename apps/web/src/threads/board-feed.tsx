import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { EllipsisIcon, MessageSquareIcon, HeartIcon } from 'lucide-react';
import { ContentItem } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { BoardSortNav, type BoardSort } from './board-sort';
import { Byline, fullDateTime, timeText } from './byline';
import { threadLocation, threadTitle } from './thread-href';
import { threadActivity } from './activity';
import {
  boardThreadPreview,
  boardThreadReactionCount,
  type BoardFeedThread,
  type CommunityBoardPage,
} from './board-feed-data';

function ThreadCard({
  thread,
  authors,
  now,
}: {
  thread: BoardFeedThread;
  authors: CommunityBoardPage['authors'];
  now: string;
}) {
  const locale = getLocale();
  const href = threadLocation(locale, { id: thread.id, title: threadTitle(thread) });
  const available = thread.availability === 'available';
  const preview = boardThreadPreview(thread);
  const title = available ? (thread.title ?? preview ?? m.threads_untitled()) : m.thread_post_deleted();
  const openingUnavailable = available && thread.firstPost.availability !== 'available';
  const previewContent: ReactNode =
    preview || openingUnavailable ? (
      <>
        {preview ? (
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground sm:text-base">{preview}</p>
        ) : null}
        {openingUnavailable ? (
          <p className="text-sm text-muted-foreground">{m.board_feed_opening_unavailable()}</p>
        ) : null}
      </>
    ) : null;
  const { replyCount, lastActivityAt } = threadActivity(thread);
  const reactions = boardThreadReactionCount(thread);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).href);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  return (
    <ContentItem
      className="px-3 py-5 sm:px-4"
      title={title}
      href={href}
      headingLevel={3}
      titleDataSlot="board-feed-card"
      metadata={
        available ? (
          <Byline author={authors?.[thread.authorId]} createdAt={thread.createdAt} now={now} size="sm" />
        ) : null
      }
      preview={previewContent}
      actions={
        <>
          <Menu
            title={m.thread_content_more_actions()}
            trigger={
              <Button variant="ghost" size="icon" aria-label={m.thread_content_more_actions()}>
                <EllipsisIcon />
              </Button>
            }
            entries={[
              { type: 'link', label: m.board_feed_open_thread(), href },
              { type: 'item', label: m.thread_content_copy_link(), onSelect: () => void copyLink() },
            ]}
          />
          {available && reactions !== null ? (
            <a
              href={href}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-muted px-3 text-foreground hover:bg-accent"
            >
              <HeartIcon aria-hidden="true" className="size-4" />
              {m.board_feed_reactions({ count: reactions })}
            </a>
          ) : null}
          <a
            href={href}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-muted px-3 text-foreground hover:bg-accent"
          >
            <MessageSquareIcon aria-hidden="true" className="size-4" />
            {available && replyCount !== null
              ? m.board_feed_replies({ count: replyCount })
              : m.board_feed_open_thread()}
          </a>
          {available && lastActivityAt ? (
            <time dateTime={lastActivityAt} title={fullDateTime(lastActivityAt, locale)} className="text-xs">
              {m.board_thread_last_activity({ time: timeText(lastActivityAt, now, locale) })}
            </time>
          ) : null}
          {copyStatus ? (
            <span role="status">
              {copyStatus === 'copied' ? m.board_feed_link_copied() : m.board_feed_copy_failed()}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** A community feed composes shared rows, menus and buttons; shadcn has no domain feed or signed continuation. */
export function BoardFeed({
  boardId,
  sort,
  page,
  authors,
  now,
  actions,
}: {
  boardId: string;
  sort: BoardSort;
  page: CommunityBoardPage['threads'];
  authors: CommunityBoardPage['authors'];
  now: string;
  actions?: ReactNode;
}) {
  const locale = getLocale();
  const refreshedAt =
    sort !== 'new' && page.rankRefreshedAt && !Number.isNaN(Date.parse(page.rankRefreshedAt))
      ? page.rankRefreshedAt
      : null;
  return (
    <section className="min-w-0 space-y-3" aria-labelledby="board-threads-heading">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
        <h2 id="board-threads-heading" className="text-lg font-semibold">
          {m.board_threads_heading()}
        </h2>
        {actions}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BoardSortNav boardId={boardId} sort={sort} />
        {refreshedAt ? (
          <details className="max-w-prose text-xs text-muted-foreground">
            <summary className="min-h-10 cursor-pointer content-center rounded-lg px-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <time dateTime={refreshedAt} title={fullDateTime(refreshedAt, locale)}>
                {m.board_feed_order_help()}
              </time>
            </summary>
            <p className="px-2 py-2">{m.board_rank_refreshed({ time: timeText(refreshedAt, now, locale) })}</p>
          </details>
        ) : null}
      </div>
      {page.threads.length ? (
        <ul className="space-y-2">
          {page.threads.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} authors={authors} now={now} />
          ))}
        </ul>
      ) : (
        <div className="rounded-2xl bg-muted/50 px-5 py-10 text-center">
          <MessageSquareIcon aria-hidden="true" className="mx-auto mb-4 size-8 text-muted-foreground" />
          <p className="mx-auto max-w-sm text-muted-foreground">
            {page.next === null ? m.board_threads_empty() : m.board_threads_page_empty()}
          </p>
        </div>
      )}
      {page.next !== null ? (
        <nav aria-label={m.board_threads_heading()} className="pt-3">
          <Link
            to="/boards/$id"
            params={{ id: boardId }}
            search={{ cursor: page.next, ...(sort === 'active' ? {} : { sort }) }}
            className={buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' })}
          >
            {m.threads_next_page()}
          </Link>
        </nav>
      ) : null}
    </section>
  );
}
