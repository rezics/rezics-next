import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { cookies, recoveryProof } from './recovery-fixture.ts';

test('form sign-in cannot admit an old-password session after recovery during verification', async () => {
  const f = await accountFixture();
  let resume = () => {};
  try {
    const member = await f.signup('form-recovery@example.test');
    const guardian = await f.signup('form-guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    const context = await f.auth.$context;
    const verify = context.password.verify;
    let entered = () => {};
    const paused = new Promise<'paused'>(resolve => { entered = () => resolve('paused'); });
    const released = new Promise<void>(resolve => { resume = resolve; });
    context.password.verify = async input => {
      // The provider has already read the old hash when it calls verify.
      entered();
      await released;
      return verify(input);
    };
    const pending = fetch(`${f.baseURL}/api/auth/sign-in/email`, {
      method: 'POST', headers: { origin: f.baseURL,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: member.email, password: member.password }),
    });
    const state = await Promise.race([paused, pending.then(() => 'rejected' as const)]);
    expect((await proof.activate()).status).toBe(200);
    resume();
    const response = await pending;
    const session = cookies(response)
      ? await (await f.request('/api/auth/get-session', undefined, cookies(response))).json()
      : null;
    expect(session).toBeNull();
    expect(state).toBe('rejected');
    expect(response.status).toBe(415);
    context.password.verify = verify;
    expect((await f.request('/api/auth/sign-in/email', {
      email: member.email, password: 'new independently bound password',
    })).status).toBe(200);
  } finally { resume(); await f.close(); }
}, 60_000);

test('authentication rejects non-JSON media types before provider proof verification', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('auth-media@example.test');
    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data',
      'text/plain', 'application/json-invalid', 'text/application/json']) {
      for (const path of ['/api/auth/sign-in/email', '/api/auth/reset-password',
        '/api/auth/passkey/verify-authentication', '/api/auth/two-factor/verify-totp',
        '/api/auth/two-factor/verify-backup-code']) {
        const response = await fetch(`${f.baseURL}${path}`, { method: 'POST',
          headers: { origin: f.baseURL, 'content-type': contentType },
          body: JSON.stringify({ email: member.email, password: member.password, code: 'invalid' }) });
        expect(response.status).toBe(415);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    expect((await f.request('/api/auth/sign-in/email', {
      email: member.email.toUpperCase(), password: member.password,
    }, undefined, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
  } finally { await f.close(); }
}, 60_000);
