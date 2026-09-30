import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { proxyAccountRequest } from '../../../apps/accounts/features/proxy/account-proxy.ts';
import { accountsConfig, enrollmentSiteKey } from '../../../apps/accounts/features/config/env.ts';

test('G-543 review: missing widget key leaves OAuth and auth proxy configuration usable', async () => {
  const config = accountsConfig({ NODE_ENV: 'production', ACCOUNT_TURNSTILE_SITE_KEY: '' });
  expect(config.ACCOUNT_SERVICE_ORIGIN).toBeTruthy();
  const prior = console.error;
  const logs: string[] = [];
  console.error = message => { logs.push(String(message)); };
  try { expect(enrollmentSiteKey({ NODE_ENV: 'production', ACCOUNT_TURNSTILE_SITE_KEY: '' })).toBeUndefined(); }
  finally { console.error = prior; }
  expect(logs.join()).toContain('enrollment widget disabled');
  for (const path of ['/oauth2/authorize', '/api/auth/get-session']) {
    const response = await proxyAccountRequest(new Request(`http://127.0.0.1:3004${path}`), {
      serviceOrigin: config.ACCOUNT_SERVICE_ORIGIN, publicOrigin: config.ACCOUNT_BASE_URL,
      fetch: Object.assign(async () => Response.json({ forwarded: true }), { preconnect: fetch.preconnect }),
    });
    expect(response.status).toBe(200);
  }
});

test('G-543 review: explicit local enrollment verifies without a provider request', async () => {
  const f = await accountFixture({ turnstileMode: 'local' });
  try {
    const body = { name: 'Offline', email: 'offline@example.test', password: 'a secure long password' };
    // Same direct API call used by admin.e2e.ts: no captcha header.
    expect((await f.request('/api/auth/sign-up/email', body)).status).toBe(200);
    expect((await f.request('/api/auth/sign-up/email', { ...body, email: 'localhost@example.test' }, undefined,
      { 'x-captcha-response': 'local:localhost:account-enrollment' })).status).toBe(200);
  } finally { await f.close(); }
}, 120_000);

test('G-543: enrollment refuses absent, invalid and unavailable challenges before account/email effects', async () => {
  let mode: 'accept' | 'reject' | 'outage' | 'wrong-host' | 'wrong-action' = 'accept';
  let verifications = 0;
  const verifier = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    verifications++;
    const body = await request.json() as { secret: string; response: string };
    expect(body.secret).toBe('1x0000000000000000000000000000000AA');
    if (mode === 'outage') return new Response('unavailable', { status: 503 });
    return Response.json({ success: mode !== 'reject' && body.response === 'test-token',
      hostname: mode === 'wrong-host' ? 'other.example' : '127.0.0.1',
      action: mode === 'wrong-action' ? 'different-action' : 'account-enrollment' });
  } });
  const f = await accountFixture({ turnstileSecretKey: '1x0000000000000000000000000000000AA',
    turnstileVerifyURL: `http://127.0.0.1:${verifier.port}/siteverify` });
  const body = { name: 'Newcomer', email: 'g543@example.test', password: 'a secure long password', locale: 'en' };
  try {
    for (const path of ['/api/auth/sign-up/email', '/api/auth/request-password-reset', '/api/auth/send-verification-email']) {
      expect((await f.request(path, body)).status).toBe(400);
    }
    expect(verifications).toBe(0);
    expect((await f.pool.query('SELECT id FROM "user"')).rowCount).toBe(0);
    mode = 'reject';
    expect((await f.request('/api/auth/sign-up/email', { ...body, email: 'rejected@example.test' }, undefined,
      { 'x-captcha-response': 'invalid' })).status).toBe(403);
    mode = 'outage';
    expect((await f.request('/api/auth/sign-up/email', { ...body, email: 'outage@example.test' }, undefined,
      { 'x-captcha-response': 'test-token' })).ok).toBe(false);
    expect((await f.pool.query('SELECT id FROM "user"')).rowCount).toBe(0);
    for (const mismatch of ['wrong-host', 'wrong-action'] as const) {
      mode = mismatch;
      expect((await f.request('/api/auth/sign-up/email', { ...body, email: `${mismatch}@example.test` }, undefined,
        { 'x-captcha-response': 'test-token' })).status).toBe(403);
    }
    mode = 'accept';
    // Exercise the actual public-origin proxy too: without forwarding this
    // header a successful browser widget would still be rejected by Account.
    const signup = await proxyAccountRequest(new Request(`${f.baseURL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { origin: f.baseURL, 'content-type': 'application/json', 'x-captcha-response': 'test-token' },
      body: JSON.stringify(body),
    }), { serviceOrigin: f.baseURL, publicOrigin: f.baseURL });
    expect(signup.status).toBe(200);
    expect(await signup.json()).toEqual({ status: true });
    expect((await f.pool.query('SELECT id FROM "user"')).rowCount).toBe(1);
    expect((await f.request('/api/auth/request-password-reset', { email: body.email }, undefined,
      { 'x-captcha-response': 'test-token' })).status).toBe(200);
    expect((await f.request('/api/auth/send-verification-email', { email: body.email }, undefined,
      { 'x-captcha-response': 'test-token' })).status).toBe(200);
    await f.email.drain();
    expect(f.messages.length).toBeGreaterThan(0);
  } finally { await f.close(); await verifier.stop(true); }
}, 120_000);
