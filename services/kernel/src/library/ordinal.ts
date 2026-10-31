import { BASE_62_DIGITS, generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export const MAX_ORDINAL_KEY_LENGTH = 48;
export const GENERATED_ORDINAL_KEY_LENGTH = 32;

export const ORDER_WINDOW_SIZE = 128;
export const ORDER_BATCH_SIZE = 100;
const MAX_LOCAL_KEYS = ORDER_WINDOW_SIZE + ORDER_BATCH_SIZE;
const digits = new Set(BASE_62_DIGITS);

function acceptedByLibrary(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

export function isOrdinalKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ORDINAL_KEY_LENGTH) return false;
  for (const character of value) {
    if (!digits.has(character)) return false;
  }
  return acceptedByLibrary(value);
}

export function keyBetween(before: string | null, after: string | null): string | null {
  if (before !== null && !isOrdinalKey(before)) throw new Error(`invalid order key: ${before}`);
  if (after !== null && !isOrdinalKey(after)) throw new Error(`invalid order key: ${after}`);
  // Compared by code unit, which is how PostgreSQL's COLLATE "C" orders these ASCII keys.
  if (before !== null && after !== null && before >= after) throw new Error(`${before} >= ${after}`);

  const key = generateKeyBetween(before, after);
  return key.length <= GENERATED_ORDINAL_KEY_LENGTH ? key : null;
}

export function respacedKeys(count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647) {
    throw new RangeError('count must fit a nonnegative PostgreSQL integer');
  }
  return generateNKeysBetween(null, null, count);
}

/** Only bounded command windows use this allocator. Never pass an owner count. */
export function localOrderKeys(before: string | null, after: string | null, count: number): string[] | null {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_LOCAL_KEYS)
    throw new RangeError('Invalid local order window');
  const keys = generateNKeysBetween(before, after, count);
  return keys.every((key) => isOrdinalKey(key) && key.length <= GENERATED_ORDINAL_KEY_LENGTH) ? keys : null;
}

/** A deterministic balanced tree of package-generated keys, visited only for the
 * requested ranks. Pruning costs O(log count + size), including for a million rows.
 * Boundaries are immutable for one repair; page boundaries never affect the keys.
 */
export function orderRepairKeys(lower: string, upper: string, count: number, start: number, size: number): string[] {
  if (
    !isOrdinalKey(lower) ||
    !isOrdinalKey(upper) ||
    lower >= upper ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 2_147_483_647 ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > ORDER_WINDOW_SIZE ||
    start + size > count
  )
    throw new RangeError('Invalid order repair ranks');
  const result: string[] = [];
  const end = start + size;
  function visit(a: string, b: string, offset: number, length: number): void {
    if (!length || offset >= end || offset + length <= start) return;
    const left = Math.floor(length / 2);
    const rank = offset + left;
    const key = generateKeyBetween(a, b);
    if (!isOrdinalKey(key)) throw new RangeError('Order repair exceeds stored ordinal width');
    visit(a, key, offset, left);
    if (rank >= start && rank < end) result.push(key);
    visit(key, b, rank + 1, length - left - 1);
  }
  visit(lower, upper, 0, count);
  return result;
}

export function orderRepairRange(minimum: string, count: number): { lower: string; upper: string } {
  // Raw deletion locators (~UUID) sort after every legal live ordinal. A repair
  // is admitted only for a nonempty live population, so its raw minimum is legal.
  if (!isOrdinalKey(minimum)) throw new RangeError('Invalid original order minimum');
  const upper = generateKeyBetween(null, minimum);
  const lower = generateKeyBetween(null, upper);
  // The deepest left/right paths bound the width of the balanced midpoint tree.
  // Stored headroom (48 bytes) is available to maintenance; commands prefer 32.
  orderRepairKeys(lower, upper, count, 0, 1);
  orderRepairKeys(lower, upper, count, count - 1, 1);
  return { lower, upper };
}
