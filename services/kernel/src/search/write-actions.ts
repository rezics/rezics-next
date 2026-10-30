import { bulkLines, type IndexAction } from './document.ts';
import type { OpenSearch } from './opensearch.ts';

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

function validateBulkResponse(response: unknown, target: string, actions: readonly IndexAction[]): boolean {
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
      !safeInteger(result._version, 1) ||
      BigInt(result._version) !== action.version ||
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

function validateRefreshResponse(status: number, response: unknown): void {
  if (!Number.isInteger(status) || status < 200 || status >= 300 || !isRecord(response)) return writeError([response]);

  if (!completeShards(response._shards)) return writeError([response]);
}

/**
 * Write one batch to a physical index, preserving external versions and complete bodies.
 * Return only after every action is visible to search, including independently winning
 * writes behind accepted external-version conflicts.
 */
export async function writeIndexActions(
  search: OpenSearch,
  index: string,
  actions: readonly IndexAction[],
): Promise<void> {
  const response = await search.bulk<BulkResponse>(bulkLines(index, actions), {
    query: { refresh: 'wait_for' },
  });
  const hasConflict = validateBulkResponse(response, index, actions);

  if (hasConflict) {
    const refresh = await search.request<RefreshResponse>('POST', `/${index}/_refresh`);
    validateRefreshResponse(refresh.status, refresh.body);
  }
}
