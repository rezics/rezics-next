import { expect, test } from 'bun:test';
import { normalizePublicRatingFigure } from '../../src/search/rating-source.ts';
test('public rating figures preserve null and zero and reject private or malformed data', () => {
  const binding = {
    questionId: '00000000-0000-8000-8000-000000000001',
    populationId: '00000000-0000-8000-8000-000000000000',
    subjectId: '00000000-0000-8000-8000-00a000000001',
  };
  const figure = {
    ...binding,
    count: 5,
    mean: 0,
    score: 0,
    priorEpoch: 1,
    revision: '9007199254740993',
    asOf: '2026-10-28T00:00:00Z',
  };
  expect(normalizePublicRatingFigure(figure, binding)).toEqual(figure);
  for (const patch of [
    { count: '5' },
    { score: Infinity },
    { voterId: binding.subjectId },
    { populationId: binding.subjectId },
    { revision: '01' },
    { priorEpoch: null },
  ]) {
    expect(() => normalizePublicRatingFigure({ ...figure, ...patch }, binding)).toThrow();
  }
});
