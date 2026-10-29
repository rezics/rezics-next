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
const context: RatingCursorContext = {
  questionId: '00000000-0000-8000-8000-000000000001',
  populationId: '00000000-0000-8000-8000-000000000000',
  priorEpoch: 1,
};
const id = '00000000-0000-8000-8000-00a000000001';
const invalid = { ok: false, reason: 'invalid' } as const;
const wire = (after: SearchSortValue[]) => encodeSearchCursor(ring, binding, { generation: 3, after }, 1000);

test('rating metadata rejects malformed Global literals and private populations in both phases', async () => {
  for (const phase of ['scored', 'unscored'] satisfies RatingPhase[]) {
    const after = phase === 'scored' ? [0, 'A', id] : ['A', id];
    const cursor = { generation: 3, phase, after };
    const token = await encodeRatingCursor(ring, binding, context, cursor, 1000);
    for (const populationId of ['00000000-0000-8000-8000-0000000', context.populationId + '\n', id, '']) {
      const current = { ...context, populationId };
      await expect(encodeRatingCursor(ring, binding, current, cursor, 1000)).rejects.toThrow();
      expect(await decodeRatingCursor(ring, binding, current, token, 1001)).toEqual(invalid);
      const signed = await wire(['rating-v1', context.questionId, populationId, 1, phase, ...after]);
      expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, signed, 1001)).toEqual(invalid);
    }
  }
});

test('each signed metadata field requires its exact primitive type before eligibility comparison', async () => {
  const valid: SearchSortValue[] = ['rating-v1', context.questionId, context.populationId, 1, 'scored', 0, 'A', id];
  for (const index of [0, 1, 2, 4, 6, 7]) {
    for (const value of index === 6 ? [0] : [null, 0]) {
      const changed = [...valid];
      changed[index] = value;
      expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, await wire(changed), 1001)).toEqual(
        invalid,
      );
    }
  }
  for (const phase of ['scored', 'unscored']) {
    for (const after of [[], ['A'], [0, 'A'], ['A', id, null]]) {
      const signed = await wire(['rating-v1', context.questionId, context.populationId, 1, phase, ...after]);
      expect(await decodeRatingCursor(ring, binding, context, signed, 1001)).toEqual(invalid);
    }
  }
});

test('native metadata is a structural view and only the closed rating tuple is signed', async () => {
  const native = { ...context, sourceRevision: 'current', standard: true };
  const cursor = { generation: 3, phase: 'unscored' as const, after: ['名前 🐈', id] };
  const token = await encodeRatingCursor(ring, binding, native, cursor, 1000);
  expect(await decodeRatingCursor(ring, binding, native, token, 1001)).toEqual({ ok: true, ...cursor });
  const closedToken = await encodeRatingCursor(ring, binding, context, cursor, 1000);
  expect(token).not.toBe(closedToken);
  expect(await decodeSearchCursor(ring, binding, token, 1001)).toEqual(
    await decodeSearchCursor(ring, binding, closedToken, 1001),
  );
  expect(await decodeRatingCursor(ring, binding, { ...native, priorEpoch: null }, token, 1001)).toEqual({
    ok: false,
    reason: 'restart',
  });
});
