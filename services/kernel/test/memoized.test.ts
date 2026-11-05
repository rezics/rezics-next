import { expect, test } from 'bun:test';
import { memoizedValue } from '../src/memoized.ts';

test('module getters compute on use and preserve identity, including undefined', () => {
  const key = {};
  let calls = 0;
  const create = () => {
    calls += 1;
    return { value: calls };
  };
  expect(calls).toBe(0);
  expect(memoizedValue(key, create)).toBe(memoizedValue(key, create));
  expect(calls).toBe(1);
  const empty = {};
  expect(memoizedValue(empty, () => undefined)).toBeUndefined();
  expect(
    memoizedValue(empty, () => {
      throw new Error('already computed');
    }),
  ).toBeUndefined();
});

test('a failed computation does not publish a partially initialized value', () => {
  const key = {};
  expect(() =>
    memoizedValue(key, () => {
      throw new Error('failed');
    }),
  ).toThrow('failed');
  expect(memoizedValue(key, () => 4)).toBe(4);
});
