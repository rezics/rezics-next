import { useId, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { MessageSquareIcon, HeartIcon } from 'lucide-react';
import { ContentItem } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { BoardSortNav, type BoardSort } from './board-sort';
import { Byline, fullDateTime, timeText } from './byline';
import { threadLocation, threadTitle } from './thread-href';
import { threadActivity } from './activity';
import { CopyDiscussionLink } from './copy-discussion-link';
import {
  BoardPinBadge,
  BoardPinPageStatus,
  BoardPinThreadControls,
  boardPinVisitKey,
  useBoardPinPage,
  useBoardPinVisit,
} from './board-pins/controller';
import { unavailableBoardPinProducer } from './board-pins/contract';
import type {
  BoardPinProducer,
  BoardPinReadResult,
  BoardPinSender,
  BoardPinThread,
} from './board-pins/contract';
import {
  boardThreadPreview,
  boardThreadReactionCount,
  type BoardFeedThread,
  type CommunityBoardPage,
} from './board-feed-data';

const consumedContinuationStates = new WeakSet<object>();
let lastObservedHistoryIndex: number | null = null;

function ThreadCard({
  thread,
  authors,
  now,
  pin,
  pinControl,
}: {
  thread: BoardFeedThread;
  authors: CommunityBoardPage['authors'];
  now: string;
  pin?: BoardPinThread;
  pinControl?: ReactNode;
}) {
  const locale = getLocale();
  const available = thread.availability === 'available';
  const href = threadLocation(locale, { id: thread.id, title: available ? threadTitle(thread) : null });
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

  return (
    <ContentItem
      className="px-3 py-5 [overflow-wrap:anywhere] sm:px-4 [&>div]:sm:block [&_[data-content-item-slot=title]]:line-clamp-none [&_[data-content-item-slot=actions]]:min-w-0 [&_[data-content-item-slot=actions]]:max-w-full [&_[data-content-item-slot=actions]]:sm:mt-3"
      title={title}
      href={href}
      headingLevel={3}
      titleDataSlot="board-feed-card"
      metadata={
        available ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {pin?.pinned ? <BoardPinBadge pinned /> : null}
            <Byline
              author={authors?.[thread.authorId]}
              createdAt={thread.createdAt}
              now={now}
              size="sm"
              className="w-full [&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:whitespace-normal"
            />
          </div>
        ) : null
      }
      preview={previewContent}
      actions={
        <>
          <CopyDiscussionLink href={href} />
          {pinControl}
          {available && reactions !== null ? (
            <a
              href={href}
              className="inline-flex min-h-11 min-w-11 max-w-full items-center gap-1.5 rounded-xl bg-muted px-3 py-2 text-start whitespace-normal text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <HeartIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0">{m.board_feed_reactions({ count: reactions })}</span>
            </a>
          ) : null}
          <a
            href={href}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center gap-1.5 rounded-xl bg-muted px-3 py-2 text-start whitespace-normal text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <MessageSquareIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0">
              {available && replyCount !== null
                ? m.board_feed_replies({ count: replyCount })
                : m.board_feed_open_thread()}
            </span>
          </a>
          {available && lastActivityAt ? (
            <time
              dateTime={lastActivityAt}
              title={fullDateTime(lastActivityAt, locale)}
              className="min-w-0 max-w-full text-xs"
            >
              {m.board_thread_last_activity({ time: timeText(lastActivityAt, now, locale) })}
            </time>
          ) : null}
        </>
      }
    />
  );
}

/** A community feed composes shared rows, menus and buttons; shadcn has no domain feed or signed continuation. */
type BoardFeedProps = {
  boardId: string;
  sort: BoardSort;
  page: CommunityBoardPage['threads'];
  authors: CommunityBoardPage['authors'];
  now: string;
  actions?: ReactNode;
  /** Native-format seam inputs for a future Content binding and its focused stories. */
  initialPinRead?: BoardPinReadResult;
  pinProducer?: BoardPinProducer;
  pinSender?: BoardPinSender;
};

export function BoardFeed(props: BoardFeedProps) {
  const threadIds = useMemo(() => props.page.threads.map((thread) => thread.id), [props.page.threads]);
  const pinProducer = props.pinProducer ?? unavailableBoardPinProducer;
  const visit = useBoardPinVisit(props.pinSender);
  const key = boardPinVisitKey({
    boardId: props.boardId,
    threadIds,
    ...(props.initialPinRead === undefined ? {} : { initial: props.initialPinRead }),
    producer: pinProducer,
    visit,
  });
  return <BoardFeedVisit key={key} {...props} pinProducer={pinProducer} threadIds={threadIds} visit={visit} />;
}

function BoardFeedVisit({
  boardId,
  sort,
  page,
  authors,
  now,
  actions,
  initialPinRead,
  pinProducer,
  threadIds,
  visit,
}: BoardFeedProps & {
  pinProducer: BoardPinProducer;
  threadIds: readonly string[];
  visit: ReturnType<typeof useBoardPinVisit>;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const locale = getLocale();
  const location = useLocation();
  const pins = useBoardPinPage({
    boardId,
    threadIds,
    ...(initialPinRead === undefined ? {} : { initial: initialPinRead }),
    producer: pinProducer,
    visit,
  });
  useLayoutEffect(() => {
    const state = location.state;
    const continuationState = state as unknown as Record<string, unknown>;
    const currentIndex = state.__TSR_index;
    const previousIndex = lastObservedHistoryIndex;
    lastObservedHistoryIndex = currentIndex;
    if (continuationState.__boardNextPage !== true || consumedContinuationStates.has(state)) return;
    if (previousIndex !== null && currentIndex > previousIndex) {
      consumedContinuationStates.add(state);
      heading.current?.focus();
    }
    const browserState = window.history.state;
    if (browserState && typeof browserState === 'object') {
      const current = browserState as Record<string, unknown>;
      if (current.__boardNextPage === true) window.history.replaceState({ ...current, __boardNextPage: false }, '');
    }
  }, [location.state]);
  const refreshedAt =
    sort !== 'new' && page.rankRefreshedAt && !Number.isNaN(Date.parse(page.rankRefreshedAt))
      ? page.rankRefreshedAt
      : null;
  return (
    <section className="min-w-0 space-y-3 [overflow-wrap:anywhere]" aria-labelledby={headingId}>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
        <h2 ref={heading} id={headingId} tabIndex={-1} className="min-w-0 max-w-full text-lg font-semibold">
          {m.board_threads_heading()}
        </h2>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:py-2 [&_a]:whitespace-normal [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:py-2 [&_button]:whitespace-normal [&_svg]:shrink-0">
          {actions}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <BoardSortNav boardId={boardId} sort={sort} />
        {refreshedAt ? (
          <details className="min-w-0 max-w-full text-xs text-muted-foreground sm:max-w-prose">
            <summary className="min-h-11 min-w-11 cursor-pointer content-center rounded-lg px-2 py-2 whitespace-normal hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              <time dateTime={refreshedAt} title={fullDateTime(refreshedAt, locale)}>
                {m.board_feed_order_help()}
              </time>
            </summary>
            <p className="px-2 py-2">{m.board_rank_refreshed({ time: timeText(refreshedAt, now, locale) })}</p>
          </details>
        ) : null}
      </div>
      <BoardPinPageStatus state={pins.state} onRetry={pins.refresh} />
      {page.threads.length ? (
        <ul className="space-y-2">
          {page.threads.map((thread) => {
            const row =
              thread.availability === 'available' && pins.state.state === 'ready'
                ? pins.state.byThreadId.get(thread.id)
                : undefined;
            const rowStatus = pins.rowStatuses[thread.id];
            const pinControl = row || rowStatus ? (
              <BoardPinThreadControls
                discussionTitle={thread.title ?? m.threads_untitled()}
                {...(row === undefined ? {} : { row })}
                management={pins.state.state === 'ready' ? pins.state.management : null}
                sender={pins.sender}
                {...(rowStatus === undefined ? {} : { status: rowStatus })}
                onChange={(action) => pins.start(thread.id, action)}
                onRetry={() => pins.retry(thread.id)}
                onRefresh={pins.refresh}
              />
            ) : null;
            return (
              <ThreadCard
                key={`${boardId}:${thread.id}:${thread.availability}`}
                thread={thread}
                authors={authors}
                now={now}
                {...(row === undefined ? {} : { pin: row })}
                pinControl={pinControl}
              />
            );
          })}
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
            state={{ __boardNextPage: true } as never}
            className={buttonVariants({
              variant: 'outline',
              size: 'lg',
              className: 'h-auto min-h-11 min-w-11 w-full max-w-full py-3 whitespace-normal',
            })}
          >
            {m.threads_next_page()}
          </Link>
        </nav>
      ) : null}
    </section>
  );
}
