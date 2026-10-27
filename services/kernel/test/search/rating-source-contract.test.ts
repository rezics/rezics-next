import { expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { normalizePublicRatingFigure, type PublicRatingFigure } from '../../src/search/rating-source.ts';

const binding = {
  questionId: '00000000-0000-8000-8000-000000000001',
  populationId: GLOBAL_CONTEXT.id,
  subjectId: '00000000-0000-8000-8000-00a000000001',
};

const figure = (): PublicRatingFigure => ({
  ...binding,
  count: 5,
  mean: 0,
  score: 0,
  priorEpoch: 1,
  revision: '1',
  asOf: '2026-10-28T00:00:00Z',
});

test('public Global figures keep precision, nulls and zero without recomputing values', () => {
  const scored = {
    ...figure(),
    mean: 6.1234,
    score: 8.4321,
    revision: '9007199254740993',
    asOf: '2026-10-28T00:00:00.123456789123456789+08:00',
  };
  expect(normalizePublicRatingFigure(scored, binding)).toEqual(scored);

  expect(normalizePublicRatingFigure(figure(), binding)).toMatchObject({ mean: 0, score: 0 });
  for (const revision of ['-9223372036854775808', '9223372036854775807']) {
    expect(normalizePublicRatingFigure({ ...figure(), revision }, binding).revision).toBe(revision);
  }
  const maximumPrecisionTime = `2026-10-28T00:00:00.${'1'.repeat(43)}Z`;
  expect(normalizePublicRatingFigure({ ...figure(), asOf: maximumPrecisionTime }, binding).asOf).toBe(
    maximumPrecisionTime,
  );
  expect(
    normalizePublicRatingFigure({ ...figure(), mean: 4.25, score: null, priorEpoch: null }, binding),
  ).toMatchObject({ count: 5, mean: 4.25, score: null, priorEpoch: null });
  expect(
    normalizePublicRatingFigure({ ...figure(), count: 0, mean: null, score: null, priorEpoch: null }, binding),
  ).toMatchObject({ count: 0, mean: null, score: null, priorEpoch: null });
});

test('normalization returns an independent allowlisted copy', () => {
  const input = figure();
  const output = normalizePublicRatingFigure(input, binding);

  expect(output).not.toBe(input);
  input.mean = 7;
  input.asOf = '2026-10-29T00:00:00Z';
  expect(output.mean).toBe(0);
  expect(output.asOf).toBe('2026-10-28T00:00:00Z');
});

test('normalization rejects malformed data, invalid bindings and private fields', () => {
  const base = figure();
  const invalidFigures: unknown[] = [
    null,
    [],
    new Date(),
    Object.assign(Object.create({ inherited: true }), base),
    { ...base, voterId: binding.subjectId },
    { ...base, voterCount: 5 },
    { ...base, realmId: binding.populationId },
    { ...base, privateRealmMean: 9 },
    { ...base, count: '5' },
    { ...base, count: -1 },
    { ...base, count: 1.5 },
    { ...base, count: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, mean: '0' },
    { ...base, mean: Number.NaN },
    { ...base, mean: Number.POSITIVE_INFINITY },
    { ...base, mean: -0.01 },
    { ...base, mean: 10.01 },
    { ...base, score: '0' },
    { ...base, score: Number.NEGATIVE_INFINITY },
    { ...base, score: -1 },
    { ...base, score: 11 },
    { ...base, priorEpoch: '1' },
    { ...base, priorEpoch: 0 },
    { ...base, priorEpoch: -1 },
    { ...base, priorEpoch: 1.5 },
    { ...base, priorEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, revision: '01' },
    { ...base, revision: '+1' },
    { ...base, revision: '-0' },
    { ...base, revision: '9223372036854775808' },
    { ...base, revision: '-9223372036854775809' },
    { ...base, asOf: '2026-02-29T00:00:00Z' },
    { ...base, asOf: '2026-10-28T24:00:00Z' },
    { ...base, asOf: '2026-10-28T00:00:00' },
    { ...base, asOf: '2026-10-28T00:00:00+24:00' },
    { ...base, asOf: `2026-10-28T00:00:00.${'1'.repeat(44)}Z` },
  ];
  for (const invalid of invalidFigures) expect(() => normalizePublicRatingFigure(invalid, binding)).toThrow();

  const withGetter = { ...base };
  Object.defineProperty(withGetter, 'mean', { get: () => 0, enumerable: true });
  expect(() => normalizePublicRatingFigure(withGetter, binding)).toThrow();

  const withSymbol = { ...base, [Symbol('private')]: 'hidden data' };
  expect(() => normalizePublicRatingFigure(withSymbol, binding)).toThrow();

  for (const [field, value] of Object.entries(base)) {
    const missing = { ...base } as Record<string, unknown>;
    delete missing[field];
    expect(() => normalizePublicRatingFigure(missing, binding)).toThrow();
    void value;
  }

  expect(() => normalizePublicRatingFigure({ ...base, questionId: 'not-a-uuid' }, binding)).toThrow();
  expect(() =>
    normalizePublicRatingFigure({ ...base, subjectId: '00000000-0000-7000-0000-00a000000001' }, binding),
  ).toThrow();
  expect(() =>
    normalizePublicRatingFigure({ ...base, questionId: '00000000-0000-8000-8000-000000000002' }, binding),
  ).toThrow();
  expect(() =>
    normalizePublicRatingFigure({ ...base, populationId: '00000000-0000-8000-8000-000000000002' }, binding),
  ).toThrow();
  expect(() => normalizePublicRatingFigure(base, { ...binding, subjectId: 'not-a-uuid' })).toThrow();
  expect(() =>
    normalizePublicRatingFigure(base, { ...binding, questionId: '00000000-0000-8000-8000-000000000002' }),
  ).toThrow();
  expect(() =>
    normalizePublicRatingFigure(base, {
      ...binding,
      populationId: '00000000-0000-8000-8000-000000000002',
    }),
  ).toThrow();
});

test('score nullability follows the public eligibility fields', () => {
  const base = figure();
  expect(() => normalizePublicRatingFigure({ ...base, count: 0, mean: 0 }, binding)).toThrow();
  expect(() => normalizePublicRatingFigure({ ...base, count: 0, score: 1 }, binding)).toThrow();
  expect(() => normalizePublicRatingFigure({ ...base, score: 1, mean: null }, binding)).toThrow();
  expect(() => normalizePublicRatingFigure({ ...base, count: 4, score: 1 }, binding)).toThrow();
  expect(() => normalizePublicRatingFigure({ ...base, priorEpoch: null, score: 1 }, binding)).toThrow();
});
