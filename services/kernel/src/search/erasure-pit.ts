import { SearchUnavailableError } from './opensearch.ts';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only the native receipt for the requested PIT releases its durable custody.
 * OpenSearch returns HTTP 200 even when one or more shard contexts could not be deleted.
 * Its successful receipt also covers contexts that were already absent on replay.
 */
export function assertRetainedPitDeletion(pit: string, response: unknown): void {
  if (!record(response) || 'error' in response || !Array.isArray(response.pits) || response.pits.length !== 1)
    throw new SearchUnavailableError('Retained Search PIT cleanup is unconfirmed');
  const receipt: unknown = response.pits[0];
  if (!record(receipt) || receipt.pit_id !== pit || receipt.successful !== true || 'error' in receipt)
    throw new SearchUnavailableError('Retained Search PIT cleanup is unconfirmed');
}
