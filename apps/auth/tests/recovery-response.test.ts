import { expect, spyOn, test } from 'bun:test';
import { recoveryResponseByteBounds } from '@rezics/auth-contract';
import {
  completeRecovery,
  definitiveRecoveryRefusal,
  startRecovery,
  type RecoveryCommandResult,
} from '../src/recovery';

const encoder = new TextEncoder();
function streamed(bytes: Uint8Array, status = 200, headers: HeadersInit = {}, cuts: number[] = []) {
  const points = [0, ...cuts, bytes.length].sort((a, b) => a - b);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 1; index < points.length; index++)
          controller.enqueue(bytes.slice(points[index - 1]!, points[index]!));
        controller.close();
      },
    }),
    { status, headers },
  );
}
const unavailable = (result: RecoveryCommandResult) =>
  expect(result).toMatchObject({ ok: false, status: 503, code: 'unavailable' });

test('typed commands send one fixed POST and require exact acknowledgements and admitted refusals', async () => {
  const replies = [
    streamed(encoder.encode('{"success":true}'), 200, {}, [4]),
    streamed(encoder.encode('{"success":true}')),
    Response.json({ error: 'authentication_denied' }, { status: 429, headers: { 'retry-after': '37' } }),
    Response.json({ code: 'invalid_recovery' }, { status: 401 }),
    Response.json({ error: 'authentication_denied' }, { status: 503 }),
    Response.json({ success: true, extra: true }),
  ];
  const request = spyOn(globalThis, 'fetch').mockImplementation(async () => replies.shift()!);
  try {
    expect(await startRecovery({ email: 'reader@example.test' })).toMatchObject({ ok: true, body: { success: true } });
    expect(await completeRecovery({ account_id: 'acct', token: 'token', new_password: 'new password' })).toMatchObject({
      ok: true,
      body: { success: true },
    });
    const limited = await startRecovery({ email: 'reader@example.test' });
    expect(limited).toMatchObject({ ok: false, status: 429, code: 'authentication_denied', retryAfter: '37' });
    if (!limited.ok) expect(definitiveRecoveryRefusal(limited)).toBe(true);
    expect(await completeRecovery({ account_id: 'acct', token: 'token', new_password: 'new password' })).toMatchObject({
      ok: false,
      status: 401,
      code: 'invalid_recovery',
    });
    const dependency = await completeRecovery({ account_id: 'acct', token: 'token', new_password: 'new password' });
    expect(dependency).toMatchObject({ ok: false, status: 503, code: 'authentication_denied' });
    if (!dependency.ok) expect(definitiveRecoveryRefusal(dependency)).toBe(false);
    unavailable(await completeRecovery({ account_id: 'acct', token: 'token', new_password: 'new password' }));
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.map(([path]) => String(path))).toEqual([
      '/recovery/start',
      '/recovery/complete',
      '/recovery/start',
      '/recovery/complete',
      '/recovery/complete',
      '/recovery/complete',
    ]);
    expect(request.mock.calls.map(([, init]) => init?.body)).toEqual([
      '{"email":"reader@example.test"}',
      '{"account_id":"acct","token":"token","new_password":"new password"}',
      '{"email":"reader@example.test"}',
      '{"account_id":"acct","token":"token","new_password":"new password"}',
      '{"account_id":"acct","token":"token","new_password":"new password"}',
      '{"account_id":"acct","token":"token","new_password":"new password"}',
    ]);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    }
  } finally {
    request.mockRestore();
  }
});

test('bounded reads reject lying lengths, split or malformed UTF-8, overflow, parse errors and incomplete streams', async () => {
  const values: Response[] = [
    streamed(encoder.encode('{"code":"é"}'), 400, { 'content-length': '1' }, [10]),
    streamed(new Uint8Array([0x7b, 0x22, 0xff, 0x7d]), 400),
    streamed(encoder.encode('{'), 400),
    streamed(encoder.encode('{'), 200),
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"error'));
          controller.error(new Error('incomplete'));
        },
      }),
      { status: 400 },
    ),
  ];
  const overLimit = `{"code":"invalid_request","detail":"${'x'.repeat(recoveryResponseByteBounds.nativeError)}"}`;
  values.push(streamed(encoder.encode(overLimit), 429, { 'content-length': '1', 'retry-after': '99999999' }));
  const request = spyOn(globalThis, 'fetch').mockImplementation(async () => values.shift()!);
  const parse = spyOn(JSON, 'parse');
  try {
    for (let index = 0; index < 4; index++) unavailable(await startRecovery({ email: 'reader@example.test' }));
    const parsesBeforeOverflow = parse.mock.calls.length;
    unavailable(await startRecovery({ email: 'reader@example.test' }));
    expect(parse).toHaveBeenCalledTimes(parsesBeforeOverflow);
    expect(request).toHaveBeenCalledTimes(5);
  } finally {
    parse.mockRestore();
    request.mockRestore();
  }
});

test('the five-second deadline settles a fetch and a stream that ignore abort and cancellation', async () => {
  let signal: AbortSignal | undefined;
  const request = spyOn(globalThis, 'fetch').mockImplementation((_, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>(() => {});
  });
  try {
    const started = Date.now();
    unavailable(await startRecovery({ email: 'reader@example.test' }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(4800);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(signal?.aborted).toBe(true);
  } finally {
    request.mockRestore();
  }

  const stalled = spyOn(globalThis, 'fetch').mockImplementation((_, init) => {
    signal = init?.signal as AbortSignal;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise<void>(() => {}),
          cancel: () => new Promise<void>(() => {}),
        }),
      ),
    );
  });
  try {
    unavailable(await completeRecovery({ account_id: 'acct', token: 'token', new_password: 'new password' }));
    expect(signal?.aborted).toBe(true);
  } finally {
    stalled.mockRestore();
  }
}, 15000);
