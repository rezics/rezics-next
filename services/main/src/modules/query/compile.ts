import type { FilterCondition, FilterDocument, FilterNode, ResourceQuery }
  from '../../../../../model/definitions/filter-document-v1.ts';
import type { ResourceQuery as ResourceQueryV2 }
  from '../../../../../model/definitions/filter-document-v2.ts';
import { checkedFilter, InvalidFilter } from '../facets/schema.ts';
import { resolveFacet } from '../facets/registry.ts';
import { WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { ZONE_BROWSE_COST } from '../zone-modules/contract.ts';
import { CONCEPT_WORKS_COST, type ConceptWorksQuery, type FilteredWorksQuery } from '../concept-page/contract.ts';
import { compileReleaseQuery, relatedCondition, type ReleaseQuery } from '../facets/release-query.ts';
import type { ResourceListQuery, ResourceListPlan, ResourceCondition } from './resource-contract.ts';

export const QUERY_COST = {
  nodes: 32, depth: 4, graphReads: 7, candidateRows: 512,
  searchExecutions: 4, conceptReads: 3, deadlineMs: 10_000, searchPageSize: 64,
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

type ZoneRequest = { q?: string; sort: 'relevance' | 'newest' | 'updated'; type?: string[];
  concept?: string[]; excludeConcept?: string[];
  status?: ('ongoing' | 'completed' | 'hiatus')[]; excludeStatus?: ('ongoing' | 'completed' | 'hiatus')[];
  length?: string; language?: string; limit: number; cursor?: string };
type ConceptSelection = { operator: 'include' | 'exclude'; value: string; revision?: string };

export type CompiledQuery =
  | { template: 'resource-list'; request: ResourceListPlan; facets: string[]; graphReads: number }
  | { template: 'release-works'; request: ReleaseQuery; facets: string[]; graphReads: number }
  | { template: 'search'; request: SearchRequest; concept?: { value: string; revision?: string };
    facets: string[]; graphReads: number }
  | { template: 'search-concepts'; request: SearchRequest;
    concepts: ConceptSelection[]; includeMatch: 'all' | 'any';
    facets: string[]; graphReads: number }
  | { template: 'zone-browse'; realm: string; request: ZoneRequest;
    facets: string[]; graphReads: number }
  | { template: 'concept-works'; concept: string; request: ConceptWorksQuery | FilteredWorksQuery;
    facets: string[]; graphReads: number };

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const simple = (node: FilterNode): node is FilterCondition => 'facet' in node;
const fail = (message: string): never => { throw new QueryRejected('unsupported_query_shape', message); };

/** No terms are executed until the entire document and its cost pass admission. */
function admit(filter: FilterDocument | undefined, zone = false): { conditions: FilterCondition[]; facets: string[];
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
  // meaningful multiplicity in related release groups; other occurrence templates remain refused.
  if (!('all' in filter)) fail('A template for top-level any is not admitted');
  const conditions: FilterCondition[] = [];
  for (const node of (filter as { all: FilterNode[] }).all) {
    if (!simple(node)) fail('A template for nested boolean groups is not admitted');
    const condition = node as FilterCondition;
    if (condition.where && !relatedCondition(condition)) {
      fail('No admitted template binds this occurrence group');
    }
    if (!conditions.some(existing => JSON.stringify(existing) === JSON.stringify(condition))) conditions.push(condition);
  }
  // Zone include/exclude Conditions share the same bounded batch for each Facet.
  let graphReads = 0;
  for (const condition of zone ? [...new Map(conditions.map(item =>
    [resolveFacet(item.facet)!.id, item])).values()] : conditions) {
    const facet = resolveFacet(condition.facet)!;
    graphReads += facet.cost.graphReads;
  }
  if (graphReads > QUERY_COST.graphReads && anchoredConceptExclusion(conditions)) {
    graphReads -= resolveFacet('concept')!.cost.graphReads * 2;
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

type ConceptOperator = 'any' | 'all' | 'none';

function conceptOperator(condition: FilterCondition): ConceptOperator | undefined {
  const present = (['any', 'all', 'none'] as const).filter(operator => condition[operator] !== undefined);
  return present.length === 1 ? present[0] : undefined;
}

function conceptValues(condition: FilterCondition, operator: ConceptOperator): string[] | undefined {
  const found = condition[operator];
  if (!found?.length || found.some(value => typeof value !== 'string')) return undefined;
  return found as string[];
}

/**
 * The page Concept is an `all` or a one-value `any`, plus one additions
 * Condition. One included `all` stays match-all. A single multi-value `any`
 * is not an anchor; the caller compiles it as a union.
 */
function conceptPageAnchor(included: { operator: 'any' | 'all'; values: string[] }[]):
  { concept: string; include: string[]; match: 'all' | 'any' } | undefined {
  if (included.length === 1) {
    const only = included[0]!;
    if (only.operator === 'any' && only.values.length > 1) return undefined;
    return { concept: only.values[0]!, include: only.values.slice(1),
      match: only.operator === 'any' ? 'any' : 'all' };
  }
  if (included.length !== 2) return undefined;
  const allAnchor = included.findIndex(clause => clause.operator === 'all' && clause.values.length === 1);
  const anyAnchor = included.findIndex(clause => clause.operator === 'any' && clause.values.length === 1);
  const chosen = allAnchor >= 0 ? allAnchor : anyAnchor;
  if (chosen < 0) return undefined;
  const additions = included[1 - chosen]!;
  return { concept: included[chosen]!.values[0]!, include: additions.values, match: additions.operator };
}

/**
 * An anchored page with an exclusion is three Concept Conditions and one
 * visibility read. Charging the Facet per Condition would refuse that shape
 * before the template runs.
 */
function anchoredConceptExclusion(conditions: FilterCondition[]): boolean {
  const concepts = conditions.filter(condition => resolveFacet(condition.facet)?.name === 'concept');
  if (concepts.length !== 3 || concepts.some(condition => condition.interpretation || condition.applicability
    || condition.bind || condition.range || condition.where)) return false;
  const clauses = concepts.map(condition => {
    const operator = conceptOperator(condition);
    const chosen = operator ? conceptValues(condition, operator) : undefined;
    return operator && chosen ? { operator, values: chosen } : undefined;
  });
  if (clauses.some(clause => !clause)) return false;
  const typed = clauses as { operator: ConceptOperator; values: string[] }[];
  const excluded = typed.filter(clause => clause.operator === 'none');
  const included = typed.filter((clause): clause is { operator: 'any' | 'all'; values: string[] } =>
    clause.operator !== 'none');
  return excluded.length === 1 && conceptPageAnchor(included) !== undefined;
}

/** A Query body is filter-document-v1 or filter-document-v2. v1 cannot name the revision fields. */
export type AdmittedQuery = ResourceQuery | ResourceQueryV2;

/**
 * Compile only combinations whose existing template executes their full meaning.
 * Unsupported shapes fail before a graph or index read, never as zero matches.
 * Search delegates its complete-result budget (512 Works and a stable graph/text
 * snapshot); Zone browse delegates its 60-candidate window and 20-item page.
 * Release inventories filter before paging and continue over the complete graph population.
 */
export function compileQuery(query: AdmittedQuery | ResourceListQuery): CompiledQuery {
  if ('profile' in query && query.profile === 'resource-list-v1') {
    const input = query as ResourceListQuery;
    const admitted = admit(input.filter as FilterDocument | undefined, true);
    if (input.sort === 'relevance' && !input.q?.trim()) fail('Relevance needs text');
    if (input.scope.kind === 'realm' && (input.context === 'global' || input.context.realm !== input.scope.realm)) {
      fail('A Realm scope needs the same Realm Context');
    }
    if (input.scope.kind === 'all' && input.context !== 'global') fail('All uses the global Context');
    if (!Number.isInteger(input.limit ?? 20) || (input.limit ?? 20) < 1 || (input.limit ?? 20) > 64) {
      throw new QueryRejected('query_budget_exceeded', 'Resource page exceeds its bound');
    }
    const conditions: ResourceCondition[] = admitted.conditions.map(condition => {
      const name = resolveFacet(condition.facet)!.name;
      if (!['type', 'concept', 'language'].includes(name) || condition.bind || condition.interpretation
        || condition.applicability || condition.where || condition.range) fail(`${name} has no resource list template`);
      const operator = condition.any ? 'any' : condition.all ? 'all' : 'none';
      return { facet: name as ResourceCondition['facet'], operator, values: values(condition, operator) };
    });
    return { template: 'resource-list', request: { input, conditions },
      facets: admitted.facets, graphReads: admitted.graphReads };
  }
  const legacy = query as ResourceQuery | ResourceQueryV2;
  return compileLegacyQuery(legacy);
}

function compileLegacyQuery(query: ResourceQuery | ResourceQueryV2): CompiledQuery {
  if (query.sourcePolicy !== undefined || query.asOf !== undefined) {
    throw new QueryRejected('unsupported_query_source', 'Only the current product source is admitted');
  }
  const admitted = admit(query.filter, query.scope.kind === 'realm');
  const { conditions, facets, graphReads } = admitted;
  if (!Number.isInteger(query.page?.size) || query.page.size < 1) {
    throw new QueryRejected('invalid_query', 'Page size must be positive');
  }
  if (conditions.some(relatedCondition)) {
    return { template: 'release-works', request: compileReleaseQuery(query, conditions), facets, graphReads };
  }
  if (query.scope.kind === 'realm') {
    if (typeof query.context === 'string' || query.context.realm !== query.scope.realm) {
      fail('A Zone scope needs the same Realm Context');
    }
    if (query.page.size > QUERY_COST.zonePageSize) {
      throw new QueryRejected('query_budget_exceeded', 'Zone page exceeds its bound');
    }
    const zoneSort = query.sort === 'top-rated' ? fail('Zone browse has no top-rated template') : query.sort;
    const zoneText = query.text;
    if (zoneText && !('phrase' in zoneText)) fail('Zone browse admits one phrase');
    const request: ZoneRequest = { sort: zoneSort, limit: query.page.size };
    if (zoneText && 'phrase' in zoneText) request.q = zoneText.phrase;
    const continuation = query.page.continuation;
    if (continuation !== undefined) {
      if (typeof continuation !== 'string') fail('Zone continuation has the wrong form');
      request.cursor = continuation as string;
    }
    for (const condition of conditions) {
      const facet = resolveFacet(condition.facet)!;
      if (!['type', 'concept', 'status', 'length'].includes(facet.name)) {
        fail(`${facet.name} has no Zone browse template`);
      }
      if (condition.interpretation || condition.applicability || condition.bind) {
        fail(`${facet.name} qualifiers have no Zone browse template`);
      }
      if (facet.name === 'length') {
        if (!condition.range || request.length !== undefined) fail('Length needs one range');
        request.length = `${condition.range!.min ?? ''}-${condition.range!.max ?? ''}`;
        continue;
      }
      const operator = condition.any ? 'any' : condition.none ? 'none' : fail(`${facet.name} all has no Zone browse template`);
      const chosen = values(condition, operator);
      if (chosen.length > ZONE_BROWSE_COST.filterValues) {
        throw new QueryRejected('query_budget_exceeded', 'Zone Condition exceeds its value bound');
      }
      if (facet.name === 'type') {
        if (operator !== 'any' || request.type?.length) fail('Type needs one any Zone Condition');
        if (chosen.some(type => !(WORK_SEMANTIC_TYPES as readonly string[]).includes(type))) {
          fail('Zone browse does not admit this Work type');
        }
        request.type = chosen;
      } else if (facet.name === 'concept') {
        const key = operator === 'any' ? 'concept' : 'excludeConcept';
        if (request[key]?.length) fail('Concept has multiple Zone Conditions with the same operator');
        if (chosen.some(value => !nativeId.test(value))) fail('Zone browse needs native Concept IDs');
        request[key] = chosen;
      } else {
        const key = operator === 'any' ? 'status' : 'excludeStatus';
        if (request[key]?.length) fail('Status has multiple Zone Conditions with the same operator');
        request[key] = chosen as NonNullable<ZoneRequest['status']>;
      }
    }
    if (query.sort === 'relevance' && !query.text) fail('Relevance needs text');
    return { template: 'zone-browse', realm: query.scope.realm, request, facets, graphReads };
  }
  // The Concept page's bounded projection is the no-text Query template.
  // Newest is the Concept page; top-rated, Mine and exclude-only are Discover.
  if (!query.text && (query.sort === 'newest' || query.sort === 'top-rated')) {
    if (query.page.size > CONCEPT_WORKS_COST.pageSize) {
      throw new QueryRejected('query_budget_exceeded', 'Concept Works page exceeds its bound');
    }
    const revised = 'profile' in query ? query : undefined;
    const mine = query.scope.kind === 'mine';
    const top = query.sort === 'top-rated';
    const ratingContext = revised?.ratingContext;
    const actingSubject = revised?.actingSubject;
    const request: ConceptWorksQuery = { limit: query.page.size,
      ...(mine || query.context === 'global' ? { scope: 'global' }
        : { scope: 'realm', realm: query.context.realm }) };
    if (query.page.continuation !== undefined) {
      if (typeof query.page.continuation !== 'string') fail('Concept Works continuation has the wrong form');
      request.cursor = query.page.continuation as string;
    }
    let excluded: string[] | undefined;
    const includedClauses: { operator: 'any' | 'all'; values: string[] }[] = [];
    for (const condition of conditions) {
      const facet = resolveFacet(condition.facet)!;
      if (condition.interpretation || condition.applicability || condition.bind || condition.range) {
        fail(`${facet.name} qualifiers have no Concept Works template`);
      }
      if (facet.name === 'type' && condition.any?.length === 1 && !request.type) {
        const type = values(condition, 'any')[0]!;
        if (!(WORK_SEMANTIC_TYPES as readonly string[]).includes(type)) fail('Concept Works does not admit this type');
        request.type = type as NonNullable<ConceptWorksQuery['type']>;
      } else if (facet.name === 'concept') {
        const operator = conceptOperator(condition);
        const chosen = operator ? conceptValues(condition, operator) : undefined;
        if (!operator || !chosen) fail('concept Condition needs one operator');
        else if (operator === 'none') {
          if (excluded) fail('Concept Works admits one exclusion');
          excluded = chosen;
        } else includedClauses.push({ operator, values: chosen });
      } else fail(`${facet.name} has no Concept Works template`);
    }
    const distinct = (list: readonly string[] | undefined) => !!list?.length
      && list.every(value => nativeId.test(value)) && new Set(list).size === list.length;
    // A plain any of several Concepts is a union: Discover's newest shelf sends
    // that shape and has no page Concept. The Concept page is a separate anchor
    // Condition plus any of the additions. Top-rated, Mine and exclude-only stay
    // on the same union path.
    const plainUnion = includedClauses.length === 1 && includedClauses[0]!.operator === 'any'
      && includedClauses[0]!.values.length > 1;
    if (includedClauses.length > 1 && (mine || top)) fail('Top-rated and Mine keep one Concept Condition');
    if (mine || top || plainUnion || !includedClauses.length) {
      const included = includedClauses[0]?.values;
      if (includedClauses[0]) request.match = includedClauses[0].operator === 'any' ? 'any' : 'all';
      if ((included && !distinct(included)) || (excluded && !distinct(excluded))
        || excluded?.some(value => included?.includes(value))
        || (!included?.length && !excluded?.length)) {
        fail('Concept Works needs visible, distinct native Concept values');
      }
      if (top && !ratingContext) fail('Top-rated needs a rating Context');
      if (mine && (!actingSubject || !ratingContext)) fail('Mine needs the reader and a rating Context');
      if ((top || mine) && !nativeId.test(ratingContext ?? '')) fail('Rating Context needs a native ID');
      if (mine && !nativeId.test(actingSubject ?? '')) fail('Mine needs a native reader');
      const filtered: FilteredWorksQuery = { ...request, role: 'filter', scope: mine ? 'mine' : request.scope,
        sort: top ? 'top-rated' : 'recent',
        ...(top || mine ? { context: ratingContext } : {}),
        ...(mine ? { actingSubject } : {}),
        ...(included?.length ? { include: included } : {}),
        ...(excluded?.length ? { exclude: excluded } : {}) };
      return { template: 'concept-works', concept: (included ?? excluded)![0]!, request: filtered, facets, graphReads };
    }
    if (includedClauses.length > 2) fail('Concept Works admits an anchor and one additions Condition');
    const anchor = conceptPageAnchor(includedClauses)
      ?? fail('A multi-value Concept any needs an anchor Condition');
    const pageValues = [anchor.concept, ...anchor.include, ...(excluded ?? [])];
    if (pageValues.some(value => !nativeId.test(value)) || new Set(pageValues).size !== pageValues.length
      || (excluded && !distinct(excluded))) {
      fail('Concept Works needs visible, distinct native Concept values');
    }
    request.match = anchor.match;
    if (anchor.include.length) request.include = anchor.include;
    if (excluded?.length) request.exclude = excluded;
    return { template: 'concept-works', concept: anchor.concept, request, facets, graphReads };
  }
  if (query.scope.kind === 'mine') fail('Mine has no phrase template');
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
  const concepts: ConceptSelection[] = [];
  let includeMatch: 'all' | 'any' = 'all';
  let hasIncludedConcepts = false, hasExcludedConcepts = false;
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
        if (!chosen?.length || (interpretation && !('definition' in interpretation))) {
          fail('Search needs a Concept Condition with a supported interpretation');
        }
        if (operator === 'none' ? hasExcludedConcepts : hasIncludedConcepts) {
          fail('Multiple Concept Conditions with the same operator have no search template');
        }
        if (operator === 'none') hasExcludedConcepts = true;
        else { hasIncludedConcepts = true; includeMatch = operator; }
        if (chosen!.length > 1 && interpretation) {
          fail('One interpretation revision cannot describe several Concepts');
        }
        concepts.push(...values(condition, operator).map(value => ({
          operator: operator === 'none' ? 'exclude' as const : 'include' as const, value,
          ...interpretation && 'definition' in interpretation ? { revision: interpretation.definition } : {},
        })));
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
    throw new QueryRejected('query_budget_exceeded', 'Concept set exceeds its bounded reads');
  }
  if (concepts.length > 1 || concepts[0]?.operator === 'exclude') {
    if (request.ratingContext) fail('Concept set has no rated search template');
    request.profile = realm ? 'public-realm-phrase-v1' : 'public-main-phrase-v1';
    delete request.pageSize;
    delete request.continuation;
    return { template: 'search-concepts', request, concepts, includeMatch, facets, graphReads };
  }
  const concept = concepts[0];
  request.profile = !request.phrase ? 'public-main-title-body-page-v1'
    : request.ratingContext ? 'public-realm-classified-rated-phrase-page-v1'
      : concept ? realm ? 'public-realm-classified-phrase-page-v1' : 'public-main-classified-phrase-page-v1'
        : realm ? 'public-realm-phrase-page-v1' : 'public-main-phrase-page-v1';
  return { template: 'search', request,
    ...concept ? { concept: { value: concept.value, revision: concept.revision } } : {}, facets, graphReads };
}
