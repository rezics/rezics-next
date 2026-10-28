import { subjectPartition } from './source.ts';
import { SearchUnavailableError } from './opensearch.ts';

type RecordValue = Record<string, unknown>;
type NativeSortValue = string | number | null;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(): never {
  throw new SearchUnavailableError('OpenSearch query payload is missing or malformed');
}

function safeCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function hitsOf(body: unknown, maximum: number, total: boolean): RecordValue[] {
  if (!record(body) || !record(body.hits) || !Array.isArray(body.hits.hits) || body.hits.hits.length > maximum) fail();
  if (total) {
    const nativeTotal = body.hits.total;
    if (
      !record(nativeTotal) ||
      !safeCount(nativeTotal.value, 10_000) ||
      (nativeTotal.relation !== 'eq' && nativeTotal.relation !== 'gte')
    )
      fail();
  }
  return body.hits.hits.map((hit) => {
    if (!record(hit) || !uuid(hit._id) || typeof hit._index !== 'string' || !record(hit._source)) fail();
    let partition: number;
    try {
      partition = subjectPartition(hit._id);
    } catch {
      return fail();
    }
    if (
      !safeCount(hit._source.partition, 4095) ||
      hit._source.partition !== partition ||
      !safeCount(hit._source.security_revision)
    )
      fail();
    return hit;
  });
}

export function admitSearchPayload(
  body: unknown,
  plan: { size: number; sort: 'relevance' | 'name' | 'id' | 'collections' | 'rating'; generation?: number },
  prefix: string,
): asserts body is RecordValue {
  const hits = hitsOf(body, plan.size, true);
  const physicalIndex = new RegExp(`^${prefix}subjects-g([1-9][0-9]*)$`);
  for (const hit of hits) {
    const index = physicalIndex.exec(hit._index as string);
    if (!index || (plan.generation !== undefined && Number(index[1]) !== plan.generation)) fail();
    if (
      !Array.isArray(hit.sort) ||
      ('matched_queries' in hit &&
        (!Array.isArray(hit.matched_queries) || !hit.matched_queries.every((item) => typeof item === 'string')))
    )
      fail();
    const tuple = hit.sort as unknown[];
    const id = tuple[plan.sort === 'id' ? 0 : tuple.length - 1];
    if (!uuid(id)) fail();
    if (plan.sort === 'id') {
      if (tuple.length !== 1 || tuple[0] !== hit._id) fail();
    } else if (plan.sort === 'name') {
      if (tuple.length !== 2 || (tuple[0] !== null && typeof tuple[0] !== 'string') || tuple[1] !== hit._id) fail();
    } else if (plan.sort === 'collections') {
      if (
        tuple.length !== 3 ||
        !safeCount(tuple[0]) ||
        (tuple[1] !== null && typeof tuple[1] !== 'string') ||
        tuple[2] !== hit._id
      )
        fail();
    } else if (plan.sort === 'relevance') {
      if (tuple.length !== 2 || typeof tuple[0] !== 'number' || !Number.isFinite(tuple[0]) || tuple[1] !== hit._id)
        fail();
    } else fail();
  }
}

export function requireSearchOverflow(body: unknown): boolean {
  if (!record(body) || !record(body.aggregations) || !record(body.aggregations.overflow)) fail();
  const count = body.aggregations.overflow.doc_count;
  if (!safeCount(count)) fail();
  return count > 0;
}

export function admitSuggestPayload(body: unknown, size: number, prefix: string): asserts body is RecordValue {
  const hits = hitsOf(body, size, false);
  const physicalIndex = new RegExp(`^${prefix}subjects-g([1-9][0-9]*)$`);
  for (const hit of hits) if (!physicalIndex.test(hit._index as string)) fail();
}

type FacetPlan = {
  facets: readonly { property: string; size: number }[];
  sample: number;
  overflowProperties?: readonly string[];
};

function buckets(node: unknown, maximum: number, nested: boolean, sample: number): void {
  if (!record(node) || !Array.isArray(node.buckets) || node.buckets.length > maximum) fail();
  for (const bucket of node.buckets) {
    if (!record(bucket) || typeof bucket.key !== 'string') fail();
    if (nested) {
      if (!record(bucket.subjects) || !safeCount(bucket.subjects.doc_count, sample)) fail();
    } else if (!safeCount(bucket.doc_count, sample)) fail();
  }
}

function admitFacetNodes(nodes: RecordValue, plan: FacetPlan): void {
  for (const [index, facet] of plan.facets.entries()) {
    const outer = nodes[`facet_${index}`];
    if (!record(outer)) fail();
    let terms: unknown;
    let nested = false;
    if (facet.property === 'type') {
      if (!record(outer.values)) fail();
      terms = outer.values;
    } else {
      nested = true;
      if (!record(outer.facts) || !record(outer.facts.property) || !record(outer.facts.property.values)) fail();
      terms = outer.facts.property.values;
    }
    buckets(terms, facet.size * 2, nested, plan.sample);
  }
}

export function admitFacetPayload(body: unknown, plan: FacetPlan): asserts body is RecordValue {
  if (!record(body) || !record(body.hits) || !record(body.hits.total)) fail();
  if (
    !safeCount(body.hits.total.value, 10_000) ||
    (body.hits.total.relation !== 'eq' && body.hits.total.relation !== 'gte') ||
    !record(body.aggregations)
  )
    fail();
  const aggs = body.aggregations;
  const definite = (plan.overflowProperties?.length ?? 0) > 0;
  for (let index = 0; index < plan.facets.length; index++) {
    const overflow = aggs[`overflow_${index}`];
    if (!record(overflow) || !safeCount(overflow.doc_count)) fail();
  }
  if (definite) {
    if (!record(aggs.filter_overflow) || !safeCount(aggs.filter_overflow.doc_count)) fail();
    if (!record(aggs.definite) || !safeCount(aggs.definite.doc_count)) fail();
    admitFacetNodes(aggs.definite, plan);
  } else {
    admitFacetNodes(aggs, plan);
  }
}
