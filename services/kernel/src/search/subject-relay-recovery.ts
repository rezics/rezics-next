import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { assertCompleteSearch } from './complete-search.ts';
import { bulkLines, type IndexAction } from './document.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import { retainIndexWriteItems } from './write-actions.ts';

/** OpenSearch charges <http_request> before calling its bulk handler. Other failures can follow mutation. */
export async function submitSubjectRelay(
  search: OpenSearch,
  index: string,
  writeAlias: string,
  actions: readonly IndexAction[],
): Promise<{ items: string[]; failure?: OpenSearchError }> {
  let bulk: unknown;
  try {
    bulk = await search.bulk(bulkLines(writeAlias, actions), {
      query: { require_alias: true, wait_for_active_shards: 'all', refresh: 'wait_for' },
    });
  } catch (error) {
    if (
      !(error instanceof OpenSearchError) ||
      error.status !== 429 ||
      error.type !== 'circuit_breaking_exception' ||
      !/^\[(parent|in_flight_requests)\] Data too large, data for \[<http_request>\]/.test(error.reason ?? '')
    )
      throw error;
    return {
      items: actions.map((action) =>
        JSON.stringify({ rejected: 'http_request', action: { ...action, version: String(action.version) } }),
      ),
      failure: error,
    };
  }
  const items = retainIndexWriteItems(bulk, index, actions);
  return {
    items: actions.map((action, i) =>
      JSON.stringify({ op: action.op, version: String(action.version), bulk: items[i] }),
    ),
  };
}

export function decodeRejectedSubjectRelay(stored: string): IndexAction {
  const { rejected, action } = JSON.parse(stored);
  if (
    rejected !== 'http_request' ||
    !action ||
    typeof action.version !== 'string' ||
    !/^[1-9]\d{0,15}$/.test(action.version) ||
    (action.op !== 'delete' && (action.op !== 'index' || action.document?.id !== action.id))
  )
    throw new SearchUnavailableError('Invalid retained Subject relay rejection');
  return { ...action, version: BigInt(action.version) };
}

export function subjectRelayIntent(action: IndexAction): string {
  return `${action.version}:${action.op === 'delete' ? 'delete' : documentDigest(action.document)}`;
}

function documentDigest(document: unknown): string {
  const json = canonicalize(document);
  if (json === undefined) throw new SearchUnavailableError('Search relay has an invalid original document');
  return createHash('sha256').update(json).digest('hex');
}

export class SubjectRelayProofPending extends SearchUnavailableError {}

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
    throw new SubjectRelayProofPending('Search relay original dispatch is not visible');
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
      throw new SubjectRelayProofPending('Search relay visible winner conflicts with its original dispatch');
    seen.add(hit._id);
  }
}
