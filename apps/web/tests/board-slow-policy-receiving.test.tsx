import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { changeBoardSlowModeRequest, readBoardSlowModeRequest } from '../src/threads/slow-mode/native';

const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000091';
const policy = { intervalSeconds: 45, retryAt: null, nextEligibleAt: null, canChange: true,
  exempt: true, admissionState: 'ready', retryAfterSeconds: 0 };

test('only the original exact PUT body acknowledges; malformed/opposite results never trigger readback', async () => {
  for (const body of [policy, { ...policy, intervalSeconds: 300 }, {}, { policy }]) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.test', { fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json(body);
    }) as typeof fetch });
    const result = await changeBoardSlowModeRequest({ boardId, intervalSeconds: 45,
      idempotencyKey: boardId }, new Request('https://web.test', {
      method: 'PUT', headers: { authorization: 'Bearer original' },
    }), {}, client, true);
    expect(result.kind).toBe(body === policy ? 'applied' : 'unknown');
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(`/v1/boards/${boardId}/slowMode`);
    expect(calls[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(boardId));
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer original');
  }
});

test('the installed reader preserves pending and a nonpreset policy', async () => {
  const client = createKernelClient('https://kernel.test', { fetch: (async () =>
    Response.json({ ...policy, exempt: false, canChange: false, admissionState: 'pending' })) as typeof fetch });
  expect(await readBoardSlowModeRequest(boardId, new Request('https://web.test', {
    headers: { authorization: 'Bearer ordinary' },
  }), {}, client, true)).toEqual({ kind: 'available', policy: {
    ...policy, exempt: false, canChange: false, admissionState: 'pending',
  } });
});
