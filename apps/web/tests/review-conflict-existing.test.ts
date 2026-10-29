import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { startThreadRequest } from '../src/threads/post-writes';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const request = new Request('https://rezics.test/', {
  headers: { authorization: 'Bearer reader' },
});
const body = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: { type: 'doc', content: [] },
} as never;
const input = {
  boardId: id(1),
  title: 'Review',
  body,
  idempotencyKey: id(2),
  kind: 'review' as const,
  subjectId: id(3),
};
const conflict = (existingThreadId?: string) => ({
  status: 409,
  headers: new Headers(),
  error: { value: { code: 'review_exists', ...(existingThreadId ? { existingThreadId } : {}) } },
});

function client(existingThreadId?: string, subjectReads: string[] = []) {
  return {
    threads: Object.assign(() => ({}), { post: async () => conflict(existingThreadId) }),
    subjects: (params: { id: string }) => ({
      threads: {
        get: async () => {
          subjectReads.push(params.id);
          return { data: { threads: [], next: null } };
        },
      },
    }),
  } as unknown as KernelClient;
}

const refusal = () => ({ ok: false as const, reason: 'conflict' as const });

test('a review-create 409 carrying existingThreadId offers that review with no further kernel request', async () => {
  const reads: string[] = [];
  const result = await startThreadRequest(input, request, {}, client(id(9), reads), refusal);
  expect(result).toMatchObject({ ok: false, reason: 'conflict', existingReviewId: id(9) });
  expect(reads).toEqual([]);
});

test('a review-create 409 without existingThreadId returns conflict with no subject threads read', async () => {
  const reads: string[] = [];
  const result = await startThreadRequest(input, request, {}, client(undefined, reads), refusal);
  expect(result).toEqual({ ok: false, reason: 'conflict' });
  expect(reads).toEqual([]);
});

test('submitting a review makes no subject threads request with 1, 30 or 300 reviews on the subject', async () => {
  for (const reviewCount of [1, 30, 300]) {
    const requests: string[] = [];
    const fakeClient = {
      threads: Object.assign(() => ({}), {
        post: async () => {
          requests.push('POST /v1/threads');
          return conflict(id(9));
        },
      }),
      subjects: (params: { id: string }) => ({
        threads: {
          get: async () => {
            requests.push(`GET /v1/subjects/${params.id}/threads`);
            return { data: { threads: [], next: null } };
          },
        },
      }),
    } as unknown as KernelClient;
    const result = await startThreadRequest(input, request, {}, fakeClient, refusal);
    expect(result).toMatchObject({ existingReviewId: id(9) });
    expect(reviewCount).toBeGreaterThan(0);
    expect(requests).toEqual(['POST /v1/threads']);
  }
});

test('the fake review create returns a conflict with an optional existingThreadId', async () => {
  const fake = createFakeKernelFetch(fixtures as never);
  const create = (headers = new Headers()) =>
    fake('https://kernel.test/v1/threads', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', ...Object.fromEntries(headers) }),
      body: JSON.stringify({ kind: 'review' }),
    });
  const present = await (await create()).json();
  const absent = await (await create(new Headers({ 'x-fake-omit-existing-thread-id': 'true' }))).json();
  expect(present).toMatchObject({ code: 'review_exists', existingThreadId: id(9) });
  expect(absent).toMatchObject({ code: 'review_exists' });
  expect(absent).not.toHaveProperty('existingThreadId');
});
