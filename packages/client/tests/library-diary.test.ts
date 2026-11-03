import { expect, test } from 'bun:test';
import { createKernelClient } from '../src/index.ts';
import type { DiaryPage } from '../src/kernel/library/diary-model.ts';

test('typed diary client preserves continuation and uses the native cancellation and addressed detail methods', async () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const payload: DiaryPage = {
    occurrences: [],
    next: null,
    continuation: null,
    expiresAt: null,
    order: 'recorded_started_desc_id_desc',
  };
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body });
      return Response.json(payload);
    }) as typeof fetch,
  });
  const result = await client.libraryDiary.get({ query: { limit: 2, cursor: 'sealed-token' } });
  const typed: DiaryPage | null = result.data;
  expect(typed).toEqual(payload);
  await client.libraryDiary.$cancel.post({ continuation: 'sealed-token' });
  await client
    .progressSessions({ sessionId: '019a1b2c-3d4e-7f00-8a00-000000000001' })
    .get({ query: { presentation: 'FULL', view: 'FULL' } });
  expect(new URL(requests[0]!.url).searchParams.get('cursor')).toBe('sealed-token');
  expect(requests[1]).toMatchObject({
    method: 'POST',
    url: 'http://kernel.test/v1/libraryDiary:cancel',
    body: JSON.stringify({ continuation: 'sealed-token' }),
  });
  expect(requests[2]!.url).toContain('/v1/progressSessions/019a1b2c-3d4e-7f00-8a00-000000000001?');
});
