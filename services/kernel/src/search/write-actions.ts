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

function validateBulkResponse(response: unknown, actions: readonly IndexAction[]): boolean {
  if (!isRecord(response) || typeof response.errors !== 'boolean' || !Array.isArray(response.items))
    return writeError([response]);

  const items = response.items as unknown[];
  if (items.length !== actions.length) return writeError(items);

  let hasConflict = false;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const item = items[index];
    const operationName = action.op;
    if (!isRecord(item) || Object.keys(item).length !== 1 || !isRecord(item[operationName]))
      return writeError([item]);

    const result = item[operationName] as BulkItem;
    const status = result.status;
    if (typeof status !== 'number' || !Number.isInteger(status)) return writeError([item]);
    const hasItemError = result.error !== undefined;

    if (status === 409 && isRecord(result.error)) {
      if (result.error.type !== 'version_conflict_engine_exception') return writeError([item]);
      hasConflict = true;
      continue;
    }

    if (hasItemError) return writeError([item]);
    if (operationName === 'index' && (status === 200 || status === 201)) continue;
    if (operationName === 'delete' && (status === 200 || status === 404)) continue;
    return writeError([item]);
  }

  if (response.errors !== hasConflict) return writeError(items);
  return hasConflict;
}

function validateRefreshResponse(status: number, response: unknown): void {
  if (!Number.isInteger(status) || status < 200 || status >= 300 || !isRecord(response))
    return writeError([response]);

  const shards = response._shards;
  if (!isRecord(shards)) return writeError([response]);
  const { total, successful, failed } = shards;
  if (
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total <= 0 ||
    typeof successful !== 'number' ||
    !Number.isSafeInteger(successful) ||
    successful !== total ||
    typeof failed !== 'number' ||
    !Number.isSafeInteger(failed) ||
    failed !== 0
  )
    return writeError([response]);
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
  const hasConflict = validateBulkResponse(response, actions);

  if (hasConflict) {
    const refresh = await search.request<RefreshResponse>('POST', `/${index}/_refresh`);
    validateRefreshResponse(refresh.status, refresh.body);
  }
}
