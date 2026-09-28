'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { infiniteQueryOptions, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { BanIcon, CircleSlashIcon, HourglassIcon, LibraryBigIcon, type LucideIcon, RefreshCwIcon, RotateCwIcon,
  TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { WorkGrid } from '../catalogue/work-shelf.tsx';
import { discoveryWork } from '../discover/cards.ts';
import { Notice } from '../discover/notice.tsx';
import Link from '../shell/localized-link.tsx';
import type { ConceptMessages } from './messages.ts';
import { type ConceptState, conceptHref } from './state.ts';
import type { ConceptWorksPage, Loaded, ReadFailure } from './types.ts';
import { readConceptWorks } from './works-read.ts';

type Text = ReturnType<typeof materializeData<ConceptMessages>>;

/** Reads a page, the first again after "Start over"; the BFF by default, a fixture in stories. */
export type ConceptWorksLoader = (state: ConceptState, locale: UiLocale, cursor?: string) =>
  Promise<Loaded<ConceptWorksPage>>;
const bffWorks: ConceptWorksLoader = (state, locale, cursor) => readConceptWorks(browserMainApi(), state, locale, cursor);

class ReadError extends Error {
  constructor(readonly failure: ReadFailure) { super(`Concept Works read failed: ${failure}`); }
}

/** An empty page may still continue: Main stops a page where its bounded seek does. Read on, a few pages at most. */
const AUTO_PAGES = 4;

const count = (matches: ConceptWorksPage['matches'], locale: UiLocale, t: Text) => matches.kind === 'exact'
  ? t.workCount(matches.value) : t.workCountAtLeast({ count: new Intl.NumberFormat(locale).format(matches.value) });

function failureNotice(failure: ReadFailure, t: Text): { icon: LucideIcon; title: string; description?: string;
  tone: 'default' | 'destructive' } {
  switch (failure) {
    case 'missing': return { icon: CircleSlashIcon, title: t.valueMissing, description: t.valueMissingHelp,
      tone: 'default' };
    case 'invalid': return { icon: BanIcon, title: t.invalidConditions, tone: 'destructive' };
    case 'unbuilt': return { icon: HourglassIcon, title: t.unbuilt, description: t.unbuiltHelp, tone: 'default' };
    case 'moved': return { icon: RefreshCwIcon, title: t.moved, description: t.movedHelp, tone: 'default' };
    case 'unavailable': return { icon: TriangleAlertIcon, title: t.worksUnavailable,
      description: t.worksUnavailableHelp, tone: 'destructive' };
  }
}

/**
 * The Works the Condition bar selects, newest first: the server's first page,
 * then "Show more" through the BFF. A list that cannot load says why in its
 * place and offers the way back to the Concept's own Works.
 */
export function ConceptWorks({ state, name, initial, avatarQuery, load = bffWorks, locale, messages }: {
  state: ConceptState; name: string; initial: Loaded<ConceptWorksPage>; avatarQuery?: string;
  load?: ConceptWorksLoader; locale: UiLocale; messages: ConceptMessages;
}) {
  const t = materializeData(messages, { locale });
  const headingId = useId();
  const router = useRouter();
  const filtered = state.include.length > 0 || state.exclude.length > 0;
  const plain = conceptHref({ ...state, include: [], exclude: [], match: 'all' });
  const heading = (extra?: ReactNode) => <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <h2 id={headingId} className="font-semibold text-xl tracking-tight">{t.works}</h2>{extra}</header>;
  if (!initial.ok) {
    const notice = failureNotice(initial.failure, t);
    return <section aria-labelledby={headingId} className="grid gap-4">
      {heading()}
      <Notice {...notice} headingLevel={3}>
        {initial.failure === 'moved' || initial.failure === 'unavailable'
          ? <Button size="sm" variant="outline" onClick={() => router.refresh()}>
            <RotateCwIcon aria-hidden="true" />{t.retry}</Button> : null}
        {(initial.failure === 'missing' || initial.failure === 'invalid') && filtered
          ? <Link href={plain} className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t.showAll({ name })}</Link>
          : null}
        {initial.failure === 'unbuilt' && state.scope.kind === 'realm'
          ? <Link href={conceptHref({ ...state, scope: { kind: 'global' } })}
            className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t.seeEveryone}</Link> : null}
      </Notice>
    </section>;
  }
  if (initial.data.stale) {
    return <section aria-labelledby={headingId} className="grid gap-4">
      {heading()}
      <Notice icon={HourglassIcon} title={t.stale} description={t.staleHelp} />
    </section>;
  }
  return <Pages state={state} first={initial.data} filtered={filtered} plain={plain} name={name} heading={heading}
    avatarQuery={avatarQuery} load={load} locale={locale} messages={messages} headingId={headingId} />;
}

function Pages({ state, first, filtered, plain, name, heading, headingId, avatarQuery, load, locale, messages }: {
  state: ConceptState; first: ConceptWorksPage; filtered: boolean; plain: string; name: string;
  heading: (extra?: ReactNode) => ReactNode; headingId: string; avatarQuery?: string; load: ConceptWorksLoader;
  locale: UiLocale; messages: ConceptMessages;
}) {
  const t = materializeData(messages, { locale });
  const client = useQueryClient();
  const options = infiniteQueryOptions({
    // The first page's source position is in the key, so a fresh server render starts a new list.
    queryKey: ['concept-works', state, locale, first.sourcePosition.dataEpoch, first.sourcePosition.sequence],
    queryFn: async ({ pageParam }) => {
      const read = await load(state, locale, pageParam ?? undefined);
      if (!read.ok) throw new ReadError(read.failure);
      return read.data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    initialData: { pages: [first], pageParams: [null] },
    retry: false,
  });
  const pages = useInfiniteQuery(options);
  const loaded = pages.data?.pages ?? [first];
  const items = loaded.flatMap(page => page.items);
  const last = loaded.at(-1) ?? first;
  const failed = pages.isFetchNextPageError || pages.isRefetchError;
  const failure = !failed ? null : pages.error instanceof ReadError ? pages.error.failure : 'unavailable';
  const list = useRef<HTMLUListElement>(null);
  const focusFrom = useRef<number | null>(null);

  // Keep keyboard users where the new results begin, once they are on screen.
  useEffect(() => {
    if (focusFrom.current === null || items.length <= focusFrom.current) return;
    list.current?.querySelectorAll<HTMLElement>('h3 a')[focusFrom.current]?.focus();
    focusFrom.current = null;
  }, [items.length]);
  // Main ends a page where its seek window does, even with no match yet: read on before saying "none".
  const { hasNextPage, isFetching, fetchNextPage } = pages;
  useEffect(() => {
    if (!items.length && hasNextPage && !isFetching && !failure && loaded.length <= AUTO_PAGES) void fetchNextPage();
  }, [items.length, hasNextPage, isFetching, failure, loaded.length, fetchNextPage]);

  const searching = !items.length && hasNextPage && !failure;
  return <section aria-labelledby={headingId} aria-busy={searching || undefined} className="grid gap-5">
    {heading(<p className="text-muted-foreground text-sm tabular-nums">{count(last.matches, locale, t)}</p>)}
    {items.length ? <WorkGrid works={items.map(item => discoveryWork(item, state.scope))} avatarQuery={avatarQuery}
      locale={locale} listRef={list} />
      : !hasNextPage ? <Notice icon={LibraryBigIcon} title={filtered ? t.noMatches : t.noWorks({ name })}
        description={filtered ? t.noMatchesHelp : t.noWorksHelp}>
        {filtered ? <Link href={plain} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {t.showAll({ name })}</Link> : null}
      </Notice> : null}
    {failure ? <Notice {...failureNotice(failure, t)}>
      {failure === 'moved' ? <Button size="sm" onClick={() => {
        client.setQueryData(options.queryKey, data => data && { pages: data.pages.slice(0, 1),
          pageParams: data.pageParams.slice(0, 1) });
        void pages.refetch();
      }}><RotateCwIcon aria-hidden="true" />{t.startOver}</Button>
        : <Button size="sm" variant="outline" onClick={() => void pages.fetchNextPage()}>
          <RotateCwIcon aria-hidden="true" />{t.retry}</Button>}
    </Notice> : null}
    <p aria-live="polite" className="sr-only">{pages.isFetchingNextPage ? t.loadingMore : ''}</p>
    {hasNextPage && !failure && (items.length || loaded.length > AUTO_PAGES) ? <div className="flex justify-center">
      <Button variant="outline" pill isLoading={pages.isFetchingNextPage} disabled={isFetching} onClick={() => {
        focusFrom.current = items.length;
        void fetchNextPage();
      }}>{pages.isFetchingNextPage ? t.loadingMore : t.showMore}</Button>
    </div> : null}
  </section>;
}
