import { useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import type { ReactionKind } from '@rezics/ui/reactions';
import { ContentItem } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { FeedActionBar } from '../features/feed/action-bar';
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
import { pinnedIdentitySet } from './board-pins/contract';
import { productionBoardPinProducer } from './board-pins/producer';
import type { BoardPinProducer, BoardPinReadResult, BoardPinSender, BoardPinThread } from './board-pins/contract';
import {
  authorsForCurrentReading,
  boardPinThreadIds,
  boardThreadPreview,
  nativePinnedSection,
  ordinaryBoardThreads,
  type BoardFeedThread,
  type BoardThreadPage,
  type CommunityBoardPage,
} from './board-feed-data';
import { captureBoardReadingReturn, disclosedBoardAuthorIds } from './board-reading';
import type { PageAuthors } from '../identity/read';

const consumedContinuationStates = new WeakSet<object>();
let lastObservedHistoryIndex: number | null = null;

function nativeReactionCounts(thread: BoardFeedThread): Partial<Record<ReactionKind, number>> | undefined {
  if (thread.availability !== 'available' || thread.reactions === undefined) return undefined;
  const counts: Partial<Record<ReactionKind, number>> = {};
  for (const [kind, value] of Object.entries(thread.reactions)) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    counts[kind as ReactionKind] = value;
  }
  return counts;
}

function ThreadCard({
  thread,
  authors,
  now,
  pin,
  pinControl,
  signedIn,
  origin,
}: {
  thread: BoardFeedThread;
  authors: CommunityBoardPage['authors'];
  now: string;
  pin?: BoardPinThread;
  pinControl?: ReactNode;
  signedIn: boolean;
  origin: { key: string; isCurrent(): boolean };
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
  const counts = nativeReactionCounts(thread);

  return (
    <ContentItem
      className="px-3 py-5 [overflow-wrap:anywhere] sm:px-4 [&>div]:sm:block [&_[data-content-item-slot=title]]:line-clamp-none [&_[data-content-item-slot=actions]]:min-w-0 [&_[data-content-item-slot=actions]]:max-w-full [&_[data-content-item-slot=actions]]:sm:mt-3"
      title={title}
      href={href}
      headingLevel={3}
      titleDataSlot="board-feed-card"
      data-thread-id={thread.id}
      tabIndex={-1}
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
        available ? (
          <FeedActionBar
            locale={locale}
            title={title}
            href={href}
            signedIn={signedIn}
            origin={origin}
            {...(replyCount === null ? {} : { replyCount })}
            {...(counts === undefined
              ? {}
              : {
                  reaction: {
                    target: { kind: 'thread' as const, id: thread.id },
                    counts,
                    value: null,
                    personalReady: false,
                    settleWithRead: false,
                    reactionOrigin: { key: origin.key, reader: null, isCurrent: origin.isCurrent },
                  },
                })}
            reply={{ href: `${href}${href.includes('#') ? '' : '#reply'}` }}
            overflow={<CopyDiscussionLink href={href} />}
          >
            {signedIn ? null : <CopyDiscussionLink href={href} />}
            {pinControl}
            {lastActivityAt ? (
              <time
                dateTime={lastActivityAt}
                title={fullDateTime(lastActivityAt, locale)}
                className="min-w-0 max-w-full text-xs"
              >
                {m.board_thread_last_activity({ time: timeText(lastActivityAt, now, locale) })}
              </time>
            ) : null}
          </FeedActionBar>
        ) : (
          <>
            <CopyDiscussionLink href={href} />
            {pinControl}
          </>
        )
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
  cursor?: string;
  /** Native-format seam inputs for a future Content binding and its focused stories. */
  initialPinRead?: BoardPinReadResult;
  pinProducer?: BoardPinProducer;
  pinSender?: BoardPinSender;
};

function applyBoardPinReading(
  page: BoardThreadPage,
  result: {
    pinnedThreads: readonly unknown[];
    threads: readonly unknown[];
    next: string | null;
    rankRefreshedAt: string | null;
  },
): BoardThreadPage {
  return {
    ...page,
    pinnedThreads: result.pinnedThreads as BoardThreadPage['pinnedThreads'],
    threads: result.threads as BoardThreadPage['threads'],
    next: result.next,
    rankRefreshedAt: result.rankRefreshedAt,
  };
}

export function BoardFeed(props: BoardFeedProps) {
  const pinProducer = props.pinProducer ?? productionBoardPinProducer;
  const visit = useBoardPinVisit(props.pinSender);
  const key = boardPinVisitKey({
    boardId: props.boardId,
    sort: props.sort,
    ...(props.cursor === undefined ? {} : { cursor: props.cursor }),
    ...(props.initialPinRead === undefined ? {} : { initial: props.initialPinRead }),
    producer: pinProducer,
    visit,
  });
  return <BoardFeedVisit key={key} {...props} pinProducer={pinProducer} visit={visit} />;
}

function BoardFeedVisit({
  boardId,
  sort,
  page,
  authors: initialAuthors,
  now,
  actions,
  cursor,
  initialPinRead,
  pinProducer,
  visit,
}: BoardFeedProps & {
  pinProducer: BoardPinProducer;
  visit: ReturnType<typeof useBoardPinVisit>;
}) {
  const headingId = useId();
  const pinHeadingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const locale = getLocale();
  const location = useLocation();
  const router = useRouter();
  const [reading, setReading] = useState(page);
  const [authors, setAuthors] = useState(initialAuthors);
  const section = nativePinnedSection(reading.pinnedThreads);
  const ordinarySource = ordinaryBoardThreads(reading);
  const pinVisitKey = boardPinVisitKey({
    boardId,
    sort,
    ...(cursor === undefined ? {} : { cursor }),
    ...(initialPinRead === undefined ? {} : { initial: initialPinRead }),
    producer: pinProducer,
    visit,
  });
  const threadIds = useMemo(() => boardPinThreadIds(reading), [reading]);
  const pinnedIds = useMemo(() => pinnedIdentitySet(reading.pinnedThreads), [reading]);
  const pins = useBoardPinPage({
    boardId,
    threadIds,
    pinnedIds,
    sort,
    ...(cursor === undefined ? {} : { cursor }),
    ...(initialPinRead === undefined ? {} : { initial: initialPinRead }),
    producer: pinProducer,
    visit,
    onBoardRead: (result) => {
      const next = applyBoardPinReading(page, result);
      setReading(next);
      const ordinary = ordinaryBoardThreads(next);
      const ids = disclosedBoardAuthorIds(next.pinnedThreads, ordinary.threads);
      setAuthors((previous) => authorsForCurrentReading(previous, result.authors as PageAuthors | null, ids));
    },
  });
  const ordinary = pins.needsRestart ? { ...ordinarySource, next: null } : ordinarySource;
  const origin = { key: pinVisitKey, isCurrent: () => visit.observation.snapshot() === visit.revision };
  const signedIn = !!pins.sender;
  const returnAddress = captureBoardReadingReturn({
    boardId,
    sort,
    locale,
    ...(cursor === undefined || pins.needsRestart ? {} : { cursor }),
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
  useLayoutEffect(() => {
    const focused = typeof document === 'undefined' ? null : document.activeElement;
    if (!(focused instanceof HTMLElement) || !list.current?.contains(focused)) return;
    const row = focused.closest('[data-thread-id]');
    const id = row?.getAttribute('data-thread-id');
    if (!id || threadIds.includes(id)) return;
    const next = list.current.querySelector<HTMLElement>('[data-thread-id]');
    (next ?? heading.current)?.focus();
  }, [threadIds]);
  const refreshedAt =
    sort !== 'new' && reading.rankRefreshedAt && !Number.isNaN(Date.parse(reading.rankRefreshedAt))
      ? reading.rankRefreshedAt
      : null;
  const openReturnedThread = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a');
    if (!link || !returnAddress) return;
    const href = link.getAttribute('href');
    if (!href || !href.includes('/threads/')) return;
    event.preventDefault();
    void router.navigate({ href, state: { boardReadingReturn: returnAddress } as never });
  };
  const card = (thread: BoardFeedThread, pinnedRow?: BoardPinThread) => {
    const row =
      pinnedRow ??
      (thread.availability === 'available' && pins.state.state === 'ready'
        ? pins.state.byThreadId.get(thread.id)
        : undefined);
    const rowStatus = pins.rowStatuses[thread.id];
    const pinControl =
      row || rowStatus ? (
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
        signedIn={signedIn}
        origin={origin}
      />
    );
  };
  return (
    <section
      ref={list}
      className="min-w-0 space-y-3 [overflow-wrap:anywhere]"
      aria-labelledby={headingId}
      onClick={openReturnedThread}
    >
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
      {pins.malformed ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-slot="board-reading-malformed" role="status">
          <p className="min-w-0 text-sm text-muted-foreground">{m.board_reading_malformed()}</p>
          <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={pins.refresh}>
            {m.board_community_retry()}
          </Button>
        </div>
      ) : (
        <BoardPinPageStatus state={pins.state} onRetry={pins.refresh} />
      )}
      {pins.needsRestart ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-slot="board-reading-restart" role="status">
          <p className="min-w-0 text-sm text-muted-foreground">{m.board_reading_restart_help()}</p>
          <Link
            to="/boards/$id"
            params={{ id: boardId }}
            search={sort === 'active' ? {} : { sort }}
            className={buttonVariants({
              variant: 'outline',
              className: 'h-auto min-h-11 min-w-11 max-w-full py-2 whitespace-normal',
            })}
          >
            {m.board_reading_restart()}
          </Link>
        </div>
      ) : null}
      {section.state === 'ready' ? (
        <div role="region" aria-labelledby={pinHeadingId} data-slot="board-pin-section" className="min-w-0 space-y-2">
          <p id={pinHeadingId} className="min-w-0 max-w-full text-base font-semibold">
            {m.board_pin_section_heading()}
          </p>
          <ul className="space-y-2">
            {section.threads.map((thread) => {
              const fromProducer = pins.state.state === 'ready' ? pins.state.byThreadId.get(thread.id) : undefined;
              return card(thread, fromProducer ?? { threadId: thread.id, pinned: true, actions: [] });
            })}
          </ul>
        </div>
      ) : section.state === 'unavailable' ? (
        <BoardPinPageStatus state={{ state: 'unavailable' }} onRetry={pins.refresh} />
      ) : null}
      {ordinary.threads.length ? (
        <ul className="space-y-2">{ordinary.threads.map((thread) => card(thread))}</ul>
      ) : section.state === 'ready' ? null : (
        <div className="rounded-2xl bg-muted/50 px-5 py-10 text-center">
          <p className="mx-auto max-w-sm text-muted-foreground">
            {ordinary.next === null ? m.board_threads_empty() : m.board_threads_page_empty()}
          </p>
        </div>
      )}
      {ordinary.next !== null ? (
        <nav aria-label={m.board_threads_heading()} className="pt-3">
          <Link
            to="/boards/$id"
            params={{ id: boardId }}
            search={{ cursor: ordinary.next, ...(sort === 'active' ? {} : { sort }) }}
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
