import { expect, test } from 'bun:test';
import { fieldAfterResponse } from './controls.tsx';

test('an older save does not replace newer text left in an unfocused field', () => {
  expect(fieldAfterResponse('Melt the butter slowly.', 'Cream the butter.', 'Melt the butter.', false))
    .toBe('Melt the butter slowly.');
});

test('a response replaces an unfocused field that still shows the previous text', () => {
  expect(fieldAfterResponse('Cream the butter.', 'Cream the butter.', 'Melt the butter.', false)).toBe('Melt the butter.');
});

test('a response leaves a field that is being typed in', () => {
  expect(fieldAfterResponse('Melt the butter slowly.', 'Cream the butter.', 'Melt the butter.', true))
    .toBe('Melt the butter slowly.');
});
