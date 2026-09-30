import { expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { adoptOpenLibraryBook, submitReviewedBatch } from '../features/library/import-api.ts';

const throttled = (retryAfter: string) => ({ status: 429, data: null,
  error: { value: { code: 'rate_limited' } },
  response: new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }),
});

test('G-543: Library batch resumes the same intent after Retry-After, without failing a row', async () => {
  const keys: string[] = [], times: number[] = [];
  const progress = { items: [{ index: 0, result: { work: 'work', applied: ['status'], issues: [] } }],
    total: 1, pending: false };
  const main = { v1: { me: { 'library-import': { batches: { post: async (_body: unknown,
    options: { headers: { 'idempotency-key': string } }) => {
    keys.push(options.headers['idempotency-key']); times.push(Date.now());
    return keys.length === 1 ? throttled('1') : { status: 200, data: progress };
  } } } } } } as unknown as MainClient;
  const observed: unknown[] = [];
  expect(await submitReviewedBatch('reader', null, 'en', [], [{ work: 'work', status: 'read',
    startedOn: null, finishedOn: null, rating: null, hasRating: false, review: null,
    reviewVisibility: 'private', shelves: [] }], value => observed.push(value), () => main)).toEqual(progress);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]); expect(observed).toEqual([progress]);
});

test('G-543: Library adoption retries an HTTP-date Retry-After with the same idempotency key', async () => {
  const keys: string[] = [];
  const main = { v1: { me: { 'library-import': { 'open-library': { adoptions: {
    post: async (_body: unknown, options: { headers: { 'idempotency-key': string } }) => {
      keys.push(options.headers['idempotency-key']);
      return keys.length === 1 ? throttled(new Date(Date.now() - 1000).toUTCString())
        : { status: 200, data: { work: 'https://rezics.com/id/adopted' } };
    },
  } } } } } } as unknown as MainClient;
  expect(await adoptOpenLibraryBook('reader', 'OL66554W', 'en', () => main)).toBe('https://rezics.com/id/adopted');
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
});
