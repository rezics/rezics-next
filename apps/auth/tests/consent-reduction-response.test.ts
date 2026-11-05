import { afterEach, expect, test } from 'bun:test';
import { CONSENT_REDUCTION_MAX_RESPONSE_BYTES as ceiling } from '@rezics/auth-contract';
import { reduceConsent, type GrantedConsent } from '../src/security-inventory';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const row: GrantedConsent = {
  client_id: 'client',
  display_name: null,
  granted: ['read'],
  status: 'current',
  reducible: true,
  pending_reduction: false,
};
const send = (response: Response) => {
  globalThis.fetch = (async () => response) as typeof fetch;
  return reduceConsent(row, []);
};
test.each([
  [200, { client_id: 'client', scope: [] }, 'accepted'],
  [200, { client_id: 'other', scope: [] }, 'unknown'],
  [200, { client_id: 'client', scope: [], extra: true }, 'unknown'],
  [401, { error: 'authentication_denied' }, 'unknown'],
  [401, { error: 'step_up_required', effect_status: 'not_applied' }, 'signed-out'],
  [403, { error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' }, 'denied'],
  [403, { error: 'authentication_denied' }, 'denied'],
  [409, { error: 'authentication_denied', code: 'stale_review' }, 'stale-review'],
  [409, {}, 'unknown'],
  [403, {}, 'unknown'],
  [401, {}, 'unknown'],
  [403, { error: 'authentication_denied', extra: true }, 'unknown'],
  [503, { error: 'authentication_denied' }, 'unknown'],
] as const)('native status %s and body %j => %s', async (status, body, kind) => {
  expect(await send(Response.json(body, { status }))).toEqual({ kind });
});
test('actual streamed overflow wins over lying length and invalid JSON', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(ceiling + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  expect(await send(new Response(body, { headers: { 'Content-Length': '1' } }))).toEqual({ kind: 'unknown' });
  expect(cancelled).toBe(true);
});
test('maximally escaped ID and split UTF-8 are admitted without a length header', async () => {
  const client_id = '\u0000'.repeat(1022) + 'éé';
  const bytes = new TextEncoder().encode(JSON.stringify({ client_id, scope: [] }));
  const stream = new ReadableStream({
    start(c) {
      for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
      c.close();
    },
  });
  globalThis.fetch = (async () => new Response(stream)) as typeof fetch;
  expect(await reduceConsent({ ...row, client_id }, [])).toEqual({ kind: 'accepted' });
});
test('maximum legal scope acknowledgement fits the public formula', () => {
  const scope = Array.from({ length: 1000 }, (_, i) => `${i}`.padEnd(128, '~'));
  expect(new TextEncoder().encode(JSON.stringify({ client_id: '\u0000'.repeat(1024), scope })).length).toBe(ceiling);
});
test.each(['headers', 'body'] as const)('retirement during %s leaves dispatched uncertainty', async (where) => {
  const caller = new AbortController();
  let dispatched = false;
  const history: string[] = [];
  globalThis.fetch = (async () => {
    dispatched = true;
    if (where === 'headers') return new Promise(() => {});
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
      }),
    );
  }) as typeof fetch;
  const result = reduceConsent(row, [], {
    signal: caller.signal,
    isCurrent: () => !caller.signal.aborted,
    record: (h) => history.push(h),
    finish() {},
  });
  await Promise.resolve();
  caller.abort();
  expect(dispatched).toBe(true);
  expect(await result).toEqual({ kind: 'unknown' });
  expect(history).toEqual(['dispatched']);
});
test('retirement before dispatch sends nothing', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  expect(await reduceConsent(row, [], { isCurrent: () => false, record() {}, finish() {} })).toEqual({
    kind: 'retired',
  });
  expect(calls).toBe(0);
});
test.each(['headers', 'body'] as const)(
  'whole POST deadline covers stalled %s ignoring abort',
  async (where) => {
    globalThis.fetch = (async () =>
      where === 'headers'
        ? new Promise(() => {})
        : new Response(
            new ReadableStream({
              pull() {
                return new Promise(() => {});
              },
            }),
          )) as typeof fetch;
    expect(await reduceConsent(row, [])).toEqual({ kind: 'unknown' });
  },
  7000,
);

test.each(['{', new Uint8Array([0xc3, 0x28])])('malformed JSON or UTF-8 remains unknown', async (body) => {
  expect(await send(new Response(body))).toEqual({ kind: 'unknown' });
});
