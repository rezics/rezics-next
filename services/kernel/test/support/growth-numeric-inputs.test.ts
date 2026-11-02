import { expect, test } from 'bun:test';
import { checkedMultiplyDivide } from './growth-numeric.ts';

test('checkedMultiplyDivide rejects non-finite operands before zero short-circuits', () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
    for (const [operands, name] of [
      [[invalid, 1, 1], 'a'],
      [[0, invalid, 1], 'b'],
      [[0, 1, invalid], 'c'],
    ] as const)
      expect(() => checkedMultiplyDivide(...operands, 'Growth slope')).toThrow(`Growth slope operand ${name}`);
});

test('checkedMultiplyDivide keeps finite signed, subnormal, and intermediate-safe results', () => {
  for (const [operands, expected] of [
    [[-Number.MAX_VALUE, 2, 2], -Number.MAX_VALUE],
    [[Number.MIN_VALUE, 2, 2], Number.MIN_VALUE],
    [[Number.MAX_VALUE, 2, 2], Number.MAX_VALUE],
  ] as const)
    expect(checkedMultiplyDivide(...operands, 'Growth slope')).toBe(expected);
});
