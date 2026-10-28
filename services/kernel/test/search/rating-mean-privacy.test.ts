import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { normalizePublicRatingFigure } from '../../src/search/rating-source.ts';
test('a public mean below the minimum publication threshold is rejected even without a score', () => {
  const binding = { questionId: '00000000-0000-8000-8000-000000000001', populationId: GLOBAL_CONTEXT.id, subjectId: '00000000-0000-8000-8000-00a000000001' };
  const figure = { ...binding, count: 4, mean: 0, score: null, priorEpoch: null, revision: '1', asOf: '2026-10-28T00:00:00Z' };
  expect(() => normalizePublicRatingFigure(figure, binding)).toThrow();
  expect(normalizePublicRatingFigure({ ...figure, count: 5 }, binding).mean).toBe(0);
});
