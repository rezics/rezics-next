import { STRUCTURE_LIMITS } from './format.ts';

// Fractional sibling keys: base-36 digits read as a fraction 0.d1d2..., never
// ending in '0', so byte order equals numeric order and a key always exists
// between two others. A key over the byte budget forces a bounded rebalance of
// its own order segment instead of growing without limit.

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const KEY = /^[0-9a-z]*[1-9a-z]$/;

export class OrderKeyInvalid extends Error {}

function digit(character: string | undefined): number {
  return character === undefined ? 0 : DIGITS.indexOf(character);
}

export function checkOrderKey(key: string): string {
  if (!KEY.test(key)) throw new OrderKeyInvalid('order key is not a canonical base-36 fraction');
  return key;
}

function midpoint(low: string, high: string | null): string {
  if (high !== null) {
    let shared = 0;
    while ((low[shared] ?? '0') === high[shared]) shared++;
    if (shared > 0) return high.slice(0, shared) + midpoint(low.slice(shared), high.slice(shared));
  }
  const lowDigit = digit(low[0]);
  const highDigit = high === null ? DIGITS.length : digit(high[0]);
  if (highDigit - lowDigit > 1) return DIGITS[Math.round((lowDigit + highDigit) / 2)]!;
  if (high !== null && high.length > 1) return high[0]!;
  return DIGITS[lowDigit]! + midpoint(low.slice(1), null);
}

/** A key strictly between `low` and `high`; either bound may be open. */
export function keyBetween(low: string | null, high: string | null): string {
  if (low !== null) checkOrderKey(low);
  if (high !== null) checkOrderKey(high);
  if (low !== null && high !== null && low >= high) throw new OrderKeyInvalid('order keys are not increasing');
  return midpoint(low ?? '', high);
}

export function withinBudget(key: string): boolean {
  return key.length <= STRUCTURE_LIMITS.orderKeyBytes;
}

/** Advance an eight-digit tick at an open boundary, reserving the remaining
 * 24 digits for later interior splits. Repeated appends/prepends do not halve
 * the remaining gap and force a rewrite of all sibling segments. */
export function segmentKeyBetween(low: string | null, high: string | null): string {
  // Stage pages admit zero-padded lexicographic keys, including trailing zeros.
  const fraction = (key: string | null) => key === null ? null : key.replace(/0+$/, '') || null;
  if (low === null && high === null || low !== null && high !== null) {
    const candidate = keyBetween(fraction(low), fraction(high));
    if (low !== null && candidate <= low || high !== null && candidate >= high) {
      throw new OrderKeyInvalid('segment interval needs a local rebalance');
    }
    return candidate;
  }
  const bound = (low ?? high)!;
  if (!/^[0-9a-z]+$/.test(bound)) throw new OrderKeyInvalid('invalid segment key');
  const width = STRUCTURE_LIMITS.orderKeyBytes;
  let value = 0n;
  for (const character of bound.padEnd(width, '0')) value = value * 36n + BigInt(digit(character));
  const step = 36n ** BigInt(width - 8);
  value += low === null ? -step : step;
  if (value > 0n && value < 36n ** BigInt(width)) return value.toString(36).padStart(width, '0').replace(/0+$/, '');
  throw new OrderKeyInvalid('segment boundary needs a local rebalance');
}

/** `count` evenly spaced short keys, used by a bounded segment rebalance. */
export function evenKeys(count: number): string[] {
  if (!Number.isInteger(count) || count < 1) throw new OrderKeyInvalid('rebalance needs at least one key');
  let width = 1;
  while (DIGITS.length ** width <= count + 1) width++;
  const step = Math.floor(DIGITS.length ** width / (count + 1));
  return Array.from({ length: count }, (_, index) => {
    const key = ((index + 1) * step).toString(36).padStart(width, '0').replace(/0+$/, '');
    return checkOrderKey(key);
  });
}
