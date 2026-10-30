import { expect, test } from 'bun:test';
import { encodeRatingCursor, decodeRatingCursor } from '../../src/search/rating-cursor.ts';
test('rating cursors bind Global eligibility and phase without treating an epoch change as tampering', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const binding = { operation: 'subjects.search', principal: 'anonymous', request: { sort: 'rating', limit: 2 } };
  const context = {
    questionId: '00000000-0000-8000-8000-000000000001',
    populationId: '00000000-0000-8000-8000-000000000000',
    priorEpoch: 1,
  };
  const position = { generation: 3, phase: 'scored' as const, after: [0, 'A', '00000000-0000-8000-8000-00a000000001'] };
  const token = await encodeRatingCursor(ring, binding, context, position, 1000);
  expect(await decodeRatingCursor(ring, binding, context, token, 1001)).toEqual({ ok: true, ...position });
  expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, token, 1001)).toEqual({
    ok: false,
    reason: 'restart',
  });
  expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: null }, token, 1001)).toEqual({
    ok: false,
    reason: 'restart',
  });
  expect(await decodeRatingCursor(ring, { ...binding, principal: 'account:other' }, context, token, 1001)).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

test('rating continuation time boundaries remain independent of prior restart and request binding', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const request = { sort: 'rating', limit: 1, languages: ['en'] };
  const binding = { operation: 'subjects.search', principal: 'anonymous', request };
  const context = {
    questionId: '00000000-0000-8000-8000-000000000001',
    populationId: '00000000-0000-8000-8000-000000000000',
    priorEpoch: 1,
  };
  const position = { generation: 3, phase: 'unscored' as const, after: ['A', '00000000-0000-8000-8000-00a000000001'] };
  const issued = 1_000_000;
  const token = await encodeRatingCursor(ring, binding, context, position, issued);
  for (const elapsed of [899_999, 900_000, -59_999, -60_000])
    expect(await decodeRatingCursor(ring, binding, context, token, issued + elapsed)).toEqual({
      ok: true,
      ...position,
    });
  expect(await decodeRatingCursor(ring, binding, context, token, issued + 900_001)).toEqual({
    ok: false,
    reason: 'expired',
  });
  expect(await decodeRatingCursor(ring, binding, context, token, issued - 60_001)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, token, issued)).toEqual({
    ok: false,
    reason: 'restart',
  });
  for (const changed of [
    { ...binding, principal: 'account:00000000-0000-8000-8000-00a000000002' },
    { ...binding, request: { ...request, text: 'other' } },
    { ...binding, request: { ...request, languages: ['ja'] } },
  ])
    expect(await decodeRatingCursor(ring, changed, { ...context, priorEpoch: 2 }, token, issued)).toEqual({
      ok: false,
      reason: 'invalid',
    });
});
