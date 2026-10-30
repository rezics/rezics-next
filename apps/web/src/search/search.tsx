import { facetProperties, FILTER_LIMITS, parseFilter, type FilterDocument, type FilterRange } from '@rezics/filter';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { KernelClient } from '@rezics/client';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { SlidersHorizontalIcon } from 'lucide-react';
import { cn } from '@rezics/ui/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { kernelClient } from '../kernel/client.ts';
import { requestLanguages } from '../kernel/languages.ts';
import { readRelease, type Release } from '../subject/definitions.ts';
import { PageHeading } from '../shell/page-heading';
import { localizedLabel, ResultList, type Fact, type ResultHit } from './results.tsx';
import { SearchSort } from './sort.tsx';
import { readSearchPage } from './search-request.ts';
import { compileRefinement, refinementHref, refinementProperties } from './refinement/model';
import { facetRequest, readFacetPage, facetProblem, refinementKey, type FacetState } from './refinement/request';
import { Refinement, type RefinementData } from './refinement/refinement';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { readDiscovery, type DiscoveryState } from './discovery';
import { DiscoveryResults } from './discovery-results';
import { useRegisterHeaderSearchFilters } from './header-search/filter-region';
type SearchBody = Parameters<KernelClient['subjects']['$search']['post']>[0] & {
  descriptions?: boolean;
  languages?: string[];
  properties?: string[];
};
type SearchData = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;
type SearchResult = Omit<SearchData, 'subjects'> & {
  subjects: (SearchData['subjects'][number] & {
    descriptions?: Record<string, string>;
    facts?: Record<string, Fact[]>;
  } & Pick<ResultHit, 'summary' | 'figure' | 'storyOverlay'>)[];
};
type SearchParams = {
  query: string;
  locale: string;
  cursor?: string;
  sort?: 'rating';
  type?: string;
  facetValues: Record<string, string[]>;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument;
};
type SearchPageData = {
  refinement?: RefinementData;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument;
  result?: SearchResult;
  discovery?: DiscoveryState;
  type?: string;
  typeLabels?: Record<string, string>;
  hitTypes: Record<string, Record<string, string>>;
  /** The properties whose time values give a hit its year, in the order the search asked for them. */
  yearProperties: string[];
  typeChoices: { id: string; labels: Record<string, string> }[];
  groups: {
    property: string;
    labels: Record<string, string>;
    values: {
      value: string;
      labels: Record<string, string>;
      parentTypeLabels?: Record<string, string>;
    }[];
  }[];
  selectedFacets: Record<string, string[]>;
  selectedFacetLabels: Record<string, Record<string, string>>;
  facetsAvailable: boolean;
  facetRetry: boolean;
  facetIndexNotReady: boolean;
  staleCursorRestarted: boolean;
  sort: 'relevance' | 'rating';
};
/** At most this many facet properties are asked for on a single-type search. */
const FACT_PROPERTIES = 2;
/** At most this many time properties are asked for to give hits their year. */
const YEAR_PROPERTIES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allowedType(release: Release, type: unknown): type is string {
  return typeof type === 'string' && Object.hasOwn(release.types, type) && isRecord(release.types[type]);
}

/** Properties whose values a result row can show: items, years, quantities and codes with a declared pattern. */
function factProperties(release: Release, type: string): string[] {
  return facetProperties(release, [type])
    .filter((property) => {
      const definition = Object.hasOwn(release.properties, property) ? release.properties[property] : undefined;
      if (!definition) return false;
      if (['wikibase-item', 'time', 'quantity'].includes(definition.datatype)) return true;
      return definition.datatype === 'string' && !!definition.value?.pattern;
    })
    .slice(0, FACT_PROPERTIES);
}

/**
 * Time properties that give a hit its year: the type's own first one, or on a search across types the first of
 * every returnable type, so each result can show a year without more than four properties in the request.
 */
function yearProperties(release: Release, type?: string): string[] {
  const candidates = type
    ? facetProperties(release, [type])
    : Object.keys(release.types).flatMap((id) => facetProperties(release, [id]));
  const found = new Set<string>();
  for (const property of candidates) {
    if (found.size >= (type ? 1 : YEAR_PROPERTIES)) break;
    const definition = Object.hasOwn(release.properties, property) ? release.properties[property] : undefined;
    if (definition?.datatype === 'time') found.add(property);
  }
  return [...found];
}

const readSearchWithLocale = createServerFn({ method: 'GET' })
  .validator((input: unknown): SearchParams => {
    if (!isRecord(input) || typeof input.query !== 'string' || input.query.length > 256)
      throw new Error('Invalid search');
    if (typeof input.locale !== 'string' || input.locale.length === 0 || input.locale.length > 35)
      throw new Error('Invalid locale');
    if (input.cursor !== undefined && typeof input.cursor !== 'string') throw new Error('Invalid cursor');
    if (input.sort !== undefined && input.sort !== 'rating') throw new Error('Invalid sort');
    if (input.type !== undefined && typeof input.type !== 'string') throw new Error('Invalid type');
    const facetValues: Record<string, string[]> = Object.create(null);
    if (isRecord(input.facetValues)) {
      for (const [property, values] of Object.entries(input.facetValues)) {
        if (
          !Array.isArray(values) ||
          values.length > FILTER_LIMITS.in ||
          values.some((value) => typeof value !== 'string')
        )
          throw new Error('Invalid facet values');
        facetValues[property] = values;
      }
    }
    return {
      query: input.query,
      locale: input.locale,
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
      ...(input.sort === 'rating' ? { sort: 'rating' as const } : {}),
      ...(typeof input.type === 'string' ? { type: input.type } : {}),
      facetValues,
      ...(isRecord(input.ranges)
        ? {
            ranges: Object.fromEntries(
              Object.entries(input.ranges).map(([property, range]) => {
                const parsed = parseFilter({ statement: { property, range } });
                if (!('statement' in parsed) || !('range' in parsed.statement)) throw new Error('Invalid range');
                return [property, parsed.statement.range];
              }),
            ),
          }
        : {}),
      ...(input.condition ? { condition: parseFilter(input.condition) } : {}),
    };
  })
  .handler(async ({ data }): Promise<SearchPageData> => {
    const signal = getRequest().signal;
    let release: Release | undefined;
    try {
      release = await readRelease();
    } catch {
      release = undefined;
    }

    const type = release && allowedType(release, data.type) ? data.type : undefined;
    if (data.type && !type) throw new Error('Unsupported search type');
    const filter = release ? compileRefinement(release, data) : undefined;
    if (!release && (data.condition || Object.keys(data.facetValues).length || Object.keys(data.ranges ?? {}).length))
      throw new Error('Definitions unavailable');
    const hasSearch = data.query.length > 0 || type !== undefined || filter !== undefined;
    const languages = requestLanguages(data.locale);
    const years = release ? yearProperties(release, type) : [];
    const properties = release ? [...new Set([...(type ? factProperties(release, type) : []), ...years])] : [];
    let staleCursorRestarted = false;
    const searchPromise: Promise<{ result?: SearchResult; discovery?: DiscoveryState }> = hasSearch
      ? (async () => {
          const body: SearchBody = {
            ...(data.query ? { text: data.query } : {}),
            limit: 100,
            descriptions: true,
            languages,
            ...(properties.length > 0 ? { properties } : {}),
            ...(data.cursor ? { cursor: data.cursor } : {}),
            ...(data.sort ? { sort: data.sort } : {}),
            ...(filter ? { filter } : {}),
          };
          if (!type) {
            const mixed = await readDiscovery({ ...body, representation: 'discovery-v1', languages }, (request) =>
              kernelClient(data.locale).subjects.$search.post(request, { fetch: { signal } }),
            );
            staleCursorRestarted = mixed.restarted;
            return { discovery: mixed.discovery };
          }
          const { response, restarted } = await readSearchPage(body, (request) =>
            kernelClient(data.locale).subjects.$search.post(request, { fetch: { signal } }),
          );
          staleCursorRestarted = restarted;
          if (response.error) throw new Error('Search failed');
          return { result: response.data as SearchResult };
        })()
      : Promise.resolve({});

    const roster = release ? refinementProperties(release, type ?? data.facetValues.type) : [];
    const requestedFacets = roster
      .slice(0, 8)
      .filter((entry) => entry.mode === 'values' || entry.mode === 'types')
      .map(({ property }) => ({ property, size: 10 }));
    const facetsPromise: Promise<FacetState | undefined> = requestedFacets.length
      ? readFacetPage(
          facetRequest(
            { ...(data.query ? { text: data.query } : {}), ...(filter ? { filter } : {}), languages },
            requestedFacets,
          ),
          (body) => kernelClient(data.locale).subjects.$facets.post(body, { fetch: { signal } }),
        ).catch((error): FacetState => {
          if (signal.aborted) throw error;
          if (isPlatformClosedError(error))
            return {
              status: 'refused',
              code: 'platform_closed',
              httpStatus: error.status,
              problem: facetProblem(error.problem),
            };
          return { status: 'unavailable', code: error instanceof Error ? error.name : 'transport_error' };
        })
      : Promise.resolve(undefined);

    const [{ result, discovery }, facetResult] = await Promise.all([searchPromise, facetsPromise]);
    // Mixed kind metadata belongs to the single result response. Do not probe global Subject counts.
    const typeChoices =
      discovery?.status === 'ready' && release
        ? discovery.page.kinds.values
            .filter((kind) => allowedType(release, kind.id))
            .map((kind) => ({ id: kind.id, labels: kind.labels }))
        : [];
    const hitTypes: Record<string, Record<string, string>> = {};
    if (release)
      for (const subject of result?.subjects ?? [])
        if (allowedType(release, subject.type)) hitTypes[subject.type] = release.types[subject.type]?.labels ?? {};
    return {
      ...(result ? { result } : {}),
      ...(discovery ? { discovery } : {}),
      ...(type ? { type } : {}),
      ...(type && release ? { typeLabels: release.types[type]?.labels ?? {} } : {}),
      hitTypes,
      yearProperties: years,
      typeChoices,
      groups: [],
      ...(release
        ? {
            refinement: {
              key: refinementKey({
                principal: 'anonymous',
                languages,
                release: release.digest!,
                source: 'public-global',
                text: data.query,
                ...(filter ? { filter } : {}),
              }),
              properties: roster,
              ...(facetResult ? { initial: facetResult } : {}),
            },
          }
        : {}),
      ...(data.ranges ? { ranges: data.ranges } : {}),
      ...(data.condition ? { condition: data.condition } : {}),
      selectedFacets: data.facetValues,
      selectedFacetLabels: Object.fromEntries(
        Object.keys(data.facetValues).map((property) => [property, release?.properties[property]?.labels ?? {}]),
      ),
      facetsAvailable: release !== undefined,
      facetRetry: false,
      facetIndexNotReady: facetResult?.status === 'preparing',
      staleCursorRestarted,
      sort: data.sort ?? 'relevance',
    };
  });

function searchHref(
  locale: string,
  query: string,
  type: string | undefined,
  facets: Record<string, string[]>,
  cursor?: string,
  sort?: 'rating',
  ranges?: Record<string, FilterRange>,
  condition?: FilterDocument,
): string {
  return refinementHref(
    locale,
    query,
    {
      ...(type ? { type } : {}),
      facetValues: facets,
      ...(ranges ? { ranges } : {}),
      ...(condition ? { condition } : {}),
    },
    sort,
    cursor,
  );
}

const linkClass = cn(buttonVariants({ variant: 'link' }), 'h-auto justify-start p-0');

export function SearchPage({
  query,
  cursor,
  data,
  filtersOnly = false,
  initiallyOpen = false,
}: {
  query: string;
  cursor?: string;
  data?: SearchPageData;
  filtersOnly?: boolean;
  initiallyOpen?: boolean;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [desktopFiltersOpen, setDesktopFiltersOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const locale = getLocale();
  const type = data?.type;
  const result = data?.result;
  const discovery = data?.discovery;
  const selectedFacets = data?.selectedFacets ?? {};
  const number = new Intl.NumberFormat(locale);
  const activeFilterCount =
    (type ? 1 : 0) +
    Object.values(selectedFacets).reduce((sum, values) => sum + values.length, 0) +
    Object.keys(data?.ranges ?? {}).length +
    (data?.condition ? 1 : 0);
  useEffect(() => setHydrated(true), []);
  const desktopPanel = useRef<HTMLDivElement>(null);
  const openFilters = useCallback(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      setDesktopFiltersOpen(true);
      requestAnimationFrame(() =>
        desktopPanel.current
          ?.querySelector<HTMLElement>('a[href], input:not([type="hidden"]), button:not(:disabled)')
          ?.focus(),
      );
    } else setMobileFiltersOpen(true);
  }, []);
  useEffect(() => {
    if (initiallyOpen) openFilters();
  }, [initiallyOpen, openFilters]);

  const typeLabel = type
    ? localizedLabel(data?.typeLabels ?? data?.typeChoices.find((choice) => choice.id === type)?.labels ?? {}, locale)
    : undefined;
  const hasFilterPanel = Boolean(data?.refinement?.properties.length || data?.typeChoices.length || type);
  const filterRegion = useMemo(
    () => ({ activeCount: activeFilterCount, open: openFilters }),
    [activeFilterCount, openFilters],
  );
  useRegisterHeaderSearchFilters(hasFilterPanel, filterRegion);
  const results = renderResults(query, result, locale, type, selectedFacets, data);

  const filterContents = (surface: 'desktop' | 'mobile') => (
    <div className="space-y-5 pt-3 lg:pt-0">
      <input type="hidden" name="q" value={query} />
      {type && <input type="hidden" name="type" value={type} />}
      {data?.sort === 'rating' && <input type="hidden" name="sort" value="rating" />}
      {type && (
        <section className="space-y-3">
          <h2 className="font-medium">
            {m.search_type()}: <span lang={typeLabel?.lang}>{typeLabel?.text || type}</span>
          </h2>
          <a
            className={linkClass}
            href={refinementHref(
              locale,
              query,
              {
                facetValues: selectedFacets,
                ...(data?.ranges ? { ranges: data.ranges } : {}),
                ...(data?.condition ? { condition: data.condition } : {}),
              },
              data?.sort === 'rating' ? 'rating' : undefined,
            )}
          >
            {m.search_clear_type()}
          </a>
        </section>
      )}
      {!type && data?.typeChoices.length ? (
        <section className="space-y-3">
          <h2 className="font-medium">{m.search_types()}</h2>
          <ul className="space-y-2">
            {data.typeChoices.map((choice) => (
              <li key={choice.id}>
                <a
                  className={linkClass}
                  href={refinementHref(
                    locale,
                    query,
                    {
                      type: choice.id,
                      facetValues: selectedFacets,
                      ...(data.ranges ? { ranges: data.ranges } : {}),
                      ...(data.condition ? { condition: data.condition } : {}),
                    },
                    data.sort === 'rating' ? 'rating' : undefined,
                  )}
                >
                  {localizedLabel(choice.labels, locale).text || choice.id}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data?.refinement && (
        <Refinement
          key={`${surface}-${data.refinement.key}`}
          data={data.refinement}
          conditions={{
            ...(type ? { type } : {}),
            facetValues: selectedFacets,
            ...(data.ranges ? { ranges: data.ranges } : {}),
            ...(data.condition ? { condition: data.condition } : {}),
          }}
          query={query}
          locale={locale}
          {...(data.sort === 'rating' ? { sort: 'rating' as const } : {})}
        />
      )}
      {data?.condition && <input type="hidden" name="condition" value={JSON.stringify(data.condition)} />}
      {Object.entries(data?.ranges ?? {}).map(([property, range]) => (
        <input key={property} type="hidden" name={`r.${property}`} value={JSON.stringify(range)} />
      ))}
      <Button type="submit" variant="outline" hidden={hydrated}>
        {m.search_apply()}
      </Button>
    </div>
  );

  const filterControls = (
    <>
      <form
        id="desktop-filter-form"
        method="get"
        action={`/${locale}/search`}
        className="hidden lg:block lg:col-start-1 lg:row-start-1"
      >
        <Collapsible
          open={!hydrated || desktopFiltersOpen}
          onOpenChange={setDesktopFiltersOpen}
          className={cn((!hydrated || desktopFiltersOpen) && 'rounded-xl border border-border/60 p-4')}
        >
          <CollapsibleTrigger className="hidden">{m.search_filters()}</CollapsibleTrigger>
          <CollapsibleContent>
            <div ref={desktopPanel}>{filterContents('desktop')}</div>
          </CollapsibleContent>
        </Collapsible>
      </form>
      <button
        type="button"
        className={`${buttonVariants({ variant: 'outline' })} w-fit gap-2 border-border lg:hidden`}
        style={{ borderColor: 'color-mix(in oklch, var(--border), var(--foreground) 35%)' }}
        aria-label={`${m.search_filters()} (${number.format(activeFilterCount)})`}
        onClick={() => setMobileFiltersOpen(true)}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
        {m.search_filters()} ({number.format(activeFilterCount)})
      </button>
      <BottomSheet
        open={mobileFiltersOpen}
        onOpenChange={setMobileFiltersOpen}
        title={`${m.search_filters()} (${number.format(activeFilterCount)})`}
      >
        <form id="mobile-filter-form" method="get" action={`/${locale}/search`}>
          {filterContents('mobile')}
        </form>
      </BottomSheet>
    </>
  );

  if (filtersOnly) {
    if (!hasFilterPanel) return null;
    return <div className="w-full">{filterControls}</div>;
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.search_heading()}</PageHeading>
      {hasFilterPanel ? (
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          {filterControls}
          <div className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-1">{results}</div>
        </div>
      ) : (
        results
      )}
    </section>
  );
}

function renderResults(
  query: string,
  result: SearchResult | undefined,
  locale: string,
  type: string | undefined,
  selectedFacets: Record<string, string[]>,
  data: SearchPageData | undefined,
) {
  if (!result && !data?.discovery) return null;
  const next = data?.discovery?.status === 'ready' ? data.discovery.page.next : result?.next;
  return (
    <>
      {data?.sort === 'rating' && (
        <p className="text-sm text-muted-foreground">{m.rating_public_ordering({}, { locale: locale as never })}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{m.search_results()}</p>
        <SearchSort
          sort={data?.sort ?? 'relevance'}
          locale={locale}
          query={query}
          type={type}
          facets={selectedFacets}
        />
      </div>
      {data?.staleCursorRestarted && (
        <p role="status" className="text-sm text-muted-foreground">
          {m.search_stale_cursor_restarted()}
        </p>
      )}
      {data?.facetRetry && (
        <p role="status" className="text-sm text-muted-foreground">
          {data.facetIndexNotReady ? m.search_facet_index_not_ready() : m.search_facet_unavailable()}{' '}
          <a
            className={linkClass}
            href={searchHref(
              locale,
              query,
              type,
              selectedFacets,
              undefined,
              data.sort === 'rating' ? 'rating' : undefined,
            )}
          >
            {m.search_facet_retry()}
          </a>
        </p>
      )}
      {data?.discovery ? (
        <DiscoveryResults state={data.discovery} locale={locale} />
      ) : result?.subjects.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle className="text-base font-normal">{m.search_no_results()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <ResultList
            hits={result?.subjects ?? []}
            locale={locale}
            hitTypes={data?.hitTypes ?? {}}
            yearProperties={data?.yearProperties ?? []}
          />
        </>
      )}
      {next && (
        <a
          href={searchHref(
            locale,
            query,
            type,
            selectedFacets,
            next,
            data?.sort === 'rating' ? 'rating' : undefined,
            data?.ranges,
            data?.condition,
          )}
          className={buttonVariants({ variant: 'outline' })}
        >
          {m.search_more()}
        </a>
      )}
    </>
  );
}

/** The route's loader call; the page locale travels with the request so the server asks for the right languages. */
function readSearch({
  data,
  locale = getLocale(),
  signal,
}: {
  data: Omit<SearchParams, 'locale'>;
  locale?: string;
  signal?: AbortSignal;
}): Promise<SearchPageData> {
  return readSearchWithLocale({ data: { ...data, locale }, ...(signal ? { signal } : {}) });
}

export { readSearch };

// Retain current callers while the reusable region owns the only query implementation.
export { ShellSearch } from './header-search/shell-search';
export { ScopeChip } from './header-search/scope-chip';
export type { SearchScope, SearchScopeKind } from './header-search/types';
