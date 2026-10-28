import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../rating/votes.ts';
import { routeOf } from '../route/route.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { subjectAlias, subjectGenerations, subjectIndexName } from './indices.ts';
import { OpenSearchError, type OpenSearch, SearchUnavailableError } from './opensearch.ts';
import type { SearchPlan, SearchResult } from './query.ts';
import type { PublicRatingEpoch } from './rating-source.ts';

export type RatingQueryPlan = Pick<
  SearchPlan,
  'query' | 'filter' | 'boost' | 'size' | 'after' | 'overflowProperties' | 'ratingPhase' | 'generation'
> & { rating: PublicRatingEpoch };

type Phase = 'scored' | 'unscored';
type SortValue = string | number | null;
type Total = { value: number; relation: 'eq' | 'gte' };
type NativePhase = { hits: SearchResult['hits']; total: Total; overflow: boolean };

const MAX_NAME_LENGTH = 512;
const TOTAL_LIMIT = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(message: string, cause?: unknown): SearchUnavailableError {
  return new SearchUnavailableError(message, cause === undefined ? undefined : { cause });
}

function isRoutableId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && routeOf(value) !== null;
}

function isName(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= MAX_NAME_LENGTH && value.isWellFormed());
}

function admittedRating(value: unknown): PublicRatingEpoch {
  if (!record(value)) throw new TypeError('Invalid Global rating query metadata');
  const keys = Reflect.ownKeys(value);
  const expected = ['questionId', 'populationId', 'priorEpoch'];
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key)))
    throw new TypeError('Invalid Global rating query metadata');

  const properties: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid Global rating query metadata');
    properties[key] = descriptor.value;
  }

  if (
    properties.questionId !== STANDARD_QUESTION_ID ||
    properties.populationId !== GLOBAL_CONTEXT.id ||
    !(
      properties.priorEpoch === null ||
      (Number.isSafeInteger(properties.priorEpoch) && Number(properties.priorEpoch) > 0)
    )
  )
    throw new TypeError('Invalid Global rating query metadata');

  return properties as PublicRatingEpoch;
}

function validatePlan(
  prefix: string,
  plan: RatingQueryPlan,
): {
  rating: PublicRatingEpoch;
  phase: Phase;
  after?: readonly SortValue[];
  query?: Record<string, unknown>;
  filter?: Record<string, unknown>;
} {
  const rating = admittedRating(plan?.rating);
  if (!Number.isInteger(plan.size) || plan.size < 1 || plan.size > 200)
    throw new RangeError('Search size must be an integer from 1 to 200');
  subjectAlias(prefix);
  if (plan.generation !== undefined) subjectIndexName(prefix, plan.generation);

  const phase = plan.ratingPhase;
  if (
    (phase !== undefined && phase !== 'scored' && phase !== 'unscored') ||
    (phase === 'scored' && rating.priorEpoch === null)
  )
    throw new TypeError('Invalid rating query phase');

  const after = plan.after;
  if (after !== undefined) {
    const scored = phase === 'scored';
    if (!Array.isArray(after) || phase === undefined || after.length !== (scored ? 3 : 2))
      throw new TypeError('Invalid rating query tuple');
    const score: unknown = after[0];
    const name: unknown = after[scored ? 1 : 0];
    const id: unknown = after[scored ? 2 : 1];
    if (
      (scored && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10)) ||
      !isName(name) ||
      !isRoutableId(id)
    )
      throw new TypeError('Invalid rating query tuple');
  }

  if (plan.query !== undefined && !record(plan.query)) throw new TypeError('Invalid rating query');
  if (plan.filter !== undefined && !record(plan.filter)) throw new TypeError('Invalid rating filter');
  const overflowProperties = plan.overflowProperties;
  if (
    overflowProperties !== undefined &&
    (!Array.isArray(overflowProperties) || overflowProperties.some((property) => typeof property !== 'string'))
  )
    throw new TypeError('Invalid rating overflow properties');

  return {
    rating,
    phase: phase ?? (rating.priorEpoch === null ? 'unscored' : 'scored'),
    ...(after === undefined ? {} : { after }),
    ...(plan.query === undefined ? {} : { query: plan.query }),
    ...(plan.filter === undefined ? {} : { filter: plan.filter }),
  };
}

function readTotal(value: unknown): Total {
  if (
    !record(value) ||
    typeof value.value !== 'number' ||
    !Number.isSafeInteger(value.value) ||
    value.value < 0 ||
    (value.relation !== 'eq' && value.relation !== 'gte')
  )
    throw unavailable('OpenSearch rating total is missing or malformed');
  return { value: value.value, relation: value.relation };
}

function readOverflow(body: Record<string, unknown>, hasOverflow: boolean): boolean {
  if (!hasOverflow) return false;
  const aggregations = body.aggregations;
  const overflow = record(aggregations) ? aggregations.overflow : undefined;
  const count = record(overflow) ? overflow.doc_count : undefined;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
    throw unavailable('OpenSearch rating overflow aggregation is missing or malformed');
  return count > 0;
}

function validateHits(value: unknown, size: number, phase: Phase, index: string): SearchResult['hits'] {
  if (!Array.isArray(value) || value.length > size)
    throw unavailable('OpenSearch rating hits are missing or exceed the requested size');

  const hits: SearchResult['hits'] = [];
  for (const candidate of value) {
    if (!record(candidate)) throw unavailable('OpenSearch rating hit is malformed');
    const id = candidate._id;
    const actualIndex = candidate._index;
    const source = candidate._source;
    const sort = candidate.sort;
    if (
      !isRoutableId(id) ||
      typeof actualIndex !== 'string' ||
      actualIndex !== index ||
      !record(source) ||
      !Number.isSafeInteger(source.partition) ||
      Number(source.partition) < 0 ||
      Number(source.partition) >= 4096 ||
      Number(source.partition) !== routeOf(id)! >>> 4 ||
      !Number.isSafeInteger(source.security_revision) ||
      Number(source.security_revision) < 0 ||
      !Array.isArray(sort)
    )
      throw unavailable('OpenSearch rating hit is malformed');

    const scored = phase === 'scored';
    const name = sort[scored ? 1 : 0];
    const sortId = sort[scored ? 2 : 1];
    if (
      sort.length !== (scored ? 3 : 2) ||
      (scored && (typeof sort[0] !== 'number' || !Number.isFinite(sort[0]) || sort[0] < 0 || sort[0] > 10)) ||
      !isName(name) ||
      !isRoutableId(sortId) ||
      sortId !== id
    )
      throw unavailable('OpenSearch rating sort tuple is malformed');

    const matchedQueries = candidate.matched_queries;
    if (
      matchedQueries !== undefined &&
      (!Array.isArray(matchedQueries) || matchedQueries.some((item) => typeof item !== 'string'))
    )
      throw unavailable('OpenSearch rating matched queries are malformed');

    hits.push({
      id,
      index: actualIndex,
      partition: Number(source.partition),
      securityRevision: Number(source.security_revision),
      matched: matchedQueries === undefined ? [] : matchedQueries,
      sort: sort as SortValue[],
      ratingPhase: phase,
    });
  }
  return hits;
}

function nativeQuery(
  baseFilter: Record<string, unknown> | undefined,
  phase: Phase,
  epoch: number | null,
): { filter?: Record<string, unknown>; hasFilter: boolean } {
  const filters: Record<string, unknown>[] = [];
  if (baseFilter !== undefined) filters.push(baseFilter);
  if (phase === 'scored') {
    if (epoch === null) throw new TypeError('Scored rating search requires an eligible epoch');
    filters.push({
      bool: {
        filter: [{ term: { rating_prior_epoch: epoch } }, { exists: { field: 'rating_score' } }],
      },
    });
  } else if (epoch !== null) {
    filters.push({
      bool: {
        must_not: [
          {
            bool: {
              filter: [{ term: { rating_prior_epoch: epoch } }, { exists: { field: 'rating_score' } }],
            },
          },
        ],
      },
    });
  }

  const combined = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : { bool: { filter: filters } };
  return { ...(combined === undefined ? {} : { filter: combined }), hasFilter: combined !== undefined };
}

async function resolveGeneration(search: OpenSearch, prefix: string, requested?: number): Promise<number> {
  let state: Awaited<ReturnType<typeof subjectGenerations>>;
  try {
    state = await subjectGenerations(search, prefix);
  } catch (error) {
    if (error instanceof OpenSearchError && error.type === 'index_not_found_exception')
      throw unavailable('Pinned subject generation is unavailable', error);
    throw error;
  }

  if (
    !state ||
    !Array.isArray(state.generations) ||
    state.generations.some((generation) => !Number.isSafeInteger(generation) || generation < 1) ||
    !(state.active === null || (Number.isSafeInteger(state.active) && state.active > 0))
  )
    throw unavailable('Subject generation metadata is missing or malformed');

  const generation = requested ?? state.active;
  if (generation === null || generation === undefined || !state.generations.includes(generation))
    throw unavailable('Pinned subject generation is unavailable');
  // Validate the exact physical target before any search is sent. The alias is never a phase target.
  subjectIndexName(prefix, generation);
  return generation;
}

async function searchPhase(
  search: OpenSearch,
  prefix: string,
  target: string,
  templateId: string,
  plan: RatingQueryPlan,
  query: Record<string, unknown> | undefined,
  baseFilter: Record<string, unknown> | undefined,
  phase: Phase,
  size: number,
  after?: readonly SortValue[],
  countOnly = false,
): Promise<NativePhase> {
  const filter = nativeQuery(baseFilter, phase, plan.rating.priorEpoch);
  const hasOverflow = (plan.overflowProperties?.length ?? 0) > 0;
  const sort = countOnly
    ? []
    : phase === 'scored'
      ? [{ rating_score: 'desc' }, { name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }]
      : [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }];
  const params = {
    query,
    has_query: query !== undefined,
    filter: filter.filter,
    has_filter: filter.hasFilter,
    boost: plan.boost === undefined ? undefined : JSON.stringify(plan.boost),
    has_boost: plan.boost !== undefined,
    sort,
    size,
    after: countOnly ? undefined : after,
    has_after: !countOnly && after !== undefined,
    has_overflow: hasOverflow,
    overflow_properties: plan.overflowProperties,
  };

  let response: Awaited<ReturnType<OpenSearch['request']>>;
  try {
    response = await search.request(
      'POST',
      `/${target}/_search/template`,
      {
        id: `${prefix}${templateId}`,
        params,
      },
      { query: { allow_partial_search_results: false } },
    );
  } catch (error) {
    if (error instanceof OpenSearchError && error.type === 'index_not_found_exception')
      throw unavailable('Pinned subject generation is unavailable', error);
    throw error;
  }

  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300)
    throw unavailable('OpenSearch rating search status is missing or unsuccessful');
  const body: unknown = response.body;
  assertCompleteSearch(body);
  if (!record(body) || !record(body.hits)) throw unavailable('OpenSearch rating response is malformed');
  const total = readTotal(body.hits.total);
  const hits = validateHits(body.hits.hits, size, phase, target);
  return { hits, total, overflow: readOverflow(body, hasOverflow) };
}

function combinedTotal(a: Total, b: Total): SearchResult['total'] {
  const sum = a.value + b.value;
  return {
    value: Math.min(TOTAL_LIMIT, sum),
    relation: a.relation === 'eq' && b.relation === 'eq' && sum <= TOTAL_LIMIT ? 'exact' : 'lower_bound',
  };
}

/** Search the native scored phase followed by its exact unscored complement on one pinned generation. */
export async function searchRatingSubjects(
  search: OpenSearch,
  prefix: string,
  plan: RatingQueryPlan,
  templateId: string,
): Promise<SearchResult> {
  const admitted = validatePlan(prefix, plan);
  const generation = await resolveGeneration(search, prefix, plan.generation);
  const target = subjectIndexName(prefix, generation);
  const epoch = admitted.rating.priorEpoch;
  const overflowProperties = plan.overflowProperties;

  let a: NativePhase = { hits: [], total: { value: 0, relation: 'eq' }, overflow: false };
  let b: NativePhase;
  const hits: SearchResult['hits'] = [];

  if (epoch !== null && admitted.phase === 'scored') {
    a = await searchPhase(
      search,
      prefix,
      target,
      templateId,
      plan,
      admitted.query,
      admitted.filter,
      'scored',
      plan.size,
      admitted.after,
    );
    hits.push(...a.hits);
    const bSize = a.hits.length < plan.size ? plan.size - a.hits.length : 0;
    b = await searchPhase(
      search,
      prefix,
      target,
      templateId,
      plan,
      admitted.query,
      admitted.filter,
      'unscored',
      bSize,
      undefined,
      bSize === 0,
    );
    hits.push(...b.hits);
  } else {
    if (epoch !== null) {
      a = await searchPhase(
        search,
        prefix,
        target,
        templateId,
        plan,
        admitted.query,
        admitted.filter,
        'scored',
        0,
        undefined,
        true,
      );
    }
    b = await searchPhase(
      search,
      prefix,
      target,
      templateId,
      plan,
      admitted.query,
      admitted.filter,
      'unscored',
      plan.size,
      admitted.after,
    );
    hits.push(...b.hits);
  }

  const total = combinedTotal(a.total, b.total);
  return {
    generation,
    hits,
    total,
    ...(overflowProperties?.length ? { overflow: a.overflow || b.overflow } : {}),
  };
}
