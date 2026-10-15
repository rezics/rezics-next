import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createOTP } from '@better-auth/utils/otp';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { enrollSecondFactor, factorCookies } from './factor-fixture.ts';

test('operator reads and provider mutations require a fresh current second factor, including a new session', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('factor-owner@example.test');
    f.operators.add(owner.id);
    const create = () => f.request('/api/auth/oauth2/create-client', {
      client_name: 'Privileged app', token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], redirect_uris: ['https://app.example.test/callback'], scope: 'openid',
    }, owner.cookie, { 'x-account-reason': 'Explicit operator change' });
    expect((await f.request('/api/account/admin/users', undefined, owner.cookie)).status).toBe(403);
    expect((await create()).status).toBe(403);
    const secret = await enrollSecondFactor(f, owner);
    expect((await f.request('/api/account/admin/users', undefined, owner.cookie)).status).toBe(200);
    expect((await create()).status).toBe(200);
    await f.pool.query('DELETE FROM rezics_account_step_up WHERE session_id IN (SELECT id FROM "session" WHERE "userId" = $1)', [owner.id]);
    expect((await create()).status).toBe(403);
    expect((await f.request('/api/account/reauthenticate', { password: owner.password }, owner.cookie)).status).toBe(403);
    expect((await f.request('/api/account/reauthenticate', { password: owner.password,
      totpCode: await createOTP(secret).totp() }, owner.cookie)).status).toBe(200);
    expect((await create()).status).toBe(200);
  } finally { await f.close(); }
}, 60_000);

test('replacing a verified authenticator needs its fresh proof and retires every remembered device', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('remembered@example.test');
    const secret = await enrollSecondFactor(f, member);
    const remembered: string[] = [];
    for (let device = 0; device < 2; device++) {
      const login = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
      expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
      const verified = await f.request('/api/auth/two-factor/verify-totp', {
        code: await createOTP(secret).totp(), trustDevice: true }, factorCookies(login));
      expect(verified.status).toBe(200);
      remembered.push(factorCookies(verified));
    }
    const trusted = () => f.pool.query(`SELECT id FROM verification WHERE value = $1
      AND identifier LIKE 'trust-device-%'`, [member.id]);
    expect((await trusted()).rowCount).toBe(2);
    await f.pool.query('DELETE FROM rezics_account_step_up WHERE session_id IN (SELECT id FROM "session" WHERE "userId" = $1)', [member.id]);
    for (const path of ['enable', 'disable']) {
      expect((await f.request(`/api/auth/two-factor/${path}`, { password: member.password }, member.cookie)).status).toBe(403);
    }
    expect((await trusted()).rowCount).toBe(2);
    expect((await f.request('/api/account/reauthenticate', { password: member.password,
      totpCode: await createOTP(secret).totp() }, member.cookie)).status).toBe(200);
    const disabled = await f.request('/api/auth/two-factor/disable', { password: member.password }, member.cookie);
    expect(disabled.status).toBe(200);
    member.cookie = factorCookies(disabled);
    expect((await trusted()).rowCount).toBe(0);
    await enrollSecondFactor(f, member);
    for (const cookie of remembered) {
      const login = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password }, cookie);
      expect(await login.json()).toMatchObject({ twoFactorRedirect: true });
    }
  } finally { await f.close(); }
}, 60_000);

for (const change of ['install', 'revoke'] as const) {
  for (const ended of ['role', 'session'] as const) {
    test(`installation ${change} denies a ${ended} ended while waiting on its target`, async () => {
      const f = await accountFixture();
      const blocker = await f.pool.connect();
      let pending: Promise<Response> | undefined;
      try {
        const { owner, createClient } = await oauthFixture(f);
        const client = await createClient();
        const installation = (await f.pool.query('SELECT id FROM rezics_oauth_installation WHERE client_id = $1 AND state = \'active\'', [client.client_id])).rows[0].id;
        if (change === 'install') {
          expect((await f.request('/api/account/installation-changes', { change: 'revoke', installationId: installation }, owner.cookie)).status).toBe(200);
        }
        const spare = await f.signup('spare-owner@example.test');
        await f.pool.query("INSERT INTO rezics_account_operator (user_id, role) VALUES ($1, 'owner')", [spare.id]);
        const before = (await f.pool.query('SELECT id,state FROM rezics_oauth_installation WHERE client_id = $1', [client.client_id])).rows;
        const audits = (await f.pool.query('SELECT id FROM rezics_account_operator_audit WHERE action LIKE \'installation_%\'')).rowCount;
        await blocker.query('BEGIN');
        await blocker.query(change === 'install' ? 'SELECT 1 FROM "oauthClient" WHERE "clientId" = $1 FOR UPDATE'
          : 'SELECT 1 FROM rezics_oauth_installation WHERE client_id = $1 FOR UPDATE', [client.client_id]);
        pending = f.request('/api/account/installation-changes', change === 'install'
          ? { change, clientId: client.client_id, scopes: ['openid'], changeKey: randomUUID() }
          : { change, installationId: installation }, owner.cookie);
        let waiting = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          waiting = (await f.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
            AND (query LIKE 'SELECT%rezics_declared_scopes%' OR query LIKE 'SELECT * FROM rezics_oauth_installation%')`)).rowCount! > 0;
          if (waiting) break;
          await Bun.sleep(5);
        }
        expect(waiting).toBe(true);
        if (ended === 'role') await f.pool.query("UPDATE rezics_account_operator SET role = 'support' WHERE user_id = $1", [owner.id]);
        else await f.pool.query('DELETE FROM "session" WHERE "userId" = $1', [owner.id]);
        await blocker.query('COMMIT');
        expect((await pending).status).toBe(403);
        expect((await f.pool.query('SELECT id,state FROM rezics_oauth_installation WHERE client_id = $1', [client.client_id])).rows).toEqual(before);
        expect((await f.pool.query('SELECT id FROM rezics_account_operator_audit WHERE action LIKE \'installation_%\'')).rowCount).toBe(audits);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => {});
        await f.close();
      }
    }, 60_000);
  }
}
