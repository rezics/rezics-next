import type { KernelClient } from '@rezics/client';
import { facetProperties } from '@rezics/filter';
import { pickText } from '@rezics/composition';
import type { Release } from '../subject/definitions';
import { discoveryRequest, realmSearchRequest } from './search-request';
import { applicableRefinementProperties, refinementProperties, type RefinementApplicability } from './refinement/model';
import { readFacetPage, facetProblem, refinementKey, type FacetState } from './refinement/request';
import { scopedRefinementRequests } from './refinement/scoped-refinement';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { conditionMetadata } from './condition-editor-model';
import {
  facetSearchInvalidation,
  readSearchOutcome,
  searchPageForRecovery,
  searchUnavailablePage,
  type SearchRecoveryState,
} from './search-recovery';
import { hasResultSearchIntent } from './search-intent';
import {
  RESOURCE_LANGUAGE_PROPERTY,
  resourceLanguageRefinement,
  withoutResourceLanguageSelection,
} from './language-refinement';
import { searchRequiresCurrentReader, searchSessionLifetime } from './scoped-search-lifetime';
import type {
  SearchApplication,
  SearchApplicationContext,
  SearchFacetValueLabel,
  SearchPageData,
  SearchRequestParams,
} from './search-query-contract';
import type { SearchLoaderDeps } from './search-params';

const FACT_PROPERTIES = 2;
const YEAR_PROPERTIES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function allowedType(release: Release, type: unknown): type is string {
  return typeof type === 'string' && Object.hasOwn(release.types, type) && isRecord(release.types[type]);
}

/** Properties whose values a result row can show: items, years, quantities and codes with a declared pattern. */
export function factProperties(release: Release, type: string): string[] {
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
export function yearProperties(release: Release, type?: string): string[] {
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

/** Keep the page's pure request state available to secondary Search operations such as kind traversal. */
export function requestParams(data: SearchRequestParams): SearchLoaderDeps {
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
    resourceScope: data.resourceScope,
    ratingPopulation: data.ratingPopulation,
  };
}

function selectedFacetValueLabels(
  facets: Record<string, string[]>,
  result: FacetState | undefined,
  locale: string,
): SearchPageData['selectedFacetLabels'] {
  const admitted = result?.status === 'ready' ? result.page.facets : [];
  return Object.fromEntries(
    Object.entries(facets).map(([property, values]) => {
      const nativeFacet = admitted.find((facet) => facet.property === property);
      return [
        property,
        Object.fromEntries(
          values.flatMap((value) => {
            const labels = nativeFacet?.values.find((entry) => entry.value === value)?.labels;
            if (!labels) return [];
            const picked = pickText(labels, locale);
            return picked.text.trim()
              ? [
                  [
                    value,
                    {
                      text: picked.text,
                      ...(picked.lang ? { lang: picked.lang } : {}),
                    } satisfies SearchFacetValueLabel,
                  ],
                ]
              : [];
          }),
        ),
      ];
    }),
  );
}

export type SearchApplicationAdapters = Readonly<{
  createClient(locale: string): KernelClient;
  readRelease(): Promise<Release>;
  requestLanguages(locale: string): string[];
}>;

/** Build one Search use case around the current generated client provider and the owner's release/language readers. */
export function createSearchApplication(adapters: SearchApplicationAdapters): SearchApplication {
  return {
    read: (data, context) => readSearch(adapters, data, context),
    queryKey: (locale, params, reader) => ['search', 'discovery-v1', searchSessionLifetime(locale, params, reader)],
    loadingPage: (params) => searchPageForRecovery(searchUnavailablePage(params), { status: 'loading' }),
    unavailablePage: (params) => searchUnavailablePage(params),
  };
}

async function readSearch(
  adapters: SearchApplicationAdapters,
  data: SearchRequestParams,
  context: SearchApplicationContext,
): Promise<SearchPageData> {
  const { signal, reader } = context;
  const queryState = requestParams(data);
  const realmCatalogue = queryState.resourceScope?.kind === 'realm';
  if (searchRequiresCurrentReader(data) && (!reader || data.reader !== reader.owner))
    return { ...searchUnavailablePage(queryState), recovery: { status: 'session' } };

  let release: Release | undefined;
  try {
    release = await adapters.readRelease();
  } catch {
    release = undefined;
  }

  const type = data.type;
  const knownType = release && allowedType(release, type) ? type : undefined;
  const languages = data.languages ?? adapters.requestLanguages(data.locale);
  const selectedSemanticKinds =
    release && data.kinds?.length ? data.kinds.filter((kind) => allowedType(release, kind)) : undefined;
  const years = release
    ? knownType
      ? yearProperties(release, knownType)
      : selectedSemanticKinds
        ? [...new Set(selectedSemanticKinds.flatMap((kind) => yearProperties(release, kind)))].slice(0, YEAR_PROPERTIES)
        : yearProperties(release)
    : [];
  const properties = release
    ? [
        ...new Set([
          ...(knownType
            ? factProperties(release, knownType)
            : (selectedSemanticKinds?.flatMap((kind) => factProperties(release, kind)) ?? [])),
          ...years,
        ]),
      ].slice(0, 4)
    : [];
  const refinementTypes = knownType ?? (data.facetValues.type?.length ? data.facetValues.type : selectedSemanticKinds);
  const roster = release ? refinementProperties(release, refinementTypes) : [];
  let refinementRequests: ReturnType<typeof scopedRefinementRequests> | undefined;
  try {
    refinementRequests = scopedRefinementRequests(queryState, adapters.requestLanguages(data.locale), []);
  } catch {
    refinementRequests = undefined;
  }
  const body = refinementRequests?.search;
  const hasSearch =
    hasResultSearchIntent(queryState) ||
    queryState.resourceScope !== undefined ||
    (queryState.sort === 'rating' && queryState.ratingPopulation !== undefined);
  let client: KernelClient | undefined;
  const kernel = () => (client ??= adapters.createClient(data.locale));
  const sendSearch = async (request: Parameters<ReturnType<typeof kernel>['subjects']['$search']['post']>[0]) =>
    kernel().subjects.$search.post(request, {
      ...(reader?.authorization ? { headers: { authorization: reader.authorization } } : {}),
      fetch: { signal, cache: 'no-store' },
    });

  const realmRatingUnavailable = data.sort === 'rating' && data.ratingPopulation !== undefined;
  const runSearch = hasSearch || body !== undefined;
  const searchPromise = runSearch
    ? (async () => {
        // No installed Content complete-order adapter exists yet. Never ask Global Search and relabel it.
        if (realmRatingUnavailable) return { recovery: { status: 'unavailable' } as SearchRecoveryState };
        if (!body) return { recovery: { status: 'invalid' } as SearchRecoveryState };
        if (realmCatalogue) {
          const request = {
            ...realmSearchRequest(queryState, adapters.requestLanguages(data.locale)),
            ...(properties.length ? { properties } : {}),
          };
          return readSearchOutcome(request, sendSearch, signal, 'subjects');
        }
        const request = {
          ...body,
          ...(!hasSearch || !properties.length ? {} : { properties }),
          ...(!hasSearch ? { limit: 1 } : {}),
        };
        if (data.representation !== 'subjects-v1') {
          return readSearchOutcome(request, sendSearch, signal);
        }
        const { representation: _representation, kindPage: _metadata, kindCountLeaf: _counts, ...legacy } = request;
        return readSearchOutcome(legacy, sendSearch, signal);
      })()
    : Promise.resolve(undefined);

  const outcome = await searchPromise;
  const result = hasSearch && outcome && 'result' in outcome ? outcome.result : undefined;
  const discovery = outcome && 'discovery' in outcome ? outcome.discovery : undefined;
  const applicability =
    discovery?.status === 'ready'
      ? discovery.page.applicability
      : realmCatalogue && outcome?.recovery.status === 'ready'
        ? ({ type: 'all', statement: 'all' } satisfies RefinementApplicability)
        : undefined;
  const eligibleFacets = applicableRefinementProperties(roster, applicability).filter(
    (entry) => entry.mode === 'values' || entry.mode === 'types',
  );
  const requestedFacets = [
    ...eligibleFacets.filter((entry) => entry.property === RESOURCE_LANGUAGE_PROPERTY),
    ...eligibleFacets.filter((entry) => entry.property !== RESOURCE_LANGUAGE_PROPERTY),
  ]
    .slice(0, 8)
    .map(({ property }) => ({ property, size: 10 }));
  let facetResult: FacetState | undefined;
  if (body && (discovery?.status === 'ready' || (realmCatalogue && result !== undefined)) && requestedFacets.length) {
    try {
      const optionRequest = scopedRefinementRequests(
        withoutResourceLanguageSelection(queryState),
        adapters.requestLanguages(data.locale),
        requestedFacets,
      );
      if (optionRequest.facets)
        facetResult = await readFacetPage(optionRequest.facets, (request) =>
          kernel().subjects.$facets.post(request, {
            ...(reader?.authorization ? { headers: { authorization: reader.authorization } } : {}),
            fetch: { signal, cache: 'no-store' },
          }),
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
        });
    } catch (error) {
      if (signal.aborted) throw error;
      facetResult = { status: 'invalid', code: error instanceof Error ? error.name : 'invalid_facet_request' };
    }
  }
  const recovery = !outcome
    ? undefined
    : ['session', 'closed', 'denied'].includes(outcome.recovery.status)
      ? outcome.recovery
      : (facetSearchInvalidation(facetResult) ?? outcome.recovery);
  const problem = recovery && 'problem' in recovery ? recovery.problem : undefined;
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
    ...(applicability ? { refinementApplicability: applicability } : {}),
    ...(type ? { type } : {}),
    ...(knownType && release ? { typeLabels: release.types[knownType]?.labels ?? {} } : {}),
    hitTypes,
    yearProperties: years,
    typeChoices,
    groups: [],
    ...(release
      ? {
          refinement: {
            key: refinementKey({
              principal: reader?.owner ?? 'anonymous',
              languages,
              release: release.digest!,
              source: data.resourceScope ? `${data.resourceScope.kind}:${data.resourceScope.id}` : 'public-global',
              text: data.query,
              ...(body?.filter ? { filter: body.filter } : {}),
              ...(data.resourceScope ? { scope: data.resourceScope } : {}),
              ...(data.ratingPopulation ? { ratingPopulation: data.ratingPopulation } : {}),
              sort: data.sort ?? 'relevance',
              mode: searchRequiresCurrentReader(data) ? 'personal' : 'public-anonymous',
            }),
            properties: roster,
            ...(facetResult ? { initial: facetResult } : {}),
          },
        }
      : {}),
    resourceLanguage: resourceLanguageRefinement(
      roster,
      data.facetValues[RESOURCE_LANGUAGE_PROPERTY] ?? [],
      facetResult ?? (release ? undefined : { status: 'unavailable', code: 'release_unavailable' }),
      release !== undefined,
      applicability?.statement,
    ),
    ...(data.ranges ? { ranges: data.ranges } : {}),
    ...(data.condition ? { condition: data.condition } : {}),
    selectedFacets: data.facetValues,
    selectedFacetLabels: selectedFacetValueLabels(data.facetValues, facetResult, data.locale),
    facetsAvailable: release !== undefined,
    facetRetry: false,
    facetIndexNotReady: facetResult?.status === 'preparing',
    staleCursorRestarted: false,
    sort: data.sort ?? 'relevance',
    ...(data.ratingPopulation ? { ratingPopulation: data.ratingPopulation } : {}),
    ...(realmRatingUnavailable ? { ratingReadiness: { status: 'unavailable' as const } } : {}),
  });
}
