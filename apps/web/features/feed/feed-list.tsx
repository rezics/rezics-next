'use client';

import { Button } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { ArrowUpIcon, CircleCheckBigIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { commandKey } from './api.ts';
import { FeedCard } from './card.tsx';
import { relativeTime } from './time.ts';
import { useFeed } from './feed-context.tsx';
import type { FeedHead, FeedItem, FeedPage, FeedQuery, Loaded, ReadFailure } from './types.ts';

/** How often an open feed asks whether newer posts exist. */
const HEAD_INTERVAL_MS = 60_000;
/** Pages read in a row without a new post before the list waits for the reader to ask for more. */
const SPARSE_PAGES = 4;

interface ListState {
  items: FeedItem[];
  cursor: string | null;
  caughtUp: FeedPage['caughtUp'];
  loading: boolean;
  failure: ReadFailure | null;
  /** Consecutive pages that added nothing; Main's filters can leave a page empty. */
  sparse: number;
}

function initialState(initial: FeedPage): ListState {
  return { items: initial.items, cursor: initial.nextCursor, caughtUp: initial.caughtUp, loading: false,
    failure: null, sparse: initial.items.length ? 0 : 1 };
}

/** A card-shaped placeholder, so loading keeps the page's rhythm. */
function FeedSkeleton({ count = 3 }: { count?: number }) {
  return <div aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div key={index} className="grid gap-3 border-border/60 border-b
      px-4 py-4">
      <div className="flex items-center gap-2"><Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-3 w-40 rounded-full" /></div>
      <div className="grid grid-cols-[minmax(0,1fr)_4rem] gap-4">
        <div className="grid content-start gap-2"><Skeleton className="h-4 w-3/4 rounded-full" />
          <SkeletonText lines={2} /></div>
        <Skeleton className="aspect-[2/3] w-16 rounded-md" />
      </div>
      <Skeleton className="h-8 w-64 rounded-full" />
    </div>)}
  </div>;
}

/** The first page failed: say so in words and offer the one fix. */
function FeedFailure({ failure }: { failure: ReadFailure }) {
  const { t } = useFeed();
  const router = useRouter();
  const moved = failure === 'moved';
  return <EmptyState icon={moved ? RefreshCwIcon : TriangleAlertIcon} tone={moved ? 'default' : 'destructive'}
    role="alert" title={moved ? t.moved : t.failed} description={moved ? t.movedBody : t.failedBody}
    className="m-3 sm:m-4">
    <Button onClick={() => router.refresh()}><RotateCwIcon aria-hidden="true" />{moved ? t.refresh : t.retry}</Button>
  </EmptyState>;
}

/**
 * Asks Main, while the page is visible, how many posts arrived since the one
 * the reader is looking at began; never inserts them above the reader.
 */
function useNewPosts(page: FeedPage, scope: 'following' | 'all', interval: number) {
  const { api, actingSubject, signedIn } = useFeed();
  const [head, setHead] = useState<FeedHead | null>(null);
  useEffect(() => {
    if (signedIn && !actingSubject) return;
    let stopped = false;
    const after = page.projection.sequence;
    async function check() {
      if (document.visibilityState !== 'visible') return;
      const read = await api().head({ after, scope, ...(actingSubject ? { actingSubject } : {}) });
      if (stopped) return;
      // A Main without the head read (404) is not asked again on this page.
      if (!read.ok && read.failure === 'missing') { stopped = true; clearInterval(timer); return; }
      if (read.ok) setHead(read.data);
    }
    const timer = setInterval(() => void check(), interval);
    return () => { stopped = true; clearInterval(timer); };
  }, [api, actingSubject, signedIn, page.projection.sequence, scope, interval]);
  return head && head.newPosts.value > 0 ? head : null;
}

/** Records how far the reader has seen, so the navigation's new-activity dots clear. */
function useWatermark(page: FeedPage, scope: 'following' | 'all') {
  const { api, actingSubject } = useFeed();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    const position = `${scope}:${page.sourcePosition.dataEpoch}:${page.projection.sequence}`;
    if (!actingSubject || sent.current === position) return;
    sent.current = position;
    void api().watermark(scope, { actingSubject, dataEpoch: page.sourcePosition.dataEpoch,
      sequence: page.projection.sequence }, commandKey());
  }, [api, actingSubject, page, scope]);
}

/**
 * The posts of one feed view. The server renders the first page; later pages
 * load as the reader nears the end, with a button as the fallback. Main's
 * page can be sparse after filtering, so an empty page continues on its own
 * for a few pages before handing the choice back to the reader.
 */
export function FeedList({ initial, query, empty, allHref, headInterval = HEAD_INTERVAL_MS }: {
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
  if (!initial.ok) return <FeedFailure failure={initial.failure} />;
  return <FeedPages key={`${JSON.stringify(query)}:${initial.data.projection.sequence}`} page={initial.data}
    query={query} empty={empty} allHref={allHref} headInterval={headInterval} />;
}

function FeedPages({ page, query, empty, allHref, headInterval }: { page: FeedPage; query: FeedQuery;
  empty: ReactNode; allHref: string; headInterval: number }) {
  const { t, api } = useFeed();
  const router = useRouter();
  const [state, setState] = useState(() => initialState(page));
  const sentinel = useRef<HTMLDivElement>(null);
  const scope = query.scope ?? 'all';
  const fresh = useNewPosts(page, scope, headInterval);
  useWatermark(page, scope);

  const loadMore = useCallback(async () => {
    const cursor = state.cursor;
    if (!cursor || state.loading) return;
    setState(current => ({ ...current, loading: true, failure: null }));
    const next = await api().page({ ...query, cursor });
    setState(current => {
      if (!next.ok) return { ...current, loading: false, failure: next.failure };
      const seen = new Set(current.items.map(item => item.id));
      const added = next.data.items.filter(item => !seen.has(item.id));
      return { items: [...current.items, ...added], cursor: next.data.nextCursor, caughtUp: next.data.caughtUp,
        loading: false, failure: null, sparse: added.length ? 0 : current.sparse + 1 };
    });
  }, [api, query, state.cursor, state.loading]);

  // Near the end, the next page loads by itself; the button below stays for keyboards and screen readers.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !state.cursor || state.loading || state.failure || state.sparse >= SPARSE_PAGES) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '600px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, state.cursor, state.loading, state.failure, state.sparse]);

  function showNewest() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    router.refresh();
  }

  const { items } = state;
  const finished = !state.cursor && !state.loading;
  return <div className="relative">
    {fresh ? <div className="pointer-events-none sticky top-20 z-30 flex justify-center">
      <Button size="sm" onClick={showNewest} className="pointer-events-auto rounded-full shadow-lg">
        <ArrowUpIcon aria-hidden="true" />
        {fresh.newPosts.kind === 'exact' ? t.newPosts(fresh.newPosts.value) : t.newPostsAtLeast(fresh.newPosts.value)}
      </Button>
    </div> : null}
    {items.length ? <div role="feed" aria-label={t.posts} aria-busy={state.loading}>
      {items.map((item, index) => <FeedCard key={item.id} item={item} position={index + 1}
        total={state.cursor ? undefined : items.length} />)}
    </div> : finished ? empty : null}
    {state.loading ? <><span role="status" className="sr-only">{t.loadingMore}</span><FeedSkeleton count={2} /></>
      : null}
    <div ref={sentinel} aria-hidden="true" />
    {state.failure ? <div role="alert" className="flex flex-wrap items-center justify-center gap-3 px-4 py-6 text-sm">
      <span className="text-muted-foreground">{state.failure === 'moved' ? t.moved : t.loadMoreFailed}</span>
      {state.failure === 'moved'
        ? <Button size="sm" variant="outline" onClick={() => router.refresh()}>
          <RefreshCwIcon aria-hidden="true" />{t.refresh}</Button>
        : <Button size="sm" variant="outline" onClick={() => void loadMore()}>
          <RotateCwIcon aria-hidden="true" />{t.retry}</Button>}
    </div> : state.cursor && !state.loading ? <div className="flex justify-center px-4 py-6">
      <Button variant="outline" onClick={() => void loadMore()}>{t.loadMore}</Button>
    </div> : null}
    {finished && items.length ? <FeedEnd caughtUp={state.caughtUp} allHref={allHref} /> : null}
  </div>;
}

function FeedEnd({ caughtUp, allHref }: { caughtUp: FeedPage['caughtUp']; allHref: string }) {
  const { t, now, locale } = useFeed();
  if (caughtUp?.state === 'caught-up') {
    return <section aria-label={t.caughtUp} className="grid justify-items-center gap-2 px-4 py-10 text-center">
      <CircleCheckBigIcon aria-hidden="true" className="size-8 text-success-foreground" />
      <h2 className="font-semibold text-lg">{t.caughtUp}</h2>
      <p className="max-w-sm text-muted-foreground text-sm">{t.caughtUpBody}
        {caughtUp.lastVisitedAt ? <> {t.lastVisit({ time: relativeTime(caughtUp.lastVisitedAt, now, locale, 'long') })}</>
          : null}</p>
      <LocalizedLink href={allHref} className="mt-1 font-medium text-primary text-sm underline-offset-4
        hover:underline">{t.moreFromAll}</LocalizedLink>
    </section>;
  }
  if (caughtUp?.state === 'projecting') {
    return <p role="status" className="px-4 py-10 text-center text-muted-foreground text-sm">
      <span className="block font-medium text-foreground">{t.arriving}</span>{t.arrivingBody}</p>;
  }
  return <p className="px-4 py-10 text-center text-muted-foreground text-sm">{t.endOfFeed}</p>;
}
