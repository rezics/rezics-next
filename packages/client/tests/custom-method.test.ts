import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';

test('the client sends custom methods to their AIP-136 paths', async () => {
  const sent: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${init?.method ?? 'GET'} ${input instanceof Request ? input.url : String(input)}`);
    return Response.json({});
  }) as typeof fetch;
  const client = createKernelClient('http://kernel.test', { fetch: fetcher }) as any;
  await client.media({ id: '019a1b2c-3d4e-7f00-8a00-000000000001' }).$complete.post({});
  await client.subjects.$merge.post({ subjects: [] });
  await client.subjects({ id: '019a1b2c-3d4e-7f00-8a00-000000000002' }).get();
  await client.definitions.releases({ digest: `sha256:${'0'.repeat(64)}` }).$activate.post({ expected_head: null });
  expect(sent.slice(0, 3)).toEqual([
    'POST http://kernel.test/v1/media/019a1b2c-3d4e-7f00-8a00-000000000001:complete',
    'POST http://kernel.test/v1/subjects:merge',
    'GET http://kernel.test/v1/subjects/019a1b2c-3d4e-7f00-8a00-000000000002',
  ]);
  expect(sent[3]).toMatch(new RegExp(`^POST http://kernel\\.test/v1/definitions/releases/sha256(:|%3A)${'0'.repeat(64)}:activate$`));
});
