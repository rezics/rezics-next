import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('the typed client reads and edits a session journal by its existing session ID', async () => {
  const sent: Request[] = [];
  const sessionId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      return request.method === 'GET'
        ? Response.json({
            journal: { sessionId, revision: 0, startDate: { year: 2022, month: 11 }, finishDate: null, reflection: null },
          })
        : Response.json({ journal: { sessionId, revision: 1, changed: true } });
    }) as typeof fetch,
  });

  const read = await client.progressSessions({ sessionId }).journal.get();
  expect(read.data?.journal.startDate).toEqual({ year: 2022, month: 11 });
  await client.progressSessions({ sessionId }).journal.patch(
    { revision: 0, reflection: 'A private note' },
    { headers: { 'idempotency-key': 'journal-write-1' } },
  );
  expect(sent.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
    `GET /v1/progressSessions/${sessionId}/journal`,
    `PATCH /v1/progressSessions/${sessionId}/journal`,
  ]);
  expect(sent[1]?.headers.get('idempotency-key')).toBe('journal-write-1');
  expect(await sent[1]?.json()).toEqual({ revision: 0, reflection: 'A private note' });
});
