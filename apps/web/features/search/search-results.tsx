'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { BanIcon, BookTextIcon, CircleSlashIcon, FileTextIcon, LibraryIcon, QuoteIcon, RefreshCwIcon, RotateCwIcon,
  SearchIcon, SearchXIcon, TagIcon, TriangleAlertIcon, UserRoundIcon, UsersRoundIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import { WorkRow } from '../catalogue/work-row.tsx';
import { WorkShelf } from '../catalogue/work-shelf.tsx';
import { Notice } from '../discover/notice.tsx';
import { workHref } from '../discover/scope.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import type { SearchFallback } from './fallback.ts';
import type { SearchMessages } from './messages.ts';
import { bffSearch, SearchError, type SearchLoader, searchPagesOptions } from './query.ts';
import { phraseStatus, type SearchState, searchHref } from './state.ts';
import type { Suggestion } from './suggest.ts';
import type { SearchFailure, SearchHit, SearchLoaded, SearchResultPage } from './types.ts';

type Text = ContractOf<SearchMessages>;

export interface SearchResultsProps {
  state: SearchState;
  /** Page one from the server; null while the phrase is too short to search. */
  initial: SearchLoaded | null;
  /** The scope in words ("Global", a Realm's name). */
  scopeLabel: string;
  /** Mutes apply to a signed-in reader's results, which the completeness line says. */
  signedIn: boolean;
  actingSubject?: string;
  avatarQuery?: string;
  /** Reads later pages; the BFF by default, a fixture in stories. */
  load?: SearchLoader;
  /** Near matches and popular Works, read when page one found nothing. */
  fallback?: SearchFallback | null;
  locale: UiLocale;
  messages: SearchMessages;
}

function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/**
 * The count, then what was searched for anyone who asks: the population,
 * filters, mutes and index position stay one click away, not in the way.
 */
function Completeness({ page, state, scopeLabel, signedIn, locale, t }: {
  page: SearchResultPage; state: SearchState; scopeLabel: string; signedIn: boolean; locale: UiLocale; t: Text;
}) {
  const parts = [t.searched({ count: page.population, scope: scopeLabel }), t.complete,
    ...(state.language ? [t.onlyLanguage({ language: languageName(state.language, locale) })] : []),
    ...(state.term ? [t.onlyTerm] : []), ...(signedIn ? [t.mutes] : []),
    t.freshness({ sequence: page.sequence })];
  return <div data-testid="search-completeness" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
    <p className="font-medium">{t.count(page.total)}</p>
    <details className="group text-muted-foreground">
      <summary className="cursor-pointer list-none rounded-sm underline decoration-dotted underline-offset-4 outline-none
        hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {t.aboutResults}</summary>
      <ul className="mt-2 grid gap-0.5">{parts.map(part => <li key={part}>{part}</li>)}</ul>
    </details>
  </div>;
}

/** A result as a catalogue card: cover, title, credited authors, rating and tagline, as Main's card gives them. */
export function hitWork(hit: SearchHit, state: SearchState): CatalogueWork {
  return { id: hit.work, href: workHref(hit.work, state.scope), title: hit.title, cover: hit.cover,
    kind: coverKindOf(hit.types), authors: hit.authors, rating: hit.rating, tagline: hit.tagline,
    completion: hit.completion };
}

const SLOT = '\u0000';

/** A message with one value set in place, in the value's own language, wherever the message puts it. */
export function withValue(message: (value: string) => string, value: string, lang: string | null): ReactNode {
  const [before = '', after = ''] = message(SLOT).split(SLOT);
  return <span>{before}<span lang={lang ?? undefined}>{value}</span>{after}</span>;
}

/** Where the phrase was found, in words: the title (or another of its titles), an author, the tagline or the text. */
function matchReason(hit: SearchHit, locale: UiLocale, t: Text): { icon: typeof FileTextIcon; text: ReactNode } {
  const { field, matchedText, matchedLanguage, language } = hit.reasons;
  switch (field) {
    case 'title': return { icon: BookTextIcon, text: matchedText && matchedText !== hit.title?.value
      ? withValue(title => t.matchOtherTitle({ title }), matchedText, matchedLanguage) : t.matchTitle };
    case 'credit': return { icon: UserRoundIcon, text: matchedText
      ? withValue(name => t.matchCredit({ name }), matchedText, matchedLanguage) : t.matchCreditUnnamed };
    case 'tagline': return { icon: QuoteIcon, text: t.matchTagline };
    case 'body': return { icon: FileTextIcon, text: t.textMatch({ language: languageName(language, locale) }) };
  }
}

function Reasons({ hit, scopeLabel, locale, t }: { hit: SearchHit; scopeLabel: string; locale: UiLocale; t: Text }) {
  const { reasons } = hit;
  const term = reasons.classification?.conceptName;
  const items: { icon: typeof FileTextIcon; text: ReactNode }[] = [
    matchReason(hit, locale, t),
    ...(reasons.realm ? [{ icon: UsersRoundIcon, text: reasons.realm === 'realm-adoption'
      ? t.realmAdopted({ realm: scopeLabel }) : t.realmFallback({ realm: scopeLabel }) }] : []),
    ...(reasons.classification ? [{ icon: TagIcon, text: <span lang={term?.language}>
      {reasons.classification.source === 'local'
        ? t.classifiedLocal({ term: term?.value ?? t.thisTerm, realm: scopeLabel })
        : t.classifiedGlobal({ term: term?.value ?? t.thisTerm })}</span> }] : []),
  ];
  return <ul aria-label={t.reasons} className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
    {items.map((item, index) => <li key={index} className="flex items-start gap-1.5">
      <item.icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span>{item.text}</span></li>)}
  </ul>;
}

function FailureNotice({ failure, state, t, onRetry, onRestart }: {
  failure: SearchFailure; state: SearchState; t: Text; onRetry: () => void; onRestart: () => void;
}) {
  switch (failure) {
    case 'restart': return <Notice icon={RefreshCwIcon} title={t.restartTitle} description={t.restartHelp}>
      <Button size="sm" onClick={onRestart}><RotateCwIcon aria-hidden="true" />{t.restart}</Button></Notice>;
    case 'budget': return <Notice icon={LibraryIcon} title={t.budgetTitle} description={t.budgetHelp} />;
    case 'missing': return <Notice icon={CircleSlashIcon} title={t.realmMissingTitle}>
      <Link href={searchHref({ ...state, scope: { kind: 'global' } })}
        className={buttonVariants({ size: 'sm', variant: 'outline' })}>{t.seeGlobal}</Link></Notice>;
    case 'invalid': return <Notice icon={BanIcon} tone="destructive" title={t.invalidTitle} />;
    case 'unavailable': return <Notice icon={TriangleAlertIcon} tone="destructive" title={t.errorTitle}
      description={t.errorFallback}>
      <Button size="sm" variant="outline" onClick={onRetry}><RotateCwIcon aria-hidden="true" />{t.retry}</Button>
    </Notice>;
  }
}

/** Close titles and names for a search that found nothing, each one step away. */
function DidYouMean({ suggestions, state, t }: { suggestions: readonly Suggestion[]; state: SearchState; t: Text }) {
  const link = 'font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 '
    + 'focus-visible:ring-ring rounded-sm';
  return <span className="text-base text-foreground">{t.didYouMean}{' '}
    {suggestions.map((suggestion, index) => <span key={suggestion.kind === 'work' ? suggestion.item.work : suggestion.name}>
      {index ? t.listSeparator : null}
      {suggestion.kind === 'work'
        ? <Link href={workHref(suggestion.item.work, state.scope)} lang={suggestion.item.title.language}
          className={cn(link, 'font-work-title')}>{suggestion.item.title.value}</Link>
        : <Link href={searchHref({ ...state, phrase: suggestion.name, language: null, term: null })}
          lang={suggestion.language ?? undefined} className={link}>{suggestion.name}</Link>}
    </span>)}
    {t.didYouMeanEnd}</span>;
}

/** Where an empty search can look instead: the neighbouring scope and each filter removed. */
function Widen({ state, t }: { state: SearchState; t: Text }) {
  const links = [
    ...(state.scope.kind === 'realm'
      ? [{ label: t.seeGlobal, href: searchHref({ ...state, scope: { kind: 'global' } }) }] : []),
    ...(state.language ? [{ label: t.anyLanguageAction, href: searchHref({ ...state, language: null }) }] : []),
    ...(state.term ? [{ label: t.removeClassification, href: searchHref({ ...state, term: null }) }] : []),
  ];
  return links.map(link => <Link key={link.href} href={link.href}
    className={buttonVariants({ size: 'sm', variant: 'outline' })}>{link.label}</Link>);
}

function Pages({ first, props, t }: { first: SearchResultPage; props: SearchResultsProps; t: Text }) {
  const { state, scopeLabel, signedIn, avatarQuery, locale } = props;
  const client = useQueryClient();
  const options = searchPagesOptions(state, locale, props.actingSubject, first,
    props.load ?? bffSearch(state, locale, props.actingSubject));
  const pages = useInfiniteQuery(options);
  const list = useRef<HTMLOListElement>(null);
  const loaded = pages.data?.pages ?? [first];
  // Page one as last read: a restart replaces the server's, and the counts with it.
  const current = loaded[0]!;
  const hits = loaded.flatMap(page => page.hits);
  // A later page, or page one again after a restart, may fail while the shown pages stay.
  const failed = pages.isFetchNextPageError || pages.isRefetchError;
  const failure = !failed ? null : pages.error instanceof SearchError ? pages.error.failure : 'unavailable';

  // Keep keyboard users where the new results begin, once they are on screen.
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    if (focusFrom.current === null || hits.length <= focusFrom.current) return;
    list.current?.querySelectorAll<HTMLElement>('h2 a')[focusFrom.current]?.focus();
    focusFrom.current = null;
  }, [hits.length]);
  function showMore() {
    focusFrom.current = hits.length;
    void pages.fetchNextPage();
  }
  function restart() {
    client.setQueryData(options.queryKey, data => data && { pages: data.pages.slice(0, 1),
      pageParams: data.pageParams.slice(0, 1) });
    void pages.refetch();
  }

  if (!current.total) {
    const { suggestions = [], popular = [] } = props.fallback ?? {};
    return <>
      <EmptyState icon={SearchXIcon} title={state.scope.kind === 'realm'
        ? t.emptyIn({ scope: scopeLabel, phrase: state.phrase }) : t.empty({ phrase: state.phrase })}
        description={suggestions.length ? <DidYouMean suggestions={suggestions} state={state} t={t} /> : t.emptyHelp}
        className="py-10 sm:py-12"><Widen state={state} t={t} /></EmptyState>
      {popular.length ? <WorkShelf heading={{ title: t.popularTitle, seeAll: { href: '/discover' } }} works={popular}
        avatarQuery={avatarQuery} locale={locale} /> : null}
    </>;
  }
  return <>
    <Completeness page={current} state={state} scopeLabel={scopeLabel} signedIn={signedIn} locale={locale} t={t} />
    {loaded.some(page => !page.titles) ? <Alert variant="warning">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-foreground">{t.titlesUnavailable}</AlertDescription>
    </Alert> : null}
    <ol ref={list} className="grid divide-y divide-border/70">
      {hits.map(hit => <li key={hit.matchUnit} className="py-5 first:pt-1">
        <WorkRow work={hitWork(hit, state)} avatarQuery={avatarQuery} locale={locale}>
          <Reasons hit={hit} scopeLabel={scopeLabel} locale={locale} t={t} />
        </WorkRow>
      </li>)}
    </ol>
    {failure ? <FailureNotice failure={failure} state={state} t={t}
      onRetry={() => void (pages.isRefetchError ? pages.refetch() : pages.fetchNextPage())}
      onRestart={restart} /> : null}
    {pages.hasNextPage && !failure ? <div className="flex justify-center">
      <Button variant="outline" onClick={showMore} isLoading={pages.isFetchingNextPage}
        disabled={pages.isFetching}>{pages.isFetchingNextPage ? t.loadingMore : t.showMore}</Button>
    </div> : null}
  </>;
}

/**
 * Results for the URL's search: an exact count and what was searched, each
 * Work with why it matched, and "Show more" through Main's continuation. A
 * continuation that expires or no longer follows on offers a restart.
 */
export function SearchResults(props: SearchResultsProps) {
  const { state, initial, locale, messages } = props;
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const status = phraseStatus(state.phrase);
  return <section aria-label={t.resultsRegion} aria-live="polite" className="grid min-w-0 content-start gap-4">
    {status === 'empty' || status === 'short'
      ? <EmptyState icon={SearchIcon} title={t.idleTitle} description={t.idle} /> : null}
    {status === 'long' ? <Notice icon={BanIcon} title={t.tooLong} /> : null}
    {initial && !initial.ok ? <FailureNotice failure={initial.failure} state={state} t={t}
      onRetry={() => router.refresh()} onRestart={() => router.refresh()} /> : null}
    {initial?.ok ? <Pages first={initial.page} props={props} t={t} /> : null}
  </section>;
}
