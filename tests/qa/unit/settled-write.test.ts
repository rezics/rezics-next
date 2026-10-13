import { expect, test } from 'bun:test';
import { settledWrite } from '../support/settled-write.ts';

const pending = (overrides: object = {}) => Response.json({
  operationId: 'operation', status: 'reconciling', phase: 'realm-adoption', result: null,
  retry: { allowed: true, afterMs: 7 }, ...overrides,
}, { status: 202 });

test('final first answers are returned intact, including refusals and server failures', async () => {
  for (const status of [200, 201, 400, 409, 503]) {
    const response = Response.json({ marker: 'final' }, { status });
    let calls = 0;
    const result = await settledWrite(async () => { calls++; return response; }, 'POST', '/v1/works');
    expect(result).toBe(response);
    expect(await result.json()).toEqual({ marker: 'final' });
    expect(calls).toBe(1);
  }
});

test('pending twice then final preserves method, path, body and supplied or generated key', async () => {
  for (const key of [undefined, 'caller-key']) {
    const body = { intent: 'original' };
    const calls: unknown[][] = [];
    const waits: number[] = [];
    const final = Response.json({ work: 'created' }, { status: 201 });
    const responses = [pending(), pending({ retry: { allowed: true, afterMs: 11 } }), final];
    const result = await settledWrite(async (...args) => {
      calls.push(args);
      return responses.shift()!;
    }, 'POST', '/v1/works', body, key, { sleep: async ms => { waits.push(ms); } });
    expect(result).toBe(final);
    expect(calls).toHaveLength(3);
    expect(calls[0]![3]).toBeString();
    if (key) expect(calls[0]![3]).toBe(key);
    for (const call of calls) {
      expect(call).toEqual(['POST', '/v1/works', body, calls[0]![3]]);
      expect(call[2]).toBe(body);
    }
    expect(waits).toEqual([7, 11]);
  }
});

test('invalid pending bodies fail with the request and last answer', async () => {
  for (const response of [Response.json(null, { status: 202 }),
    new Response('invalid-json', { status: 202 }),
    ...[{ operationId: '' }, { status: 'pending' }, { phase: '' }, { result: {} },
      { retry: { allowed: false, afterMs: 7 } }, { retry: { allowed: true, afterMs: -1 } },
      { retry: { allowed: true, afterMs: '7' } }].map(pending)]) {
    await expect(settledWrite(async () => response, 'POST', '/v1/works'))
      .rejects.toThrow('Fixture write POST /v1/works: returned an invalid reconciling answer; last answer=');
  }
});

test('changing operation identity reports the latest pending answer', async () => {
  const responses = [pending(), pending({ operationId: 'another' })];
  await expect(settledWrite(async () => responses.shift()!, 'POST', '/v1/works', {}, 'key',
    { sleep: async () => {} })).rejects.toThrow(/changed operation identity.*another/);
});

test('resend count, deadline and a hung resend are bounded', async () => {
  let calls = 0;
  await expect(settledWrite(async () => { calls++; return pending(); }, 'POST', '/v1/works', {}, 'key',
    { maxAttempts: 2, sleep: async () => {} })).rejects.toThrow(/within 2 retries.*last answer=/);
  expect(calls).toBe(3);
  await expect(settledWrite(async () => pending(), 'POST', '/v1/works', {}, 'key',
    { timeoutMs: 1 })).rejects.toThrow('did not settle');
  let first = true;
  await expect(settledWrite(async () => {
    if (first) { first = false; return pending({ retry: { allowed: true, afterMs: 0 } }); }
    return new Promise<Response>(() => {});
  }, 'POST', '/v1/works', {}, 'key', { timeoutMs: 20 }))
    .rejects.toThrow(/POST \/v1\/works.*resend timed out.*last answer=/);
});
