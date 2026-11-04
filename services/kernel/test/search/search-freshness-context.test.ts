import { expect, test } from 'bun:test';
import { publicFreshness, searchObservation } from '../../src/search/search-context';

test('public observation retains native timestamp and catching-up semantics without relay detail', () => {
  const native = { asOf: new Date('2026-01-01T00:00:00Z'), behind: 37, catchingUp: true };
  expect(searchObservation(native)).toEqual({ as_of: '2026-01-01T00:00:00.000Z', freshness: { state: 'catching-up' } });
  expect(publicFreshness({ ...native, catchingUp: false })).toEqual({ state: 'current' });
  expect(publicFreshness({ ...native, asOf: new Date(NaN) })).toEqual({ state: 'unavailable' });
  expect(() => searchObservation({ ...native, asOf: new Date(NaN) })).toThrow();
});
