import type { FilterCondition, FilterDocument, FilterNode, ResourceQuery }
  from '../../../../../model/definitions/filter-document-v1.ts';
import { checkedFilter, InvalidFilter } from '../facets/schema.ts';
import { resolveFacet } from '../facets/registry.ts';
import { WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { ZONE_BROWSE_COST } from '../zone-modules/contract.ts';

export const QUERY_COST = {
  nodes: 32, depth: 4, graphReads: 6, candidateRows: 512,
  searchExecutions: 3, conceptReads: 2, deadlineMs: 10_000, searchPageSize: 64,
  zonePageSize: ZONE_BROWSE_COST.pageSize, responseBytes: 8 * 1024 * 1024,
} as const;

export type QueryRefusal = 'invalid_query' | 'unsupported_query_shape' | 'query_budget_exceeded'
  | 'unsupported_query_source' | 'stale_query_meaning' | 'stale_query_result';

export class QueryRejected extends Error {
  constructor(readonly refusal: QueryRefusal, message: string) { super(message); }
}

type SearchRequest = { profile: string; phrase?: string; titleTerm?: string; bodyTerm?: string;
  language: string | null; author?: string; context?: { kind: 'realm-local'; id: string };
  includeTypes?: string[]; excludeTypes?: string[]; sense?: string;
  ratingContext?: string; minimumMeanTimes10?: number; pageSize?: number; continuation?: unknown };

type ZoneRequest = { q?: string; sort: ResourceQuery['sort']; type?: string[];
  concept?: string[]; language?: string; limit: number; cursor?: string };

export type CompiledQuery =
  | { template: 'search'; request: SearchRequest; concept?: { value: string; revision: string };
    facets: string[]; graphReads: number }
  | { template: 'search-concepts'; request: SearchRequest;
    concepts: { operator: 'include' | 'exclude'; value: string; revision: string }[];
    facets: string[]; graphReads: number }
  | { template: 'zone-browse'; realm: string; request: ZoneRequest;
    facets: string[]; graphReads: number };

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const simple = (node: FilterNode): node is FilterCondition => 'facet' in node;
const fail = (message: string): never => { throw new QueryRejected('unsupported_query_shape', message); };

/** No terms are executed until the entire document and its cost pass admission. */
function admit(filter: FilterDocument | undefined): { conditions: FilterCondition[]; facets: string[];
  graphReads: number } {
  if (filter === undefined) return { conditions: [], facets: [], graphReads: 0 };
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new QueryRejected('invalid_query', 'Filter is not a group');
  }
  // The empty document has no implicit condition. Nonempty documents use the
  // same Facet/operator, node and depth admission as Saved Filters.
  if (Object.keys(filter).length === 1 && 'all' in filter
    && Array.isArray(filter.all) && filter.all.length === 0) {
    return { conditions: [], facets: [], graphReads: 0 };
  }
  let facets: string[];
  try { facets = checkedFilter(filter as Parameters<typeof checkedFilter>[0]); }
  catch (error) {
    if (error instanceof InvalidFilter) {
      throw new QueryRejected(error.refusal === 'filter_too_large' ? 'query_budget_exceeded' : 'invalid_query',
        `${error.refusal}: ${error.message}`);
    }
    throw error;
  }
  // Current templates evaluate conjunctions of resource Conditions. Retain
  // meaningful multiplicity in occurrence groups, which remain refused here.
  if (!('all' in filter)) fail('A template for top-level any is not admitted');
  const conditions: FilterCondition[] = [];
  for (const node of (filter as { all: FilterNode[] }).all) {
    if (!simple(node)) fail('A template for nested boolean groups is not admitted');
    const condition = node as FilterCondition;
    if (condition.where) fail('No admitted template binds this occurrence group');
    if (!conditions.some(existing => JSON.stringify(existing) === JSON.stringify(condition))) conditions.push(condition);
  }
  let graphReads = 0;
  for (const condition of conditions) {
    const facet = resolveFacet(condition.facet)!;
    graphReads += facet.cost.graphReads;
  }
  if (graphReads > QUERY_COST.graphReads) {
    throw new QueryRejected('query_budget_exceeded', 'Facet graph reads exceed the Query budget');
  }
  return { conditions, facets, graphReads };
}

function values(condition: FilterCondition, operator: 'any' | 'all' | 'none'): string[] {
  const found = condition[operator];
  if (!found || found.some(value => typeof value !== 'string')) fail(`${condition.facet} needs IRI or lexical values`);
  return found as string[];
}

/**
 * Compile only combinations whose existing template executes their full meaning.
 * Unsupported shapes fail before a graph or index read, never as zero matches.
 * Search delegates its complete-result budget (512 Works and a stable graph/text
 * snapshot); Zone browse delegates its 60-candidate window and 20-item page.
 */
export function compileQuery(query: ResourceQuery): CompiledQuery {
  if (query.sourcePolicy !== undefined || query.asOf !== undefined) {
    throw new QueryRejected('unsupported_query_source', 'Only the current product source is admitted');
  }
  const admitted = admit(query.filter);
  const { conditions, facets, graphReads } = admitted;
  if (!Number.isInteger(query.page?.size) || query.page.size < 1) {
    throw new QueryRejected('invalid_query', 'Page size must be positive');
  }
  if (query.scope.kind === 'realm') {
    if (typeof query.context === 'string' || query.context.realm !== query.scope.realm) {
      fail('A Zone scope needs the same Realm Context');
    }
    if (query.page.size > QUERY_COST.zonePageSize) {
      throw new QueryRejected('query_budget_exceeded', 'Zone page exceeds its bound');
    }
    const zoneText = query.text;
    if (zoneText && !('phrase' in zoneText)) fail('Zone browse admits one phrase');
    const request: ZoneRequest = { sort: query.sort, limit: query.page.size };
    if (zoneText && 'phrase' in zoneText) request.q = zoneText.phrase;
    const continuation = query.page.continuation;
    if (continuation !== undefined) {
      if (typeof continuation !== 'string') fail('Zone continuation has the wrong form');
      request.cursor = continuation as string;
    }
    for (const condition of conditions) {
      const facet = resolveFacet(condition.facet)!;
      if (facet.name !== 'type' && facet.name !== 'concept') fail(`${facet.name} has no Zone browse template`);
      if (condition.interpretation || condition.applicability || condition.bind || condition.range) {
        fail(`${facet.name} qualifiers have no Zone browse template`);
      }
      if (!condition.any) fail(`${facet.name} ${condition.all ? 'all' : 'none'} has no Zone browse template`);
      const chosen = values(condition, 'any');
      if (facet.name === 'type') {
        if (request.type?.length) fail('Type has multiple Zone Conditions');
        if (chosen.some(type => !(WORK_SEMANTIC_TYPES as readonly string[]).includes(type))) {
          fail('Zone browse does not admit this Work type');
        }
        request.type = chosen;
      } else {
        if (request.concept?.length) fail('Concept has multiple Zone Conditions');
        if (chosen.some(value => !nativeId.test(value))) fail('Zone browse needs native Concept IDs');
        request.concept = chosen;
      }
    }
    if (query.sort === 'relevance' && !query.text) fail('Relevance needs text');
    return { template: 'zone-browse', realm: query.scope.realm, request, facets, graphReads };
  }
  if (query.page.size > QUERY_COST.searchPageSize) {
    throw new QueryRejected('query_budget_exceeded', 'Search page exceeds its bound');
  }
  const searchText = query.text;
  if (!searchText || query.sort !== 'relevance') fail('Public search needs text and relevance order');
  if (query.page.continuation !== undefined && (typeof query.page.continuation !== 'object'
    || query.page.continuation === null || Array.isArray(query.page.continuation))) {
    fail('Search continuation has the wrong form');
  }
  const realm = query.context === 'global' ? undefined : query.context.realm;
  const request: SearchRequest = { profile: '', language: null, pageSize: query.page.size,
    ...realm ? { context: { kind: 'realm-local', id: realm } } : {},
    ...query.page.continuation === undefined ? {} : { continuation: query.page.continuation } };
  if (searchText && 'phrase' in searchText) request.phrase = searchText.phrase;
  else if (searchText) { request.titleTerm = searchText.title; request.bodyTerm = searchText.body; }
  const concepts: { operator: 'include' | 'exclude'; value: string; revision: string }[] = [];
  for (const condition of conditions) {
    const facet = resolveFacet(condition.facet)!;
    if (condition.applicability || condition.where) fail(`${facet.name} qualifiers have no search template`);
    switch (facet.name) {
      case 'type': {
        if (condition.bind || condition.interpretation || condition.range) fail('Type qualifiers are unsupported');
        if (condition.all && condition.all.length !== 1) fail('Multiple required types have no search template');
        const chosen = condition.none ? values(condition, 'none')
          : condition.any ? values(condition, 'any') : values(condition, 'all');
        if (chosen.some(type => !(WORK_SEMANTIC_TYPES as readonly string[]).includes(type))) {
          fail('Search does not admit this Work type');
        }
        const key = condition.none ? 'excludeTypes' : 'includeTypes';
        if (request[key]) fail(`Multiple ${key} Conditions have no search template`);
        request[key] = chosen;
        break;
      }
      case 'language':
      case 'contributor': {
        if (!condition.any || condition.any.length !== 1 || condition.bind || condition.interpretation
          || condition.range || condition.all || condition.none) fail(`${facet.name} needs one included value`);
        const value = values(condition, 'any')[0]!;
        if (facet.name === 'language') {
          if (request.language !== null) fail('Multiple language Conditions have no search template');
          request.language = value;
        } else {
          if (request.author) fail('Multiple contributor Conditions have no search template');
          request.author = value;
        }
        break;
      }
      case 'concept': {
        const interpretation = condition.interpretation;
        const operator = condition.none ? 'none' : condition.any ? 'any' : 'all';
        const chosen = condition[operator];
        if (!chosen || chosen.length !== 1 || !interpretation || !('definition' in interpretation)) {
          fail('Search needs one Concept per Condition and its exact interpretation revision');
        }
        concepts.push({ operator: operator === 'none' ? 'exclude' : 'include',
          value: values(condition, operator)[0]!,
          revision: (interpretation as { definition: string }).definition });
        break;
      }
      case 'rating': {
        const range = condition.range, binding = condition.bind;
        if (!realm || !range?.min || range.max || !binding?.ratingContext
          || condition.any || condition.all || condition.none) fail('Rating has no matching search template');
        if (request.ratingContext) fail('Multiple Rating Conditions have no search template');
        const timesTen = Number(range?.min) * 10;
        if (!Number.isInteger(timesTen) || timesTen < 10 || timesTen > 100) fail('Rating threshold is unsupported');
        request.ratingContext = binding!.ratingContext;
        request.minimumMeanTimes10 = timesTen;
        break;
      }
      default: fail(`${facet.name} has no public search template`);
    }
  }
  if (request.includeTypes?.some(type => request.excludeTypes?.includes(type))) {
    throw new QueryRejected('invalid_query', 'The same type is included and excluded');
  }
  if (request.ratingContext && (concepts.length !== 1 || concepts[0]!.operator !== 'include'
    || !realm || !request.phrase)) fail('Rated search needs Realm and one included Concept');
  if (!request.phrase && (realm || concepts.length || request.ratingContext)) {
    fail('Title/body search has no Realm or Concept template');
  }
  if (concepts.length > QUERY_COST.conceptReads) {
    throw new QueryRejected('query_budget_exceeded', 'Concept set exceeds three bounded reads');
  }
  if (concepts.length > 1 || concepts[0]?.operator === 'exclude') {
    if (request.ratingContext) fail('Concept set has no rated search template');
    request.profile = realm ? 'public-realm-phrase-v1' : 'public-main-phrase-v1';
    delete request.pageSize;
    delete request.continuation;
    return { template: 'search-concepts', request, concepts, facets, graphReads };
  }
  const concept = concepts[0];
  request.profile = !request.phrase ? 'public-main-title-body-page-v1'
    : request.ratingContext ? 'public-realm-classified-rated-phrase-page-v1'
      : concept ? realm ? 'public-realm-classified-phrase-page-v1' : 'public-main-classified-phrase-page-v1'
        : realm ? 'public-realm-phrase-page-v1' : 'public-main-phrase-page-v1';
  return { template: 'search', request,
    ...concept ? { concept: { value: concept.value, revision: concept.revision } } : {}, facets, graphReads };
}
