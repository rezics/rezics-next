import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { accountFixture } from './account-fixture.ts';
import { cookies, recoveryProof } from './recovery-fixture.ts';

const link = (text: string) => /https?:\/\/\S+/.exec(text)![0];
type Fixture = Awaited<ReturnType<typeof accountFixture>>;

async function resendByOperator(f: Fixture, userId: string, cookie: string) {
  const resent = await f.request(`/api/account/admin/users/${userId}/actions`, {
    commandId: randomUUID(), action: 'resend-verification', reasonCode: 'support',
    reason: 'Requested a verification link',
  }, cookie);
  expect(resent.status).toBe(200);
  await f.email.drain();
  return link(f.messages.at(-1)!.text);
}

for (const issuer of ['signup', 'operator'] as const) {
  test(`${issuer} verification cannot authenticate a replacement account after email reuse`, async () => {
    const f = await accountFixture();
    try {
      const operator = await f.signup('operator@example.test');
      f.operators.add(operator.id);
      const original = { email: 'reused@example.test', name: 'Original', password: 'original sufficiently long password' };
      expect((await f.request('/api/auth/sign-up/email', original)).status).toBe(200);
      await f.email.drain();
      const originalId = (await f.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1',
        [original.email])).rows[0]!.id;
      const retained = issuer === 'signup' ? link(f.messages.at(-1)!.text)
        : await resendByOperator(f, originalId, operator.cookie);
      const verified = await f.request(retained);
      expect(verified.status).toBe(302);
      expect(new URL(verified.headers.get('location')!, f.baseURL).searchParams.has('error')).toBe(false);
      const originalCookie = cookies(verified);
      expect(originalCookie).not.toBe('');
      expect(await (await f.request('/api/auth/get-session', undefined, originalCookie)).json())
        .toMatchObject({ user: { id: originalId, emailVerified: true } });

      expect((await f.request('/api/auth/change-email', { newEmail: 'moved@example.test', callbackURL: '/' },
        originalCookie)).status).toBe(200);
      await f.email.drain();
      expect((await f.request(link(f.messages.at(-1)!.text), undefined, originalCookie)).status).toBe(302);
      await f.email.drain();
      expect((await f.request(link(f.messages.at(-1)!.text), undefined, originalCookie)).status).toBe(302);
      expect((await f.pool.query('SELECT email FROM "user" WHERE id = $1', [originalId])).rows[0].email)
        .toBe('moved@example.test');

      const replacement = { ...original, name: 'Replacement', password: 'replacement independently chosen password' };
      expect((await f.request('/api/auth/sign-up/email', replacement)).status).toBe(200);
      await f.email.drain();
      const fresh = link(f.messages.at(-1)!.text);
      const replacementId = (await f.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1',
        [original.email])).rows[0]!.id;
      expect(replacementId).not.toBe(originalId);
      expect((await f.pool.query('SELECT id FROM rezics_account_recovery_policy WHERE id = ANY($1::text[])',
        [[originalId, replacementId]])).rows).toEqual([]);

      const replay = await f.request(retained);
      // Check effects before the error response: provider auto-login would create a session here.
      expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [replacementId]))
        .rows[0].emailVerified).toBe(false);
      expect((await f.pool.query('SELECT id FROM "session" WHERE "userId" = $1', [replacementId])).rows).toEqual([]);
      expect(cookies(replay)).toBe('');
      expect(await (await f.request('/api/auth/get-session', undefined, cookies(replay))).json()).toBeNull();
      expect(replay.status).toBe(302);
      expect(new URL(replay.headers.get('location')!, f.baseURL).searchParams.get('error')).toBe('INVALID_TOKEN');
      expect((await f.request('/api/auth/sign-in/email', replacement)).status).toBe(403);

      const accepted = await f.request(fresh);
      expect(accepted.status).toBe(302);
      expect(await (await f.request('/api/auth/get-session', undefined, cookies(accepted))).json())
        .toMatchObject({ user: { id: replacementId, emailVerified: true } });
    } finally { await f.close(); }
  }, 60_000);
}

test('legacy verification JWTs without an immutable identity binding are rejected', async () => {
  const f = await accountFixture();
  try {
    const email = 'legacy@example.test';
    expect((await f.request('/api/auth/sign-up/email', { email, name: 'Legacy',
      password: 'legacy sufficiently long password' })).status).toBe(200);
    const token = await createEmailVerificationToken(f.secret, email, undefined, 1800,
      { rezics_account_recovery_generation: '0' });
    for (const callback of [undefined, '/', 'https://other.example.test/']) {
      const url = new URL('/api/auth/verify-email', f.baseURL);
      url.searchParams.set('token', token);
      if (callback) url.searchParams.set('callbackURL', callback);
      const response = await f.request(url.toString());
      expect(cookies(response)).toBe('');
      expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE email = $1', [email]))
        .rows[0].emailVerified).toBe(false);
      if (callback === '/') {
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('INVALID_TOKEN');
      } else {
        expect(response.status).toBe(403);
        expect(response.headers.get('location')).toBeNull();
      }
    }
  } finally { await f.close(); }
}, 60_000);

test('operator verification uses the current recovery generation and rejects its stale link', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('recovered@example.test');
    const guardian = await f.signup('guardian@example.test');
    const operator = await f.signup('operator@example.test');
    f.operators.add(operator.id);
    const recovery = await recoveryProof(f, member, guardian);
    await f.pool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [member.id]);
    const stale = await resendByOperator(f, member.id, operator.cookie);
    expect((await recovery.activate()).status).toBe(200);
    const rejected = await f.request(stale);
    expect(cookies(rejected)).toBe('');
    expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [member.id]))
      .rows[0].emailVerified).toBe(false);
    const fresh = await resendByOperator(f, member.id, operator.cookie);
    const verified = await f.request(fresh);
    expect(verified.status).toBe(302);
    expect(new URL(verified.headers.get('location')!, f.baseURL).searchParams.has('error')).toBe(false);
    expect(await (await f.request('/api/auth/get-session', undefined, cookies(verified))).json())
      .toMatchObject({ user: { id: member.id, emailVerified: true } });
  } finally { await f.close(); }
}, 60_000);
