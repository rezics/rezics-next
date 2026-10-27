import { expect, test } from 'bun:test';
import { decodeSearchCursor, encodeSearchCursor, type SearchSortValue } from '../../src/search/cursor.ts';
import {
  decodeRatingCursor,
  encodeRatingCursor,
  type RatingCursorContext,
  type RatingPhase,
} from '../../src/search/rating-cursor.ts';

const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const binding = { operation: 'subjects.search', principal: 'anonymous', request: { sort: 'rating', limit: 2 } };
const context = {
  questionId: '00000000-0000-8000-8000-000000000001',
  populationId: '00000000-0000-8000-8000-000000000000',
  priorEpoch: 1,
};
const id = '00000000-0000-8000-8000-00a000000001';
const otherQuestion = '00000000-0000-7000-8000-000000000002';
const position = { generation: 3, phase: 'scored' as const, after: [0, 'A', id] };
const invalid = { ok: false, reason: 'invalid' } as const;
const restart = { ok: false, reason: 'restart' } as const;
const token = () => encodeRatingCursor(ring, binding, context, position, 1000);
const wire = (values: readonly SearchSortValue[]) =>
  encodeSearchCursor(ring, binding, { generation: 3, after: values }, 1000);
const signed = (
  overrides: {
    questionId?: SearchSortValue;
    populationId?: SearchSortValue;
    epoch?: SearchSortValue;
    phase?: SearchSortValue;
    after?: SearchSortValue[];
  } = {},
) =>
  wire([
    'rating-v1',
    overrides.questionId ?? context.questionId,
    overrides.populationId ?? context.populationId,
    Object.hasOwn(overrides, 'epoch') ? overrides.epoch! : 1,
    overrides.phase ?? 'scored',
    ...(overrides.after ?? position.after),
  ]);

test('search cursor preserves canonical requests and numeric primitive values', () => {
  const after = [0, -0, 1.25, null, '名前 🐈'] satisfies SearchSortValue[];
  const encoded = encodeSearchCursor(ring, binding, { generation: 3, after }, 1000);
  expect(decodeSearchCursor(ring, { ...binding, request: { limit: 2, sort: 'rating' } }, encoded, 1001)).toEqual({
    ok: true,
    generation: 3,
    after,
  });
  expect(decodeRatingCursor(ring, binding, context, encoded, 1001)).toEqual(invalid);
});

test('rating cursors use the closed search wire form and retain numeric scores and UTF-8 names', () => {
  for (const score of [0, -0, 0.125, 9.999999999999998, 10]) {
    const cursor = { ...position, after: [score, 'é e\u0301 名 🐈\u0000', id] };
    const encoded = encodeRatingCursor(ring, binding, context, cursor, 1000);
    expect(decodeRatingCursor(ring, binding, context, encoded, 1001)).toEqual({ ok: true, ...cursor });
    expect(decodeSearchCursor(ring, binding, encoded, 1001)).toEqual({
      ok: true,
      generation: 3,
      after: ['rating-v1', context.questionId, context.populationId, 1, 'scored', ...cursor.after],
    });
  }
});

test('unscored cursors roundtrip with null or positive prior epochs', () => {
  for (const epoch of [null, 1, Number.MAX_SAFE_INTEGER]) {
    const current = { ...context, priorEpoch: epoch };
    const cursor = { generation: Number.MAX_SAFE_INTEGER, phase: 'unscored' as const, after: ['', id] };
    const encoded = encodeRatingCursor(ring, binding, current, cursor, 1000);
    expect(decodeRatingCursor(ring, binding, current, encoded, 1001)).toEqual({ ok: true, ...cursor });
    expect(
      decodeRatingCursor(ring, binding, { ...current, priorEpoch: epoch === null ? 1 : null }, encoded, 1001),
    ).toEqual(restart);
  }
});

test('native missing names roundtrip exactly in both rating phases', () => {
  for (const epoch of [null, 1]) {
    const current = { ...context, priorEpoch: epoch };
    const cursors = [
      { generation: 3, phase: 'unscored' as const, after: [null, id] },
      ...(epoch === null ? [] : [{ generation: 3, phase: 'scored' as const, after: [0, null, id] }]),
    ];
    for (const cursor of cursors) {
      const encoded = encodeRatingCursor(ring, binding, current, cursor, 1000);
      expect(decodeRatingCursor(ring, binding, current, encoded, 1001)).toEqual({ ok: true, ...cursor });
      expect(decodeSearchCursor(ring, binding, encoded, 1001)).toEqual({
        ok: true,
        generation: 3,
        after: ['rating-v1', context.questionId, context.populationId, epoch, cursor.phase, ...cursor.after],
      });
    }
  }
});

test('valid signed metadata changes restart only after authenticating and validating the full tuple', () => {
  expect(decodeRatingCursor(ring, binding, { ...context, questionId: otherQuestion }, token(), 1001)).toEqual(restart);
  expect(decodeRatingCursor(ring, binding, context, signed({ questionId: otherQuestion }), 1001)).toEqual(restart);
  expect(decodeRatingCursor(ring, binding, context, signed({ epoch: 2 }), 1001)).toEqual(restart);
  expect(decodeRatingCursor(ring, binding, context, signed({ epoch: 2, after: [null, 'A', id] }), 1001)).toEqual(
    invalid,
  );
  expect(decodeRatingCursor(ring, binding, context, signed({ epoch: null }), 1001)).toEqual(invalid);
  // Current null eligibility must not invalidate an authentic formerly-scored tuple before comparison.
  expect(decodeRatingCursor(ring, binding, { ...context, priorEpoch: null }, token(), 1001)).toEqual(restart);
});

test('request, viewer, operation, key and every token mutation fail authentication', () => {
  for (const changed of [
    { ...binding, request: { ...binding.request, limit: 3 } },
    { ...binding, request: { ...binding.request, sort: 'name' } },
    { ...binding, principal: 'account:other' },
    { ...binding, operation: 'subjects.suggest' },
    { ...binding, principal: '' },
  ])
    expect(decodeRatingCursor(ring, changed, { ...context, priorEpoch: 2 }, token(), 1001)).toEqual(invalid);
  const wrongKey = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
  expect(decodeRatingCursor(wrongKey, binding, context, token(), 1001)).toEqual(invalid);
  const encoded = token();
  for (let index = 0; index < encoded.length; index++) {
    const changed = encoded.slice(0, index) + (encoded[index] === 'A' ? 'B' : 'A') + encoded.slice(index + 1);
    expect(decodeRatingCursor(ring, binding, context, changed, 1001)).toEqual(invalid);
  }
  const account = { ...binding, principal: 'account:reader' };
  const privateToken = encodeRatingCursor(ring, account, context, position, 1000);
  expect(decodeRatingCursor(ring, binding, context, privateToken, 1001)).toEqual(invalid);
});

test('expiry, future timestamps, generation and key rotation retain the shared cursor semantics', () => {
  const encoded = token();
  expect(decodeRatingCursor(ring, binding, context, encoded, 901000)).toEqual({ ok: true, ...position });
  expect(decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, encoded, 901001)).toEqual({
    ok: false,
    reason: 'expired',
  });
  expect(decodeRatingCursor(ring, binding, context, encoded, -59000)).toEqual({ ok: true, ...position });
  expect(decodeRatingCursor(ring, binding, context, encoded, -59001)).toEqual(invalid);
  const rotated = { current: 2, keys: new Map([...ring.keys, [2, new Uint8Array(32).fill(9)]]) };
  expect(decodeRatingCursor(rotated, binding, context, encoded, 1001)).toEqual({ ok: true, ...position });
  const newToken = encodeRatingCursor(rotated, binding, context, position, 1000);
  expect(decodeRatingCursor(rotated, binding, context, newToken, 1001)).toEqual({ ok: true, ...position });
  expect(decodeRatingCursor(ring, binding, context, newToken, 1001)).toEqual(invalid);
  expect(
    decodeRatingCursor({ current: 2, keys: new Map([[2, rotated.keys.get(2)!]]) }, binding, context, encoded, 1001),
  ).toEqual(invalid);
});

test('signed malformed metadata, phases and tuple arities are invalid even with stale eligibility', () => {
  const malformed: SearchSortValue[][] = [
    [],
    ['rating-v1'],
    ['rating-v2', context.questionId, context.populationId, 1, 'scored', ...position.after],
    ['rating-v1', context.questionId, context.populationId, 1, 'unscored', 'A', id, 'extra'],
    ...['', 'SCORED', 'other'].map((phase) => [
      'rating-v1',
      context.questionId,
      context.populationId,
      1,
      phase,
      ...position.after,
    ]),
  ];
  for (const values of malformed) {
    expect(decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, wire(values), 1001)).toEqual(invalid);
  }
  for (const epoch of [0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])
    expect(decodeRatingCursor(ring, binding, context, signed({ epoch }), 1001)).toEqual(invalid);
  for (const questionId of [
    '',
    'bad',
    context.questionId.toUpperCase().replace('000001', '00000A'),
    id + '\n',
    id.replace('-8000-', '-4000-'),
    id.replace('-8000-8000-', '-8000-0000-'),
  ])
    expect(decodeRatingCursor(ring, binding, context, signed({ questionId }), 1001)).toEqual(invalid);
  expect(decodeRatingCursor(ring, binding, context, signed({ populationId: id }), 1001)).toEqual(invalid);
});

test('invalid ordering values throw on encode and signed malformed ordering fails closed', () => {
  const malformed: { phase: unknown; after: unknown[] }[] = [
    ...[-1, 10.1, null, '0', Number.MAX_SAFE_INTEGER + 1].map((score) => ({
      phase: 'scored',
      after: [score, 'A', id],
    })),
    { phase: 'scored', after: ['A', id] },
    { phase: 'unscored', after: [0, 'A', id] },
    { phase: 'scored', after: [0, 'A', 'bad'] },
    { phase: 'unscored', after: [1, id] },
    { phase: 'unscored', after: ['A'] },
    { phase: 'unscored', after: ['A', id.toUpperCase()] },
    { phase: 'unscored', after: ['\ud800', id] },
    { phase: 'unscored', after: ['A', id, null] },
    { phase: null, after: ['A', id] },
    { phase: 'other', after: ['A', id] },
  ];
  for (const bad of malformed) {
    expect(() =>
      encodeRatingCursor(ring, binding, context, { generation: 3, ...bad } as typeof position, 1000),
    ).toThrow();
    expect(
      decodeRatingCursor(
        ring,
        binding,
        context,
        wire([
          'rating-v1',
          context.questionId,
          context.populationId,
          1,
          bad.phase as SearchSortValue,
          ...(bad.after as SearchSortValue[]),
        ]),
        1001,
      ),
    ).toEqual(invalid);
  }
  for (const score of [NaN, Infinity, -Infinity])
    expect(() => encodeRatingCursor(ring, binding, context, { ...position, after: [score, 'A', id] }, 1000)).toThrow();
  expect(() => encodeRatingCursor(ring, binding, { ...context, priorEpoch: null }, position, 1000)).toThrow();
});

test('name slots reject runtime objects, arrays and nonfinite or nonstring primitives', () => {
  for (const phase of ['scored', 'unscored'] as const) {
    for (const name of [undefined, {}, [], ['A'], false, 0, NaN, Infinity, -Infinity]) {
      const after = phase === 'scored' ? [0, name, id] : [name, id];
      expect(() =>
        encodeRatingCursor(
          ring,
          binding,
          context,
          { generation: 3, phase, after } as unknown as Parameters<typeof encodeRatingCursor>[3],
          1000,
        ),
      ).toThrow();
    }
  }
});

test('invalid current contexts and hostile runtime inputs fail closed', () => {
  for (const bad of [
    null,
    undefined,
    [],
    {},
    { ...context, questionId: 'bad' },
    { ...context, populationId: id },
    ...[undefined, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((priorEpoch) => ({
      ...context,
      priorEpoch,
    })),
  ]) {
    expect(() => encodeRatingCursor(ring, binding, bad as RatingCursorContext, position, 1000)).toThrow();
    expect(decodeRatingCursor(ring, binding, bad as RatingCursorContext, token(), 1001)).toEqual(invalid);
  }
  for (const bad of [null, undefined, 1, {}, [], '', 'x'.repeat(4097), token() + '.'])
    expect(decodeRatingCursor(ring, binding, context, bad as string, 1001)).toEqual(invalid);
  for (const generation of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => encodeRatingCursor(ring, binding, context, { ...position, generation }, 1000)).toThrow();
  for (const now of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => encodeRatingCursor(ring, binding, context, position, now)).toThrow();
    expect(decodeRatingCursor(ring, binding, context, token(), now)).toEqual(invalid);
  }
});

test('encoded cursors respect native name bounds and the shared token limit including UTF-8 and JSON escaping', () => {
  for (const name of ['A'.repeat(512), '名'.repeat(500), '🐈'.repeat(256), '\u0000'.repeat(200)]) {
    const cursor = { ...position, phase: 'unscored' as RatingPhase, after: [name, id] };
    const encoded = encodeRatingCursor(ring, binding, context, cursor, 1000);
    expect(encoded.length).toBeLessThanOrEqual(4096);
    expect(decodeRatingCursor(ring, binding, context, encoded, 1001)).toEqual({ ok: true, ...cursor });
  }
  for (const name of [
    'A'.repeat(4097),
    'A'.repeat(3000),
    '名'.repeat(1000),
    'A'.repeat(513),
    '🐈'.repeat(257),
    '\u0000'.repeat(500),
  ])
    expect(() => encodeRatingCursor(ring, binding, context, { ...position, after: [0, name, id] }, 1000)).toThrow();
  for (const name of ['A'.repeat(513), '🐈'.repeat(257)]) {
    for (const phase of ['scored', 'unscored'] as const) {
      const after = phase === 'scored' ? [0, name, id] : [name, id];
      expect(decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, signed({ phase, after }), 1001)).toEqual(
        invalid,
      );
    }
  }
});
