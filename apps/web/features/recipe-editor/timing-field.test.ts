import { expect, test } from 'bun:test';
import type { Measure } from './model.ts';
import { timingLeave, timingShown } from './timing-field.ts';

const seconds: Measure = { kind: 'cooking-duration', value: { numerator: 90, denominator: 1 }, unitText: 's' };
const minutes: Measure = { kind: 'preparation-duration', value: { numerator: 20, denominator: 1 }, unitText: 'min' };
const fractional: Measure = { kind: 'cooking-duration', value: { numerator: 3, denominator: 2 }, unitText: 'min' };

test('a timing the minutes field cannot represent is shown, and leaving that text does not clear it', () => {
  expect(timingShown(seconds)).toBe('90 s');
  expect(timingLeave(seconds, timingShown(seconds))).toEqual({ kind: 'unchanged' });
  expect(timingLeave(seconds, '')).toEqual({ kind: 'write', minutes: null });
  expect(timingLeave(seconds, '45')).toEqual({ kind: 'write', minutes: 45 });
  expect(timingLeave(seconds, 'soon')).toEqual({ kind: 'invalid' });
  expect(timingShown(fractional)).toBe('1 1/2 min');
  expect(timingLeave(fractional, timingShown(fractional))).toEqual({ kind: 'unchanged' });
});

test('leaving a minutes field writes only when the cook changed it', () => {
  expect(timingShown(minutes)).toBe('20');
  expect(timingLeave(minutes, '20')).toEqual({ kind: 'unchanged' });
  expect(timingLeave(minutes, ' 20 ')).toEqual({ kind: 'unchanged' });
  expect(timingLeave(minutes, '21')).toEqual({ kind: 'write', minutes: 21 });
  expect(timingLeave(minutes, '')).toEqual({ kind: 'write', minutes: null });
  expect(timingLeave(undefined, '')).toEqual({ kind: 'unchanged' });
  expect(timingLeave(undefined, '15')).toEqual({ kind: 'write', minutes: 15 });
});
