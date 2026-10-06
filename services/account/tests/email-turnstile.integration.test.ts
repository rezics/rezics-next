import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';

for (const path of [
  '/api/auth/sign-up/email',
  '/api/auth/request-password-reset',
  '/api/auth/send-verification-email',
]) {
  test(`email protection: ${path} charges the target only after a valid challenge`, async () => {
    let mode: 'accept' | 'reject' | 'wrong-host' | 'wrong-action' | 'outage' = 'reject';
    let verifications = 0;
    const verifier = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        verifications++;
        if (mode === 'outage') return new Response('unavailable', { status: 503 });
        return Response.json({
          success: mode !== 'reject',
          hostname: mode === 'wrong-host' ? 'other.example' : '127.0.0.1',
          action: mode === 'wrong-action' ? 'other-action' : 'account-enrollment',
        });
      },
    });
    const f = await accountFixture({
      turnstileMode: 'cloudflare',
      turnstileSecretKey: '1x0000000000000000000000000000000AA',
      turnstileVerifyURL: `http://127.0.0.1:${verifier.port}/siteverify`,
    });
    const body = {
      email: 'protected@example.test',
      name: 'Protected',
      password: 'a secure long password',
    };
    const targetKey = createHmac('sha256', f.secret).update(`${path}:${body.email}`).digest('hex');
    const count = async () =>
      (
        await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1', [
          targetKey,
        ])
      ).rows;
    try {
      if (path !== '/api/auth/sign-up/email') {
        mode = 'accept';
        expect(
          (
            await f.request('/api/auth/sign-up/email', body, undefined, {
              'x-captcha-response': 'test-token',
            })
          ).status,
        ).toBe(200);
        mode = 'reject';
        verifications = 0;
      }
      const usersBefore = (await f.pool.query('SELECT id FROM "user"')).rowCount;
      const emailsBefore = (await f.pool.query('SELECT id FROM rezics_account_email')).rowCount;
      expect((await f.request(path, body)).status).toBe(400);
      expect(verifications).toBe(0);
      for (const failure of ['reject', 'wrong-host', 'wrong-action', 'outage'] as const) {
        mode = failure;
        const response = await f.request(path, body, undefined, {
          'x-captcha-response': 'test-token',
        });
        expect(response.status).toBe(failure === 'outage' ? 500 : 403);
      }
      expect(await count()).toEqual([]);
      expect((await f.pool.query('SELECT id FROM "user"')).rowCount).toBe(usersBefore);
      expect((await f.pool.query('SELECT id FROM rezics_account_email')).rowCount).toBe(
        emailsBefore,
      );
      mode = 'accept';
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await f.request(path, body, undefined, {
          'x-captcha-response': 'test-token',
        });
        expect(response.status).toBe(200);
      }
      expect(await count()).toEqual([{ count: 3 }]);
      const exhausted = await f.request(path, body, undefined, {
        'x-captcha-response': 'test-token',
      });
      expect(exhausted.status).toBe(429);
      expect(exhausted.headers.get('retry-after')).toBe('300');
      expect(await count()).toEqual([{ count: 3 }]);
      // Each supplied token is verified once, including the target-limited call.
      expect(verifications).toBe(8);
    } finally {
      await f.close();
      await verifier.stop(true);
    }
  }, 120_000);
}

test('email protection: failed challenges have a caller budget that ignores spoofed addresses and target emails', async () => {
  let verifications = 0;
  const verifier = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      verifications++;
      return Response.json({ success: false });
    },
  });
  const f = await accountFixture({
    turnstileMode: 'cloudflare',
    turnstileSecretKey: '1x0000000000000000000000000000000AA',
    turnstileVerifyURL: `http://127.0.0.1:${verifier.port}/siteverify`,
  });
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await f.request(
        '/api/auth/request-password-reset',
        { email: `target-${attempt}@example.test` },
        undefined,
        {
          'x-captcha-response': 'invalid',
          'x-rezics-client-ip': `192.0.2.${attempt + 1}`,
          'x-forwarded-for': `192.0.2.${attempt + 1}`,
        },
      );
      expect(response.status).toBe(403);
    }
    const exhausted = await f.request(
      '/api/auth/send-verification-email',
      { email: 'another-target@example.test' },
      undefined,
      { 'x-captcha-response': 'invalid' },
    );
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get('retry-after')).toBe('300');
    expect(verifications).toBe(20);
    expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit')).rows).toEqual([
      { count: 20 },
    ]);
  } finally {
    await f.close();
    await verifier.stop(true);
  }
}, 120_000);

test('email protection: embedded auth handlers retain target limits after challenge verification', async () => {
  const f = await accountFixture({ turnstileMode: 'local' });
  try {
    const request = () =>
      f.auth.handler(
        new Request(`${f.baseURL}/api/auth/request-password-reset`, {
          method: 'POST',
          headers: { origin: f.baseURL, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'embedded@example.test' }),
        }),
      );
    for (let attempt = 0; attempt < 3; attempt++) expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  } finally {
    await f.close();
  }
}, 120_000);
