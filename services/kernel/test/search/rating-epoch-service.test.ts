import { expect, test } from 'bun:test';
import { encodeSearchCursor } from '../../src/search/cursor.ts';
import { encodeRatingCursor } from '../../src/search/rating-cursor.ts';
import { book, context, deployment, figure } from './rating-service-admission.test.ts';

const code = (name: string) => ({ code: name });

test('null eligibility, numeric zero and current scored/unscored positions use native tuples', async () => {
  const a = book(1),
    b = book(2),
    c = book(3);
  const d = await deployment([{ subject: a, score: 0 }, { subject: b, score: 9 }, { subject: c }]);
  const first = await d.search({ sort: 'rating', limit: 1 });
  expect(first.subjects.map((x) => x.id)).toEqual([b.id]);
  const second = await d.search({ sort: 'rating', limit: 1, cursor: first.next! });
  expect(second.subjects.map((x) => x.id)).toEqual([a.id]);
  const third = await d.search({ sort: 'rating', limit: 1, cursor: second.next! });
  expect(third.subjects.map((x) => x.id)).toEqual([c.id]);
  expect(third.next).toBeNull();
  d.setEpoch(context(null));
  const below = await d.search();
  expect(below.subjects.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
});

test('signed cursor authenticates viewer/query/phase before changed epoch restart, including 50 to 49', async () => {
  const d = await deployment([1, 2, 3].map((n) => ({ subject: book(n), score: n })));
  const first = await d.search({ sort: 'rating', limit: 1 });
  const cursor = first.next!;
  for (const epoch of [null, 2]) {
    d.setEpoch(context(epoch));
    await expect(d.search({ sort: 'rating', limit: 1, cursor })).rejects.toMatchObject(code('search_restart_required'));
    await expect(d.search({ sort: 'rating', limit: 2, cursor })).rejects.toMatchObject(code('invalid_request'));
    await expect(d.service.search('account:other', { sort: 'rating', limit: 1, cursor })).rejects.toMatchObject(
      code('invalid_request'),
    );
    await expect(d.search({ sort: 'rating', text: 'book', limit: 1, cursor })).rejects.toMatchObject(
      code('invalid_request'),
    );
    await expect(d.search({ sort: 'name', limit: 1, cursor })).rejects.toMatchObject(code('invalid_request'));
  }
  d.setEpoch(context(1));
  await d.publish(2);
  await expect(d.search({ sort: 'rating', limit: 1, cursor })).rejects.toMatchObject(code('search_restart_required'));
});

test('mid-request epoch and alias changes restart even on empty pages', async () => {
  for (const change of ['epoch', 'generation'] as const) {
    const d = await deployment();
    d.onEpoch(async () => {
      if (d.counts().epochCalls !== 2) return;
      if (change === 'epoch') d.setEpoch(context(2));
      else await d.publish(2);
    });
    await expect(d.search()).rejects.toMatchObject(code('search_restart_required'));
  }
});

test('unavailable or invalid native context and figure reads fail retryably', async () => {
  for (const failure of ['epoch', 'source', 'invalid'] as const) {
    const d = await deployment([{ subject: book(1), score: 8 }]);
    if (failure === 'epoch') d.failEpoch();
    else if (failure === 'source') d.failSource();
    else d.setEpoch({ ...context(0) });
    await expect(d.search()).rejects.toMatchObject({ code: 'index_not_ready', headers: { 'retry-after': '1' } });
  }
});

test('stale, wrong grain and newly eligible unscored figures are consumed without reranking', async () => {
  const entries = [1, 2, 3, 4, 5, 6].map((n) => ({ subject: book(n), ...(n < 5 ? { score: 10 - n } : {}) }));
  const d = await deployment(entries);
  d.figures.set(book(1).id, figure(book(1).id, 1));
  d.figures.set(book(2).id, figure(book(2).id, 8, 2));
  d.figures.set(book(3).id, { ...figure(book(3).id, 7), questionId: book(99).id });
  d.figures.set(book(5).id, figure(book(5).id, 10));
  const page = await d.search({ sort: 'rating', limit: 2 });
  expect(page.subjects.map((x) => x.id)).toEqual([book(4).id, book(6).id]);
  expect(d.counts().epochCalls).toBe(2);
  expect(d.counts().sizes.every((size) => size <= 200)).toBe(true);
});

test('bounded refill stops after three rounds', async () => {
  const d = await deployment(Array.from({ length: 620 }, (_, i) => ({ subject: book(i + 1), score: 8 })));
  // All indexed scores are stale; no synthesized current order or unbounded fill is permitted.
  d.figures.clear();
  const result = await d.search({ sort: 'rating', limit: 100 });
  expect(result.subjects).toEqual([]);
  expect(d.counts().sizes).toEqual([200, 0, 200, 0, 200, 0]);
  expect(d.counts().aliasCalls).toBe(2);
  expect(d.counts().freshnessCalls).toBe(1);
  expect(result.next).toBeString();
  expect(d.counts().sizes.every((n) => n <= 200)).toBe(true);
  expect(d.counts().epochCalls).toBe(2);
});

test('live phase movement consumes duplicate raw IDs without re-emitting', async () => {
  const d = await deployment(
    [1, 2, 3, 4, 5].map((n) => ({ subject: book(n), score: 10 - n })).concat([{ subject: book(6), score: 0 }]),
  );
  for (const n of [2, 3, 4, 5]) d.figures.delete(book(n).id);
  d.onSearch(async (number) => {
    // First round consumes A's first five hits; next round sees the emitted ID move into B.
    if (number === 3) await d.unscore(book(1).id);
  });
  const page = await d.search({ sort: 'rating', limit: 2 });
  expect(page.subjects.map((x) => x.id)).toEqual([book(1).id, book(6).id]);
  expect(new Set(page.subjects.map((x) => x.id)).size).toBe(page.subjects.length);
});

test('signed malformed phase is invalid and lower-bound operation continues with actual native phase', async () => {
  const d = await deployment([1, 2, 3].map((n) => ({ subject: book(n), score: 10 - n })));
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(5)]]) };
  const binding = { operation: 'subjects.search', principal: 'anonymous', request: { sort: 'rating', limit: 1 } };
  const malformed = await encodeSearchCursor(ring, binding, {
    generation: 1,
    after: ['rating-v1', context(1).questionId, context(1).populationId, 1, 'unscored', 9, 'book 0001', book(1).id],
  });
  await expect(d.search({ sort: 'rating', limit: 1, cursor: malformed })).rejects.toMatchObject(
    code('invalid_request'),
  );
  const cursor = await encodeRatingCursor(ring, { ...binding, operation: 'subjects.search.lower_bound' }, context(1), {
    generation: 1,
    phase: 'scored',
    after: [9, 'book 0001', book(1).id],
  });
  const result = await d.search({ sort: 'rating', limit: 1, cursor });
  expect(result.subjects.map((x) => x.id)).toEqual([book(2).id]);
  expect(result).not.toHaveProperty('total');
});

test('figures from a different native partition publication cannot justify current source disclosure', async () => {
  const d = await deployment([{ subject: book(1), score: 8 }]);
  d.onRead(async () => {
    d.fake.advance(10);
  });
  await expect(d.search()).rejects.toMatchObject({ code: 'index_not_ready', headers: { 'retry-after': '1' } });
});
