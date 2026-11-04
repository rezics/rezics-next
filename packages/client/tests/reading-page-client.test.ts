import { expect, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '../src/index.ts';

const ORIGIN = 'https://kernel.test';
const THREAD_ID = '019a1b2c-3d4e-7f00-8a00-000000000001';

test('the generated reading page route sends its cursor through the kernel client', async () => {
  const requests: Request[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const client: KernelClient = createKernelClient(ORIGIN, { fetch });
  const cursor = 'selected-frontier';

  const result = await client.threads({ id: THREAD_ID })['reading-page'].get({ query: { cursor } });

  expect(result.status).toBe(200);
  expect(result.error).toBeNull();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe('GET');
  const url = new URL(requests[0]!.url);
  expect(url.pathname).toBe(`/v1/threads/${THREAD_ID}/reading-page`);
  expect(url.searchParams.get('cursor')).toBe(cursor);
});
