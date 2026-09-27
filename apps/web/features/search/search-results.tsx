'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button, buttonVariants } from '@rezics/ui/button';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { BanIcon, CircleSlashIcon, FileTextIcon, LibraryIcon, RefreshCwIcon, RotateCwIcon, SearchIcon, SearchXIcon,
  TagIcon, TriangleAlertIcon, UsersRoundIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { DiscoverMessages } from '../discover/messages.ts';
import { Notice } from '../discover/notice.tsx';
import { workHref } from '../discover/scope.ts';
import { WorkCard } from '../discover/work-card.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import type { SearchMessages } from './messages.ts';
import { bffSearch, SearchError, type SearchLoader, searchPagesOptions } from './query.ts';
import { phraseStatus, type SearchState, searchHref } from './state.ts';
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
  locale: UiLocale;
  messages: SearchMessages;
  discoverMessages: DiscoverMessages;
}

function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/** What was searched and how complete the answer is: exact count, scope, filters, exclusions, index position. */
function Completeness({ page, state, scopeLabel, signedIn, locale, t }: {
  page: SearchResultPage; state: SearchState; scopeLabel: string; signedIn: boolean; locale: UiLocale; t: Text;
}) {
  const parts = [t.searched({ count: page.population, scope: scopeLabel }),
    ...(state.language ? [t.onlyLanguage({ language: languageName(state.language, locale) })] : []),
    ...(state.term ? [t.onlyTerm] : []), ...(signedIn ? [t.mutes] : []),
    t.freshness({ sequence: page.sequence })];
  return <p className="text-pretty text-muted-foreground text-sm" data-testid="search-completeness">
    <span className="font-medium text-foreground">{t.countExact(page.total)}</span>
    {parts.map(part => <span key={part}> · {part}</span>)}
  </p>;
}

function Reasons({ hit, scopeLabel, locale, t }: { hit: SearchHit; scopeLabel: string; locale: UiLocale; t: Text }) {
  const { reasons } = hit;
  const term = reasons.classification?.conceptName;
  const items: { icon: typeof FileTextIcon; text: ReactNode }[] = [
    { icon: FileTextIcon, text: t.textMatch({ language: languageName(reasons.language, locale) }) },
    ...(reasons.realm ? [{ icon: UsersRoundIcon, text: reasons.realm === 'realm-adoption'
      ? t.realmAdopted({ realm: scopeLabel }) : t.realmFallback({ realm: scopeLabel }) }] : []),
    ...(reasons.classification ? [{ icon: TagIcon, text: <span lang={term?.language}>
      {reasons.classification.source === 'local'
        ? t.classifiedLocal({ term: term?.value ?? t.thisTerm, realm: scopeLabel })
        : t.classifiedGlobal({ term: term?.value ?? t.thisTerm })}</span> }] : []),
  ];
  return <ul aria-label={t.reasons} className="grid gap-1 text-muted-foreground">
    {items.map((item, index) => <li key={index} className="flex items-start gap-2">
      <item.icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span>{item.text}</span></li>)}
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

/** Where an empty search can look instead: the neighbouring scope and each filter removed. */
function Widen({ state, t }: { state: SearchState; t: Text }) {
  const links = [
    ...(state.scope.kind === 'realm' ? [{ label: t.seeGlobal, href: searchHref({ ...state, scope: { kind: 'global' } }) }] : []),
    ...(state.language ? [{ label: t.anyLanguageAction, href: searchHref({ ...state, language: null }) }] : []),
    ...(state.term ? [{ label: t.removeClassification, href: searchHref({ ...state, term: null }) }] : []),
  ];
  return links.map(link => <Link key={link.href} href={link.href}
    className={buttonVariants({ size: 'sm', variant: 'outline' })}>{link.label}</Link>);
}

function Pages({ first, props, t }: { first: SearchResultPage; props: SearchResultsProps; t: Text }) {
  const { state, scopeLabel, signedIn, avatarQuery, locale, discoverMessages } = props;
  const client = useQueryClient();
  const options = searchPagesOptions(state, locale, first,
    props.load ?? bffSearch(state, locale, props.actingSubject));
  const pages = useInfiniteQuery(options);
  const list = useRef<HTMLOListElement>(null);
  const loaded = pages.data?.pages ?? [first];
  const hits = loaded.flatMap(page => page.hits);
  const failure = !pages.isFetchNextPageError ? null
    : pages.error instanceof SearchError ? pages.error.failure : 'unavailable';

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

  if (!first.total) {
    return <>
      <Completeness page={first} state={state} scopeLabel={scopeLabel} signedIn={signedIn} locale={locale} t={t} />
      <EmptyState icon={SearchXIcon} title={t.empty({ scope: scopeLabel, phrase: state.phrase })}
        description={t.emptyHelp}><Widen state={state} t={t} /></EmptyState>
    </>;
  }
  return <>
    <Completeness page={first} state={state} scopeLabel={scopeLabel} signedIn={signedIn} locale={locale} t={t} />
    {loaded.some(page => !page.titles) ? <Alert variant="warning">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-foreground">{t.titlesUnavailable}</AlertDescription>
    </Alert> : null}
    <ol ref={list} className="grid gap-3">
      {hits.map(hit => <li key={hit.matchUnit}>
        <WorkCard layout="row" headingLevel={2} work={hit.work} title={hit.title} cover={hit.cover} types={[]}
          href={workHref(hit.work, state.scope)} scopeLabel={scopeLabel} avatarQuery={avatarQuery} locale={locale}
          messages={discoverMessages}>
          <Reasons hit={hit} scopeLabel={scopeLabel} locale={locale} t={t} />
        </WorkCard>
      </li>)}
    </ol>
    {failure ? <FailureNotice failure={failure} state={state} t={t} onRetry={() => void pages.fetchNextPage()}
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
