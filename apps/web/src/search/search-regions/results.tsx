import { SearchCoverage } from '../search-context/coverage';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { cn } from '@rezics/ui/utils';
import { locales } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { ResultList } from '../results.tsx';
import { SearchSort } from '../sort.tsx';
import { type LegacySearchPage } from '../discovery';
import { SearchRecovery } from '../search-recovery-view';
import { EmptySearchRecovery } from '../empty-recovery';
import { discoverySearchHref, type SearchLoaderDeps } from '../search-params';
import { ResultKindNavigation } from '../result-kind-navigation';
import { DiscoveryResults } from '../discovery-results';
import { realmCatalogueSubjectHref } from '../realm-catalogue-handoff';
import { SearchWindowControls } from '../search-window';
import type { SearchWindowNavigation } from '../search-window';

import type { SearchPageData } from '../search';
import type { useSearchRetryFocus } from '../search-retry-focus';
import type { useDiscoveryPersonalResults } from '../discovery-personal-host';
type ResultData = Pick<
  SearchPageData,
  | 'queryState'
  | 'sort'
  | 'ratingPopulations'
  | 'ratingReadiness'
  | 'discovery'
  | 'recovery'
  | 'staleCursorRestarted'
  | 'facetRetry'
  | 'facetIndexNotReady'
  | 'typeLabels'
  | 'typeChoices'
  | 'selectedFacetLabels'
  | 'groups'
  | 'yearProperties'
  | 'conditionMetadata'
  | 'hitTypes'
  | 'ranges'
  | 'condition'
>;
export type SearchResultsRegionProps = {
  query: string;
  result?: LegacySearchPage | undefined;
  locale: string;
  type?: string | undefined;
  selectedFacets: Record<string, string[]>;
  data?: ResultData | undefined;
  continuationAllowed?: boolean;
  invalid?: boolean;
  onRetry?: (() => void) | undefined;
  retryState?: SearchLoaderDeps | undefined;
  retryFocus?: Pick<ReturnType<typeof useSearchRetryFocus>, 'regionRef' | 'retryRef' | 'captureRetryFocus'>;
  currentSearchHref?: string | undefined;
  windowNavigation?: SearchWindowNavigation | undefined;
  personal?: Pick<ReturnType<typeof useDiscoveryPersonalResults>, 'regionRef' | 'renderPersonal'>;
};
const linkClass = cn(buttonVariants({ variant: 'link' }), 'h-auto justify-start p-0');
function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}
function searchHref(
  locale: string,
  query: string,
  type: string | undefined,
  facets: Record<string, string[]>,
  cursor?: string,
  sort?: 'rating',
  state?: SearchLoaderDeps,
): string {
  return discoverySearchHref(locale, { ...state, query, type, facets, cursor, sort });
}

/** Presentation consumes the host's executed page and retired reader-owned actions. */
export function SearchResultsRegion({
  query,
  result,
  locale,
  type,
  selectedFacets,
  data,
  continuationAllowed = true,
  invalid = false,
  onRetry,
  retryState = data?.queryState,
  retryFocus,
  currentSearchHref,
  personal,
  windowNavigation,
}: SearchResultsRegionProps) {
  if (!result && !data?.discovery && !data?.recovery) return null;
  const options = messageOptions(locale);
  const subjectHrefFor = currentSearchHref
    ? (subject: { id: string; label: string }) => realmCatalogueSubjectHref(subject, locale, currentSearchHref)
    : undefined;
  const next =
    continuationAllowed && (!data?.recovery || data.recovery.status === 'ready')
      ? data?.discovery?.status === 'ready'
        ? data.discovery.page.next
        : result?.next
      : undefined;
  return (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{m.search_results({}, options)}</p>
          <SearchSort
            sort={data?.sort ?? 'relevance'}
            locale={locale}
            query={query}
            type={type}
            facets={selectedFacets}
            state={retryState}
            ratingPopulations={data?.ratingPopulations}
            ratingPopulation={retryState?.ratingPopulation}
            ratingReadiness={data?.ratingReadiness}
            disabled={invalid}
          />
        </div>
        {data?.queryState && !result && (
          <ResultKindNavigation
            kinds={data.discovery?.status === 'ready' ? data.discovery.page.kinds : undefined}
            state={data.queryState}
            locale={locale}
            disabled={invalid}
          />
        )}
      </div>
      {data?.queryState &&
        (data.discovery?.status === 'ready' || result) &&
        (!data.recovery || data.recovery.status === 'ready') && (
          <SearchCoverage
            state={retryState ?? data.queryState}
            data={data}
            observation={data.discovery?.status === 'ready' ? data.discovery.page : result!}
            locale={locale}
            refreshHref={discoverySearchHref(locale, { ...(retryState ?? data.queryState), cursor: undefined })}
            onRefresh={onRetry}
            refreshRef={retryFocus?.retryRef}
            onFocus={retryFocus?.captureRetryFocus}
          />
        )}
      {data?.staleCursorRestarted && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_stale_cursor_restarted({}, options)}
        </p>
      )}
      {data?.facetRetry && (
        <p role="status" className="text-sm text-muted-foreground">
          {data.facetIndexNotReady
            ? m.search_reader_facets_not_ready({}, options)
            : m.search_reader_facets_unavailable({}, options)}{' '}
          <a
            className={linkClass}
            href={searchHref(
              locale,
              query,
              type,
              selectedFacets,
              undefined,
              data.sort === 'rating' ? 'rating' : undefined,
              data.queryState,
            )}
          >
            {m.search_facet_retry({}, options)}
          </a>
        </p>
      )}
      {data?.queryState && (
        <SearchWindowControls
          window={windowNavigation}
          cursor={data.queryState.cursor}
          query={data.queryState.query}
          locale={locale}
          next={next}
          enabled={continuationAllowed && !invalid && data.recovery?.status !== 'loading'}
        />
      )}
      <section
        id="search-results"
        ref={(element) => {
          if (retryFocus) retryFocus.regionRef.current = element;
          if (personal) personal.regionRef.current = element;
          if (windowNavigation) windowNavigation.regionRef.current = element;
        }}
        tabIndex={-1}
        aria-label={m.search_results({}, options)}
        data-search-results
      >
        {data?.recovery &&
        data.recovery.status !== 'ready' &&
        data.queryState &&
        !(
          ['loading', 'sparse', 'exhausted', 'index-not-ready', 'source-not-ready', 'unavailable'].includes(
            data.recovery.status,
          ) &&
          (data.discovery || result)
        ) ? (
          <SearchRecovery
            state={data.recovery}
            retryHref={discoverySearchHref(locale, retryState ?? data.queryState)}
            restartHref={discoverySearchHref(locale, { ...data.queryState, cursor: undefined })}
            onRetry={onRetry}
            locale={locale}
            {...(retryFocus ? { retryRef: retryFocus.retryRef, onRetryFocus: retryFocus.captureRetryFocus } : {})}
          />
        ) : data?.discovery ? (
          <>
            {data.recovery && data.recovery.status !== 'ready' ? (
              <SearchRecovery
                state={data.recovery}
                retryHref={discoverySearchHref(locale, retryState ?? data.queryState!)}
                restartHref={discoverySearchHref(locale, { ...data.queryState!, cursor: undefined })}
                onRetry={onRetry}
                locale={locale}
                {...(retryFocus ? { retryRef: retryFocus.retryRef, onRetryFocus: retryFocus.captureRetryFocus } : {})}
              />
            ) : null}
            <DiscoveryResults
              state={data.discovery}
              renderPersonal={personal?.renderPersonal}
              locale={locale}
              yearProperties={data.yearProperties}
              factDefinitions={data.conditionMetadata?.properties}
              subjectHrefFor={subjectHrefFor}
              restartHref={
                data.queryState ? discoverySearchHref(locale, { ...data.queryState, cursor: undefined }) : undefined
              }
            />
            {data.recovery?.status === 'ready' &&
            data.queryState &&
            data.discovery.status === 'ready' &&
            data.discovery.page.hits.length === 0 &&
            data.discovery.page.next === null &&
            data.queryState.cursor === undefined &&
            data.discovery.page.emptyRecovery ? (
              <EmptySearchRecovery
                recovery={data.discovery.page.emptyRecovery}
                state={data.queryState}
                locale={locale}
                labels={{
                  typeLabels: data.typeLabels ?? {},
                  typeChoices: data.typeChoices,
                  selectedFacetLabels: data.selectedFacetLabels,
                  groups: data.groups,
                }}
                onRetry={onRetry}
              />
            ) : null}
          </>
        ) : result?.subjects.length === 0 ? (
          <>
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle className="text-base font-normal">{m.search_no_results({}, options)}</EmptyTitle>
              </EmptyHeader>
            </Empty>
            {data?.queryState &&
            data.queryState.cursor === undefined &&
            result.next === null &&
            result.emptyRecovery ? (
              <EmptySearchRecovery
                recovery={result.emptyRecovery}
                state={data.queryState}
                locale={locale}
                labels={{
                  typeLabels: data.typeLabels ?? {},
                  typeChoices: data.typeChoices,
                  selectedFacetLabels: data.selectedFacetLabels,
                  groups: data.groups,
                }}
                onRetry={onRetry}
              />
            ) : null}
          </>
        ) : (
          <>
            <ResultList
              hits={result?.subjects ?? []}
              locale={locale}
              hitTypes={data?.hitTypes ?? {}}
              yearProperties={data?.yearProperties ?? []}
              factDefinitions={data?.conditionMetadata?.properties}
              subjectHrefFor={subjectHrefFor}
            />
          </>
        )}
      </section>
    </>
  );
}
