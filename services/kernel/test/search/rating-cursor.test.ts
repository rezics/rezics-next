import { expect, test } from 'bun:test';
import { encodeRatingCursor, decodeRatingCursor } from '../../src/search/rating-cursor.ts';
test('rating cursors bind Global eligibility and phase without treating an epoch change as tampering', () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const binding = { operation: 'subjects.search', principal: 'anonymous', request: { sort: 'rating', limit: 2 } };
  const context = { questionId: '00000000-0000-8000-8000-000000000001', populationId: '00000000-0000-8000-8000-000000000000', priorEpoch: 1 };
  const position = { generation: 3, phase: 'scored' as const, after: [0, 'A', '00000000-0000-8000-8000-00a000000001'] };
  const token = encodeRatingCursor(ring, binding, context, position, 1000);
  expect(decodeRatingCursor(ring, binding, context, token, 1001)).toEqual({ ok: true, ...position });
  expect(decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, token, 1001)).toEqual({ ok: false, reason: 'restart' });
  expect(decodeRatingCursor(ring, binding, { ...context, priorEpoch: null }, token, 1001)).toEqual({ ok: false, reason: 'restart' });
  expect(decodeRatingCursor(ring, { ...binding, principal: 'account:other' }, context, token, 1001)).toEqual({ ok: false, reason: 'invalid' });
});
