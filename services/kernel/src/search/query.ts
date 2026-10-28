import { readFileSync } from 'node:fs';
import type { Facet } from './facets.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { subjectAlias, subjectIndexName } from './indices.ts';
import type { OpenSearch } from './opensearch.ts';
import type { RatingPhase } from './rating-cursor.ts';
import { searchRatingSubjects } from './rating-query.ts';
import type { PublicRatingEpoch } from './rating-source.ts';

// Released templates keep their source and id; changes require a new version of both.
export const SEARCH_TEMPLATE = 'subjects-search-v2';
export const SUGGEST_TEMPLATE = 'subjects-suggest-v1';
export const FACET_TEMPLATE = 'subjects-facets-v1';
export const TOTAL_LIMIT = 10_000;

const templates = [SEARCH_TEMPLATE, SUGGEST_TEMPLATE].map((name) => ({
  name,
  body: JSON.parse(readFileSync(new URL(`../../db/search/templates/${name}.json`, import.meta.url), 'utf8')) as unknown,
}));

// Kept here with its versioned id; all untrusted input is serialized through toJson.
templates.push({
  name: FACET_TEMPLATE,
  body: {
    script: {
      lang: 'mustache',
      source: `{
        "size": 0,
        "track_total_hits": 10000,
        "query": {{#toJson}}query{{/toJson}},
        "aggs": {{#toJson}}aggregations{{/toJson}}
      }`,
    },
  },
});

type SortValue = string | number | null;

export type SearchPlan = {
  query?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  boost?: string;
  sort: 'relevance' | 'name' | 'id' | 'collections' | 'rating';
  /** Internal native planner metadata, never HTTP body selectors. */
  rating?: PublicRatingEpoch;
  ratingPhase?: RatingPhase;
  generation?: number;
  size: number;
  after?: readonly SortValue[];
  /** Distinct statement properties in the admitted filter. */
  overflowProperties?: readonly string[];
};

export type SubjectHit = {
  id: string;
  index: string;
  partition: number;
  securityRevision: number;
};

export type SearchHit = SubjectHit & {
  ratingPhase?: RatingPhase;
  matched: string[];
  sort: SortValue[];
};

export type SearchResult = {
  generation?: number;
  hits: SearchHit[];
  total: { value: number; relation: 'exact' | 'lower_bound' };
  overflow?: boolean;
};

type StoredHit = {
  _id: string;
  _index: string;
  _source: { partition: number; security_revision: number };
  matched_queries?: string[];
  sort: SortValue[];
};

type SearchResponse = {
  hits: {
    hits: StoredHit[];
    total: { value: number; relation: 'eq' | 'gte' };
  };
  aggregations?: { overflow: { doc_count: number } };
};

function validateSize(size: number, maximum: number): void {
  if (!Number.isInteger(size) || size < 1 || size > maximum)
    throw new RangeError(`Search size must be an integer from 1 to ${maximum}`);
}

function subjectHit(hit: StoredHit): SubjectHit {
  return {
    id: hit._id,
    index: hit._index,
    partition: hit._source.partition,
    securityRevision: hit._source.security_revision,
  };
}

export async function installTemplates(search: OpenSearch, prefix: string): Promise<void> {
  subjectAlias(prefix);
  for (const { name, body } of templates) await search.request('PUT', `/_scripts/${prefix}${name}`, body);
}

export function searchSubjects(search: OpenSearch, prefix: string, plan: SearchPlan): Promise<SearchResult> {
  validateSize(plan.size, 200);
  if (plan.sort === 'rating')
    return searchRatingSubjects(search, prefix, { ...plan, rating: plan.rating! }, SEARCH_TEMPLATE);
  const target = plan.generation === undefined ? subjectAlias(prefix) : subjectIndexName(prefix, plan.generation);
  const hasOverflow = (plan.overflowProperties?.length ?? 0) > 0;
  const sort =
    plan.sort === 'relevance'
      ? [{ _score: 'desc' }, { id: 'asc' }]
      : plan.sort === 'name'
        ? [{ name_sort: 'asc' }, { id: 'asc' }]
        : plan.sort === 'collections'
          ? [{ public_collection_count: { order: 'desc', missing: 0 } }, { name_sort: 'asc' }, { id: 'asc' }]
          : [{ id: 'asc' }];

  return search
    .request<SearchResponse>(
      'POST',
      `/${target}/_search/template`,
      {
        id: `${prefix}${SEARCH_TEMPLATE}`,
        params: {
          query: plan.query,
          has_query: plan.query !== undefined,
          filter: plan.filter,
          has_filter: plan.filter !== undefined,
          // OpenSearch's toJson serializes containers but emits scalar strings verbatim.
          // Encode string scalars first so quotes and control characters remain JSON data.
          boost: plan.boost === undefined ? undefined : JSON.stringify(plan.boost),
          has_boost: plan.boost !== undefined,
          sort,
          size: plan.size,
          after: plan.after,
          has_after: plan.after !== undefined,
          has_overflow: hasOverflow,
          overflow_properties: plan.overflowProperties,
        },
      },
      { query: { allow_partial_search_results: false } },
    )
    .then(({ body }) => {
      assertCompleteSearch(body);
      return {
        ...(plan.generation === undefined ? {} : { generation: plan.generation }),
        hits: body.hits.hits.map((hit) => ({
          ...subjectHit(hit),
          matched: hit.matched_queries ?? [],
          sort: hit.sort,
        })),
        total: {
          value: body.hits.total.value,
          relation: body.hits.total.relation === 'gte' ? 'lower_bound' : 'exact',
        },
        ...(hasOverflow ? { overflow: body.aggregations!.overflow.doc_count > 0 } : {}),
      };
    });
}

export function suggestSubjects(
  search: OpenSearch,
  prefix: string,
  plan: { text: string; size: number },
): Promise<SubjectHit[]> {
  validateSize(plan.size, 50);
  const alias = subjectAlias(prefix);
  return search
    .request<SearchResponse>(
      'POST',
      `/${alias}/_search/template`,
      {
        id: `${prefix}${SUGGEST_TEMPLATE}`,
        params: { text: JSON.stringify(plan.text), size: plan.size },
      },
      { query: { allow_partial_search_results: false } },
    )
    .then(({ body }) => {
      assertCompleteSearch(body);
      return body.hits.hits.map(subjectHit);
    });
}

type FacetAggregation =
  | { values: { buckets: { key: string; doc_count: number }[] } }
  | { facts: { property: { values: { buckets: { key: string; subjects: { doc_count: number } }[] } } } };

type FacetAggregations = Record<`facet_${number}`, FacetAggregation>;

type FacetResponse = {
  hits: { total: { value: number; relation: 'eq' | 'gte' } };
  aggregations: FacetAggregations & {
    [key: `overflow_${number}`]: { doc_count: number } | undefined;
    filter_overflow?: { doc_count: number };
    definite?: FacetAggregations & { doc_count: number };
  };
};

export async function countFacets(
  search: OpenSearch,
  prefix: string,
  plan: {
    query?: Record<string, unknown>;
    filter?: Record<string, unknown>;
    /** Distinct statement properties in the admitted filter. */
    overflowProperties?: readonly string[];
    facets: readonly Facet[];
    sample: number;
  },
) {
  const facetAggregations = Object.fromEntries(
    plan.facets.map(({ property, size }, index) => [
      `facet_${index}`,
      {
        sampler: { shard_size: plan.sample },
        aggs:
          property === 'type'
            ? {
                values: {
                  terms: { field: 'type', size: 2 * size, order: [{ _count: 'desc' }, { _key: 'asc' }] },
                },
              }
            : {
                facts: {
                  nested: { path: 'facts' },
                  aggs: {
                    property: {
                      filter: { term: { 'facts.property': property } },
                      aggs: {
                        values: {
                          terms: {
                            field: 'facts.value',
                            size: 2 * size,
                            order: [{ subjects: 'desc' }, { _key: 'asc' }],
                          },
                          aggs: { subjects: { reverse_nested: {} } },
                        },
                      },
                    },
                  },
                },
              },
      },
    ]),
  );
  const filterOverflow = plan.overflowProperties?.length
    ? { terms: { relation_facet_overflow: plan.overflowProperties } }
    : undefined;
  // Probe all candidates, outside the sampler: a missing sampled value can still make a facet incomplete.
  const aggregations = {
    ...Object.fromEntries(
      plan.facets.map(({ property }, index) => [
        `overflow_${index}`,
        { filter: { term: { relation_facet_overflow: property } } },
      ]),
    ),
    ...(filterOverflow
      ? {
          filter_overflow: { filter: filterOverflow },
          // Candidate filter truth is unresolved on these markers. Only definite matches may add counts.
          definite: { filter: { bool: { must_not: [filterOverflow] } }, aggs: facetAggregations },
        }
      : facetAggregations),
  };
  const { body } = await search.request<FacetResponse>(
    'POST',
    `/${subjectAlias(prefix)}/_search/template`,
    {
      id: `${prefix}${FACET_TEMPLATE}`,
      params: {
        query: { bool: { must: plan.query ?? { match_all: {} }, ...(plan.filter ? { filter: plan.filter } : {}) } },
        aggregations,
      },
    },
    { query: { allow_partial_search_results: false } },
  );
  assertCompleteSearch(body);
  const unresolved = (body.aggregations.filter_overflow?.doc_count ?? 0) > 0;
  const total: SearchResult['total'] = unresolved
    ? { value: Math.min(TOTAL_LIMIT, body.aggregations.definite!.doc_count), relation: 'lower_bound' }
    : {
        value: body.hits.total.value,
        relation: body.hits.total.relation === 'eq' ? 'exact' : 'lower_bound',
      };
  const relation: SearchResult['total']['relation'] =
    total.relation === 'exact' && total.value <= plan.sample ? 'exact' : 'lower_bound';
  return {
    total,
    facets: plan.facets.map(({ property }, index) => {
      const aggregation = (filterOverflow ? body.aggregations.definite! : body.aggregations)[`facet_${index}`]!;
      const values =
        'values' in aggregation
          ? aggregation.values.buckets.map(({ key, doc_count }) => ({ value: key, count: doc_count }))
          : aggregation.facts.property.values.buckets.map(({ key, subjects }) => ({
              value: key,
              count: subjects.doc_count,
            }));
      return {
        property,
        relation: (body.aggregations[`overflow_${index}`]?.doc_count ?? 0) > 0 ? 'lower_bound' : relation,
        values: values.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
      };
    }),
  };
}
