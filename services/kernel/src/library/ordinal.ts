import { BASE_62_DIGITS, generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

export const MAX_ORDINAL_KEY_LENGTH = 48;
export const GENERATED_ORDINAL_KEY_LENGTH = 32;

const MAX_RESPACED_KEYS = 5_000;
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
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_RESPACED_KEYS) {
    throw new RangeError(`count must be an integer from 0 to ${MAX_RESPACED_KEYS}`);
  }
  return generateNKeysBetween(null, null, count);
}
