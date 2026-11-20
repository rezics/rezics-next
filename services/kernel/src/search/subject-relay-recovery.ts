import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { assertCompleteSearch } from './complete-search.ts';
import type { IndexAction } from './document.ts';
import { SearchUnavailableError, type OpenSearch } from './opensearch.ts';

export function subjectRelayIntent(action: IndexAction): string {
  return `${action.version}:${action.op === 'delete' ? 'delete' : documentDigest(action.document)}`;
}

function documentDigest(document: unknown): string {
  const json = canonicalize(document);
  if (json === undefined) throw new SearchUnavailableError('Search relay has an invalid original document');
  return createHash('sha256').update(json).digest('hex');
}

/** Each expected entry is keyed by its original dispatch row. A delete needs an actual bulk receipt. */
export async function proveSubjectRelayDispatch(
  search: OpenSearch,
  index: string,
  expected: ReadonlyMap<string, string>,
): Promise<void> {
  const observed = await search.request<{
    hits?: { hits?: { _id: string; _index: string; _version: number; _source: unknown }[] };
  }>(
    'POST',
    `/${index}/_search`,
    { size: expected.size, version: true, track_total_hits: false, query: { ids: { values: [...expected.keys()] } } },
    { query: { allow_partial_search_results: false } },
  );
  assertCompleteSearch(observed.body);
  const hits = observed.body.hits?.hits;
  if (observed.status !== 200 || !Array.isArray(hits) || hits.length !== expected.size)
    throw new SearchUnavailableError('Search relay original dispatch is not visible');
  const seen = new Set<string>();
  for (const hit of hits) {
    if (
      !hit ||
      hit._index !== index ||
      !Number.isSafeInteger(hit._version) ||
      hit._version < 1 ||
      hit._source === null ||
      typeof hit._source !== 'object' ||
      Array.isArray(hit._source) ||
      seen.has(hit._id) ||
      expected.get(hit._id) !== `${hit._version}:${documentDigest(hit._source)}`
    )
      throw new SearchUnavailableError('Search relay visible winner conflicts with its original dispatch');
    seen.add(hit._id);
  }
}
