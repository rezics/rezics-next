import { expect, test } from 'bun:test';
import { memoryFeed, page, post } from '../features/feed/fixtures.ts';
import {
  appendPosts,
  projecting,
  recoverProjection,
  sameProjection,
} from '../features/feed/projection.ts';

const query = { scope: 'following', sort: 'new' } as const;
const a = post(1),
  b = post(2),
  c = post(3),
  d = post(4);
const lagging = {
  ...page([a, c]),
  projection: { sequence: '39', reviewSequence: '7', status: 'catching-up' as const },
};
const previous = { page: lagging, items: [a, c], pages: 1 };

test('G-1047: projection status covers All and ranked feeds without a caughtUp field', () => {
  expect(projecting(lagging)).toBe(true);
  expect(projecting(page([]))).toBe(false);
  expect(
    projecting(page([], { caughtUp: { state: 'projecting', asOf: '', lastVisitedAt: null } })),
  ).toBe(true);
});

test('G-1047: overlapping pages and duplicate entries in a page render once', () => {
  expect(appendPosts([a], [a, b, b, c]).map((item) => item.id)).toEqual([a.id, b.id, c.id]);
});

test('G-1047: backfilled history is replayed through the old last post without a pagination gap', async () => {
  const first = page([a, b], { nextCursor: 'fresh-2' });
  const api = memoryFeed({
    pages: { 'fresh-2': { ok: true, data: page([b, c], { nextCursor: 'fresh-3' }) } },
  });
  const recovered = await recoverProjection(api, query, first, previous, 4, () => true);
  expect(recovered).toMatchObject({
    ok: true,
    data: { items: [a, b, c], pages: 2, page: { nextCursor: 'fresh-3' } },
  });
  expect(api.calls).toEqual(['page:fresh-2']);
});

test('G-1047: a projection past the reader watermark, a changed review or a restored epoch cannot replace the view', async () => {
  const anchored = page([a, c]);
  const huge = '90071992547409930000000000000';
  const hugeNext = '90071992547409930000000000001';
  // Membership follows the epoch. Graph sequences past Number.MAX_SAFE_INTEGER stay in the same projection.
  expect(
    sameProjection(
      { ...anchored, sourcePosition: { dataEpoch: 'story', sequence: huge } },
      { ...anchored, sourcePosition: { dataEpoch: 'story', sequence: hugeNext } },
    ),
  ).toBe(true);
  expect(
    sameProjection(anchored, {
      ...anchored,
      sourcePosition: { dataEpoch: 'restored', sequence: '40' },
    }),
  ).toBe(false);
  // The watermark compares the fresh projection cut with the loaded source cut, and the anchor is present.
  expect(
    await recoverProjection(
      memoryFeed(),
      query,
      { ...anchored, projection: { ...anchored.projection, sequence: '41' } },
      previous,
      4,
      () => true,
    ),
  ).toEqual({ ok: false, failure: 'moved' });
  expect(
    await recoverProjection(
      memoryFeed(),
      query,
      { ...anchored, projection: { ...anchored.projection, sequence: hugeNext } },
      {
        ...previous,
        page: { ...previous.page, sourcePosition: { dataEpoch: 'story', sequence: huge } },
      },
      4,
      () => true,
    ),
  ).toEqual({ ok: false, failure: 'moved' });
  expect(
    await recoverProjection(
      memoryFeed(),
      query,
      { ...anchored, sourcePosition: { dataEpoch: 'restored', sequence: '40' } },
      previous,
      4,
      () => true,
    ),
  ).toEqual({ ok: false, failure: 'moved' });
  expect(
    await recoverProjection(
      memoryFeed(),
      query,
      { ...anchored, projection: { ...anchored.projection, reviewSequence: '8' } },
      previous,
      4,
      () => true,
    ),
  ).toEqual({ ok: false, failure: 'moved' });
});

test('G-1047: denied, failed, still-projecting and different-epoch replay pages do not replace the old list', async () => {
  const first = page([a, b], { nextCursor: 'fresh-2' });
  for (const next of [
    { ok: false, failure: 'moved' },
    { ok: false, failure: 'sign-in' },
    { ok: false, failure: 'unavailable' },
    { ok: true, data: lagging },
    {
      ok: true,
      data: { ...page([c]), sourcePosition: { dataEpoch: 'restored', sequence: '40' } },
    },
  ] as const) {
    const result = await recoverProjection(
      memoryFeed({ pages: { 'fresh-2': next } }),
      query,
      first,
      previous,
      4,
      () => true,
    );
    expect(result.ok).toBe(false);
    expect(previous.items).toEqual([a, c]);
  }
});

test('G-1047: a replay that reaches the loaded anchor may advance projection and review sequences', async () => {
  const first = page([a, b], { nextCursor: 'fresh-2' });
  const result = await recoverProjection(
    memoryFeed({
      pages: {
        'fresh-2': {
          ok: true,
          data: {
            ...page([c]),
            projection: { ...first.projection, sequence: '41', reviewSequence: '8' },
          },
        },
      },
    }),
    query,
    first,
    previous,
    4,
    () => true,
  );
  expect(result).toMatchObject({ ok: true, data: { items: [a, b, c] } });
  expect(previous.items).toEqual([a, c]);
});

test('G-1047: a chain that never reaches the loaded anchor does not replace the view; loops and sparse work stay bounded', async () => {
  const first = page([a, b], { nextCursor: 'fresh-2' });
  const exhausted = await recoverProjection(
    memoryFeed({ pages: { 'fresh-2': { ok: true, data: page([d]) } } }),
    query,
    first,
    previous,
    4,
    () => true,
  );
  expect(exhausted).toEqual({ ok: false, failure: 'moved' });
  const api = memoryFeed({
    pages: { 'fresh-2': { ok: true, data: page([], { nextCursor: 'fresh-2' }) } },
  });
  expect(await recoverProjection(api, query, first, previous, 4, () => true)).toEqual({
    ok: false,
    failure: 'moved',
  });
  expect(api.calls).toEqual(['page:fresh-2']);
  expect(await recoverProjection(memoryFeed(), query, first, previous, 0, () => true)).toEqual({
    ok: false,
    failure: 'moved',
  });
});

test('G-1047: leaving the view stops replay before it requests another page', async () => {
  const api = memoryFeed();
  expect(
    await recoverProjection(
      api,
      query,
      page([a], { nextCursor: 'fresh-2' }),
      previous,
      4,
      () => false,
    ),
  ).toEqual({ ok: false, failure: 'moved' });
  expect(api.calls).toEqual([]);
});
