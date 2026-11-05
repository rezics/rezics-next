import { afterEach, expect, spyOn, test } from 'bun:test';
import { runAccountOperation } from '../src/account-operations';
import {
  ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES,
  ORGANIZATION_EXECUTION_MAX_RESPONSE_BYTES,
} from '@rezics/auth-contract';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const operation = { kind: 'organization' as const, handle: 'original-team' };
const reference = 'a'.repeat(4052) + '.' + 'b'.repeat(43);
const approval = (expiresAt = new Date(Date.now() + 60000).toISOString()) => ({ reference, expiresAt });
const run = (browser?: Parameters<typeof runAccountOperation>[2]) =>
  runAccountOperation('original-key', operation, browser);
function transport(replies: (() => Response | Promise<Response>)[]) {
  const calls: RequestInit[] = [];
  globalThis.fetch = ((_path, init) => {
    calls.push(init!);
    return Promise.resolve(replies[calls.length - 1]!());
  }) as typeof fetch;
  return calls;
}
const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

test('native-shaped maximum approval and maximally escaped opaque result retain exact dispatch and costs', async () => {
  const accountId = '\u0000'.repeat(4096);
  const calls = transport([json(approval()), json({ accountId })]);
  expect(JSON.stringify(approval()).length).toBeLessThanOrEqual(ACCOUNT_OPERATION_APPROVAL_MAX_RESPONSE_BYTES);
  expect(JSON.stringify({ accountId }).length).toBe(ORGANIZATION_EXECUTION_MAX_RESPONSE_BYTES);
  expect(await run()).toEqual({ ok: true, accountId });
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[1]!.body))).toEqual({ operationKey: 'original-key', operation, reference });
  expect(calls[1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
});

for (const body of [
  approval('2000-01-01T00:00:00.000Z'),
  { ...approval(), extra: true },
  { reference: 'wrong', expiresAt: 'tomorrow' },
])
  test('unusable approval never executes or retries', async () => {
    const calls = transport([json(body)]);
    expect(await run()).toEqual({ ok: false, reason: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

for (const [body, status] of [
  [{ accountId: 'created', ownerAccountId: 'unexpected' }, 200],
  [{ accountId: 'created', expired: true }, 200],
  [{ accountId: '' }, 200],
  [{ error: 'account_operation_denied' }, 403],
  [{ error: 'platform_closed', effect_status: 'not_applied' }, 401],
  [{ error: 'account_operation_denied', effect_status: 'not_applied', extra: true }, 409],
  [{ error: 'unavailable' }, 503],
] as const)
  test('incompatible execution stays unknown without automatic execution retry', async () => {
    const calls = transport([json(approval()), json(body, status)]);
    expect(await run()).toEqual({ ok: false, reason: 'unknown' });
    expect(calls).toHaveLength(2);
  });

for (const [error, statuses, reason] of [
  ['account_operation_denied', [400, 401, 403, 409, 413, 415, 503], 'denied'],
  ['step_up_required', [401], 'step-up'],
  ['platform_closed', [403], 'platform-closed'],
] as const)
  test(`only supported ${error} envelopes classify refusal`, async () => {
    for (const status of statuses) {
      transport([json(approval()), json({ error, effect_status: 'not_applied' }, status)]);
      expect(await run()).toEqual({ ok: false, reason });
    }
  });

test('only a supported unavailable approval retries once; self-delete retains same-body uncertain recovery', async () => {
  let calls = transport([json({ error: 'unavailable' }, 503), json(approval()), json({ accountId: 'created' })]);
  expect(await run()).toEqual({ ok: true, accountId: 'created' });
  expect(calls).toHaveLength(3);
  expect(calls[0]!.body).toBe(calls[1]!.body);
  calls = transport([json(approval()), json({ error: 'unavailable' }, 503), json({ accountId: 'self' })]);
  expect(await runAccountOperation('delete-key', { kind: 'delete', accountId: 'self' })).toEqual({
    ok: true,
    accountId: 'self',
  });
  expect(calls).toHaveLength(3);
  expect(calls[1]!.body).toBe(calls[2]!.body);
});

function bytes(chunks: Uint8Array[], length?: string) {
  return new Response(
    new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
    { headers: length === undefined ? {} : { 'content-length': length } },
  );
}
test('byte admission precedes fatal decoding and parse, including split UTF-8 and lying lengths', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ accountId: 'é' }));
  transport([json(approval()), () => bytes([...encoded].map((byte) => new Uint8Array([byte])))]);
  expect(await run()).toEqual({ ok: true, accountId: 'é' });
  for (const length of [undefined, '1', String(ORGANIZATION_EXECUTION_MAX_RESPONSE_BYTES + 1)]) {
    const parse = spyOn(JSON, 'parse');
    try {
      const calls = transport([
        json(approval()),
        () => bytes([new Uint8Array(ORGANIZATION_EXECUTION_MAX_RESPONSE_BYTES + 1)], length),
      ]);
      expect(await run()).toEqual({ ok: false, reason: 'unknown' });
      expect(calls).toHaveLength(2);
      expect(parse.mock.calls).toHaveLength(1); // approval only
    } finally {
      parse.mockRestore();
    }
  }
  for (const chunks of [[new Uint8Array([0xff])], [new TextEncoder().encode('{')]]) {
    transport([json(approval()), () => bytes(chunks)]);
    expect(await run()).toEqual({ ok: false, reason: 'unknown' });
  }
});

for (const phase of ['approve', 'headers', 'body'] as const)
  test(`five-second ${phase} lifetime releases abort-ignoring I/O`, async () => {
    const timers: (() => void)[] = [];
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      expect(ms).toBe(5000);
      timers.push(callback);
      return 0;
    }) as typeof setTimeout);
    try {
      const stalled = () => new Promise<Response>(() => {});
      const calls = transport(
        phase === 'approve'
          ? [stalled]
          : [
              json(approval()),
              phase === 'headers'
                ? stalled
                : () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) })),
            ],
      );
      const result = run();
      for (let i = 0; i < 20 && calls.length < (phase === 'approve' ? 1 : 2); i++) await Promise.resolve();
      timers.at(-1)!();
      expect(await result).toEqual({ ok: false, reason: phase === 'approve' ? 'unavailable' : 'unknown' });
      expect(calls.at(-1)!.signal!.aborted).toBe(true);
    } finally {
      timer.mockRestore();
    }
  });

test('retirement after approval prevents execution and caller cancellation releases a stalled send', async () => {
  let current = true;
  const calls = transport([
    () => {
      current = false;
      return Response.json(approval());
    },
  ]);
  expect(await run({ isCurrent: () => current })).toEqual({ ok: false, reason: 'failure' });
  expect(calls).toHaveLength(1);
  const controller = new AbortController();
  transport([() => new Promise(() => {})]);
  const pending = run({ isCurrent: () => true, signal: controller.signal });
  controller.abort();
  expect(await pending).toEqual({ ok: false, reason: 'failure' });
});
