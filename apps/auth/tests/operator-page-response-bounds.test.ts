import { afterEach, expect, test } from 'bun:test';
import {
  OPERATOR_TRANSFER_PAGE_MAX_RESPONSE_BYTES as limit,
  OPERATOR_TRANSFER_PAGE_MAX_ERROR_BYTES as errorLimit,
} from '@rezics/auth-contract';
import { requestOperatorTransferPage } from '../src/operator-transfer-page';
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const input = { kind: 'readiness' as const };
const json = JSON.stringify({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } });
function stream(bytes: Uint8Array, headers: HeadersInit = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      },
    }),
    { headers },
  );
}
test('actual chunked bytes govern receiving before parsing regardless of Content-Length', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': String(limit) }]) {
    for (const excess of [0, 1]) {
      const response = stream(new TextEncoder().encode(json.padEnd(limit + excess)), headers);
      globalThis.fetch = (async (_path, init) => {
        expect(init).toMatchObject({
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
        });
        expect(JSON.parse(String(init?.body))).toEqual(input);
        return response;
      }) as typeof fetch;
      const result = await requestOperatorTransferPage(input);
      expect(result.ok).toBe(excess === 0);
    }
  }
  for (const response of [
    stream(new Uint8Array([0xff])),
    stream(new TextEncoder().encode('{')),
    stream(new TextEncoder().encode(json), { 'content-length': String(limit + 1) }),
  ]) {
    globalThis.fetch = (async () => response) as typeof fetch;
    expect(await requestOperatorTransferPage(input)).toMatchObject({ ok: false, code: 'unavailable' });
  }
  for (const size of [errorLimit, errorLimit + 1]) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 'step_up_required' }).padEnd(size), {
        status: 401,
        headers: { 'Retry-After': '17' },
      })) as typeof fetch;
    expect(await requestOperatorTransferPage(input)).toEqual({
      ok: false,
      status: 401,
      code: size === errorLimit ? 'step_up_required' : '',
      retryAfter: '17',
    });
  }
});

test('one five-second lifetime spans headers and stalled bodies even when abort is ignored; retirement wins', async () => {
  const pending = Promise.withResolvers<Response>();
  let started = false;
  globalThis.fetch = (() => {
    started = true;
    return pending.promise;
  }) as typeof fetch;
  const retired = new AbortController();
  const read = requestOperatorTransferPage(input, retired.signal);
  await Promise.resolve();
  expect(started).toBe(true);
  retired.abort();
  expect(await read).toMatchObject({ ok: false, code: 'unavailable' });
  pending.resolve(Response.json(JSON.parse(json)));
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((_path, init) => {
    signals.push(init!.signal as AbortSignal);
    return signals.length === 1 ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream()));
  }) as typeof fetch;
  const results = await Promise.all([requestOperatorTransferPage(input), requestOperatorTransferPage(input)]);
  expect(results).toEqual(Array(2).fill({ ok: false, status: 503, code: 'timeout', retryAfter: null }));
  expect(signals.every((signal) => signal.aborted)).toBe(true);
}, 7000);
