import { expect, test } from 'bun:test';
import { assertCompleteSearch } from '../../src/search/complete-search.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';

// Native protocol counters only: skipShard increments successful as well as skipped.
test('skipped shards are already included in successful and cannot cover missing successful shards', () => {
  for (const shards of [
    { total: 3, successful: 1, skipped: 2, failed: 0 },
    { total: 1, successful: 0, skipped: 1, failed: 0 },
    { total: 3, successful: 4, skipped: 0, failed: 0 },
    { total: 0, successful: 1, skipped: 0, failed: 0 },
    { total: 3, successful: 3, skipped: 4, failed: 0 },
  ]) {
    expect(() => assertCompleteSearch({ timed_out: false, _shards: shards })).toThrow(SearchUnavailableError);
  }
});

test('all successful shards including all-skipped or zero shards are complete', () => {
  for (const shards of [
    { total: 3, successful: 3, skipped: 0, failed: 0 },
    { total: 3, successful: 3, skipped: 2, failed: 0 },
    { total: 3, successful: 3, skipped: 3, failed: 0 },
    { total: 0, successful: 0, skipped: 0, failed: 0 },
  ]) {
    expect(assertCompleteSearch({ timed_out: false, _shards: shards })).toBeUndefined();
  }
});
