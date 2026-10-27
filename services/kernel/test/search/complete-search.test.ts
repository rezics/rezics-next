import { expect, test } from 'bun:test';
import { assertCompleteSearch } from '../../src/search/complete-search.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';

// Synthetic native protocol fixtures: these prove no source, permission or API outcome facts.
function complete() {
  return { timed_out: false, _shards: { total: 3, successful: 3, skipped: 0, failed: 0 } };
}

test('complete native completion metadata accepts absent or false early termination', () => {
  expect(assertCompleteSearch(complete())).toBeUndefined();
  expect(assertCompleteSearch({ ...complete(), terminated_early: false })).toBeUndefined();
});

test('successful can already include skipped shards', () => {
  const body = complete();
  body._shards.skipped = 2;
  expect(assertCompleteSearch(body)).toBeUndefined();
});

test('a complete zero-hit response is legitimate, including zero shard counters', () => {
  for (const shards of [complete()._shards, { total: 0, successful: 0, skipped: 0, failed: 0 }]) {
    expect(
      assertCompleteSearch({
        timed_out: false,
        _shards: shards,
        hits: { total: { value: 0, relation: 'eq' }, hits: [] },
      }),
    ).toBeUndefined();
  }
});

test('body and shard metadata must be objects with every required field', () => {
  for (const body of [undefined, null, false, 0, '', 'response', [], {}]) {
    expect(() => assertCompleteSearch(body)).toThrow(SearchUnavailableError);
  }
  for (const shards of [undefined, null, false, 0, '', 'shards', []]) {
    expect(() => assertCompleteSearch({ ...complete(), _shards: shards })).toThrow(SearchUnavailableError);
  }
  expect(() => assertCompleteSearch({ timed_out: false })).toThrow(SearchUnavailableError);
  expect(() => assertCompleteSearch({ _shards: complete()._shards })).toThrow(SearchUnavailableError);
  for (const field of ['total', 'successful', 'skipped', 'failed'] as const) {
    const shards: Record<string, unknown> = { ...complete()._shards };
    delete shards[field];
    expect(() => assertCompleteSearch({ ...complete(), _shards: shards })).toThrow(SearchUnavailableError);
  }
});

test('timeouts and pseudo-booleans cannot certify completion even with empty hits', () => {
  for (const timedOut of [true, undefined, null, 0, 1, 'false', 'true', '', [], {}]) {
    expect(() => assertCompleteSearch({ ...complete(), timed_out: timedOut, hits: { hits: [] } })).toThrow(
      SearchUnavailableError,
    );
  }
});

test('early termination must be absent or exactly false', () => {
  for (const terminatedEarly of [true, undefined, null, 0, 1, 'false', 'true', '', [], {}]) {
    expect(() => assertCompleteSearch({ ...complete(), terminated_early: terminatedEarly })).toThrow(
      SearchUnavailableError,
    );
  }
});

test('shard counters reject nonintegers, negatives, strings, booleans and nonfinite numbers', () => {
  for (const field of ['total', 'successful', 'skipped', 'failed'] as const) {
    for (const value of [undefined, null, -1, 0.5, NaN, Infinity, -Infinity, '0', '3', false, true, [], {}]) {
      const body = { ...complete(), _shards: { ...complete()._shards, [field]: value } };
      expect(() => assertCompleteSearch(body)).toThrow(SearchUnavailableError);
    }
  }
});

test('any failed shard prevents completion even with empty hits and aggregations', () => {
  for (const failed of [1, 2, 3]) {
    expect(() =>
      assertCompleteSearch({
        ...complete(),
        _shards: { ...complete()._shards, failed },
        hits: { hits: [] },
        aggregations: {},
      }),
    ).toThrow(SearchUnavailableError);
  }
});

test('hits, sort tuples and aggregation validation remain the caller responsibility', () => {
  for (const extra of [{}, { hits: null }, { hits: { hits: [{ sort: 'invalid' }] }, aggregations: false }]) {
    expect(assertCompleteSearch({ ...complete(), ...extra })).toBeUndefined();
  }
});

test('completion checks preserve immutable input on success and failure', () => {
  for (const timedOut of [false, true]) {
    const body = Object.freeze({
      timed_out: timedOut,
      _shards: Object.freeze({ ...complete()._shards }),
      hits: Object.freeze({ hits: Object.freeze([]) }),
    });
    const before = structuredClone(body);
    if (timedOut) expect(() => assertCompleteSearch(body)).toThrow(SearchUnavailableError);
    else expect(assertCompleteSearch(body)).toBeUndefined();
    expect(body).toEqual(before);
  }
});
