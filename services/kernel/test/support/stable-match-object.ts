import { expect, type MatcherResult } from 'bun:test';

const builtinToMatchObject = Object.getPrototypeOf(expect(0)).toMatchObject as (
  this: unknown,
  expected: unknown,
) => void;

// Bun writes asymmetric matchers into the received value, so the matcher compares a copy. structuredClone would drop
// an Error's own properties such as code, so plain objects, arrays and errors are copied with their prototype and own
// properties; any other value, whose internal slots a copy would lose, is matched as it is.
function copy(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const known = seen.get(value);
  if (known !== undefined) return known;
  const prototype = Object.getPrototypeOf(value);
  const copyable =
    prototype === Object.prototype || prototype === null || Array.isArray(value) || value instanceof Error;
  if (!copyable) return value;
  const result = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, result);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    // The copy stays writable even when the value is frozen, since the matcher writes into it.
    Object.defineProperty(
      result,
      key,
      'value' in descriptor
        ? {
            value: copy(descriptor.value, seen),
            writable: true,
            enumerable: descriptor.enumerable === true,
            configurable: true,
          }
        : { ...descriptor, configurable: true },
    );
  }
  if (Array.isArray(value)) (result as unknown[]).length = value.length;
  return result;
}

expect.extend({
  toMatchObject(this: { isNot: boolean }, received: unknown, expected: unknown): MatcherResult {
    const comparable = copy(received, new Map());
    const matcher = this.isNot ? expect(comparable).not : expect(comparable);
    builtinToMatchObject.call(matcher, expected);
    return { pass: !this.isNot };
  },
});
