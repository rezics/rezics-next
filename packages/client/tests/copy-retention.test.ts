import { expect, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER } from '../src/index.ts';

test('copy clear carries its CAS guard and exact receipt into the typed Undo request', async () => {
  const copyId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const deletionId = '019a1b2c-3d4e-7f00-8a00-000000000002';
  const sent: Request[] = [];
  const copy = {
    id: copyId,
    subjectId: '019a1b2c-3d4e-7f00-8a00-000000000003',
    kind: 'installation',
    status: 'licensed',
    revision: 9,
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: 'private edition',
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init));
    return sent.length === 1
      ? new Response(null, {
          status: 204,
          headers: { 'Library-Copy-Deletion-Id': deletionId, 'Library-Copy-Deletion-Revision': '8' },
        })
      : Response.json({ copy });
  }) as typeof fetch;
  const client = createKernelClient('https://kernel.test', { fetch: fetcher, session: 'viewer' });
  const holding = client.copies({ copyId });
  const cleared = await holding.delete(undefined, {
    query: { revision: 7 },
    headers: { 'idempotency-key': 'clear-copy' },
  });
  expect(cleared.status).toBe(204);
  expect(cleared.response.headers.get('Library-Copy-Deletion-Id')).toBe(deletionId);
  const body = {
    deletionId: cleared.response.headers.get('Library-Copy-Deletion-Id')!,
    revision: Number(cleared.response.headers.get('Library-Copy-Deletion-Revision')),
  };
  const restored = await holding.$restore.post(body, { headers: { 'idempotency-key': 'undo-copy' } });
  expect(restored.data?.copy).toEqual(copy);
  expect(sent.map(({ method, url }) => [method, url])).toEqual([
    ['DELETE', `https://kernel.test/v1/copies/${copyId}?revision=7`],
    ['POST', `https://kernel.test/v1/copies/${copyId}:restore`],
  ]);
  expect(await sent[1]!.json()).toEqual({ deletionId, revision: 8 });
  expect(sent.map((request) => request.headers.get(SESSION_HEADER))).toEqual(['viewer', 'viewer']);
  expect(sent[1]!.headers.get('idempotency-key')).toBe('undo-copy');
});
