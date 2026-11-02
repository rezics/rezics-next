import { facetProperties, FILTER_LIMITS, parseFilter, type FilterDocument, type FilterRange } from '@rezics/filter';
import * as v from 'valibot';
import { Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { SlidersHorizontalIcon, XIcon } from 'lucide-react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { cn } from '@rezics/ui/utils';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getLocale, locales } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { kernelClient } from '../kernel/client.ts';
import { requestLanguages } from '../kernel/languages.ts';
import { readRelease, type Release } from '../subject/definitions.ts';
import { PageHeading } from '../shell/page-heading';
import { localizedLabel, ResultList } from './results.tsx';
import { SearchSort } from './sort.tsx';
import { discoveryRequest } from './search-request.ts';
import { refinementProperties } from './refinement/model';
import { facetRequest, readFacetPage, facetProblem, refinementKey, type FacetState } from './refinement/request';
import { Refinement, type RefinementData } from './refinement/refinement';
import { readRefinement } from './refinement/server';
import { createRangeDraftState, updateRangeDraft, type RangeDraft } from './refinement/range-draft';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { readDiscoveryKinds, type LegacySearchPage, type DiscoveryState } from './discovery';
import {
  facetSearchInvalidation,
  readSearchOutcome,
  searchPageForRecovery,
  searchRecoveryFromResponse,
  type SearchRecoveryState,
} from './search-recovery';
import { SearchRecovery } from './search-recovery-view';
import { useSearchRetryFocus } from './search-retry-focus';
import { discoverySearchHref, searchParams, type SearchLoaderDeps } from './search-params';
import { hasResultSearchIntent } from './search-intent';
import { DiscoveryKinds } from './discovery-kinds';
import { ResultKindNavigation } from './result-kind-navigation';
import { DiscoveryResults } from './discovery-results';
import { useRegisterHeaderSearchFilters } from './header-search/filter-region';
import { ConditionEditor } from './condition-editor';
import { SearchRealmDiscovery } from './realm-discovery';
import { isRealmDiscoverySearch, type RealmDiscoveryReader } from './realm-discovery-loader';
import type { RealmDiscoveryState } from '../community/realm-discovery';
import {
  conditionAdmission,
  conditionMetadata,
  conditionSearchState,
  type ConditionMetadata,
  type SearchProblem,
} from './condition-editor-model';
import { createFilterDraft, resetFilterDraft } from './filter-draft-reset';
import { useFilterSurfaceFocus } from './filter-surface-focus';
type SearchResult = LegacySearchPage;
type SearchParams = {
  query: string;
  locale: string;
  cursor?: string | undefined;
  sort?: 'rating' | undefined;
  type?: string | undefined;
  kinds?: string[] | undefined;
  languages?: string[] | undefined;
  filter?: string | undefined;
  representation?: 'subjects-v1';
  kindCursor?: string;
  facetValues: Record<string, string[]>;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument | undefined;
};
export type SearchPageData = {
  recovery?: SearchRecoveryState;
  conditionMetadata?: ConditionMetadata;
  problem?: SearchProblem;
  queryState?: SearchLoaderDeps;
  refinement?: RefinementData;
  ranges?: Record<string, FilterRange>;
  condition?: FilterDocument | undefined;
  result?: SearchResult;
  discovery?: DiscoveryState;
  type?: string | undefined;
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

function validateSearchInput(input: unknown): SearchParams {
  if (
    !isRecord(input) ||
    typeof input.query !== 'string' ||
    typeof input.locale !== 'string' ||
    !input.locale ||
    input.locale.length > 35
  )
    throw new Error('Invalid search');
  const parsed = v.parse(searchParams, {
    q: input.query,
    type: input.type,
    cursor: input.cursor,
    sort: input.sort,
    kinds: input.kinds,
    language: input.languages,
    filter: input.filter,
  });
  if (input.kindCursor !== undefined && (typeof input.kindCursor !== 'string' || input.kindCursor.length > 4864))
    throw new Error('Invalid kind cursor');
  const facetValues: Record<string, string[]> = Object.create(null);
  if (isRecord(input.facetValues)) {
    if (Object.keys(input.facetValues).length > FILTER_LIMITS.leaves) throw new Error('Invalid facets');
    for (const [property, values] of Object.entries(input.facetValues)) {
      if (
        !Array.isArray(values) ||
        values.length > FILTER_LIMITS.in ||
        !values.every((value) => typeof value === 'string')
      )
        throw new Error('Invalid facet');
      facetValues[property] = values;
    }
  }
  return {
    query: parsed.q,
    locale: input.locale,
    type: parsed.type,
    cursor: parsed.cursor,
    sort: parsed.sort,
    kinds: parsed.kinds,
    languages: parsed.language,
    filter: parsed.filter,
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
    ...(input.representation === 'subjects-v1' ? { representation: 'subjects-v1' } : {}),
    ...(typeof input.kindCursor === 'string' ? { kindCursor: input.kindCursor } : {}),
  };
}

function requestParams(data: SearchParams): SearchLoaderDeps {
  return {
    query: data.query,
    type: data.type,
    facets: data.facetValues,
    ...(data.ranges ? { ranges: data.ranges } : {}),
    ...(data.condition ? { condition: data.condition } : {}),
    cursor: data.cursor,
    sort: data.sort,
    kinds: data.kinds,
    languages: data.languages,
    filter: data.filter,
  };
}

const readKindsWithLocale = createServerFn({ method: 'GET' })
  .validator(validateSearchInput)
  .handler(async ({ data }) => {
    if (!data.kindCursor) throw new Error('Missing kind cursor');
    let recovery: SearchRecoveryState | undefined;
    const state = await readDiscoveryKinds(
      discoveryRequest(requestParams(data), requestLanguages(data.locale)),
      data.kindCursor,
      async (body) => {
        const response = await kernelClient(data.locale).subjects.$search.post(body, {
          fetch: { signal: getRequest().signal },
        });
        if (response.error || response.status !== 200) recovery = searchRecoveryFromResponse(response);
        return response;
      },
    );
    if (state.status === 'closed') recovery = { status: 'closed' };
    return { ...state, ...(recovery ? { recovery } : {}) };
  });

const readSearchWithLocale = createServerFn({ method: 'GET' })
  .validator(validateSearchInput)
  .handler(async ({ data }): Promise<SearchPageData> => {
    const signal = getRequest().signal;
    let release: Release | undefined;
    try {
      release = await readRelease();
    } catch {
      release = undefined;
    }

    const type = data.type;
    const knownType = release && allowedType(release, type) ? type : undefined;
    const queryState = requestParams(data);
    let body;
    try {
      body = discoveryRequest(queryState, requestLanguages(data.locale));
    } catch {
      body = undefined;
    }
    const filter = body?.filter;
    const hasSearch = hasResultSearchIntent(queryState);
    const languages = data.languages ?? requestLanguages(data.locale);
    const years = release ? yearProperties(release, knownType) : [];
    const properties = release
      ? [...new Set([...(knownType ? factProperties(release, knownType) : []), ...years])].slice(0, 4)
      : [];
    const sendSearch = async (
      request: Parameters<ReturnType<typeof kernelClient>['subjects']['$search']['post']>[0],
    ) => {
      const response = await kernelClient(data.locale).subjects.$search.post(request, { fetch: { signal } });
      return response;
    };
    const searchPromise = hasSearch
      ? (async () => {
          if (!body) return { recovery: { status: 'invalid' } as SearchRecoveryState };
          const request = { ...body, ...(properties.length ? { properties } : {}) };
          if (data.representation !== 'subjects-v1') {
            return readSearchOutcome(request, sendSearch, signal);
          }
          const { representation: _representation, kindPage: _metadata, kindCountLeaf: _counts, ...legacy } = request;
          return readSearchOutcome(legacy, sendSearch, signal);
        })()
      : Promise.resolve(undefined);

    const roster = release ? refinementProperties(release, knownType ?? data.facetValues.type) : [];
    const requestedFacets = roster
      .slice(0, 8)
      .filter((entry) => entry.mode === 'values' || entry.mode === 'types')
      .map(({ property }) => ({ property, size: 10 }));
    const facetsPromise: Promise<FacetState | undefined> =
      body && requestedFacets.length
        ? readFacetPage(
            facetRequest({ ...(data.query ? { text: data.query } : {}), languages }, requestedFacets),
            (request) =>
              kernelClient(data.locale).subjects.$facets.post(
                { ...request, ...(filter ? { filter } : {}) },
                { fetch: { signal } },
              ),
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

    const [outcome, facetResult] = await Promise.all([searchPromise, facetsPromise]);
    const result = outcome && 'result' in outcome ? outcome.result : undefined;
    const discovery = outcome && 'discovery' in outcome ? outcome.discovery : undefined;
    const recovery = !outcome
      ? undefined
      : ['session', 'closed', 'denied'].includes(outcome.recovery.status)
        ? outcome.recovery
        : (facetSearchInvalidation(facetResult) ?? outcome.recovery);
    const problem = recovery && recovery.status !== 'ready' ? recovery.problem : undefined;
    const typeChoices = discovery?.status === 'ready' ? discovery.page.kinds.values : [];
    const hitTypes: Record<string, Record<string, string>> = {};
    if (release)
      for (const subject of result?.subjects ?? [])
        if (allowedType(release, subject.type)) hitTypes[subject.type] = release.types[subject.type]?.labels ?? {};
    return searchPageForRecovery({
      queryState,
      ...(recovery ? { recovery } : {}),
      ...(release ? { conditionMetadata: conditionMetadata(release) } : {}),
      ...(problem ? { problem } : {}),
      ...(result ? { result } : {}),
      ...(discovery ? { discovery } : {}),
      ...(type ? { type } : {}),
      ...(knownType && release ? { typeLabels: release.types[knownType]?.labels ?? {} } : {}),
      hitTypes,
      yearProperties: years,
      typeChoices,
      groups: [],
      ...(release
        ? {
            refinement: {
              key: JSON.stringify([
                refinementKey({
                  principal: 'anonymous',
                  languages,
                  release: release.digest!,
                  source: 'public-global',
                  text: data.query,
                }),
                filter,
              ]),
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
      staleCursorRestarted: false,
      sort: data.sort ?? 'relevance',
    });
  });

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

function languageDisplayName(tag: string, locale: string) {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const linkClass = cn(buttonVariants({ variant: 'link' }), 'h-auto justify-start p-0');
type MessageOptions = { locale: (typeof locales)[number] };

function messageOptions(locale: string): MessageOptions {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

export function SearchPage({
  query,
  cursor,
  data,
  filtersOnly = false,
  initiallyOpen = false,
  realmDiscovery,
  realmDiscoveryRead,
  onRetry,
  locale: localeProp,
  session = null,
}: {
  query: string;
  cursor?: string;
  data?: SearchPageData;
  filtersOnly?: boolean;
  initiallyOpen?: boolean;
  realmDiscovery?: RealmDiscoveryState;
  realmDiscoveryRead?: RealmDiscoveryReader;
  onRetry?: (() => void) | undefined;
  locale?: string;
  session?: string | null;
}) {
  const sourceData = data;
  const currentData = useRef(data);
  currentData.current = data;
  const [invalidation, setInvalidation] = useState<{ owner: SearchPageData; state: SearchRecoveryState }>();
  if (data) data = searchPageForRecovery(data, invalidation?.owner === data ? invalidation.state : data.recovery);
  const [hydrated, setHydrated] = useState(false);
  const [filterSurface, setFilterSurface] = useState<'desktop' | 'mobile' | undefined>();
  const router = useRouter({ warn: false });
  const typeControlId = useId();
  const locale = localeProp ?? getLocale();
  const options = messageOptions(locale);
  const type = data?.type;
  const result = data?.result;
  const discovery = data?.discovery;
  const selectedFacets = data?.selectedFacets ?? {};
  const committedState: SearchLoaderDeps = data?.queryState ?? {
    query,
    type,
    facets: selectedFacets,
    cursor,
    sort: data?.sort === 'rating' ? 'rating' : undefined,
  };
  const stateKey = JSON.stringify(committedState);
  const latestStateKey = useRef(stateKey);
  latestStateKey.current = stateKey;
  const filterFocus = useFilterSurfaceFocus(stateKey);
  const [rangeDraftState, setRangeDraftState] = useState(() => createRangeDraftState(stateKey));
  if (rangeDraftState.key !== stateKey) setRangeDraftState(createRangeDraftState(stateKey));
  const baseline = { condition: data?.condition, languages: committedState.languages };
  const [draft, setDraft] = useState(() => createFilterDraft(stateKey, baseline));
  const [revertedKey, setRevertedKey] = useState<string>();
  if (draft.key !== stateKey) {
    setDraft(createFilterDraft(stateKey, baseline));
  }
  const admit = useMemo(
    () => (data?.conditionMetadata ? conditionAdmission(data.conditionMetadata) : undefined),
    [data?.conditionMetadata],
  );
  const localIssues = admit?.(draft.condition, committedState) ?? [];
  const issues = [
    ...(data?.problem?.errors ?? []),
    ...(draft.attempted || draft.condition !== data?.condition ? localIssues : []),
  ];
  const editedState = conditionSearchState(committedState, draft.condition, draft.languages);
  // Pending fields can be incomplete. Result navigation consumes only an admitted tree.
  const navigationState = localIssues.length ? committedState : editedState;
  const editableData = data ? { ...data, queryState: navigationState, condition: navigationState.condition } : data;
  const editing =
    JSON.stringify([draft.condition, editedState.languages]) !==
    JSON.stringify([committedState.condition, committedState.languages]);
  const number = new Intl.NumberFormat(locale);
  const label = (labels: Record<string, string> | undefined, fallback: string) =>
    localizedLabel(labels ?? {}, locale).text.trim() || fallback;
  const constraints: { key: string; text: string; state: SearchLoaderDeps; details?: unknown }[] = [];
  const add = (key: string, text: string, state: SearchLoaderDeps, details?: unknown) =>
    constraints.push({ key, text, state: { ...state, cursor: undefined }, details });
  if (type)
    add(
      'type',
      `${m.search_subject_type({}, options)}: ${label(data?.typeLabels, m.search_constraint_identity_kind_unavailable({}, options))}`,
      {
        ...navigationState,
        type: undefined,
      },
      { type },
    );
  for (const kind of navigationState.kinds ?? [])
    add(
      `kind:${kind}`,
      `${m.home_kind_label({}, options)}: ${label(
        discovery?.status === 'ready'
          ? discovery.page.kinds.values.find((entry) => entry.id === kind)?.labels
          : undefined,
        m.search_constraint_identity_kind_unavailable({}, options),
      )}`,
      { ...navigationState, kinds: navigationState.kinds?.filter((value) => value !== kind) },
      { kind },
    );
  for (const [property, values] of Object.entries(selectedFacets))
    for (const value of values) {
      const page = data?.refinement?.initial;
      const valueLabels =
        page?.status === 'ready'
          ? page.page.facets.find((entry) => entry.property === property)?.values.find((entry) => entry.value === value)
              ?.labels
          : undefined;
      add(
        `facet:${property}:${value}`,
        `${property === 'type' ? m.search_subject_types({}, options) : label(data?.selectedFacetLabels[property], m.search_constraint_identity_property_unavailable({}, options))}: ${label(
          valueLabels,
          m.search_constraint_identity_value_unavailable({}, options),
        )}`,
        {
          ...navigationState,
          facets: { ...selectedFacets, [property]: values.filter((entry) => entry !== value) },
        },
        { property, value },
      );
    }
  for (const [property, range] of Object.entries(data?.ranges ?? {}))
    add(
      `range:${property}`,
      `${label(data?.conditionMetadata?.properties[property]?.labels, m.search_constraint_identity_property_unavailable({}, options))}: ${range.gte ?? '…'} – ${range.lte ?? '…'}${
        range.unit ? ` (${m.search_constraint_identity_unit_unavailable({}, options)})` : ''
      }`,
      {
        ...navigationState,
        ranges: Object.fromEntries(Object.entries(data?.ranges ?? {}).filter(([key]) => key !== property)),
      },
      { property, range },
    );
  for (const tag of draft.languages ?? [])
    add(`language:${tag}`, `${m.condition_language({}, options)}: ${languageDisplayName(tag, locale)}`, {
      ...navigationState,
      languages: draft.languages?.filter((entry) => entry !== tag),
    });
  if (draft.condition) add('condition', m.condition_heading({}, options), { ...navigationState, condition: undefined });
  if (navigationState.filter)
    add('filter', m.search_existing_filter({}, options), { ...navigationState, filter: undefined });
  const activeFilterCount = constraints.length;
  useEffect(() => setHydrated(true), []);
  const desktopPanel = useRef<HTMLDivElement>(null);
  const openFilters = useCallback(() => {
    const owner = latestStateKey.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const desktop = window.matchMedia('(min-width: 1024px)').matches;
    const surface = desktop ? 'desktop' : 'mobile';
    const id = filterFocus.begin({
      owner,
      kind: 'open',
      surface,
      opener,
      document,
      ...(desktop ? { resolveDestination: () => desktopPanel.current } : {}),
    });
    setFilterSurface(surface);
    if (desktop) filterFocus.schedule(id, owner);
  }, [filterFocus]);
  const closeFilters = useCallback(() => {
    const owner = latestStateKey.current;
    const surfaceRoot = desktopPanel.current ?? document.querySelector<HTMLElement>('[role="dialog"]');
    const id = filterFocus.begin({
      owner,
      kind: 'close',
      document,
      ...(surfaceRoot ? { surfaceRoot } : {}),
    });
    setFilterSurface(undefined);
    filterFocus.schedule(id, owner);
  }, [filterFocus]);
  useEffect(() => {
    if (filterSurface === 'desktop') filterFocus.restoreOpen(latestStateKey.current, 'desktop');
    if (!filterSurface) return;
    const media = window.matchMedia('(min-width: 1024px)');
    const resize = () => {
      const next = media.matches ? 'desktop' : 'mobile';
      if (next === filterSurface) return;
      filterFocus.retire();
      setFilterSurface(next);
    };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, [filterFocus, filterSurface]);
  useEffect(() => {
    if (initiallyOpen) openFilters();
  }, [initiallyOpen, openFilters]);
  useEffect(() => {
    if (data?.problem?.errors?.length) openFilters();
  }, [data?.problem, openFilters]);

  const hasFilterPanel = data !== undefined;
  const filterRegion = useMemo(
    () => ({ activeCount: activeFilterCount, open: openFilters }),
    [activeFilterCount, openFilters],
  );
  useRegisterHeaderSearchFilters(hasFilterPanel, filterRegion);
  const revertStatus = useRef<HTMLParagraphElement>(null);
  const retryFocus = useSearchRetryFocus({ query, locale, session }, data?.recovery?.status !== 'loading');
  const results = renderResults(
    query,
    result,
    locale,
    type,
    selectedFacets,
    editableData,
    !editing,
    localIssues.length > 0,
    onRetry,
    committedState,
    retryFocus,
  );
  const navigate = (href: string, removingCondition = false) => {
    setDraft((previous) => ({ ...previous, attempted: true }));
    if (!removingCondition && localIssues.length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-condition-errors]')?.focus());
      return;
    }
    void router?.navigate({ href });
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    setDraft((previous) => ({ ...previous, attempted: true }));
    if (localIssues.length || router) event.preventDefault();
    if (localIssues.length) {
      const form = event.currentTarget;
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[data-condition-errors]')?.focus());
      return;
    }
    if (router) {
      const params = new URLSearchParams();
      for (const [key, value] of new FormData(event.currentTarget))
        if (typeof value === 'string' && value !== '') params.append(key, value);
      navigate(`/${locale}/search?${params}`);
    }
  };
  const revertDraft = () => {
    const expectedKey = stateKey;
    if (latestStateKey.current !== expectedKey) return;
    setDraft((previous) => resetFilterDraft(previous, expectedKey, latestStateKey.current, baseline));
    setRevertedKey(expectedKey);
    requestAnimationFrame(() => {
      if (latestStateKey.current === expectedKey) revertStatus.current?.focus();
    });
  };
  const follow = (event: React.MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (
      !router ||
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(anchor.getAttribute('href')!, anchor.dataset.removeCondition === 'true');
  };
  const filterEntrance = (
    <div className="space-y-3" onClick={follow}>
      <Button
        type="button"
        variant="outline"
        aria-controls="search-filters"
        aria-expanded={!hydrated || filterSurface !== undefined}
        onClick={openFilters}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
        {m.search_filters({}, options)} ({number.format(activeFilterCount)})
      </Button>
      {constraints.length > 0 && (
        <ul aria-label={m.refinement_selected({}, options)} data-search-constraints className="flex flex-wrap gap-2">
          {constraints.map(({ key, text, state }, index) => (
            <li key={key} className="min-w-0 max-w-full">
              <a
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'h-auto min-h-11 max-w-full whitespace-normal py-2',
                )}
                data-remove-condition={key === 'condition' ? 'true' : undefined}
                aria-label={m.refinement_remove(
                  {
                    value: m.search_constraint_identity_filter(
                      { number: number.format(index + 1), label: text },
                      options,
                    ),
                  },
                  options,
                )}
                href={discoverySearchHref(locale, state)}
              >
                <span className="min-w-0 text-start wrap-anywhere">
                  {m.search_constraint_identity_filter({ number: number.format(index + 1), label: text }, options)}
                </span>
                <XIcon aria-hidden="true" className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {constraints.some(({ details }) => details !== undefined) && (
        <details className="min-w-0 text-sm" data-search-constraint-details>
          <summary className="min-h-11 w-fit max-w-full cursor-pointer rounded-sm py-2 wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.search_constraint_identity_details({}, options)}
          </summary>
          <dl className="space-y-3 pt-2">
            {constraints.map(({ key, text, details }, index) =>
              details !== undefined ? (
                <div key={key} className="min-w-0 space-y-1">
                  <dt className="font-medium wrap-anywhere">
                    {m.search_constraint_identity_filter({ number: number.format(index + 1), label: text }, options)}
                  </dt>
                  <dd className="min-w-0">
                    <code
                      tabIndex={0}
                      className="block max-w-full rounded-sm select-text whitespace-pre-wrap wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {JSON.stringify(details, null, 2)}
                    </code>
                  </dd>
                </div>
              ) : null,
            )}
          </dl>
        </details>
      )}
    </div>
  );

  const filterContents = (surface: 'desktop' | 'mobile') => (
    <div className="space-y-5 pt-3 lg:pt-0">
      <input type="hidden" name="q" value={query} />
      {data?.sort === 'rating' && <input type="hidden" name="sort" value="rating" />}
      {(draft.languages ?? []).map((tag) => (
        <input key={tag} type="hidden" name="language" value={tag} />
      ))}
      {data?.queryState?.filter && <input type="hidden" name="filter" value={data.queryState.filter} />}
      {(data?.discovery?.status !== 'ready' ? (data?.queryState?.kinds ?? []) : []).map((kind) => (
        <input key={kind} type="hidden" name="kinds" value={kind} />
      ))}
      {!data?.refinement &&
        Object.entries(selectedFacets).flatMap(([property, values]) =>
          values.map((value) => (
            <input key={`${property}:${value}`} type="hidden" name={`f.${property}`} value={value} />
          )),
        )}
      {data?.discovery?.status === 'ready' && data.queryState && (
        <DiscoveryKinds
          key={JSON.stringify([data.queryState, locale, data.discovery.page.as_of])}
          initial={data.discovery.page.kinds}
          locale={locale}
          selected={data.queryState.kinds ?? []}
          hydrated={hydrated}
          load={async (kindCursor, signal) => {
            const response = await readKindsWithLocale({
              data: { ...data.queryState!, facetValues: selectedFacets, locale, kindCursor },
              signal,
            });
            if (
              !signal.aborted &&
              sourceData &&
              currentData.current === sourceData &&
              response.recovery &&
              ['session', 'closed', 'denied', 'restart'].includes(response.recovery.status)
            )
              setInvalidation({ owner: sourceData, state: response.recovery });
            return response;
          }}
        />
      )}
      <Field>
        <FieldLabel htmlFor={`${typeControlId}-${surface}`}>{m.search_subject_type({}, options)}</FieldLabel>
        <p className="text-sm text-muted-foreground">{m.search_subject_type_help({}, options)}</p>
        <NativeSelect
          id={`${typeControlId}-${surface}`}
          name="type"
          value={type ?? ''}
          onChange={(event) => {
            if (hydrated) event.currentTarget.form?.requestSubmit();
          }}
        >
          <NativeSelectOption value="">{m.search_all_subject_types({}, options)}</NativeSelectOption>
          {type && !data?.conditionMetadata?.types[type] && (
            <NativeSelectOption value={type}>
              {label(data?.typeLabels, m.search_constraint_identity_kind_unavailable({}, options))}
            </NativeSelectOption>
          )}
          {Object.entries(data?.conditionMetadata?.types ?? {}).map(([id, definition]) => (
            <NativeSelectOption key={id} value={id}>
              {label(definition.labels, m.search_constraint_identity_kind_unavailable({}, options))}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {data?.refinement && (
        <Refinement
          key={`${surface}-${data.refinement.key}`}
          rangeDraftKey={stateKey}
          rangeDraftState={rangeDraftState}
          onRangeDraftChange={(property: string, draft: RangeDraft) =>
            setRangeDraftState((previous) => updateRangeDraft(previous, stateKey, property, draft))
          }
          data={{
            ...data.refinement,
            properties: data.refinement.properties.filter(
              (entry) => entry.mode !== 'types' || selectedFacets.type?.length,
            ),
          }}
          showSummary={false}
          onNavigate={navigate}
          conditions={{
            ...(type ? { type } : {}),
            facetValues: selectedFacets,
            ...(data.queryState?.kinds ? { kinds: data.queryState.kinds } : {}),
            ...(draft.languages ? { languages: draft.languages } : {}),
            ...(data.queryState?.filter ? { filter: data.queryState.filter } : {}),
            ...(data.ranges ? { ranges: data.ranges } : {}),
            ...(draft.condition ? { condition: draft.condition } : {}),
          }}
          query={query}
          locale={locale}
          load={async (facets, signal) => {
            const response = await readRefinement({
              data: {
                query,
                locale,
                conditions: {
                  ...(type ? { type } : {}),
                  facetValues: selectedFacets,
                  ...(data.queryState?.kinds ? { kinds: data.queryState.kinds } : {}),
                  ...(data.queryState?.languages ? { languages: data.queryState.languages } : {}),
                  ...(data.queryState?.filter ? { filter: data.queryState.filter } : {}),
                  ...(data.ranges ? { ranges: data.ranges } : {}),
                  ...(data.condition ? { condition: data.condition } : {}),
                },
                facets,
              },
              signal,
            });
            const state = facetSearchInvalidation(response);
            if (!signal.aborted && sourceData && currentData.current === sourceData && state)
              setInvalidation({ owner: sourceData, state });
            return response;
          }}
          {...(data.sort === 'rating' ? { sort: 'rating' as const } : {})}
        />
      )}
      <ConditionEditor
        value={draft.condition}
        onChange={(condition) => setDraft((previous) => ({ ...previous, condition }))}
        metadata={data?.conditionMetadata}
        locale={locale}
        issues={issues}
        values={Object.fromEntries(
          data?.refinement?.initial?.status === 'ready'
            ? data.refinement.initial.page.facets.map(({ property, values }) => [property, values])
            : [],
        )}
        languages={draft.languages}
        onLanguages={(languages) => setDraft((previous) => ({ ...previous, languages }))}
      />
      {!data?.conditionMetadata && (
        <a className={linkClass} href={discoverySearchHref(locale, committedState)}>
          {m.search_facet_retry({}, options)}
        </a>
      )}
      {data?.queryState?.filter && <p className="text-sm text-muted-foreground">{m.condition_retained({}, options)}</p>}
      {Object.entries(data?.ranges ?? {}).map(([property, range]) => (
        <input key={property} type="hidden" name={`r.${property}`} value={JSON.stringify(range)} />
      ))}
      {editing && (
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={revertDraft}>
            {m.search_filter_revert_action({}, options)}
          </Button>
        </div>
      )}
      <p
        ref={revertStatus}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="rounded-sm text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {revertedKey === stateKey ? m.search_filter_revert_status({}, options) : ''}
      </p>
    </div>
  );

  const desktopOpen = !hydrated || filterSurface === 'desktop';
  const filterControls = (
    <>
      {desktopOpen && (
        <div
          id="search-filters"
          ref={desktopPanel}
          role="region"
          aria-label={m.search_filters({}, options)}
          tabIndex={-1}
          className="min-w-0 rounded-xl border border-border/60 p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeFilters();
            }
          }}
          onClick={follow}
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-medium">{m.search_filters({}, options)}</h2>
            <Button type="button" variant="ghost" hidden={!hydrated} onClick={closeFilters}>
              {m.search_close_filters({}, options)}
            </Button>
          </div>
          <form id="desktop-filter-form" method="get" onSubmit={submit} action={`/${locale}/search`}>
            {filterContents('desktop')}
          </form>
        </div>
      )}
      {filterSurface === 'mobile' && (
        <BottomSheet
          open
          onOpenChange={(open) => {
            if (!open) closeFilters();
          }}
          title={`${m.search_filters({}, options)} (${number.format(activeFilterCount)})`}
        >
          <form id="search-filters" method="get" action={`/${locale}/search`} onSubmit={submit} onClick={follow}>
            {filterContents('mobile')}
          </form>
        </BottomSheet>
      )}
    </>
  );

  if (filtersOnly) {
    if (!hasFilterPanel) return null;
    return (
      <div className="w-full space-y-4">
        {filterEntrance}
        {filterControls}
      </div>
    );
  }

  const browsing = isRealmDiscoverySearch(committedState) && !editing && !result && !discovery && !data?.recovery;
  const content = browsing ? (
    <SearchRealmDiscovery
      key={JSON.stringify([locale, stateKey, realmDiscovery])}
      initial={realmDiscovery ?? { kind: 'loading' }}
      locale={locale}
      {...(realmDiscoveryRead ? { read: realmDiscoveryRead } : {})}
    />
  ) : (
    results
  );

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.search_heading({}, options)}</PageHeading>
      {hasFilterPanel ? (
        <>
          {filterEntrance}
          <div className={cn('grid items-start gap-6', desktopOpen && 'lg:grid-cols-[16rem_minmax(0,1fr)]')}>
            {filterControls}
            <div className="min-w-0 space-y-4">{content}</div>
          </div>
        </>
      ) : (
        content
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
  continuationAllowed = true,
  invalid = false,
  onRetry?: (() => void) | undefined,
  retryState = data?.queryState,
  retryFocus?: ReturnType<typeof useSearchRetryFocus>,
) {
  if (!result && !data?.discovery && !data?.recovery) return null;
  const options = messageOptions(locale);
  const next = continuationAllowed
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
            state={data?.queryState}
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
      <section ref={retryFocus?.regionRef} tabIndex={-1} aria-label={m.search_results({}, options)} data-search-results>
        {data?.recovery && data.recovery.status !== 'ready' && data.queryState ? (
          <SearchRecovery
            state={data.recovery}
            retryHref={discoverySearchHref(locale, retryState ?? data.queryState)}
            restartHref={discoverySearchHref(locale, { ...data.queryState, cursor: undefined })}
            onRetry={onRetry}
            locale={locale}
            {...(retryFocus ? { retryRef: retryFocus.retryRef, onRetryFocus: retryFocus.captureRetryFocus } : {})}
          />
        ) : data?.discovery ? (
          <DiscoveryResults
            state={data.discovery}
            locale={locale}
            yearProperties={data.yearProperties}
            restartHref={
              data.queryState ? discoverySearchHref(locale, { ...data.queryState, cursor: undefined }) : undefined
            }
          />
        ) : result?.subjects.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle className="text-base font-normal">{m.search_no_results({}, options)}</EmptyTitle>
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
      </section>
      {next && (
        <Link
          to="/search"
          search={{
            q: query,
            type,
            cursor: next,
            sort: data?.sort === 'rating' ? 'rating' : undefined,
            kinds: data?.queryState?.kinds,
            language: data?.queryState?.languages,
            filter: data?.queryState?.filter,
            condition: data?.condition ? JSON.stringify(data.condition) : undefined,
            ...Object.fromEntries(
              Object.entries(data?.ranges ?? {}).map(([property, range]) => [`r.${property}`, JSON.stringify(range)]),
            ),
            ...Object.fromEntries(
              Object.entries(selectedFacets).map(([property, values]) => [`f.${property}`, values]),
            ),
          }}
          className={buttonVariants({ variant: 'outline' })}
        >
          {m.search_more({}, options)}
        </Link>
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
