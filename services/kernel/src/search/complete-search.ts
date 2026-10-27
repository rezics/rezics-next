import { SearchUnavailableError } from './opensearch.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function counter(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Checks native completion metadata only; callers must validate hits, sort tuples and aggregations. */
export function assertCompleteSearch(body: unknown): void {
  if (!record(body) || body.timed_out !== false) {
    throw new SearchUnavailableError('OpenSearch completion metadata is missing, malformed or timed out');
  }
  const shards = body._shards;
  if (
    !record(shards) ||
    !counter(shards.total) ||
    !counter(shards.successful) ||
    !counter(shards.skipped) ||
    shards.failed !== 0
  ) {
    throw new SearchUnavailableError('OpenSearch shard completion metadata is missing, malformed or failed');
  }
  // Native successful can include skipped shards; summing them would reject complete responses.
  if ('terminated_early' in body && body.terminated_early !== false) {
    throw new SearchUnavailableError('OpenSearch terminated early or has malformed termination metadata');
  }
}
