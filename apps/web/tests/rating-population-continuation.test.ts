import { expect, test } from 'bun:test';
import {
  acceptPopulationPage,
  nextPopulationPage,
  startPopulationProgress,
} from '../src/features/pages/rating-population-progress';

test('only continuations within the native request bound can advance progress', () => {
  const first = startPopulationProgress();
  const tooLong = 'x'.repeat(4097);
  const rejected = acceptPopulationPage(first, first.request, tooLong);
  expect(rejected).toMatchObject({ unusableContinuation: true, cursors: [] });
  expect(nextPopulationPage(rejected, tooLong).request).toEqual(first.request);

  const exact = 'x'.repeat(4096);
  const admitted = acceptPopulationPage(first, first.request, exact);
  expect(nextPopulationPage(admitted, exact).request.cursor).toBe(exact);
  expect(nextPopulationPage(acceptPopulationPage(first, first.request, ''), '').request.cursor).toBe('');
});
