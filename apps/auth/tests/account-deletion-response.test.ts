import { afterEach, expect, spyOn, test } from 'bun:test';
import { DELETION_APPROVAL_MAX_RESPONSE_BYTES, DELETION_EXECUTION_MAX_RESPONSE_BYTES } from '@rezics/auth-contract';
import { runAccountOperation } from '../src/account-operations';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const operation = { kind: 'delete' as const, accountId: 'original' };
const reference = 'A'.repeat(4096 - 44) + '.' + 'a'.repeat(43);
const approval = (extra = {}) => ({ reference, expiresAt: new Date(Date.now() + 60000).toISOString(), ...extra });
const browser = { isCurrent: () => true, retryUncertain: true };
function replies(values: Response[]) {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_, init) => {
    calls.push(init!);
    return values.shift()!;
  }) as typeof fetch;
  return calls;
}
const refusal = (status = 403) =>
  Response.json({ error: 'account_operation_denied', effect_status: 'not_applied' }, { status });

test('closed usable approval and exact original success; malformed output never gains a retry or refusal', async () => {
  for (const value of [
    approval({ extra: true }),
    approval({ reference: '' }),
    approval({ expiresAt: new Date(0).toISOString() }),
    approval({ expiresAt: 'tomorrow' }),
  ]) {
    const calls = replies([Response.json(value)]);
    expect(await runAccountOperation('key', operation, browser)).toEqual({ ok: false, reason: 'unavailable' });
    expect(calls).toHaveLength(1);
  }
  for (const reply of [
    Response.json({ accountId: 'wrong' }),
    Response.json({ accountId: 'original', extra: true }),
    Response.json({ accountId: 'original', expired: true }),
    new Response('{'),
    new Response('{}', { status: 401 }),
    new Response('{}', { status: 403 }),
    new Response('{}', { status: 409 }),
    Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 403 }),
    Response.json({ error: 'unavailable' }, { status: 400 }),
  ]) {
    const calls = replies([Response.json(approval()), reply]);
    expect(await runAccountOperation('key', operation, browser)).toEqual({ ok: false, reason: 'unknown' });
    expect(calls).toHaveLength(2);
  }
  for (const status of [400, 401, 403, 409, 413, 415, 503]) {
    replies([Response.json(approval()), refusal(status)]);
    expect(await runAccountOperation('key', operation, browser)).toEqual({
      ok: false,
      reason: status === 503 ? 'unavailable' : [401, 403, 409].includes(status) ? 'denied' : 'failure',
    });
  }
  replies([Response.json(approval()), Response.json({ accountId: 'original' })]);
  expect(await runAccountOperation('key', operation, browser)).toEqual({ ok: true, accountId: 'original' });

  const historicalReference = 'approval-historical-operation-v1';
  const historicalCalls = replies([
    Response.json(approval({ reference: historicalReference })),
    Response.json({ accountId: 'original' }),
  ]);
  expect(await runAccountOperation('key', operation, browser)).toEqual({ ok: true, accountId: 'original' });
  expect(JSON.parse(String(historicalCalls[1]!.body)).reference).toBe(historicalReference);
});

test('raw bounds precede parsing; legal escaped maximal references and split UTF-8 survive dishonest lengths', async () => {
  const escaped = JSON.stringify(approval()).replaceAll('A', '\\u0041');
  const target = { kind: 'delete' as const, accountId: '\ud800'.repeat(4096) };
  const ack = JSON.stringify({ accountId: target.accountId });
  expect(new TextEncoder().encode(escaped).length).toBeLessThanOrEqual(DELETION_APPROVAL_MAX_RESPONSE_BYTES);
  expect(ack.length).toBe(DELETION_EXECUTION_MAX_RESPONSE_BYTES);
  replies([new Response(escaped), new Response(ack)]);
  expect(await runAccountOperation('key', target, browser)).toEqual({ ok: true, accountId: target.accountId });
  const unicode = { kind: 'delete' as const, accountId: '😀' };
  const bytes = new TextEncoder().encode(JSON.stringify({ accountId: unicode.accountId }));
  replies([
    Response.json(approval()),
    new Response(
      new ReadableStream({
        start(c) {
          for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
          c.close();
        },
      }),
      { headers: { 'content-length': '1' } },
    ),
  ]);
  expect(await runAccountOperation('key', unicode, browser)).toEqual({ ok: true, accountId: '😀' });
  for (const headers of [
    {},
    { 'content-length': '1' },
    { 'content-length': String(DELETION_EXECUTION_MAX_RESPONSE_BYTES + 1) },
  ]) {
    const parse = spyOn(JSON, 'parse');
    const calls = replies([
      Response.json(approval()),
      new Response('x'.repeat(DELETION_EXECUTION_MAX_RESPONSE_BYTES + 1), { headers }),
    ]);
    try {
      expect(await runAccountOperation('key', operation, browser)).toEqual({ ok: false, reason: 'unknown' });
      expect(parse).toHaveBeenCalledTimes(1); // approval only
      expect(calls).toHaveLength(2);
    } finally {
      parse.mockRestore();
    }
  }
  replies([Response.json(approval()), new Response(new Uint8Array([0xff]))]);
  expect(await runAccountOperation('key', operation, browser)).toEqual({ ok: false, reason: 'unknown' });
});

test('only supported unavailable repeats the same body once, preserving earlier uncertainty through refusal', async () => {
  const unavailable = () => Response.json({ error: 'unavailable' }, { status: 503 });
  const calls = replies([unavailable(), Response.json(approval()), unavailable(), refusal()]);
  expect(await runAccountOperation('key', operation, browser)).toEqual({ ok: false, reason: 'unknown' });
  expect(calls).toHaveLength(4);
  expect(calls[0]!.body).toBe(calls[1]!.body);
  expect(calls[2]!.body).toBe(calls[3]!.body);
  for (const call of calls)
    expect(call).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  const cancelled = replies([Response.json(approval())]);
  expect(await runAccountOperation('key', operation, { ...browser, onExecutionDispatch: () => false })).toEqual({
    ok: false,
    reason: 'failure',
  });
  expect(cancelled).toHaveLength(1);
});

test('each POST owns five seconds through stalled bodies and abort-ignoring headers, without retry', async () => {
  const setTimer = globalThis.setTimeout;
  const timers: (() => void)[] = [];
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => {
    expect(ms).toBe(5000);
    timers.push(fn);
    return setTimer(() => {}, 60000);
  }) as typeof setTimeout);
  try {
    for (const phase of ['approval', 'execution'] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (phase === 'execution' && calls === 1) return Response.json(approval());
        return phase === 'approval'
          ? new Promise<Response>(() => {})
          : new Response(
              new ReadableStream({
                pull() {
                  return new Promise(() => {});
                },
              }),
            );
      }) as typeof fetch;
      const result = runAccountOperation('key', operation, browser);
      await new Promise((resolve) => setTimer(resolve, 0));
      timers.at(-1)!();
      expect(await result).toEqual({ ok: false, reason: phase === 'execution' ? 'unknown' : 'unavailable' });
      expect(calls).toBe(phase === 'execution' ? 2 : 1);
    }
  } finally {
    timer.mockRestore();
  }
});
