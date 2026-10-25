import { expect, type MatcherResult } from 'bun:test';

const builtinToMatchObject = Object.getPrototypeOf(expect(0)).toMatchObject as (
  this: unknown,
  expected: unknown,
) => void;

expect.extend({
  toMatchObject(this: { isNot: boolean }, received: unknown, expected: unknown): MatcherResult {
    let comparable = received;
    try {
      comparable = structuredClone(received);
    } catch {
      // Some values cannot be cloned. The built-in matcher remains the authority for them.
    }
    const matcher = this.isNot ? expect(comparable).not : expect(comparable);
    builtinToMatchObject.call(matcher, expected);
    return { pass: !this.isNot };
  },
});
