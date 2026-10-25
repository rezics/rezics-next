import { readFileSync } from 'node:fs';
import { subjectAlias } from './indices.ts';
import type { OpenSearch } from './opensearch.ts';

// Released templates keep their source and id; changes require a new version of both.
export const SEARCH_TEMPLATE = 'subjects-search-v1';
export const SUGGEST_TEMPLATE = 'subjects-suggest-v1';
export const TOTAL_LIMIT = 10_000;

const templates = [SEARCH_TEMPLATE, SUGGEST_TEMPLATE].map((name) => ({
  name,
  body: JSON.parse(readFileSync(new URL(`../../db/search/templates/${name}.json`, import.meta.url), 'utf8')) as unknown,
}));

type SortValue = string | number | null;

export type SearchPlan = {
  query?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  boost?: string;
  sort: 'relevance' | 'name' | 'id';
  size: number;
  after?: readonly SortValue[];
};

export type SubjectHit = {
  id: string;
  index: string;
  partition: number;
  securityRevision: number;
};

export type SearchHit = SubjectHit & {
  matched: string[];
  sort: SortValue[];
};

export type SearchResult = {
  hits: SearchHit[];
  total: { value: number; relation: 'exact' | 'lower_bound' };
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
  const alias = subjectAlias(prefix);
  const sort =
    plan.sort === 'relevance'
      ? [{ _score: 'desc' }, { id: 'asc' }]
      : plan.sort === 'name'
        ? [{ name_sort: 'asc' }, { id: 'asc' }]
        : [{ id: 'asc' }];

  return search
    .request<SearchResponse>('POST', `/${alias}/_search/template`, {
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
      },
    })
    .then(({ body }) => ({
      hits: body.hits.hits.map((hit) => ({
        ...subjectHit(hit),
        matched: hit.matched_queries ?? [],
        sort: hit.sort,
      })),
      total: {
        value: body.hits.total.value,
        relation: body.hits.total.relation === 'gte' ? 'lower_bound' : 'exact',
      },
    }));
}

export function suggestSubjects(
  search: OpenSearch,
  prefix: string,
  plan: { text: string; size: number },
): Promise<SubjectHit[]> {
  validateSize(plan.size, 50);
  const alias = subjectAlias(prefix);
  return search
    .request<SearchResponse>('POST', `/${alias}/_search/template`, {
      id: `${prefix}${SUGGEST_TEMPLATE}`,
      params: { text: JSON.stringify(plan.text), size: plan.size },
    })
    .then(({ body }) => body.hits.hits.map(subjectHit));
}
