import { enrollSecondFactor } from './factor-fixture.ts';
import { expect, spyOn, test } from 'bun:test';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createAuthMiddleware, createEmailVerificationToken } from 'better-auth/api';
import { queueAfterTransactionHook } from '@better-auth/core/context';
import { decodeJwt } from 'jose';
import { bootstrapOperators } from '../src/operators.ts';
import { accountFixture } from './account-fixture.ts';
import { cookies, recoveryProof } from './recovery-fixture.ts';

const link = (text: string) => /https?:\/\/\S+/.exec(text)![0];
type Fixture = Awaited<ReturnType<typeof accountFixture>>;

async function waitForBlockedQuery(f: Fixture, statements: string[]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = await f.pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE ANY($1::text[]) AND cardinality(pg_blocking_pids(pid)) > 0`,
    [statements.map(statement => `%${statement}%`)]);
    if (blocked.rowCount) return;
    await Bun.sleep(5);
  }
  throw new Error(`No blocked query observed for ${statements.join(', ')}`);
}

for (const first of ['verification', 'operator-note'] as const) {
  test(`${first} first: verification and operator note serialize without a deadlock`, async () => {
    const f = await accountFixture();
    const paused = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const pending: Promise<Response>[] = [];
    let restore = () => {};
    try {
      const operator = await f.signup('note-operator@example.test');
      f.operators.add(operator.id);
      await enrollSecondFactor(f, operator);
      await bootstrapOperators(f.pool, f.operators);
      const email = 'note-verification@example.test';
      expect((await f.request('/api/auth/sign-up/email', { email, name: 'Member',
        password: 'member independently chosen password' })).status).toBe(200);
      await f.email.drain();
      const retained = link(f.messages.at(-1)!.text);
      const id = (await f.pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id;
      const verify = () => f.request(retained);
      const note = () => f.request(`/api/account/admin/users/${id}/actions`, {
        commandId: randomUUID(), action: 'add-note', reasonCode: 'support',
        reason: 'Mailbox verification in progress', note: 'Requested help verifying the mailbox',
      }, operator.cookie);
      if (first === 'verification') {
        const context = await f.auth.$context;
        const update = context.internalAdapter.updateUserByEmail;
        context.internalAdapter.updateUserByEmail = async (...args) => {
          // The provider lookup already holds the identity lock here.
          paused.resolve();
          await resumed.promise;
          return update(...args);
        };
        restore = () => { context.internalAdapter.updateUserByEmail = update; };
      } else {
        const query = Client.prototype.query;
        const spy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
          if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO rezics_account_operator_note')) {
            // performUserAction has acquired security; pause before its FK takes KEY SHARE on user.
            paused.resolve();
            return resumed.promise.then(() => Reflect.apply(query, this, args));
          }
          return Reflect.apply(query, this, args);
        });
        restore = () => spy.mockRestore();
      }
      const firstRequest = first === 'verification' ? verify() : note();
      pending.push(firstRequest);
      await paused.promise;
      const secondRequest = first === 'verification' ? note() : verify();
      pending.push(secondRequest);
      await waitForBlockedQuery(f, first === 'verification'
        ? ['rezics_account_security', 'rezics_account_operator_note']
        : ['rezics_account_security', 'insert into "session"']);
      resumed.resolve();
      const [firstResponse, secondResponse] = await Promise.all(pending);
      const verified = first === 'verification' ? firstResponse! : secondResponse!;
      const noted = first === 'verification' ? secondResponse! : firstResponse!;
      expect(noted.status).toBe(200);
      expect(verified.status).toBe(302);
      expect(new URL(verified.headers.get('location')!, f.baseURL).searchParams.get('error')).toBeNull();
      expect(await (await f.request('/api/auth/get-session', undefined, cookies(verified))).json())
        .toMatchObject({ user: { id, email, emailVerified: true } });
      expect((await f.pool.query('SELECT "userId" FROM "session" WHERE "userId" = $1', [id])).rows)
        .toEqual([{ userId: id }]);
      expect((await f.pool.query('SELECT user_id, author_id FROM rezics_account_operator_note WHERE user_id = $1', [id])).rows)
        .toEqual([{ user_id: id, author_id: operator.id }]);
    } finally {
      resumed.resolve();
      await Promise.allSettled(pending);
      restore();
      await f.close();
    }
  }, 60_000);
}

for (const operation of ['recovery-activation', 'age-hold', 'deletion'] as const) {
  test(`${operation} locks security before holding the user identity`, async () => {
    const f = await accountFixture({ accessDeletionFence: async () => {} });
    const paused = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    let pending: Promise<Response> | undefined;
    let restore = () => {};
    try {
      const member = await f.signup('lock-order-member@example.test');
      const proof = operation === 'recovery-activation'
        ? await recoveryProof(f, member, await f.signup('lock-order-guardian@example.test')) : undefined;
      const query = Client.prototype.query;
      const spy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
        const result = Reflect.apply(query, this, args);
        if (typeof args[0] === 'string' && /FROM (?:public\.)?"user"/.test(args[0])
          && args[0].includes('FOR UPDATE')) {
          return result.then(async (value: unknown) => {
            // Observe the real lock, before any later password/security trigger runs.
            paused.resolve();
            await resumed.promise;
            return value;
          });
        }
        return result;
      });
      restore = () => spy.mockRestore();
      pending = operation === 'recovery-activation' ? proof!.activate()
        : operation === 'age-hold' ? f.request('/api/account/content-preferences', {
          expectedRevision: 0, birthDate: '2020-01-01', country: 'US',
        }, member.cookie)
        : f.request('/api/auth/delete-user', { password: member.password }, member.cookie);
      await paused.promise;
      await expect(f.pool.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR UPDATE NOWAIT',
        [member.id])).rejects.toMatchObject({ code: '55P03' });
      resumed.resolve();
      expect((await pending).status).toBe(200);
      if (operation === 'recovery-activation') {
        expect((await f.pool.query('SELECT generation FROM rezics_account_recovery_policy WHERE id = $1',
          [member.id])).rows[0].generation).toBe('1');
      } else if (operation === 'age-hold') {
        expect((await f.pool.query('SELECT suspension_code FROM rezics_account_security WHERE user_id = $1',
          [member.id])).rows[0].suspension_code).toBe('age_requirement');
      } else {
        expect((await f.pool.query('SELECT id FROM "user" WHERE id = $1', [member.id])).rows).toEqual([]);
      }
    } finally {
      resumed.resolve();
      await pending;
      restore();
      await f.close();
    }
  }, 60_000);
}

test('ordinary verification commits the verified user and session with and without callback', async () => {
  const f = await accountFixture();
  try {
    for (const callback of [true, false]) {
      const email = `ordinary-${callback}@example.test`;
      expect((await f.request('/api/auth/sign-up/email', { email, name: 'Ordinary',
        password: 'ordinary sufficiently long password' })).status).toBe(200);
      await f.email.drain();
      const url = new URL(link(f.messages.at(-1)!.text));
      const id = (await f.pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id;
      expect(decodeJwt(url.searchParams.get('token')!)).toMatchObject({ email,
        rezics_account_verification_user_id: id, rezics_account_recovery_generation: '0' });
      if (!callback) url.searchParams.delete('callbackURL');
      const response = await f.request(url.toString());
      if (callback) expect(new URL(response.headers.get('location')!, f.baseURL).searchParams.get('error')).toBeNull();
      else expect(await response.json()).toMatchObject({ status: true });
      expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [id])).rows[0].emailVerified).toBe(true);
      expect(await (await f.request('/api/auth/get-session', undefined, cookies(response))).json())
        .toMatchObject({ user: { id, emailVerified: true } });
    }
  } finally { await f.close(); }
}, 60_000);

for (const initialOwner of ['original', 'absent', 'provider-lookup'] as const) {
  test(`verification rejects email reuse across the ${initialOwner} lookup boundary`, async () => {
    const f = await accountFixture();
    let resume = () => {};
    try {
      const email = 'admission-race@example.test';
      const body = { email, name: 'Original', password: 'original sufficiently long password' };
      expect((await f.request('/api/auth/sign-up/email', body)).status).toBe(200);
      await f.email.drain();
      const retained = link(f.messages.at(-1)!.text);
      const originalId = (await f.pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id;
      const releaseAddress = () => f.pool.query('UPDATE "user" SET email = $2 WHERE id = $1',
        [originalId, 'moved@example.test']);
      if (initialOwner === 'absent') await releaseAddress();
      const context = await f.auth.$context;
      const before = context.options.hooks!.before!;
      const paused = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      resume = () => resumed.resolve();
      let pausedOnce = false;
      const findUser = context.internalAdapter.findUserByEmail;
      if (initialOwner === 'provider-lookup') context.internalAdapter.findUserByEmail = async (...args) => {
        const selected = await findUser(...args);
        if (args[0] === email && !pausedOnce) {
          pausedOnce = true;
          paused.resolve();
          await resumed.promise;
        }
        return selected;
      };
      context.options.hooks!.before = createAuthMiddleware(async ctx => {
        const result = await before({ ...ctx, returnHeaders: false });
        if (initialOwner !== 'provider-lookup' && ctx.path === '/verify-email'
          && ctx.query?.token === new URL(retained).searchParams.get('token')) {
          paused.resolve();
          await resumed.promise;
        }
        return result;
      });
      const pending = f.request(retained);
      await paused.promise;
      if (initialOwner !== 'absent') await releaseAddress();
      expect((await f.request('/api/auth/sign-up/email', { ...body, name: 'Replacement' })).status).toBe(200);
      const replacementId = (await f.pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id;
      resume();
      const rejected = await pending;
      expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [replacementId]))
        .rows[0].emailVerified).toBe(false);
      expect((await f.pool.query('SELECT id FROM "session" WHERE "userId" = $1', [replacementId])).rows).toEqual([]);
      expect(cookies(rejected)).toBe('');
      expect(new URL(rejected.headers.get('location')!, f.baseURL).searchParams.get('error')).toBe('INVALID_TOKEN');
    } finally { resume(); await f.close(); }
  }, 60_000);
}

test('verification holds the resolved email binding and recovery generation through session creation', async () => {
  const f = await accountFixture();
  let resume = () => {};
  try {
    const member = await f.signup('locked-verification@example.test');
    const guardian = await f.signup('guardian@example.test');
    await recoveryProof(f, member, guardian);
    await f.pool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [member.id]);
    expect((await f.request('/api/auth/send-verification-email', { email: member.email, callbackURL: '/' })).status).toBe(200);
    await f.email.drain();
    const retained = link(f.messages.at(-1)!.text);
    const context = await f.auth.$context;
    const update = context.internalAdapter.updateUserByEmail;
    const paused = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    resume = () => resumed.resolve();
    context.internalAdapter.updateUserByEmail = async (...args) => {
      paused.resolve();
      await resumed.promise;
      return update(...args);
    };
    const pending = f.request(retained);
    await paused.promise;
    const writer = await f.pool.connect();
    try {
      await writer.query("SET lock_timeout = '100ms'");
      await expect(writer.query('UPDATE "user" SET email = $2 WHERE id = $1', [member.id, 'moved@example.test']))
        .rejects.toMatchObject({ code: '55P03' });
      await expect(writer.query('UPDATE rezics_account_recovery_policy SET generation = generation + 1 WHERE id = $1', [member.id]))
        .rejects.toMatchObject({ code: '55P03' });
    } finally { await writer.query('RESET lock_timeout'); writer.release(); }
    resume();
    const verified = await pending;
    expect(await (await f.request('/api/auth/get-session', undefined, cookies(verified))).json())
      .toMatchObject({ user: { id: member.id, emailVerified: true } });
  } finally { resume(); await f.close(); }
}, 60_000);

async function resendByOperator(f: Fixture, userId: string, cookie: string) {
  const resent = await f.request(`/api/account/admin/users/${userId}/actions`, {
    commandId: randomUUID(), action: 'resend-verification', reasonCode: 'support',
    reason: 'Requested a verification link',
  }, cookie);
  expect(resent.status).toBe(200);
  await f.email.drain();
  return link(f.messages.at(-1)!.text);
}

async function issueVerification(f: Fixture, issuer: 'resend' | 'operator' | 'bulk', userId: string,
  email: string, cookie: string) {
  if (issuer === 'operator') return resendByOperator(f, userId, cookie);
  if (issuer === 'resend') {
    expect((await f.request('/api/auth/send-verification-email', { email, callbackURL: '/' })).status).toBe(200);
  } else {
    const started = await f.request('/api/account/admin/bulk-actions', { commandId: randomUUID(),
      action: 'resend-verification', reasonCode: 'support', reason: 'Requested verification links',
      userIds: [userId] }, cookie);
    expect(started.status).toBe(200);
    const { jobId } = await started.json() as { jobId: string };
    for (let attempt = 0; ; attempt++) {
      const response = await f.request(`/api/account/admin/bulk-actions/${jobId}`, undefined, cookie);
      expect(response.status).toBe(200);
      const job = await response.json() as { finishedAt: string | null; succeeded: number };
      if (job.finishedAt) {
        expect(job.succeeded).toBe(1);
        break;
      }
      if (attempt === 199) throw new Error('Verification bulk job did not finish');
      await Bun.sleep(25);
    }
  }
  await f.email.drain();
  return link(f.messages.at(-1)!.text);
}

for (const issuer of ['signup', 'resend', 'operator', 'bulk'] as const) {
  test(`${issuer} verification cannot authenticate a replacement account after email reuse`, async () => {
    const f = await accountFixture();
    try {
      const operator = await f.signup('operator@example.test');
      f.operators.add(operator.id);
      await enrollSecondFactor(f, operator);
      await bootstrapOperators(f.pool, f.operators);
      const original = { email: 'reused@example.test', name: 'Original', password: 'original sufficiently long password' };
      expect((await f.request('/api/auth/sign-up/email', original)).status).toBe(200);
      await f.email.drain();
      const originalId = (await f.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1',
        [original.email])).rows[0]!.id;
      const retained = issuer === 'signup' ? link(f.messages.at(-1)!.text)
        : await issueVerification(f, issuer, originalId, original.email, operator.cookie);
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

for (const issuer of ['resend', 'operator', 'bulk'] as const) {
test(`${issuer} verification uses the current recovery generation and rejects its stale link`, async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('recovered@example.test');
    const guardian = await f.signup('guardian@example.test');
    const operator = await f.signup('operator@example.test');
    f.operators.add(operator.id);
    await enrollSecondFactor(f, operator);
    await bootstrapOperators(f.pool, f.operators);
    const recovery = await recoveryProof(f, member, guardian);
    await f.pool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [member.id]);
    const stale = await issueVerification(f, issuer, member.id, member.email, operator.cookie);
    expect((await recovery.activate()).status).toBe(200);
    const rejected = await f.request(stale);
    expect(cookies(rejected)).toBe('');
    expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [member.id]))
      .rows[0].emailVerified).toBe(false);
    expect((await f.pool.query('SELECT generation FROM rezics_account_recovery_policy WHERE id = $1', [member.id]))
      .rows[0].generation).toBe('1');
    const fresh = await issueVerification(f, issuer, member.id, member.email, operator.cookie);
    const verified = await f.request(fresh);
    expect(verified.status).toBe(302);
    expect(new URL(verified.headers.get('location')!, f.baseURL).searchParams.has('error')).toBe(false);
    expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [member.id]))
      .rows[0].emailVerified).toBe(true);
    expect(cookies(verified)).not.toBe('');
    expect(await (await f.request('/api/auth/get-session', undefined, cookies(verified))).json())
      .toMatchObject({ user: { id: member.id, emailVerified: true } });
  } finally { await f.close(); }
}, 60_000);
}

test('signup mail binds the recovery generation current at post-commit issuance', async () => {
  const f = await accountFixture();
  try {
    const guardian = await f.signup('guardian@example.test');
    const context = await f.auth.$context;
    const send = context.options.emailVerification!.sendVerificationEmail!;
    context.options.emailVerification!.sendVerificationEmail = async (data, request) => {
      // Signup mail is issued after commit. Seed that later owner state before
      // the queued issuer runs, rather than testing only the default generation.
      await queueAfterTransactionHook(async () => {
        await f.pool.query(`INSERT INTO rezics_account_recovery_policy (id, guardian_user_id, generation)
          VALUES ($1, $2, 1)`, [data.user.id, guardian.id]);
      });
      await send(data, request);
    };
    const email = 'signup-generation@example.test';
    expect((await f.request('/api/auth/sign-up/email', { email, name: 'Signup',
      password: 'signup sufficiently long password' })).status).toBe(200);
    await f.email.drain();
    const memberId = (await f.pool.query('SELECT id FROM "user" WHERE email = $1', [email])).rows[0].id;
    expect((await f.pool.query('SELECT generation FROM rezics_account_recovery_policy WHERE id = $1', [memberId]))
      .rows[0].generation).toBe('1');
    const verified = await f.request(link(f.messages.at(-1)!.text));
    expect(new URL(verified.headers.get('location')!, f.baseURL).searchParams.has('error')).toBe(false);
    expect((await f.pool.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [memberId]))
      .rows[0].emailVerified).toBe(true);
    expect(cookies(verified)).not.toBe('');
    expect(await (await f.request('/api/auth/get-session', undefined, cookies(verified))).json())
      .toMatchObject({ user: { id: memberId, emailVerified: true } });
  } finally { await f.close(); }
}, 60_000);
