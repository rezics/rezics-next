'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightIcon, LibraryBigIcon, RotateCwIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type RefObject, useEffect, useId, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { DiscoverMessages } from './messages.ts';
import { failureNotice, Notice } from './notice.tsx';
import { bffDiscovery, type DiscoveryLoader, discoveryPagesOptions, ReadError } from './query.ts';
import { type BrowseScope, workHref } from './scope.ts';
import type { DiscoveryItem, DiscoveryPage, DiscoveryQuery, Loaded, ReadFailure } from './types.ts';
import { WorkCard } from './work-card.tsx';

export interface ShelfProps {
  /** What the shelf lists, without the scope ("Top rated"). */
  title: string;
  /** Names the scope in words; every shelf title carries it. */
  scopeLabel: string;
  scope: BrowseScope;
  /** A line under the title: the Context a ranking uses, or what a term shelf means. */
  subtitle?: string;
  /** Main's query for the first page; later pages add the cursor. */
  query: DiscoveryQuery;
  /** The server-rendered first page, or why it failed. */
  initial: Loaded<DiscoveryPage>;
  /** A focused view of this shelf ("Browse all Books"). */
  browseAll?: { href: string; label: string };
  /** Where an empty or unbuilt shelf offers to look instead. */
  neighbour?: { href: string; label: string };
  signInHref?: string;
  avatarQuery?: string;
  /** Reads later pages; the BFF by default, a fixture in stories. */
  load?: DiscoveryLoader;
  locale: UiLocale;
  messages: DiscoverMessages;
}

function Failure({ failure, scopeLabel, messages, locale, onRetry, onStartOver, neighbour, signInHref }: {
  failure: ReadFailure; scopeLabel: string; messages: DiscoverMessages; locale: UiLocale;
  onRetry: () => void; onStartOver: () => void; neighbour?: ShelfProps['neighbour']; signInHref?: string;
}) {
  const t = materializeData(messages, { locale });
  const notice = failureNotice(failure, scopeLabel, t);
  return <Notice {...notice}>
    {failure === 'moved' ? <Button size="sm" onClick={onStartOver}><RotateCwIcon aria-hidden="true" />
      {t.startOver}</Button> : null}
    {failure === 'unavailable' ? <Button size="sm" variant="outline" onClick={onRetry}>
      <RotateCwIcon aria-hidden="true" />{t.retry}</Button> : null}
    {failure === 'sign-in' && signInHref ? <Link href={signInHref} className={buttonVariants({ size: 'sm' })}>
      {t.signIn}</Link> : null}
    {(failure === 'unbuilt' || failure === 'missing') && neighbour
      ? <Link href={neighbour.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
        {neighbour.label}</Link> : null}
  </Notice>;
}

function Cards({ items, scope, scopeLabel, avatarQuery, locale, messages, listRef }: {
  items: readonly DiscoveryItem[]; scope: BrowseScope; scopeLabel: string; avatarQuery?: string;
  locale: UiLocale; messages: DiscoverMessages; listRef: RefObject<HTMLUListElement | null>;
}) {
  const t = materializeData(messages, { locale });
  return <ul ref={listRef} className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-6">
    {items.map(item => <li key={item.id} className="grid">
      <WorkCard work={item.id} title={item.title} cover={item.cover} types={item.types}
        href={workHref(item.id, scope)} scopeLabel={scopeLabel} avatarQuery={avatarQuery} locale={locale}
        messages={messages} rating={item.rating ? { mean: item.rating.mean, count: item.rating.count,
          max: item.rating.scale.max } : null}>
        {item.match.classification ? <p className="text-muted-foreground text-xs">
          {item.match.classification.source === 'local' ? t.localDecision
            : scope.kind === 'realm' ? t.inheritedDecision : t.globalDecision}</p> : null}
      </WorkCard>
    </li>)}
  </ul>;
}

/**
 * One scoped row of Works with cursor pagination. The first page arrives from
 * the server; "Show more" reads the next through the BFF and appends it. The
 * count is exact once the list ends and a lower bound before.
 */
export function Shelf({ title, scopeLabel, scope, subtitle, query, initial, browseAll, neighbour, signInHref,
  avatarQuery, load = bffDiscovery, locale, messages }: ShelfProps) {
  const headingId = useId();
  const router = useRouter();
  return <section aria-labelledby={headingId} className="grid gap-4">
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 space-y-1">
        <h2 id={headingId} className="text-balance font-semibold text-xl tracking-tight">
          {title} <span className="font-normal text-muted-foreground">· {scopeLabel}</span></h2>
        {subtitle ? <p className="text-pretty text-muted-foreground text-sm">{subtitle}</p> : null}
      </div>
      {browseAll ? <Link href={browseAll.href} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        {browseAll.label}<ArrowRightIcon aria-hidden="true" /></Link> : null}
    </header>
    {initial.ok
      ? <Pages first={initial.data} query={query} load={load} scope={scope} scopeLabel={scopeLabel}
        neighbour={neighbour} signInHref={signInHref} avatarQuery={avatarQuery} locale={locale}
        messages={messages} />
      : <Failure failure={initial.failure} scopeLabel={scopeLabel} messages={messages} locale={locale}
        onRetry={() => router.refresh()} onStartOver={() => router.refresh()} neighbour={neighbour}
        signInHref={signInHref} />}
  </section>;
}

function Pages({ first, query, load, scope, scopeLabel, neighbour, signInHref, avatarQuery, locale, messages }: {
  first: DiscoveryPage; query: DiscoveryQuery; load: DiscoveryLoader; scope: BrowseScope; scopeLabel: string;
  neighbour?: ShelfProps['neighbour']; signInHref?: string; avatarQuery?: string; locale: UiLocale;
  messages: DiscoverMessages;
}) {
  const t = materializeData(messages, { locale });
  const client = useQueryClient();
  const options = discoveryPagesOptions(query, first, load);
  const pages = useInfiniteQuery(options);
  const list = useRef<HTMLUListElement>(null);
  const loaded = pages.data?.pages ?? [first];
  const items = loaded.flatMap(page => page.items);
  const last = loaded.at(-1)!;
  const failure = pages.isFetchNextPageError && pages.error instanceof ReadError ? pages.error.failure
    : pages.isFetchNextPageError ? 'unavailable' : null;

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

  const count = last.matches.kind === 'exact' ? t.count(last.matches.value) : t.countAtLeast(last.matches.value);
  return <>
    <p aria-live="polite" className="-mt-2 text-muted-foreground text-sm">{count}</p>
    {items.length
      ? <Cards items={items} scope={scope} scopeLabel={scopeLabel} avatarQuery={avatarQuery} locale={locale}
        messages={messages} listRef={list} />
      : !pages.hasNextPage ? <Notice icon={LibraryBigIcon} title={t.empty({ scope: scopeLabel })}
        description={t.emptyHelp}>
        {neighbour ? <Link href={neighbour.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {neighbour.label}</Link> : null}
      </Notice> : null}
    {failure ? <Failure failure={failure} scopeLabel={scopeLabel} messages={messages} locale={locale}
      onRetry={() => void pages.fetchNextPage()} onStartOver={startOver} neighbour={neighbour}
      signInHref={signInHref} /> : null}
    {pages.hasNextPage && !failure ? <div className="flex justify-center">
      <Button variant="outline" onClick={showMore} isLoading={pages.isFetchingNextPage}
        disabled={pages.isFetching}>
        {pages.isFetchingNextPage ? t.loadingMore : t.showMore}</Button>
    </div> : null}
  </>;
}
