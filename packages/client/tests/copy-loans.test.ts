import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('copy-loan commands use the mounted list, create, extend and return paths', async () => {
  const loanId = '019a1b2c-3d4e-7f00-8a00-000000000001';
  const sent: string[] = [];
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(`${init?.method ?? 'GET'} ${input instanceof Request ? input.url : String(input)}`);
      return Response.json({});
    }) as typeof fetch,
  });
  const headers = { 'idempotency-key': '"loan-key"' };
  await client['copy-loans'].get({ query: { filter: 'open', limit: 20 } });
  await client['copy-loans'].post(
    {
      copyId: loanId,
      copyRevision: 1,
      direction: 'lent',
      counterparty: { kind: 'name', name: 'Ada' },
      startedOn: '2026-11-01',
    },
    { headers },
  );
  await client['copy-loans']({ loanId }).patch({ revision: 1, dueOn: '2026-11-08' }, { headers });
  await client['copy-loans']({ loanId }).return.post({ revision: 1, returnedOn: '2026-11-06' }, { headers });
  expect(sent).toEqual([
    'GET http://kernel.test/v1/copy-loans?filter=open&limit=20',
    'POST http://kernel.test/v1/copy-loans',
    `PATCH http://kernel.test/v1/copy-loans/${loanId}`,
    `POST http://kernel.test/v1/copy-loans/${loanId}/return`,
  ]);
});
