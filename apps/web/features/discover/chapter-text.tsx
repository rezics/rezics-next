'use client';

import { Button } from '@rezics/ui/button';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { BanIcon, CircleSlashIcon, FileTextIcon, LibraryIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon,
  } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { entryLabel, typeEntry } from '../catalogue/types.ts';
import { messages as searchMessages } from '../search/messages.ts';
import { bffSearch, SearchError, type SearchLoader, searchPagesOptions } from '../search/query.ts';
import type { SearchState } from '../search/state.ts';
import type { SearchFailure, SearchHit, SearchLoaded, SearchResultPage } from '../search/types.ts';
import Link from '../shell/localized-link.tsx';
import { RetryButton } from '../work-page/retry-button.tsx';
import { browseMessages } from './browse-messages.ts';
import { chapterTextMessages } from './chapter-text-messages.ts';
import { CHAPTER_SCAN_PAGES, chapterProgress } from './chapter-text-read.ts';
import { Notice } from './notice.tsx';
import { shortId, workHref } from './scope.ts';

type Text = ContractOf<typeof chapterTextMessages.en>;
type SearchText = ContractOf<typeof searchMessages.en>;

export interface ChapterTextProps {
  /** Page one, read with the page; null when the query is too short for a phrase search. */
  read: SearchLoaded | null;
  /** The same phrase selection page one used. The resource list's cursor is never part of it. */
  state: SearchState | null;
  locale: UiLocale;
  actingSubject?: string;
  signedIn?: boolean;
  /** Later pages through the BFF by default; stories supply a fixture. */
  load?: SearchLoader;
}

/**
 * Chapter matches stay separate from the resource list's population, counts and continuation.
 * Main ranks text matches after title and name matches, so a page can examine results without
 * adding a chapter match; one action follows a bounded number of pages and says how far it got.
 */
export function ChapterTextResults(props: ChapterTextProps) {
  const { read, state, locale } = props;
  if (!read || !state) return null;
  const t = materializeData(chapterTextMessages[locale], { locale });
  if (!read.ok) return <Region t={t}><FirstFailure failure={read.failure} locale={locale} /></Region>;
  // A finished search whose results all matched titles or names leaves this region out.
  if (!read.page.next && !read.page.hits.some(hit => hit.reasons.chapter)) return null;
  return <Region t={t}><ChapterPages {...props} state={state} first={read.page} t={t} /></Region>;
}

function Region({ t, children }: { t: Text; children: ReactNode }) {
  const heading = useId();
  return <section aria-labelledby={heading} className="grid min-w-0 gap-4">
    <h2 id={heading} className="font-semibold text-xl">{t.title}</h2>
    {children}
  </section>;
}

function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/** What tells equal titles apart without inventing anything: the kind, credited names and the text's language. */
export function chapterHitContext(hit: SearchHit, locale: UiLocale): string[] {
  const entry = typeEntry(hit.types, 'work');
  const names = hit.authors.map(author => author.name);
  return [...(entry && !entry.default ? [entryLabel(entry, locale)] : []),
    ...(names.length ? [new Intl.ListFormat(locale, { type: 'conjunction' }).format(names)] : []),
    languageName(hit.reasons.language, locale)];
}

function ChapterPages({ first, state, locale, actingSubject, signedIn = true, load, t }: ChapterTextProps & {
  first: SearchResultPage; state: SearchState; t: Text;
}) {
  const search = materializeData(searchMessages[locale], { locale });
  const client = useQueryClient();
  const options = searchPagesOptions(state, locale, actingSubject, first,
    load ?? bffSearch(state, locale, actingSubject, signedIn), signedIn);
  const pages = useInfiniteQuery(options);
  const progress = chapterProgress(pages.data?.pages ?? [first]);
  const failed = pages.isFetchNextPageError || pages.isRefetchError;
  const failure = !failed ? null : pages.error instanceof SearchError ? pages.error.failure : 'unavailable';
  const list = useRef<HTMLOListElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const loaded = pages.data?.pages.length ?? 1;
  // One reader action: where its new matches begin, the page it waits for and how many more it may follow.
  const [scan, setScan] = useState<{ from: number; loaded: number; pages: number } | null>(null);
  const scanning = scan !== null && !failure;

  useEffect(() => {
    if (!scan) return;
    if (failure) {
      setScan(null);
      return;
    }
    if (loaded <= scan.loaded || pages.isFetching) return;
    if (progress.hits.length > scan.from) {
      setScan(null);
      list.current?.querySelectorAll<HTMLElement>('[data-chapter-link]')[scan.from]?.focus();
    } else if (pages.hasNextPage && scan.pages > 0) {
      setScan({ ...scan, loaded, pages: scan.pages - 1 });
      void pages.fetchNextPage();
    } else {
      setScan(null);
      // The button stays for a further action; at the end, focus moves to what the search found out.
      if (!pages.hasNextPage) summary.current?.focus();
    }
  }, [scan, loaded, pages.isFetching, pages.hasNextPage, failure, progress.hits.length]);

  function more() {
    if (scanning || pages.isFetching) return;
    setScan({ from: progress.hits.length, loaded, pages: CHAPTER_SCAN_PAGES - 1 });
    void pages.fetchNextPage();
  }
  function restart() {
    setScan(null);
    client.setQueryData(options.queryKey, data => data && { pages: data.pages.slice(0, 1),
      pageParams: data.pageParams.slice(0, 1) });
    void pages.refetch();
  }

  const format = new Intl.NumberFormat(locale);
  const status = progress.complete
    ? progress.hits.length ? t.all(progress.hits.length) : t.none({ phrase: state.phrase })
    : [progress.hits.length ? t.found(progress.hits.length) : t.noneYet,
      t.checked({ checked: format.format(progress.checked), total: format.format(progress.total) })].join(' · ');
  return <>
    {progress.hits.length ? <>
      <p className="text-muted-foreground text-sm">{t.noExcerpt}</p>
      <ol ref={list} className="grid min-w-0 gap-3 sm:grid-cols-2">
        {progress.hits.map(hit => <li key={hit.matchUnit} className="grid min-w-0 content-start gap-2 rounded-2xl
          border border-border/70 bg-card p-4">
          <Link href={workHref(hit.work, state.scope)} className="min-w-0 text-muted-foreground text-sm underline-offset-4
            hover:underline">
            <bdi lang={hit.title?.language} dir={hit.title?.direction}>{hit.title?.value ?? shortId(hit.work)}</bdi>
          </Link>
          <p className="min-w-0 break-words text-muted-foreground text-xs">{chapterHitContext(hit, locale).join(' · ')}</p>
          <p className="flex min-w-0 items-start gap-2">
            <FileTextIcon aria-hidden="true" className="mt-1.5 size-4 shrink-0 text-muted-foreground" />
            <Link data-chapter-link href={hit.reasons.chapter!.href} className="min-w-0 break-words font-work-title text-lg
              text-primary underline underline-offset-4 hover:no-underline">
              <bdi lang={hit.reasons.language}>{hit.reasons.chapter!.title}</bdi>
            </Link>
          </p>
        </li>)}
      </ol>
    </> : null}
    {failure ? <LaterFailure failure={failure} search={search} onRetry={() => void (pages.isRefetchError
      ? pages.refetch() : pages.fetchNextPage())} onRestart={restart} /> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p ref={summary} tabIndex={-1} aria-live="polite" aria-atomic="true"
        className="rounded-sm text-muted-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {scanning ? t.checking : status}
      </p>
      {pages.hasNextPage && !failure ? <Button variant="outline" size="sm" onClick={more} isLoading={scanning}>{scanning ? t.checking : progress.hits.length ? t.showMore : t.checkMore}</Button>
        : null}
    </div>
  </>;
}

/** Page one could not be read; the typed reason decides what the reader can do. */
function FirstFailure({ failure, locale }: { failure: SearchFailure; locale: UiLocale }) {
  const search = materializeData(searchMessages[locale], { locale }), browse = browseMessages[locale];
  const retry = <RetryButton label={browse.retry} pendingLabel={browse.loading} />;
  return <LaterFailure failure={failure} search={search} retry={retry} restart={retry} />;
}

function LaterFailure({ failure, search, onRetry, onRestart, retry, restart }: {
  failure: SearchFailure; search: SearchText; onRetry?: () => void; onRestart?: () => void;
  retry?: ReactNode; restart?: ReactNode;
}) {
  switch (failure) {
    case 'restart': return <Notice icon={RefreshCwIcon} title={search.restartTitle} description={search.restartHelp}>
      {restart ?? <Button size="sm" onClick={onRestart}><RotateCwIcon aria-hidden="true" />{search.restart}</Button>}
    </Notice>;
    case 'budget': return <Notice icon={LibraryIcon} title={search.budgetTitle} description={search.budgetHelp} />;
    case 'unsupported': return <Notice icon={BanIcon} title={search.unsupportedTitle} description={search.unsupportedHelp} />;
    case 'missing': return <Notice icon={CircleSlashIcon} title={search.realmMissingTitle} />;
    case 'invalid': return <Notice icon={BanIcon} tone="destructive" title={search.invalidTitle} />;
    case 'unavailable': return <Notice icon={TriangleAlertIcon} tone="destructive" title={search.errorTitle}
      description={search.errorFallback}>
      {retry ?? <Button size="sm" variant="outline" onClick={onRetry}><RotateCwIcon aria-hidden="true" />{search.retry}</Button>}
    </Notice>;
  }
}
