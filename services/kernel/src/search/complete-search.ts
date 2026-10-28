import { SearchUnavailableError } from './opensearch.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function completeShards(value: unknown): boolean {
  if (!record(value)) return false;
  const { total, successful, skipped, failed } = value;
  if (
    !counter(total) ||
    !counter(successful) ||
    !counter(skipped) ||
    !counter(failed) ||
    successful !== total ||
    skipped > total ||
    failed !== 0
  ) {
    return false;
  }
  // OpenSearch counts skipped shards as successful, so successful must equal total.
  return true;
}

/** Checks native completion metadata only; callers must validate hits, sort tuples and aggregations. */
export function assertCompleteSearch(body: unknown): void {
  if (!record(body) || body.timed_out !== false) {
    throw new SearchUnavailableError('OpenSearch completion metadata is missing, malformed or timed out');
  }
  if (!completeShards(body._shards)) {
    throw new SearchUnavailableError(
      'OpenSearch shard completion metadata is missing, malformed, incomplete or failed',
    );
  }
  if ('terminated_early' in body && body.terminated_early !== false) {
    throw new SearchUnavailableError('OpenSearch terminated early or has malformed termination metadata');
  }
}
