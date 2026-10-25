import { expect, test } from 'bun:test';
import {
  GENERATED_ORDINAL_KEY_LENGTH,
  isOrdinalKey,
  keyBetween,
  MAX_ORDINAL_KEY_LENGTH,
  respacedKeys,
} from '../../src/library/ordinal.ts';

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireKey(value: string | null): string {
  expect(value).not.toBeNull();
  if (value === null) throw new Error('expected an order key');
  expect(value.length).toBeLessThanOrEqual(GENERATED_ORDINAL_KEY_LENGTH);
  expect(isOrdinalKey(value)).toBe(true);
  return value;
}

test('keys between neighbours stay in code-unit order, and the first insertion with no room returns null', () => {
  expect(MAX_ORDINAL_KEY_LENGTH).toBe(48);
  expect(GENERATED_ORDINAL_KEY_LENGTH).toBe(32);
  const anchor = requireKey(keyBetween(null, null));
  const upper = requireKey(keyBetween(anchor, null));
  const lower = requireKey(keyBetween(null, anchor));
  const mid = requireKey(keyBetween(anchor, upper));
  expect(lower < anchor && anchor < mid && mid < upper).toBe(true);

  const after: string[] = [];
  let ceiling: string | null = null;
  let exhaustedAfter = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    const key = keyBetween(anchor, ceiling);
    if (key === null) {
      exhaustedAfter = true;
      expect(keyBetween(anchor, ceiling)).toBeNull();
      break;
    }
    expect(key.length).toBeLessThanOrEqual(GENERATED_ORDINAL_KEY_LENGTH);
    expect(isOrdinalKey(key)).toBe(true);
    expect(anchor < key).toBe(true);
    if (ceiling !== null) expect(key < ceiling).toBe(true);
    after.push(key);
    ceiling = key;
  }
  expect(exhaustedAfter).toBe(true);
  expect(after.length).toBeGreaterThan(0);

  const before: string[] = [];
  let floor: string | null = null;
  let exhaustedBefore = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    const key = keyBetween(floor, anchor);
    if (key === null) {
      exhaustedBefore = true;
      expect(keyBetween(floor, anchor)).toBeNull();
      break;
    }
    expect(key.length).toBeLessThanOrEqual(GENERATED_ORDINAL_KEY_LENGTH);
    expect(isOrdinalKey(key)).toBe(true);
    expect(key < anchor).toBe(true);
    if (floor !== null) expect(floor < key).toBe(true);
    before.push(key);
    floor = key;
  }
  expect(exhaustedBefore).toBe(true);
  expect(before.length).toBeGreaterThan(0);

  const ordered = [...before, anchor, ...after.toReversed()];
  expect(ordered).toEqual([...ordered].sort(byCodeUnit));
  expect(new Set(ordered).size).toBe(ordered.length);
});

test('respacing yields short evenly spaced sorted unique keys', () => {
  for (const count of [1, 2, 5_000]) {
    const keys = respacedKeys(count);
    expect(keys).toHaveLength(count);
    let previous: string | null = null;
    for (const key of keys) {
      expect(key.length).toBeLessThanOrEqual(GENERATED_ORDINAL_KEY_LENGTH);
      expect(isOrdinalKey(key)).toBe(true);
      const spaced = keyBetween(previous, null);
      expect(spaced).toBe(key);
      previous = key;
    }
    expect(new Set(keys).size).toBe(count);
    expect(keys).toEqual([...keys].sort(byCodeUnit));
  }
  expect(() => respacedKeys(5_001)).toThrow();
  expect(() => respacedKeys(-1)).toThrow();
  expect(() => respacedKeys(1.5)).toThrow();
});

test('invalid and out-of-order neighbours throw', () => {
  const anchor = requireKey(keyBetween(null, null));
  const next = requireKey(keyBetween(anchor, null));
  expect(() => keyBetween(next, anchor)).toThrow();
  expect(() => keyBetween(anchor, anchor)).toThrow();
  expect(() => keyBetween('nope', null)).toThrow();
  expect(() => keyBetween(null, 'nope')).toThrow();
  expect(() => keyBetween('', null)).toThrow();
  expect(() => keyBetween('a', anchor)).toThrow();
  expect(() => keyBetween(anchor, 'a00')).toThrow();
  expect(() => keyBetween('a0 ', null)).toThrow();

  expect(isOrdinalKey(anchor)).toBe(true);
  expect(isOrdinalKey(next)).toBe(true);
  expect(isOrdinalKey(`a0${'V'.repeat(46)}`)).toBe(true);
  expect(isOrdinalKey('')).toBe(false);
  expect(isOrdinalKey('a')).toBe(false);
  expect(isOrdinalKey('nope')).toBe(false);
  expect(isOrdinalKey('a00')).toBe(false);
  expect(isOrdinalKey('a0 ')).toBe(false);
  expect(isOrdinalKey('a0!')).toBe(false);
  expect(isOrdinalKey(`a0${'V'.repeat(47)}`)).toBe(false);
  expect(isOrdinalKey(`A${'0'.repeat(26)}`)).toBe(false);
  expect(isOrdinalKey(null)).toBe(false);
  expect(isOrdinalKey(undefined)).toBe(false);
  expect(isOrdinalKey(1)).toBe(false);
  expect(isOrdinalKey({ key: anchor })).toBe(false);
});

test('two hundred inserts after one member respace the Collection before the two hundredth insert and every generated key has at most 32 characters', () => {
  const anchor = requireKey(keyBetween(null, null));
  const tail = requireKey(keyBetween(anchor, null));
  let next = tail;
  let respacedAt: number | null = null;
  let sawThirtyTwo = false;
  for (let insert = 1; insert <= 200; insert += 1) {
    const key = keyBetween(anchor, next);
    if (key === null) {
      respacedAt = insert;
      break;
    }
    expect(key.length).toBeLessThanOrEqual(GENERATED_ORDINAL_KEY_LENGTH);
    if (key.length === GENERATED_ORDINAL_KEY_LENGTH) sawThirtyTwo = true;
    expect(isOrdinalKey(key)).toBe(true);
    expect(anchor < key && key < next).toBe(true);
    next = key;
  }
  expect(respacedAt).not.toBeNull();
  expect(respacedAt!).toBeGreaterThan(1);
  expect(respacedAt!).toBeLessThan(200);
  expect(sawThirtyTwo).toBe(true);
});

test('a stored key of up to 48 characters is still accepted as a neighbour', () => {
  const stored = `a0${'V'.repeat(46)}`;
  const shorter = `a0${'V'.repeat(31)}`;
  expect(stored).toHaveLength(MAX_ORDINAL_KEY_LENGTH);
  expect(shorter).toHaveLength(33);
  expect(isOrdinalKey(stored)).toBe(true);
  expect(isOrdinalKey(shorter)).toBe(true);

  const beforeStored = requireKey(keyBetween(null, stored));
  const afterStored = requireKey(keyBetween(stored, null));
  expect(beforeStored < stored && stored < afterStored).toBe(true);

  const beforeShorter = requireKey(keyBetween(null, shorter));
  const afterShorter = requireKey(keyBetween(shorter, null));
  expect(beforeShorter < shorter && shorter < afterShorter).toBe(true);

  const higher = 'a2';
  expect(isOrdinalKey(higher)).toBe(true);
  const betweenRoom = requireKey(keyBetween(stored, higher));
  expect(stored < betweenRoom && betweenRoom < higher).toBe(true);

  expect(keyBetween(shorter, stored)).toBeNull();
});
