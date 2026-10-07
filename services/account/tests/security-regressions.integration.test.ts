import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import type { PoolClient } from 'pg';
import { accountFixture } from './account-fixture.ts';
import { acceptGuardian } from './recovery-fixture.ts';
import { sensitiveAuthPaths } from '../src/methods.ts';

type Fixture = Awaited<ReturnType<typeof accountFixture>>;
type Member = Awaited<ReturnType<Fixture['signup']>>;
const mailLink = (text: string) => /https?:\/\/\S+/.exec(text)![0];
const currentEmail = async (f: Fixture, id: string) =>
  (await f.pool.query('SELECT email FROM "user" WHERE id = $1', [id])).rows[0].email as string;

async function pendingChange(f: Fixture, member: Member, stage: 'confirm' | 'verify', address = 'changed@example.test') {
  expect((await f.request('/api/auth/change-email', { newEmail: address,
    callbackURL: '/verify-email?change=email' }, member.cookie)).status).toBe(200);
  await f.email.drain();
  const confirmation = mailLink(f.messages.at(-1)!.text);
  expect(f.messages.at(-1)!.to).toBe(member.email);
  if (stage === 'confirm') return confirmation;
  expect((await f.request(confirmation)).status).toBe(302);
  await f.email.drain();
  expect(f.messages.at(-1)!.to).toBe(address);
  return mailLink(f.messages.at(-1)!.text);
}

async function reset(f: Fixture, member: Member) {
  expect((await f.request('/api/auth/request-password-reset', {
    email: member.email, redirectTo: `${f.baseURL}/reset-password` })).status).toBe(200);
  await f.email.drain();
  const response = await f.request(mailLink(f.messages.at(-1)!.text));
  const token = new URL(response.headers.get('location')!).searchParams.get('token');
  expect((await f.request('/api/auth/reset-password', { token,
    newPassword: 'a new recovered password' })).status).toBe(200);
}

async function recovery(f: Fixture, member: Member, guardian: Member) {
  const recoveryCode = randomBytes(32).toString('base64url');
  const claimId = randomUUID();
  expect((await f.request('/api/account/reauthenticate',
    { password: member.password }, member.cookie)).status).toBe(200);
  expect((await f.request('/api/account/recovery-policy', { guardianEmail: guardian.email, recoveryCode },
    member.cookie)).status).toBe(200);
  await acceptGuardian(f, member, guardian);
  expect((await f.request('/api/account/recovery-claims', { claimId, targetEmail: member.email, recoveryCode })).status).toBe(200);
  expect((await f.request(`/api/account/recovery-claims/${claimId}/approval`, {}, guardian.cookie)).status).toBe(200);
  await f.pool.query("UPDATE rezics_account_recovery_claim SET not_before = now() - interval '1 second' WHERE id = $1", [claimId]);
  return () => f.request(`/api/account/recovery-claims/${claimId}/activation`, {
    recoveryCode, newPassword: 'an independently recovered password' });
}

test('SR-1: reset and independent recovery invalidate both email-change stages without a session', async () => {
  const f = await accountFixture();
  try {
    const guardian = await f.signup('security-guardian@example.test');
    for (const stage of ['confirm', 'verify'] as const) {
      for (const action of ['reset', 'recovery'] as const) {
        const member = await f.signup(`${action}-${stage}@example.test`);
        const activate = action === 'recovery' ? await recovery(f, member, guardian) : undefined;
        const link = await pendingChange(f, member, stage, `new-${action}-${stage}@example.test`);
        if (activate) expect((await activate()).status).toBe(200);
        else await reset(f, member);
        const messageCount = f.messages.length;
        const result = await f.request(link);
        expect(result.status).toBe(403);
        expect(result.headers.getSetCookie()).toEqual([]);
        expect(await currentEmail(f, member.id)).toBe(member.email);
        expect((await f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [member.id])).rowCount).toBe(0);
        expect((await f.pool.query('SELECT 1 FROM rezics_account_email_change WHERE user_id = $1', [member.id])).rowCount).toBe(0);
        await f.email.drain();
        expect(f.messages).toHaveLength(messageCount);
      }
    }
  } finally { await f.close(); }
}, 90_000);

test('SR-1: mailbox stages consume once, recover from enqueue failure and bind the immutable user', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('single-use@example.test');
    const first = await pendingChange(f, member, 'confirm');
    await f.pool.query(`CREATE FUNCTION reject_change_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'mail unavailable'; END $$;
      CREATE TRIGGER reject_change_mail BEFORE INSERT ON rezics_account_email
      FOR EACH ROW EXECUTE FUNCTION reject_change_mail()`);
    expect((await f.request(first)).status).toBe(503);
    await f.pool.query('DROP TRIGGER reject_change_mail ON rezics_account_email');
    const before = f.messages.length;
    expect((await Promise.all([f.request(first), f.request(first)])).map(r => r.status).sort()).toEqual([302, 403]);
    await f.email.drain();
    expect(f.messages).toHaveLength(before + 1);
    const second = mailLink(f.messages.at(-1)!.text);
    const tampered = new URL(second);
    tampered.searchParams.set('callbackURL', '//evil.test');
    const redeemed = await Promise.all([f.request(tampered.toString()), f.request(second)]);
    expect(redeemed.map(r => r.status).sort()).toEqual([302, 403]);
    expect(redeemed.find(r => r.status === 302)!.headers.get('location')).toBe('/verify-email?change=verified');
    expect(redeemed.every(r => r.headers.getSetCookie().length === 0)).toBe(true);
    expect(await currentEmail(f, member.id)).toBe('changed@example.test');
    // Reassigning the old address cannot make either spent token target its new owner.
    const replacement = await f.signup(member.email);
    expect((await f.request(first)).status).toBe(403);
    expect((await f.request(second)).status).toBe(403);
    expect(await currentEmail(f, replacement.id)).toBe(member.email);
    // A still-pending intent also refuses an address reassignment.
    const outstanding = await pendingChange(f, replacement, 'verify', 'other@example.test');
    await f.pool.query('UPDATE "user" SET email = $2 WHERE id = $1', [replacement.id, 'moved@example.test']);
    const third = await f.signup(member.email);
    expect((await f.request(outstanding)).status).toBe(403);
    expect(await currentEmail(f, third.id)).toBe(member.email);
    expect(await currentEmail(f, replacement.id)).toBe('moved@example.test');
  } finally { await f.close(); }
}, 90_000);

test('SR-1: legacy provider tokens, expired intents and security/session revocations cannot change email', async () => {
  const f = await accountFixture();
  try {
    for (const stage of ['confirm', 'verify'] as const) {
      for (const action of ['generation', 'session', 'expiry'] as const) {
        const member = await f.signup(`${action}-${stage}@example.test`);
        const link = await pendingChange(f, member, stage);
        if (action === 'generation') {
          const saved = (await f.pool.query('SELECT to_jsonb(i) AS row FROM rezics_account_email_change i WHERE user_id = $1', [member.id])).rows[0].row;
          await f.pool.query('UPDATE rezics_account_security SET generation = generation + 1 WHERE user_id = $1', [member.id]);
          expect((await f.pool.query('SELECT 1 FROM rezics_account_email_change WHERE user_id = $1', [member.id])).rowCount).toBe(0);
          // Even a retained copy cannot rebind itself to the new generation.
          await f.pool.query(`INSERT INTO rezics_account_email_change
            SELECT * FROM jsonb_populate_record(NULL::rezics_account_email_change, $1::jsonb)`, [JSON.stringify(saved)]);
        }
        if (action === 'session') await f.pool.query('DELETE FROM "session" WHERE "userId" = $1', [member.id]);
        if (action === 'expiry') await f.pool.query("UPDATE rezics_account_email_change SET expires_at = now() - interval '1 second' WHERE user_id = $1", [member.id]);
        expect((await f.request(link)).status).toBe(403);
        expect(await currentEmail(f, member.id)).toBe(member.email);
      }
    }
    const member = await f.signup('legacy-change@example.test');
    for (const requestType of [undefined, 'change-email-confirmation', 'change-email-verification']) {
      const token = await createEmailVerificationToken(f.secret, member.email, 'attacker@example.test', 1800,
        requestType ? { requestType } : undefined);
      expect((await f.request(`/api/auth/verify-email?token=${token}&callbackURL=/`)).status).toBe(400);
      await expect(f.auth.api.verifyEmail({ query: { token } })).rejects.toThrow();
    }
    expect(await currentEmail(f, member.id)).toBe(member.email);
  } finally { await f.close(); }
}, 90_000);

test('SR-1: a newer intent replaces the old link, and stale initiation cannot rearm after reset', async () => {
  const f = await accountFixture();
  let blocker: PoolClient | undefined;
  try {
    const member = await f.signup('stale-initiation@example.test');
    const previous = await pendingChange(f, member, 'confirm', 'first-change@example.test');
    const current = await pendingChange(f, member, 'confirm', 'second-change@example.test');
    expect((await f.request(previous)).status).toBe(403);
    expect((await f.request(current)).status).toBe(302);
    const password = await hashPassword('replacement credential during initiation');
    blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR UPDATE', [member.id]);
    const pending = f.request('/api/auth/change-email', { newEmail: 'third-change@example.test' }, member.cookie);
    await waitForLock(f, 'SELECT generation');
    await blocker.query('UPDATE account SET password = $2 WHERE "userId" = $1', [member.id, password]);
    await blocker.query('COMMIT'); blocker.release(); blocker = undefined;
    expect((await pending).status).toBe(403);
    expect((await f.pool.query('SELECT 1 FROM rezics_account_email_change WHERE user_id = $1', [member.id])).rowCount).toBe(0);
    expect(await currentEmail(f, member.id)).toBe(member.email);
  } finally {
    if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
    await f.close();
  }
}, 90_000);

async function waitForLock(f: Fixture, sqlPrefix: string) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if ((await f.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
      AND query LIKE $1`, [`${sqlPrefix}%`])).rowCount) return;
    await Bun.sleep(10);
  }
  throw new Error(`No pending lock: ${sqlPrefix}`);
}

test('SR-1: a redemption waiting behind reset or recovery rechecks its intent after the winner commits', async () => {
  const f = await accountFixture();
  let blocker: PoolClient | undefined;
  try {
    const guardian = await f.signup('race-guardian@example.test');
    const password = await hashPassword('rotated during the race');
    for (const stage of ['confirm', 'verify'] as const) {
      for (const action of ['reset', 'recovery'] as const) {
        const member = await f.signup(`race-${action}-${stage}@example.test`);
        if (action === 'recovery') await recovery(f, member, guardian);
        const link = await pendingChange(f, member, stage);
        blocker = await f.pool.connect();
        await blocker.query('BEGIN');
        if (action === 'recovery') await blocker.query('SELECT 1 FROM rezics_account_recovery_policy WHERE id = $1 FOR UPDATE', [member.id]);
        else await blocker.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR UPDATE', [member.id]);
        const pending = f.request(link);
        await waitForLock(f, 'SELECT generation');
        // Use the exact password fence used by reset/recovery while retaining
        // its lock, so the HTTP redemption is definitely already in flight.
        await blocker.query('UPDATE account SET password = $2 WHERE "userId" = $1', [member.id, password]);
        if (action === 'recovery') await blocker.query(`UPDATE rezics_account_recovery_policy SET
          generation = generation + 1, recovered_at = clock_timestamp() WHERE id = $1`, [member.id]);
        await blocker.query('COMMIT');
        blocker.release(); blocker = undefined;
        expect((await pending).status).toBe(403);
        expect(await currentEmail(f, member.id)).toBe(member.email);
        expect((await f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [member.id])).rowCount).toBe(0);
      }
    }
  } finally {
    if (blocker) { await blocker.query('ROLLBACK'); blocker.release(); }
    await f.close();
  }
}, 90_000);

test('SR-3: every sensitive provider alias and Account session route denies an old session', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('route-parity@example.test');
    const signed = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    const peerSession = (await signed.json() as { token: string }).token;
    await f.pool.query(`UPDATE "session" SET "createdAt" = now() - interval '10 minutes' WHERE "userId" = $1`, [member.id]);
    const aliases = ['/api/auth/revoke-session', '/api/auth/revoke-sessions', '/api/auth/revoke-other-sessions'];
    for (const path of new Set([...sensitiveAuthPaths, ...aliases, '/api/account/sessions/revoke'])) {
      const body = path.endsWith('/change-email') ? { newEmail: 'unused@example.test' }
        : path.endsWith('/delete-passkey') ? { id: 'unused' }
        : path.endsWith('/sessions/revoke') ? { others: true } : { token: peerSession };
      const response = await f.request(path, path.endsWith('/generate-register-options') ? undefined : body, member.cookie);
      expect({ path, status: response.status, body: await response.json() }).toEqual({ path, status: 403,
        body: { error: 'step_up_required' } });
    }
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [member.id])).rowCount).toBe(3);
    expect((await f.request('/api/account/reauthenticate', { password: member.password }, member.cookie)).status).toBe(200);
    for (const path of aliases) {
      expect((await f.request(path, { token: peerSession }, member.cookie, { origin: 'https://evil.test' })).status).toBe(403);
      expect((await f.request(path, { token: peerSession }, member.cookie, { origin: '' })).status).toBe(403);
    }
    expect((await f.request(aliases[0]!, { token: peerSession }, member.cookie)).status).toBe(200);
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE token = $1', [peerSession])).rowCount).toBe(0);
  } finally { await f.close(); }
}, 90_000);

test('SR-1: intent lookup and session revocation use indexes amid unrelated pending changes', async () => {
  const f = await accountFixture();
  try {
    await f.pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      SELECT 'cost-' || n, 'Cost fixture', 'cost-' || n || '@example.test', true, now(), now()
      FROM generate_series(1, 3000) AS n`);
    await f.pool.query(`INSERT INTO "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
      SELECT 'cost-' || n, 'cost-' || n, 'cost-' || n, now() + interval '1 day', now(), now()
      FROM generate_series(1, 3000) AS n`);
    await f.pool.query(`INSERT INTO rezics_account_email_change (user_id, session_id, token_hash, stage,
      old_email, new_email, security_generation, recovery_generation, callback_path, expires_at)
      SELECT 'cost-' || n, 'cost-' || n, repeat(md5(n::text), 2), 'confirm',
        'cost-' || n || '@example.test', 'new-' || n || '@example.test', 0, 0, '/', now() + interval '30 minutes'
      FROM generate_series(1, 3000) AS n`);
    await f.pool.query('ANALYZE rezics_account_email_change');
    for (const [column, value] of [['user_id', 'cost-1500'], ['session_id', 'cost-1500'],
      ['token_hash', (await f.pool.query('SELECT repeat(md5(\'1500\'), 2) AS hash')).rows[0].hash]] as const) {
      const plan = await f.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) SELECT user_id
        FROM rezics_account_email_change WHERE ${column} = $1`, [value]);
      const root = plan.rows[0]['QUERY PLAN'][0].Plan;
      expect(root['Node Type']).toMatch(/^Index (Only )?Scan$/);
      expect(root['Actual Rows']).toBe(1);
    }
  } finally { await f.close(); }
}, 60_000);
