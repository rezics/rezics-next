import { expect, test } from 'bun:test';
import { createTurnstileVerifier } from '../../src/content/turnstile.ts';

const secret = 'test-secret-never-return-this';
const hostname = 'reports.example.test';
const action = 'report_submit';

async function withProvider(
  respond: (request: Request) => Response | Promise<Response>,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: respond,
  });
  try {
    await run(`http://127.0.0.1:${server.port}/siteverify`);
  } finally {
    server.stop(true);
  }
}

const success = (overrides: Record<string, unknown> = {}) =>
  Response.json({ success: true, hostname, action, challenge_ts: '2026-10-25T00:00:00Z', ...overrides });

test('siteverify sends secret and opaque token by form POST and accepts only configured action and hostname', async () => {
  const seen: { method: string; contentType: string | null; body: URLSearchParams }[] = [];
  await withProvider(
    async (request) => {
      seen.push({
        method: request.method,
        contentType: request.headers.get('content-type'),
        body: new URLSearchParams(await request.text()),
      });
      return success();
    },
    async (siteverifyUrl) => {
      const verify = createTurnstileVerifier({ secret, hostname, action, siteverifyUrl });
      await expect(verify.verify('opaque-one-use-token')).resolves.toMatchObject({
        ok: true,
        hostname,
        action,
        challengeTimestamp: '2026-10-25T00:00:00Z',
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe('POST');
      expect(seen[0]?.contentType).toContain('application/x-www-form-urlencoded');
      expect(seen[0]?.body.get('secret')).toBe(secret);
      expect(seen[0]?.body.get('response')).toBe('opaque-one-use-token');
      expect(seen[0]?.body.has('remoteip')).toBe(false);
    },
  );
});

test('successful provider responses with a hostname or action mismatch fail closed', async () => {
  for (const result of [success({ hostname: 'attacker.example.test' }), success({ action: 'other_action' })]) {
    await withProvider(
      () => result,
      async (siteverifyUrl) => {
        const verify = createTurnstileVerifier({ secret, hostname, action, siteverifyUrl });
        await expect(verify.verify('opaque-token')).resolves.toMatchObject({ ok: false, reason: 'invalid' });
      },
    );
  }
});

test('a replayed one-use proof response is rejected by siteverify and fails closed', async () => {
  const redeemed = new Set<string>();
  await withProvider(
    async (request) => {
      const body = new URLSearchParams(await request.text());
      const token = body.get('response') ?? '';
      if (redeemed.has(token)) return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
      redeemed.add(token);
      return success();
    },
    async (siteverifyUrl) => {
      const verify = createTurnstileVerifier({ secret, hostname, action, siteverifyUrl });
      await expect(verify.verify('single-use-proof')).resolves.toMatchObject({ ok: true });
      await expect(verify.verify('single-use-proof')).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    },
  );
});

test('abort, deadline, network errors, non-success status, oversized and malformed responses fail closed', async () => {
  await withProvider(
    () => new Promise<Response>(() => {}),
    async (siteverifyUrl) => {
      const verify = createTurnstileVerifier({ secret, hostname, action, siteverifyUrl, timeoutMs: 30 });
      await expect(verify.verify('opaque-token')).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
    },
  );

  await withProvider(
    () => success(),
    async (siteverifyUrl) => {
      const verify = createTurnstileVerifier({ secret, hostname, action, siteverifyUrl });
      const controller = new AbortController();
      controller.abort();
      await expect(verify.verify('opaque-token', { signal: controller.signal })).resolves.toMatchObject({
        ok: false,
        reason: 'unavailable',
      });
      await expect(verify.verify('opaque-token', { deadline: Date.now() - 1 })).resolves.toMatchObject({
        ok: false,
        reason: 'unavailable',
      });
    },
  );

  for (const respond of [
    () => new Response('provider failure', { status: 503 }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(128), { headers: { 'content-type': 'application/json' } }),
  ]) {
    await withProvider(respond, async (siteverifyUrl) => {
      const verify = createTurnstileVerifier({ secret, hostname, action, siteverifyUrl, maxResponseBytes: 64 });
      await expect(verify.verify('opaque-token')).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
    });
  }

  const unavailable = createTurnstileVerifier({
    secret,
    hostname,
    action,
    fetch: async () => {
      throw new Error('sensitive');
    },
  });
  await expect(unavailable.verify('opaque-token')).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
});

test('missing or invalid configuration returns an unavailable verifier without storing or sending proof', async () => {
  let calls = 0;
  const missingSecret = createTurnstileVerifier({
    secret: '',
    hostname,
    action,
    fetch: async () => {
      calls++;
      return success();
    },
  });
  const missingHost = createTurnstileVerifier({
    secret,
    hostname: '',
    action,
    fetch: async () => {
      calls++;
      return success();
    },
  });
  await expect(missingSecret.verify('opaque-secret-token')).resolves.toMatchObject({
    ok: false,
    reason: 'unavailable',
  });
  await expect(missingHost.verify('opaque-secret-token')).resolves.toMatchObject({ ok: false, reason: 'unavailable' });
  const configured = createTurnstileVerifier({ secret, hostname, action });
  await expect(configured.verify('')).resolves.toMatchObject({ ok: false, reason: 'invalid' });
  expect(calls).toBe(0);
});
