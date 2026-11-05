import { afterEach, expect, test } from 'bun:test';
import { AUTH_POST_TIMEOUT_MS, authPost } from '../src/api';
import { signIn } from '../src/sign-in';
import { runAccountOperation } from '../src/account-operations';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.each(['connection', 'success body', 'error body', 'approval'])(
  '%s stalls end waiting without replay',
  async (stage) => {
    const calls: { path: string; init: RequestInit }[] = [];
    const operation = { kind: 'delete' as const, accountId: 'initiating-human' };
    globalThis.fetch = (async (path, init = {}) => {
      calls.push({ path: String(path), init });
      if (String(path).endsWith('/approve') && stage !== 'approval')
        return Response.json({
          reference: 'original-reference',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      if (stage === 'connection' || stage === 'approval') return new Promise<Response>(() => {});
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
        }),
        { status: stage === 'error body' ? 503 : 200 },
      );
    }) as typeof fetch;
    const results = await Promise.all([
      signIn('human@example.test', 'password'),
      authPost('/recovery/start', {}),
      authPost('/consent', {}),
      runAccountOperation('original-key', operation),
    ]);
    expect(results).toEqual([
      { ok: false, reason: 'unavailable' },
      { ok: false, status: 503, code: 'timeout', retryAfter: null },
      { ok: false, status: 503, code: 'timeout', retryAfter: null },
      { ok: false, reason: stage === 'approval' ? 'unavailable' : 'unknown' },
    ]);
    expect(calls.filter(({ path }) => path.endsWith('/approve'))).toHaveLength(1);
    const executions = calls.filter(({ path }) => path.endsWith('/execute'));
    expect(executions).toHaveLength(stage === 'approval' ? 0 : 1);
    if (executions.length)
      expect(JSON.parse(String(executions[0]!.init.body))).toEqual({
        operation,
        operationKey: 'original-key',
        reference: 'original-reference',
      });
    expect(calls.filter(({ init }) => init.signal?.aborted)).toHaveLength(4);
  },
  AUTH_POST_TIMEOUT_MS + 3000,
);

test.each([200, 400, 401, 429])('completed HTTP %s retains its meaning and Retry-After', async (status) => {
  const body = { code: status === 429 ? 'rate_limited' : status === 401 ? 'authentication_denied' : 'invalid_request' };
  globalThis.fetch = (async () => Response.json(body, { status, headers: { 'Retry-After': '17' } })) as typeof fetch;
  expect(await authPost('/signin', {})).toEqual(
    status === 200 ? { ok: true, body } : { ok: false, status, code: body.code, retryAfter: '17' },
  );
});
