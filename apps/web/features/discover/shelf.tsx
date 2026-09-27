'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { LibraryBigIcon, RotateCwIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type ShelfHeading, ShelfHeader, WorkGrid, WorkShelf } from '../catalogue/work-shelf.tsx';
import Link from '../shell/localized-link.tsx';
import { discoveryWork } from './cards.ts';
import type { DiscoverMessages } from './messages.ts';
import { failureNotice, Notice } from './notice.tsx';
import { bffDiscovery, type DiscoveryLoader, discoveryPagesOptions, ReadError } from './query.ts';
import type { BrowseScope } from './scope.ts';
import type { DiscoveryPage, DiscoveryQuery, Loaded, ReadFailure } from './types.ts';

export interface DiscoverShelfProps {
  heading: ShelfHeading & { title: string };
  /** `row`: one sideways row on an overview, hidden when empty. `grid`: the full list with "Show more". */
  mode: 'row' | 'grid';
  scope: BrowseScope;
  /** Main's query for the first page; later pages add the cursor. */
  query: DiscoveryQuery;
  /** The server-rendered first page, or why it failed. */
  initial: Loaded<DiscoveryPage>;
  /** Where an empty or unprepared list in a community offers to look instead. */
  neighbour?: { href: string; label: string };
  signInHref: string;
  avatarQuery?: string;
  /** Reads later pages; the BFF by default, a fixture in stories. */
  load?: DiscoveryLoader;
  locale: UiLocale;
  messages: DiscoverMessages;
}

function Failure({ failure, shelf, messages, locale, onRetry, onStartOver, neighbour, signInHref }: {
  failure: ReadFailure; shelf: string; messages: DiscoverMessages; locale: UiLocale;
  onRetry: () => void; onStartOver: () => void; neighbour?: DiscoverShelfProps['neighbour']; signInHref: string;
}) {
  const t = materializeData(messages, { locale });
  return <Notice {...failureNotice(failure, shelf, t)}>
    {failure === 'moved' ? <Button size="sm" onClick={onStartOver}><RotateCwIcon aria-hidden="true" />
      {t.startOver}</Button> : null}
    {failure === 'unavailable' ? <Button size="sm" variant="outline" onClick={onRetry}>
      <RotateCwIcon aria-hidden="true" />{t.retry}</Button> : null}
    {failure === 'sign-in' ? <Link href={signInHref} className={buttonVariants({ size: 'sm' })}>{t.signIn}</Link> : null}
    {(failure === 'unbuilt' || failure === 'stale' || failure === 'missing') && neighbour
      ? <Link href={neighbour.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
        {neighbour.label}</Link> : null}
  </Notice>;
}

/**
 * One discovery shelf. Its first page arrives from the server; on an overview
 * it is a sideways row leading to its full list, and in a focused view a grid
 * whose "Show more" reads the next page through the BFF. A shelf that cannot
 * load says so in its place; the rest of the page stays.
 */
export function DiscoverShelf(props: DiscoverShelfProps) {
  const { heading, mode, scope, initial, avatarQuery, locale } = props;
  const headingId = useId();
  const router = useRouter();
  if (initial.ok && mode === 'row') {
    if (!initial.data.items.length) return null;
    return <WorkShelf heading={heading} works={initial.data.items.map(item => discoveryWork(item, scope))}
      avatarQuery={avatarQuery} locale={locale} />;
  }
  return <section aria-labelledby={headingId} className="grid min-w-0 grid-cols-1 gap-4">
    {/* A full list of a shelf that could not load, or of the list already shown, would lead nowhere new. */}
    <ShelfHeader id={headingId} heading={{ ...heading, seeAll: undefined }} locale={locale} />
    {initial.ok ? <Pages first={initial.data} {...props} />
      : <Failure failure={initial.failure} shelf={heading.title} messages={props.messages} locale={locale}
        onRetry={() => router.refresh()} onStartOver={() => router.refresh()} neighbour={props.neighbour}
        signInHref={props.signInHref} />}
  </section>;
}

function Pages({ first, query, load = bffDiscovery, scope, heading, neighbour, signInHref, avatarQuery, locale,
  messages }: DiscoverShelfProps & { first: DiscoveryPage }) {
  const t = materializeData(messages, { locale });
  const client = useQueryClient();
  const options = discoveryPagesOptions(query, first, load);
  const pages = useInfiniteQuery(options);
  const list = useRef<HTMLUListElement>(null);
  const items = (pages.data?.pages ?? [first]).flatMap(page => page.items);
  // A later page, or page one again after "Start over", may fail while the shown pages stay.
  const failed = pages.isFetchNextPageError || pages.isRefetchError;
  const failure = !failed ? null : pages.error instanceof ReadError ? pages.error.failure : 'unavailable';

  // Keep keyboard users where the new results begin, once they are on screen.
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    if (focusFrom.current === null || items.length <= focusFrom.current) return;
    list.current?.querySelectorAll<HTMLElement>('h3 a')[focusFrom.current]?.focus();
    focusFrom.current = null;
  }, [items.length]);
  function showMore() {
    focusFrom.current = items.length;
    void pages.fetchNextPage();
  }
  function startOver() {
    client.setQueryData(options.queryKey, data => data && { pages: data.pages.slice(0, 1),
      pageParams: data.pageParams.slice(0, 1) });
    void pages.refetch();
  }

  return <>
    {items.length
      ? <WorkGrid works={items.map(item => discoveryWork(item, scope))} avatarQuery={avatarQuery} locale={locale}
        listRef={list} />
      : !pages.hasNextPage ? <Notice icon={LibraryBigIcon} title={t.empty} description={t.emptyHelp}>
        {neighbour ? <Link href={neighbour.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {neighbour.label}</Link> : null}
      </Notice> : null}
    {failure ? <Failure failure={failure} shelf={heading.title} messages={messages} locale={locale}
      onRetry={() => void (pages.isRefetchError ? pages.refetch() : pages.fetchNextPage())}
      onStartOver={startOver} neighbour={neighbour} signInHref={signInHref} /> : null}
    <p aria-live="polite" className="sr-only">{pages.isFetchingNextPage ? t.loadingMore : ''}</p>
    {pages.hasNextPage && !failure ? <div className="flex justify-center">
      <Button variant="outline" pill onClick={showMore} isLoading={pages.isFetchingNextPage}
        disabled={pages.isFetching}>
        {pages.isFetchingNextPage ? t.loadingMore : t.showMore}</Button>
    </div> : null}
  </>;
}
