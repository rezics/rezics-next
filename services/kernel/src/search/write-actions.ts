import { bulkLines, type IndexAction, type SearchDocument } from './document.ts';
import type { OpenSearch } from './opensearch.ts';
import { isDeepStrictEqual } from 'node:util';
import type { DiscoveryRegistry } from './discovery.ts';
import {
  discoveryBulkBody,
  validateDiscoveryDocumentFormat,
  type AnyDiscoveryIndexAction,
} from './discovery-documents.ts';
import { assertCompleteSearch } from './complete-search.ts';

/** A bulk write did not establish its required index visibility guarantee. */
export class IndexWriteError extends Error {
  readonly items: unknown[];

  constructor(items: unknown[]) {
    super('One or more search index bulk items failed');
    this.name = 'IndexWriteError';
    this.items = items;
  }
}

type BulkItem = Record<string, unknown>;
type BulkResponse = { errors?: unknown; items?: unknown };
type RefreshResponse = { _shards?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeError(items: unknown[]): never {
  throw new IndexWriteError(items);
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function completeShards(shards: unknown): boolean {
  if (!isRecord(shards)) return false;
  return (
    safeInteger(shards.total, 1) &&
    shards.successful === shards.total &&
    shards.failed === 0 &&
    (shards.failures === undefined || (Array.isArray(shards.failures) && shards.failures.length === 0))
  );
}

function validateBulkResponse(
  response: unknown,
  target: string,
  actions: readonly Pick<IndexAction<SearchDocument>, 'op' | 'id' | 'version'>[],
  exact = false,
): boolean {
  if (!isRecord(response) || typeof response.errors !== 'boolean' || !Array.isArray(response.items))
    return writeError([response]);

  const items = response.items as unknown[];
  if (items.length !== actions.length) return writeError(items);

  let hasConflict = false;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const item = items[index];
    const operationName = action.op;
    if (!isRecord(item) || Object.keys(item).length !== 1 || !isRecord(item[operationName])) return writeError([item]);

    const result = item[operationName] as BulkItem;
    // Native bulk items are positional. Never let an otherwise successful receipt
    // for a different key or physical target settle this action.
    if (result._id !== action.id || result._index !== target) return writeError(items);
    const status = result.status;
    if (typeof status !== 'number' || !Number.isInteger(status)) return writeError([item]);
    const hasItemError = result.error !== undefined;

    if (status === 409 && isRecord(result.error)) {
      const error = result.error;
      // BulkItemResponse emits failure identity and the engine error, not a
      // winning _version, result or shard-success receipt. Do not invent those.
      if (
        error.type !== 'version_conflict_engine_exception' ||
        typeof error.reason !== 'string' ||
        error.reason.length === 0 ||
        error.index !== target ||
        typeof error.index_uuid !== 'string' ||
        error.index_uuid.length === 0 ||
        typeof error.shard !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(error.shard) ||
        ['_version', 'result', '_shards', '_seq_no', '_primary_term', 'forced_refresh'].some((key) =>
          Object.hasOwn(result, key),
        )
      )
        return writeError(items);
      hasConflict = true;
      continue;
    }

    if (
      hasItemError ||
      !(
        safeInteger(result._version, 1) ||
        (exact && typeof result._version === 'string' && /^[1-9][0-9]{0,18}$/.test(result._version))
      ) ||
      BigInt(String(result._version)) !== action.version ||
      !safeInteger(result._seq_no, 0) ||
      !safeInteger(result._primary_term, 1) ||
      !completeShards(result._shards) ||
      (result.forced_refresh !== undefined && typeof result.forced_refresh !== 'boolean')
    )
      return writeError(items);
    if (
      operationName === 'index' &&
      ((status === 200 && result.result === 'updated') || (status === 201 && result.result === 'created'))
    )
      continue;
    if (
      operationName === 'delete' &&
      ((status === 200 && result.result === 'deleted') || (status === 404 && result.result === 'not_found'))
    )
      continue;
    return writeError(items);
  }

  if (response.errors !== hasConflict) return writeError(items);
  return hasConflict;
}

/** Revalidate a retained actual native item response, including its physical key and external version. */
export function validateIndexWriteReceipt(response: unknown, target: string, actions: readonly IndexAction[]): void {
  if (validateBulkResponse(response, target, actions)) throw new IndexWriteError([response]);
}

/** Revalidate an actual mixed bulk item response with exact signed-bigint versions. */
export function validateDiscoveryWriteReceipt(
  response: unknown,
  target: string,
  actions: readonly AnyDiscoveryIndexAction[],
): void {
  if (validateBulkResponse(response, target, actions, true)) throw new IndexWriteError([response]);
}

/** Native mixed writer. A conflict settles only an identical, actually search-visible keyed winner. */
export async function writeDiscoveryActions(
  search: OpenSearch,
  registry: DiscoveryRegistry,
  index: string,
  actions: readonly AnyDiscoveryIndexAction[],
): Promise<void> {
  if (actions.length === 0) return;
  if (!search.bulkRaw) throw new TypeError('Discovery requires the native exact-version transport');
  const response = await search.bulkRaw<unknown>(
    discoveryBulkBody(registry, index, actions, { writeAlias: `${index}-write`, replayDeletes: true }),
    { query: { refresh: 'wait_for', require_alias: true, wait_for_active_shards: 'all' } },
  );
  if (!validateBulkResponse(response, index, actions, true)) return;
  const refreshed = await search.request<RefreshResponse>('POST', `/${index}/_refresh`);
  validateRefreshResponse(refreshed.status, refreshed.body);
  if (!isRecord(response) || !Array.isArray(response.items)) return writeError([response]);
  const receiptItems: unknown[] = response.items;
  const conflicts = actions.filter((action, offset) => {
    const item = receiptItems[offset];
    const receipt = isRecord(item) ? item[action.op] : undefined;
    return isRecord(receipt) && receipt.status === 409;
  });
  const observed = await search.request<unknown>(
    'POST',
    `/${index}/_search`,
    {
      size: conflicts.length,
      version: true,
      query: { ids: { values: conflicts.map(({ id }) => id) } },
    },
    { query: { allow_partial_search_results: false } },
  );
  assertCompleteSearch(observed.body);
  if (!isRecord(observed.body) || !isRecord(observed.body.hits) || !Array.isArray(observed.body.hits.hits))
    return writeError([observed.body]);
  const winners = new Map<string, Record<string, unknown>>();
  for (const hit of observed.body.hits.hits) {
    if (!isRecord(hit) || typeof hit._id !== 'string' || hit._index !== index || winners.has(hit._id))
      return writeError([hit]);
    winners.set(hit._id, hit);
  }
  for (const action of conflicts) {
    const winner = winners.get(action.id);
    if (
      action.op !== 'index' ||
      !winner ||
      String(winner._version) !== action.version.toString() ||
      !isDeepStrictEqual(validateDiscoveryDocumentFormat(registry, winner._source), action.document)
    )
      return writeError([winner]);
  }
}

export function validateRefreshResponse(status: number, response: unknown): void {
  if (!Number.isInteger(status) || status < 200 || status >= 300 || !isRecord(response)) return writeError([response]);

  if (!completeShards(response._shards)) return writeError([response]);
}

/**
 * Write one batch to a physical index, preserving external versions and complete bodies.
 * Return only after every action is visible to search, including independently winning
 * writes behind accepted external-version conflicts.
 */
export async function writeIndexActions<Document extends SearchDocument>(
  search: OpenSearch,
  index: string,
  actions: readonly IndexAction<Document>[],
  options: Readonly<{
    rejectConflicts?: boolean;
    writeAlias?: string;
    versionConflict?: 'reject';
    timeoutMs?: number;
  }> = {},
): Promise<void> {
  const response = await search.bulk<BulkResponse>(bulkLines(options.writeAlias ?? index, actions), {
    query: {
      ...(options.writeAlias ? { require_alias: true, wait_for_active_shards: 'all' } : {}),
      refresh: 'wait_for',
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const hasConflict = validateBulkResponse(response, index, actions);

  if (hasConflict) {
    // A refresh proves visibility, not which current Source/native writer won.
    if (options.rejectConflicts || options.versionConflict === 'reject') throw new IndexWriteError([response]);
    const refresh = await search.request<RefreshResponse>('POST', `/${index}/_refresh`);
    validateRefreshResponse(refresh.status, refresh.body);
  }
}
