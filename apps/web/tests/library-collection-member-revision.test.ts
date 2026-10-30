import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { removeCollectionMemberRecord } from '../src/library/collection-records.ts';

const collectionId = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const memberId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-0000000000aa';
const write = () =>
  new Request('https://site.example.test/_serverFn/collection', {
    method: 'POST',
    headers: { authorization: 'Bearer access-token' },
  });

test('member DELETE sends the loaded parent revision in one bodyless request with deletion receipt headers', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(null, {
        status: 204,
        headers: {
          'Library-Collection-Member-Deletion-Id': '0192f3a0-6c1e-7b2a-9d4e-000000000099',
          'Library-Collection-Member-Deletion-Revision': '7',
        },
      });
    },
  });

  expect(
    await removeCollectionMemberRecord(client, write(), {}, { collectionId, memberId, revision: 7, idempotencyKey }),
  ).toEqual({ ok: true, id: memberId });
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe('DELETE');
  expect(request.url).toBe(`https://kernel.example.test/v1/collections/${collectionId}/members/${memberId}?revision=7`);
  expect(request.body).toBeNull();
  expect(request.headers.get('authorization')).toBe('Bearer access-token');
  expect(request.headers.get('idempotency-key')).toBe(idempotencyKey);
});

test('member DELETE rejects invalid numeric revisions before sending a request', async () => {
  let requests = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async () => {
      requests += 1;
      throw new Error('Invalid revision must not reach the kernel');
    },
  });

  for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      await removeCollectionMemberRecord(client, write(), {}, { collectionId, memberId, revision, idempotencyKey }),
    ).toEqual({ ok: false, reason: 'invalid' });
  }
  expect(requests).toBe(0);
});

test.each([
  [409, 'conflict'],
  [404, 'invalid'],
  [403, 'forbidden'],
  [503, 'unavailable'],
] as const)('member DELETE preserves native %i failure without a revision read or retry', async (status, reason) => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ status, code: reason }, { status });
    },
  });

  expect(
    await removeCollectionMemberRecord(client, write(), {}, { collectionId, memberId, revision: 7, idempotencyKey }),
  ).toEqual({ ok: false, reason });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe('DELETE');
  expect(new URL(requests[0]!.url).searchParams.get('revision')).toBe('7');
});
