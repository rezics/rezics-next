import { expect, test } from 'bun:test';
import { securityActionResponseByteBudgets } from '@rezics/auth-contract';
import { readJsonBounded } from '../src/private-auth-json';
import { receiveSecurityActionResponse } from '../src/security-reconciliation';
import { waitForSecurityAction } from '../src/security-target-operation';

const active = () => new AbortController();
const streamed = (chunks: Uint8Array[], status = 200, headers = new Headers()) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status, headers },
  );

test('only exact endpoint acknowledgements and admitted refusal envelopes settle a removal', async () => {
  expect(await receiveSecurityActionResponse('session', new Response('{}'), active().signal)).toEqual({
    kind: 'accepted',
  });
  expect(await receiveSecurityActionResponse('passkey', new Response('{"success":true}'), active().signal)).toEqual({
    kind: 'accepted',
  });
  expect(
    await receiveSecurityActionResponse(
      'passkey',
      new Response('{"error":"step_up_required","effect_status":"not_applied"}', { status: 401 }),
      active().signal,
    ),
  ).toEqual({ kind: 'step-up' });
  expect(
    await receiveSecurityActionResponse(
      'session',
      new Response('{"error":"authentication_denied"}', { status: 404 }),
      active().signal,
    ),
  ).toEqual({ kind: 'denied' });
  expect(
    await receiveSecurityActionResponse(
      'passkey',
      new Response('{"error":"credential_effect_denied","effect_status":"not_applied"}', { status: 409 }),
      active().signal,
    ),
  ).toEqual({ kind: 'denied' });
  expect(
    await receiveSecurityActionResponse(
      'passkey',
      new Response('{"error":"step_up_required"}', { status: 401 }),
      active().signal,
    ),
  ).toEqual({ kind: 'unknown' });
  expect(await receiveSecurityActionResponse('session', new Response('{"success":true}'), active().signal)).toEqual({
    kind: 'unknown',
  });
});

test('bounded receiving counts actual bytes, decodes split UTF-8 and rejects malformed or excess output', async () => {
  const passkeyAck = new TextEncoder().encode('{"success":true}');
  for (const headers of [new Headers(), new Headers({ 'content-length': '1' })])
    expect(
      await receiveSecurityActionResponse('passkey', new Response(passkeyAck, { headers }), active().signal),
    ).toEqual({
      kind: 'accepted',
    });

  const unicode = new TextEncoder().encode('{"note":"雪"}');
  const snow = [...unicode].findIndex((byte) => byte === 0xe9);
  expect(
    await readJsonBounded(streamed([unicode.slice(0, snow + 1), unicode.slice(snow + 1)]), 64, active().signal),
  ).toEqual({ note: '雪' });

  expect(
    await receiveSecurityActionResponse(
      'passkey',
      streamed([
        new TextEncoder().encode(`{"success":true,"extra":"${'x'.repeat(securityActionResponseByteBudgets.passkey)}"}`),
      ]),
      active().signal,
    ),
  ).toEqual({ kind: 'unknown' });
  expect(await receiveSecurityActionResponse('session', new Response('{'), active().signal)).toEqual({
    kind: 'unknown',
  });
  expect(
    await receiveSecurityActionResponse(
      'passkey',
      new Response(new Uint8Array([0xc3, 0x28]), { status: 401 }),
      active().signal,
    ),
  ).toEqual({ kind: 'unknown' });
});

test('stalled abort-ignoring bodies retire as unknown and caller retirement never sends a second command', async () => {
  const stalled = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => new Promise<void>(() => {}),
  });
  const bodySignal = new AbortController();
  const receiving = receiveSecurityActionResponse('session', new Response(stalled), bodySignal.signal);
  bodySignal.abort();
  expect(await receiving).toEqual({ kind: 'unknown' });

  const before = new AbortController();
  before.abort();
  let sends = 0;
  expect(await waitForSecurityAction(async () => (sends++, { kind: 'accepted' }), before.signal)).toEqual({
    kind: 'failure',
  });
  expect(sends).toBe(0);

  const after = new AbortController();
  const reply = Promise.withResolvers<{ kind: 'accepted' }>();
  const pending = waitForSecurityAction(async () => (sends++, reply.promise), after.signal);
  await Promise.resolve();
  after.abort();
  expect(await pending).toEqual({ kind: 'unknown' });
  reply.resolve({ kind: 'accepted' });
  await Promise.resolve();
  expect(sends).toBe(1);
});
