'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { cn, scrollBehavior } from '@rezics/ui/utils';
import {
  ArrowUpIcon,
  CircleCheckBigIcon,
  RefreshCwIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { commandKey } from './api.ts';
import { FeedCard } from './card.tsx';
import { postRhythm } from './post-row.tsx';
import { relativeTime } from './time.ts';
import { useFeed } from './feed-context.tsx';
import { appendPosts, projecting, recoverProjection, sameProjection } from './projection.ts';
import { failureText, type FeedHead, type FeedItem, type FeedPage, type FeedQuery, type Loaded, type ReadFailure } from './types.ts';

/** How often an open feed asks whether newer posts exist. */
const HEAD_INTERVAL_MS = 60_000;
/** Pages read in a row without a new post before the list waits for the reader to ask for more. */
const SPARSE_PAGES = 4;
/** A pinned topic's feed checks two candidates a page (Main's Concept filter bound), so it keeps looking longer. */
const PINNED_SPARSE_PAGES = 24;

interface ListState {
  page: FeedPage;
  pages: number;
  recovering: boolean;
  items: FeedItem[];
  cursor: string | null;
  caughtUp: FeedPage['caughtUp'];
  loading: boolean;
  failure: ReadFailure | null;
  reference?: string;
  /** Consecutive pages that added nothing; Main's filters can leave a page empty. */
  sparse: number;
}

function initialState(initial: FeedPage): ListState {
  return {
    page: initial,
    pages: 1,
    recovering: projecting(initial),
    items: appendPosts([], initial.items),
    cursor: initial.nextCursor,
    caughtUp: initial.caughtUp,
    loading: false,
    failure: null,
    sparse: initial.items.length ? 0 : 1,
  };
}

/** A post-shaped placeholder in the posts' own rhythm, so the page does not jump when they arrive. */
export function FeedSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={cn('border-border/60 border-b', postRhythm.row)}>
          <div className={cn('flex items-center gap-2', postRhythm.meta)}>
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-3 w-48 rounded-full" />
          </div>
          <div className={cn('grid', postRhythm.afterMeta, postRhythm.afterTitle)}>
            <div className="flex h-6 items-center">
              <Skeleton className="h-4 w-3/4 rounded-full" />
            </div>
            <SkeletonText lines={2} />
          </div>
          <Skeleton className={cn('h-11 w-64 rounded-xl', postRhythm.section)} />
          <div className={cn('flex items-center gap-3', postRhythm.section, postRhythm.bar)}>
            <Skeleton className="h-4 w-56 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * What follows the posts. A closed next page is absent: no error, and no control
 * that would call the closed operation again.
 */
export function feedContinuation(
  failure: ReadFailure | null,
  cursor: string | null,
  loading: boolean,
): 'error' | 'more' | 'none' {
  if (failure === 'closed') return 'none';
  if (failure) return 'error';
  return cursor && !loading ? 'more' : 'none';
}

/** The first page failed: say what failed, and offer the one next step. */
function FeedFailure({ failure, reference }: { failure: ReadFailure; reference?: string }) {
  const { t, signInHref } = useFeed();
  const router = useRouter();
  const text = failureText(failure, { failedTitle: t.failed, offline: t.failedBody, server: t.serverBody,
    missingTitle: t.feedMissing, missingBody: t.missingBody, deniedTitle: t.deniedTitle, deniedBody: t.deniedBody,
    movedTitle: t.moved, movedBody: t.movedBody, budget: t.budgetBody });
  if (text.kind === 'absent') return null;
  const moved = text.action === 'restart';
  const quiet = text.action === 'none' || text.action === 'sign-in';
  return (
    <EmptyState
      icon={moved ? RefreshCwIcon : TriangleAlertIcon}
      tone={quiet || moved ? 'default' : 'destructive'}
      role={quiet ? 'status' : 'alert'}
      title={text.title}
      description={failureDetail(text.description, reference, t.errorReference, text.reference)}
      className="m-3 sm:m-4"
    >
      {text.action === 'none' ? null : text.action === 'sign-in'
        ? <LocalizedLink href={signInHref} className={buttonVariants()}>{t.signIn}</LocalizedLink>
        : <Button onClick={() => router.refresh()}>
          <RotateCwIcon aria-hidden="true" />
          {moved ? t.refresh : t.retry}
        </Button>}
    </EmptyState>
  );
}

/**
 * Asks Main, while the page is visible, how many posts arrived since the one
 * the reader is looking at began; never inserts them above the reader.
 */
function useNewPosts(page: FeedPage, scope: 'following' | 'all' | null, interval: number) {
  const { api, actingSubject, signedIn } = useFeed();
  const [head, setHead] = useState<FeedHead | null>(null);
  useEffect(() => {
    if ((signedIn && !actingSubject) || !scope) return;
    const polled = scope;
    let stopped = false;
    // The page's source cut is the reader's view. A lagging checkpoint can
    // precede posts already on screen and must not announce them as new.
    const after = page.sourcePosition.sequence;
    async function check() {
      if (document.visibilityState !== 'visible') return;
      const read = await api().head({
        after,
        scope: polled,
        ...(actingSubject ? { actingSubject } : {}),
      });
      if (stopped) return;
      // A Main without the head read (404) is not asked again on this page.
      if (!read.ok && read.failure === 'missing') {
        stopped = true;
        clearInterval(timer);
        return;
      }
      if (read.ok) setHead(read.data);
    }
    const timer = setInterval(() => void check(), interval);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [
    api,
    actingSubject,
    signedIn,
    page.sourcePosition.sequence,
    page.sourcePosition.dataEpoch,
    scope,
    interval,
  ]);
  return head &&
    head.afterSequence === page.sourcePosition.sequence &&
    head.projection.dataEpoch === page.sourcePosition.dataEpoch &&
    head.newPosts.value > 0
    ? head
    : null;
}

/** Records how far the reader has seen, so the navigation's new-activity dots clear. */
function useWatermark(page: FeedPage, scope: 'following' | 'all' | null, recovering: boolean) {
  const { api, actingSubject } = useFeed();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (recovering) return;
    const position = `${scope}:${page.sourcePosition.dataEpoch}:${page.projection.sequence}`;
    if (!actingSubject || !scope || sent.current === position) return;
    sent.current = position;
    void api().watermark(
      scope,
      {
        actingSubject,
        dataEpoch: page.sourcePosition.dataEpoch,
        sequence: page.projection.sequence,
      },
      commandKey(),
    );
  }, [api, actingSubject, page, scope, recovering]);
}

/**
 * The posts of one feed view. The server renders the first page; later pages
 * load as the reader nears the end, with a button as the fallback. Main's
 * page can be sparse after filtering, so an empty page continues on its own
 * for a few pages before handing the choice back to the reader.
 */
export function FeedList({
  initial,
  query,
  empty,
  allHref,
  headInterval = HEAD_INTERVAL_MS,
}: {
  initial: Loaded<FeedPage>;
  /** The query that produced `initial`, without a cursor. */
  query: FeedQuery;
  /** What an empty view says, with the fixes that fit its filters. */
  empty: ReactNode;
  /** "Keep browsing All" after Following is caught up. */
  allHref: string;
  /** How often to ask for newer posts; stories shorten it. */
  headInterval?: number;
}) {
  if (!initial.ok) return <FeedFailure failure={initial.failure} reference={initial.reference} />;
  return (
    <FeedPages
      key={`${JSON.stringify(query)}:${initial.data.projection.sequence}`}
      page={initial.data}
      query={query}
      empty={empty}
      allHref={allHref}
      headInterval={headInterval}
    />
  );
}

function FeedPages({
  page,
  query,
  empty,
  allHref,
  headInterval,
}: {
  page: FeedPage;
  query: FeedQuery;
  empty: ReactNode;
  allHref: string;
  headInterval: number;
}) {
  const { t, api } = useFeed();
  const router = useRouter();
  const [state, setState] = useState(() => initialState(page));
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // IntersectionObserver and polling can fire before React renders loading.
  const reading = useRef(false);
  const active = useRef(true);
  const restore = useRef<{ id: string; top: number } | null>(null);
  const retryProjection = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // A pinned tab is only part of All: its new posts and what was seen are not All's.
  const scope = query.savedFilter ? null : (query.scope ?? 'all');
  const sparseLimit = query.savedFilter ? PINNED_SPARSE_PAGES : SPARSE_PAGES;
  const fresh = useNewPosts(page, scope, headInterval);
  useWatermark(state.page, scope, state.recovering);

  useLayoutEffect(() => {
    const anchor = restore.current;
    if (!anchor) return;
    restore.current = null;
    const row = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[data-feed-item]') ?? [],
    ).find((element) => element.dataset.feedItem === anchor.id);
    if (row)
      window.scrollBy({ top: row.getBoundingClientRect().top - anchor.top, behavior: 'instant' });
  }, [state.items]);

  // The head probe does not report target-index readiness. Ask the page, even
  // when it is empty or has a Saved Filter, and retry while its owner is building.
  useEffect(() => {
    if (!state.recovering) return;
    let stopped = false;
    async function check() {
      if (stopped || reading.current || document.visibilityState !== 'visible') return;
      reading.current = true;
      try {
        const first = await api().page(query);
        if (stopped || !first.ok || projecting(first.data)) return;
        const recovered = await recoverProjection(
          api(),
          query,
          first.data,
          state,
          sparseLimit,
          () => !stopped && active.current,
        );
        if (stopped) return;
        if (!recovered.ok) {
          setState((current) => ({ ...current, failure: recovered.failure, reference: recovered.reference }));
          return;
        }
        // Measure at commit time: the reader may have scrolled during the read.
        const rows = Array.from(
          list.current?.querySelectorAll<HTMLElement>('[data-feed-item]') ?? [],
        );
        const surviving = new Set(recovered.data.items.map((item) => item.id));
        const anchor = rows.find(
          (row) =>
            row.getBoundingClientRect().bottom > 0 && surviving.has(row.dataset.feedItem ?? ''),
        );
        if (anchor)
          restore.current = {
            id: anchor.dataset.feedItem!,
            top: anchor.getBoundingClientRect().top,
          };
        setState({
          ...initialState(recovered.data.page),
          items: recovered.data.items,
          pages: recovered.data.pages,
        });
      } finally {
        reading.current = false;
      }
    }
    const timer = setInterval(() => void check(), headInterval);
    retryProjection.current = check;
    const onVisible = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      retryProjection.current = null;
    };
  }, [api, query, state, sparseLimit, headInterval]);

  const loadMore = useCallback(async () => {
    const cursor = state.cursor;
    if (!cursor || reading.current || state.failure === 'closed') return;
    reading.current = true;
    setState((current) => ({ ...current, loading: true, failure: null, reference: undefined }));
    const next = await api().page({ ...query, cursor });
    reading.current = false;
    if (!active.current) return;
    setState((current) => {
      if (!next.ok) return { ...current, loading: false, failure: next.failure, reference: next.reference };
      if (!sameProjection(current.page, next.data))
        return { ...current, loading: false, failure: 'moved' as const, reference: undefined };
      const items = appendPosts(current.items, next.data.items);
      return {
        page: next.data,
        pages: current.pages + 1,
        recovering: current.recovering || projecting(next.data),
        items,
        cursor: next.data.nextCursor,
        caughtUp: next.data.caughtUp,
        loading: false,
        failure: null,
        sparse: items.length > current.items.length ? 0 : current.sparse + 1,
      };
    });
  }, [api, query, state.cursor, state.failure, state.loading]);

  // Near the end, the next page loads by itself; the button below stays for keyboards and screen readers.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !state.cursor || state.loading || state.failure || state.sparse >= sparseLimit)
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, state.cursor, state.loading, state.failure, state.sparse, sparseLimit]);

  function showNewest() {
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    router.refresh();
  }

  const { items } = state;
  const finished = !state.cursor && !state.loading;
  const catchingUp = state.recovering;
  return (
    <div ref={list} className="relative">
      {fresh ? (
        <div className="pointer-events-none sticky top-20 z-30 flex justify-center">
          <Button
            size="sm"
            onClick={showNewest}
            className="pointer-events-auto rounded-full shadow-lg"
          >
            <ArrowUpIcon aria-hidden="true" />
            {fresh.newPosts.kind === 'exact'
              ? t.newPosts(fresh.newPosts.value)
              : t.newPostsAtLeast(fresh.newPosts.value)}
          </Button>
        </div>
      ) : null}
      {items.length ? (
        <div role="feed" aria-label={t.posts} aria-busy={state.loading}>
          {items.map((item, index) => (
            <div key={item.id} data-feed-item={item.id}>
              <FeedCard
                item={item}
                position={index + 1}
                total={state.cursor || catchingUp ? undefined : items.length}
              />
            </div>
          ))}
        </div>
      ) : finished && !catchingUp ? (
        empty
      ) : null}
      {state.loading ? (
        <>
          <span role="status" className="sr-only">
            {t.loadingMore}
          </span>
          <FeedSkeleton count={2} />
        </>
      ) : null}
      <div ref={sentinel} aria-hidden="true" />
      {feedContinuation(state.failure, state.cursor, state.loading) === 'error' ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-center gap-3 px-4 py-6 text-sm"
        >
          <span className="text-muted-foreground">
            {state.failure === 'moved' ? t.moved
              : state.failure === 'offline' ? t.failedBody
                : state.failure === 'unavailable' ? t.serverBody
                  : state.failure === 'sign-in' ? t.deniedBody
                    : state.failure === 'budget' ? t.budgetBody
                      : t.loadMoreFailed}
            {state.failure === 'unavailable' && state.reference
              ? <span className="mt-1 block text-xs">{t.errorReference}: <span className="font-mono">{state.reference}</span></span>
              : null}
          </span>
          {state.failure === 'moved' ? (
            <Button size="sm" variant="outline" onClick={() => router.refresh()}>
              <RefreshCwIcon aria-hidden="true" />
              {t.refresh}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void (catchingUp ? retryProjection.current?.() : loadMore())}
            >
              <RotateCwIcon aria-hidden="true" />
              {t.retry}
            </Button>
          )}
        </div>
      ) : feedContinuation(state.failure, state.cursor, state.loading) === 'more' ? (
        <div className="flex justify-center px-4 py-6">
          <Button variant="outline" onClick={() => void loadMore()}>
            {t.loadMore}
          </Button>
        </div>
      ) : null}
      {catchingUp ? (
        <FeedEnd caughtUp={state.caughtUp} catchingUp allHref={allHref} />
      ) : finished && items.length ? (
        <FeedEnd caughtUp={state.caughtUp} allHref={allHref} />
      ) : null}
    </div>
  );
}

function FeedEnd({
  caughtUp,
  allHref,
  catchingUp = false,
}: {
  caughtUp: FeedPage['caughtUp'];
  allHref: string;
  catchingUp?: boolean;
}) {
  const { t, now, locale } = useFeed();
  if (catchingUp || caughtUp?.state === 'projecting') {
    return (
      <p role="status" className="px-4 py-10 text-center text-muted-foreground text-sm">
        <span className="block font-medium text-foreground">{t.arriving}</span>
        {t.arrivingBody}
      </p>
    );
  }
  if (caughtUp?.state === 'caught-up') {
    return (
      <section
        aria-label={t.caughtUp}
        className="grid justify-items-center gap-2 px-4 py-10 text-center"
      >
        <CircleCheckBigIcon aria-hidden="true" className="size-8 text-success-foreground" />
        <h2 className="font-semibold text-lg">{t.caughtUp}</h2>
        <p className="max-w-sm text-muted-foreground text-sm">
          {t.caughtUpBody}
          {caughtUp.lastVisitedAt ? (
            <> {t.lastVisit({ time: relativeTime(caughtUp.lastVisitedAt, now, locale, 'long') })}</>
          ) : null}
        </p>
        <LocalizedLink
          href={allHref}
          className="mt-1 font-medium text-primary text-sm underline-offset-4
        hover:underline"
        >
          {t.moreFromAll}
        </LocalizedLink>
      </section>
    );
  }
  return <p className="px-4 py-10 text-center text-muted-foreground text-sm">{t.endOfFeed}</p>;
}
