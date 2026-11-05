import { expect, test } from 'bun:test';
import { countFromLinks, formatCount } from '../src/features/count';

test('provided zero retains its native exactness when rows are present', () => {
  for (const exact of [true, false]) {
    const count = countFromLinks({ value: 0, exact }, 4);
    expect(count).toEqual({ value: 0, relation: exact ? 'exact' : 'lower_bound' });
    expect(formatCount(count, 'en')).toBe(exact ? '0' : '0+');
  }
});

test('a provided at-least count stays below a larger returned row count', () => {
  const count = countFromLinks({ value: 2, exact: false }, 4);
  expect(count).toEqual({ value: 2, relation: 'lower_bound' });
  expect(formatCount(count, 'en')).toBe('2+');
});

test('an absent count stays unknown regardless of returned rows', () => {
  for (const returned of [0, 4]) {
    const count = countFromLinks(undefined, returned);
    expect(count).toBeUndefined();
    expect(formatCount(count, 'en')).toBe('');
  }
});
