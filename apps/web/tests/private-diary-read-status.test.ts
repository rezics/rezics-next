import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readDiaryPage } from '../src/library/private-diary/native';

const authorization = 'Bearer current';

function answering(status: number, body: unknown) {
  return createKernelClient('https://kernel.test', {
    fetch: async () => Response.json(body, { status }),
  });
}

test('diary reads retry a mid-read conflict but restart after dead cursors and keep other failures unavailable', async () => {
  const cursor = 'opaque-next';
  expect(await readDiaryPage(answering(409, { code: 'conflict' }), authorization, cursor)).toEqual({
    kind: 'conflict',
  });
  expect(await readDiaryPage(answering(409, { code: 'stale_cursor' }), authorization, cursor)).toEqual({
    kind: 'stale',
  });
  expect(await readDiaryPage(answering(400, { code: 'invalid_cursor' }), authorization, cursor)).toEqual({
    kind: 'stale',
  });
  expect(await readDiaryPage(answering(400, { code: 'invalid_request' }), authorization)).toEqual({
    kind: 'unavailable',
  });
});
