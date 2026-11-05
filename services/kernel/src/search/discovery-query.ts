import type { DiscoveryEngineResult, DiscoveryRegistry, DiscoveryUnionKey } from './discovery.ts';
import {
  parseDiscoveryHitIdentity,
  validateDiscoveryDocumentFormat,
  type DiscoveryDocumentValue,
} from './discovery-documents.ts';
import { assertCompleteSearch } from './complete-search.ts';
import { SearchUnavailableError, type OpenSearch } from './opensearch.ts';
import type { SearchSortValue } from './cursor.ts';
import { MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT, MIXED_DISCOVERY_DOCUMENT_FORMAT } from './discovery.ts';
import { discoveryNativeQuery } from './discovery-native-query.ts';
import {
  MATCH_EVIDENCE_LIMITS,
  readEngineMatchEvidence,
  type EngineMatchEvidence,
  type MatchEvidenceQuery,
} from './match-evidence.ts';

export type DiscoveryOrder = 'id' | 'name' | 'relevance';
export type DiscoveryCandidate = {
  key: DiscoveryUnionKey;
  document: DiscoveryDocumentValue;
  index: string;
  sort: SearchSortValue[];
  matched?: readonly string[];
  engineEvidence?: EngineMatchEvidence;
};
export type DiscoveryQueryPlan = {
  sort: DiscoveryOrder;
  size: number;
  query?: Record<string, unknown>;
  /** Literal bounded text, as in the existing Subject template; never a parsed term or trimmed handle. */
  boost?: string;
  filter: Record<string, unknown>;
  after?: readonly SearchSortValue[];
  matchEvidence?: MatchEvidenceQuery;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function malformed(): never {
  throw new SearchUnavailableError('OpenSearch discovery payload is missing, malformed or out of order');
}
function tuple(value: unknown, order: DiscoveryOrder): value is SearchSortValue[] {
  if (!Array.isArray(value) || value.length !== (order === 'id' ? 3 : 4)) return false;
  const id = value.at(-3);
  if (
    typeof id !== 'string' ||
    typeof value.at(-2) !== 'string' ||
    typeof value.at(-1) !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
  )
    return false;
  if (order === 'id') return true;
  return order === 'relevance'
    ? typeof value[0] === 'number' && Number.isFinite(value[0])
    : value[0] === null || (typeof value[0] === 'string' && value[0].length <= 512 && value[0].isWellFormed());
}
export function compareDiscoveryTuple(
  left: readonly SearchSortValue[],
  right: readonly SearchSortValue[],
  order: DiscoveryOrder,
): number {
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    if (a === b) continue;
    const compared =
      a === null
        ? 1
        : b === null
          ? -1
          : typeof a === 'string' && typeof b === 'string'
            ? Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
            : a < b
              ? -1
              : 1;
    return index === 0 && order === 'relevance' ? -compared : compared;
  }
  return 0;
}

/** Validate all fetched lookahead before any disclosure, including physical target and native identity. */
export function readDiscoveryCandidates(
  body: unknown,
  registry: DiscoveryRegistry,
  physicalTarget: string,
  plan: DiscoveryQueryPlan,
): DiscoveryCandidate[] {
  assertCompleteSearch(body);
  if (!record(body) || !record(body.hits) || !Array.isArray(body.hits.hits) || body.hits.hits.length > plan.size)
    malformed();
  const seen = new Set<string>();
  const engineEvidence = plan.matchEvidence
    ? body.hits.hits.map((hit: unknown) =>
        readEngineMatchEvidence(
          record(hit) ? (hit.matched_queries ?? []) : [],
          record(hit) ? hit.highlight : undefined,
          plan.matchEvidence!,
        ),
      )
    : undefined;
  const evidenceBytes = engineEvidence?.reduce(
    (total, evidence) => total + Buffer.byteLength(JSON.stringify(evidence), 'utf8'),
    0,
  );
  const evidencePageOver = evidenceBytes !== undefined && evidenceBytes > MATCH_EVIDENCE_LIMITS.enginePageBytes;
  let previous = plan.after;
  return body.hits.hits.map((hit: unknown, index: number) => {
    const key = parseDiscoveryHitIdentity(registry, hit);
    const document = validateDiscoveryDocumentFormat(registry, record(hit) ? hit._source : undefined);
    if (
      !record(hit) ||
      hit._index !== physicalTarget ||
      !tuple(hit.sort, plan.sort) ||
      hit.sort.at(-3) !== key.id ||
      hit.sort.at(-2) !== key.kind ||
      hit.sort.at(-1) !== hit._id ||
      seen.has(`${key.kind}:${key.id}`)
    )
      malformed();
    if (
      hit._score !== undefined &&
      hit._score !== null &&
      (typeof hit._score !== 'number' || !Number.isFinite(hit._score))
    )
      malformed();
    if (plan.sort === 'relevance' && hit._score !== hit.sort[0]) malformed();
    if (
      hit.matched_queries !== undefined &&
      (!Array.isArray(hit.matched_queries) || !hit.matched_queries.every((value: unknown) => typeof value === 'string'))
    )
      malformed();
    if (previous && compareDiscoveryTuple(previous, hit.sort, plan.sort) >= 0) malformed();
    previous = hit.sort;
    seen.add(`${key.kind}:${key.id}`);
    return {
      key,
      index: physicalTarget,
      document,
      sort: hit.sort,
      ...(hit.matched_queries === undefined ? {} : { matched: hit.matched_queries }),
      ...(engineEvidence === undefined
        ? {}
        : {
            engineEvidence: evidencePageOver
              ? { matched: Array.isArray(hit.matched_queries) ? hit.matched_queries : [], malformed: true }
              : engineEvidence[index],
          }),
    };
  });
}

/** Execute only inside the native consumer's retained execution/custody. This helper supplies no privacy ACK.
 * A PIT belongs to the canonical queried observation; callers must not use a mutable alias as a substitute.
 */
export async function queryDiscoveryCandidates(
  search: OpenSearch,
  registry: DiscoveryRegistry,
  physicalTarget: string,
  pit: string,
  plan: DiscoveryQueryPlan,
): Promise<{ candidates: DiscoveryCandidate[]; pit: string }> {
  if (!Number.isInteger(plan.size) || plan.size < 1 || plan.size > 200 || !pit || !physicalTarget)
    throw new RangeError('Invalid bounded discovery query');
  if (plan.after && !tuple(plan.after, plan.sort)) throw new RangeError('Invalid discovery frontier');
  const ties = [{ id: 'asc' }, { kind: 'asc' }, { identity: 'asc' }];
  const sort =
    plan.sort === 'relevance'
      ? [{ _score: 'desc' }, ...ties]
      : plan.sort === 'name'
        ? [{ name_sort: { order: 'asc', missing: '_last' } }, ...ties]
        : ties;
  const response = await search.request(
    'POST',
    '/_search',
    {
      size: plan.size,
      track_total_hits: false,
      pit: { id: pit, keep_alive: '1m' },
      query: discoveryNativeQuery(plan),
      ...(plan.matchEvidence ? { highlight: plan.matchEvidence.highlight } : {}),
      sort,
      ...(plan.after ? { search_after: plan.after } : {}),
    },
    { query: { allow_partial_search_results: false, search_type: 'dfs_query_then_fetch' } },
  );
  if (response.status !== 200) malformed();
  const candidates = readDiscoveryCandidates(response.body, registry, physicalTarget, plan);
  const renewed = record(response.body) ? response.body.pit_id : undefined;
  if (renewed !== undefined && (typeof renewed !== 'string' || !renewed)) malformed();
  // The native consumer validates any renewal and updates its canonical observation, not this row parser.
  return { candidates, pit: typeof renewed === 'string' ? renewed : pit };
}

/** Canonical mixed DTO decoder. A legacy document is never reinterpreted as mixed-public-v1. */
export function readDiscoveryEngineResult(
  body: unknown,
  registry: DiscoveryRegistry,
  physicalTarget: string,
  plan: DiscoveryQueryPlan,
): DiscoveryEngineResult {
  const candidates = readDiscoveryCandidates(body, registry, physicalTarget, plan);
  return {
    hits: candidates.map(({ key, document, index, sort, matched, engineEvidence }) => {
      if (
        (document.document_format !== MIXED_DISCOVERY_DOCUMENT_FORMAT &&
          document.document_format !== MIXED_CALENDAR_DISCOVERY_DOCUMENT_FORMAT) ||
        (plan.sort === 'name' && sort[0] !== document.name_sort)
      )
        malformed();
      const ownerDocument = document.owner === 'commerce' || document.owner === 'content';
      return {
        key,
        index,
        sourcePosition: document.source_position,
        revision: 'security_revision' in document ? String(document.security_revision) : document.revision,
        ...(ownerDocument ? { sourceVersion: document.source_version } : {}),
        matched: matched ?? [],
        ...(engineEvidence === undefined ? {} : { engineEvidence }),
        sort,
      };
    }),
  };
}
