import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { cookies, recoveryProof } from './recovery-fixture.ts';
import type { Pool } from 'pg';
import { withRecoveryAuthentication } from '../src/recovery-auth.ts';
import { authenticationBody } from '../src/authentication-input.ts';
import { prepareAuthentication } from '../src/authentication-input.ts';
import { resolveAuthenticationSubject } from '../src/authentication-subject.ts';
import { betterAuth } from 'better-auth';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { createCookieGetter } from 'better-auth/cookies';
import { createInternalContext } from 'better-call';

for (const scheme of ['https', 'http'])
  for (const reverse of [false, true])
    for (const scenario of ['attribution', 'lock']) {
      test(`${scheme} challenge ${scenario} follows B with both names in ${reverse ? 'reverse' : 'forward'} order`, async () => {
        const issuer = `${scheme}://issuer.test`;
        const f = await accountFixture({ baseURL: issuer, requireEmailVerification: false });
        const request: typeof f.request = (path, body, cookie, extra = {}) =>
          f.request(path, body, cookie, { ...extra, origin: issuer });
        let resume = () => {};
        let pending: Promise<Response> | undefined;
        let recovering: Promise<Response> | undefined;
        const context = await f.auth.$context;
        const consume = context.internalAdapter.consumeVerificationValue;
        try {
          const signup = async (email: string) => {
            const password = 'correct horse battery staple';
            const response = await request('/api/auth/sign-up/email', {
              email,
              name: 'Cookie selection',
              password,
            });
            expect(response.status).toBe(200);
            const { user } = (await response.json()) as { user: { id: string } };
            await f.email.drain();
            const mail = [...f.messages].reverse().find((message) => message.to === email)!;
            const verification = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
            const verified = await request(`${verification.pathname}${verification.search}`);
            expect(verified.status).toBe(302);
            const session = await request('/api/auth/sign-in/email', { email, password });
            expect(session.status).toBe(200);
            return { email, password, id: user.id, cookie: cookies(session) };
          };
          const a = await signup('cookie-a@example.test');
          const b = await signup('cookie-b@example.test');
          const guardian = await signup('cookie-guardian@example.test');
          const proof = await recoveryProof({ ...f, request }, b, guardian);
          for (const member of [a, b]) {
            expect(
              (
                await request(
                  '/api/auth/two-factor/enable',
                  { password: member.password },
                  member.cookie,
                )
              ).status,
            ).toBe(200);
            const secret = await symmetricDecrypt({
              key: f.secret,
              data: (
                await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [
                  member.id,
                ])
              ).rows[0].secret,
            });
            const verified = await request(
              '/api/auth/two-factor/verify-totp',
              { code: await createOTP(secret).totp() },
              member.cookie,
            );
            expect(verified.status).toBe(200);
            member.cookie = cookies(verified);
          }
          const challenge = async (member: typeof a) => {
            const response = await request('/api/auth/sign-in/email', {
              email: member.email,
              password: member.password,
            });
            expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
            return cookies(response)
              .split('; ')
              .find((value) => value.startsWith(`${exact}=`))!;
          };
          const exact = createCookieGetter(f.auth.options)('two_factor').name;
          const other = exact.startsWith('__Secure-')
            ? 'better-auth.two_factor'
            : '__Secure-better-auth.two_factor';
          // Both cookie variants carry B so this test isolates canonical
          // selection/locking from the separate multi-subject refusal matrix.
          const aChallenge = (await challenge(b)).replace(exact, other);
          const bChallenge = await challenge(b);
          const retained = scenario === 'lock' ? await challenge(b) : undefined;
          const savedChallenge =
            scenario === 'lock'
              ? (
                  await f.pool.query<{
                    id: string;
                    identifier: string;
                    value: string;
                    createdAt: Date;
                    updatedAt: Date;
                    expiresAt: Date;
                  }>("SELECT * FROM verification WHERE value = $1 AND identifier LIKE '2fa-%'", [
                    b.id,
                  ])
                ).rows
              : [];
          const pairs = [aChallenge, bChallenge];
          if (reverse) pairs.reverse();
          const both = pairs.join('; ');
          if (scenario === 'attribution') {
            const sessionName = createCookieGetter(f.auth.options)('session_token').name;
            const otherSessionName = sessionName.startsWith('__Secure-')
              ? sessionName.slice('__Secure-'.length)
              : `__Secure-${sessionName}`;
            const aSession = a.cookie
              .split('; ')
              .find((value) => value.startsWith(`${sessionName}=`))!;
            const bSession = b.cookie
              .split('; ')
              .find((value) => value.startsWith(`${sessionName}=`))!;
            const sessionPairs = [aSession.replace(sessionName, otherSessionName), bSession];
            if (reverse) sessionPairs.reverse();
            expect(
              await (
                await request('/api/auth/get-session', undefined, sessionPairs.join('; '))
              ).json(),
            ).toMatchObject({ user: { id: b.id } });
            expect(
              await (
                await request('/api/auth/get-session', undefined, `${bSession}; ${aSession}`)
              ).json(),
            ).toMatchObject({ user: { id: b.id } });
            expect(
              await (
                await request(
                  '/api/auth/get-session',
                  undefined,
                  bSession.replace(sessionName, otherSessionName),
                )
              ).json(),
            ).toBeNull();
            expect(
              (await request('/api/auth/two-factor/verify-totp', { code: 'invalid' }, both)).status,
            ).toBe(401);
            const failures = async () =>
              (
                await f.pool.query(
                  `SELECT user_id FROM rezics_account_security_event
        WHERE action = 'sign_in_failed' AND user_id IN ($1, $2) ORDER BY occurred_at, id`,
                  [a.id, b.id],
                )
              ).rows;
            expect(await failures()).toEqual([{ user_id: b.id }]);

            // Provider parsing chooses the first exact value. Account refuses
            // a second live owner's credential before proof work or attribution.
            expect(
              (
                await request(
                  '/api/auth/two-factor/verify-totp',
                  { code: 'invalid' },
                  `invalid=unused; ${bChallenge}; ${aChallenge.replace(other, exact)}`,
                )
              ).status,
            ).toBe(400);
            expect(await failures()).toEqual([{ user_id: b.id }]);
            const repeated = new Headers({ origin: issuer, 'content-type': 'application/json' });
            repeated.append('cookie', bChallenge);
            repeated.append('cookie', aChallenge.replace(other, exact));
            const native = await createInternalContext(
              { headers: repeated },
              { options: { method: 'POST' } },
            );
            const selected = await createInternalContext(
              { headers: new Headers({ cookie: bChallenge }) },
              { options: { method: 'GET' } },
            );
            expect(await native.getSignedCookie(exact, f.secret)).toBe(
              await selected.getSignedCookie(exact, f.secret),
            );
            expect(
              (
                await fetch(`${f.baseURL}/api/auth/two-factor/verify-totp`, {
                  method: 'POST',
                  headers: repeated,
                  body: '{"code":"invalid"}',
                })
              ).status,
            ).toBe(400);
            expect(await failures()).toEqual([{ user_id: b.id }]);
            return;
          }

          const nativeChallenge = await createInternalContext(
            { headers: new Headers({ cookie: bChallenge }) },
            { options: { method: 'GET' } },
          );
          const identifier = await nativeChallenge.getSignedCookie(exact, f.secret);
          expect(typeof identifier).toBe('string');
          let entered = () => {};
          const paused = new Promise<'paused'>((resolve) => {
            entered = () => resolve('paused');
          });
          const released = new Promise<void>((resolve) => {
            resume = resolve;
          });
          context.internalAdapter.consumeVerificationValue = async (value) => {
            if (value === identifier) {
              entered();
              await released;
            }
            return consume(value);
          };
          const secret = await symmetricDecrypt({
            key: f.secret,
            data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [b.id]))
              .rows[0].secret,
          });
          pending = request(
            '/api/auth/two-factor/verify-totp',
            { code: await createOTP(secret).totp() },
            both,
          );
          expect(await Promise.race([paused, pending.then(() => 'finished' as const)])).toBe(
            'paused',
          );
          recovering = proof.activate();
          let waiting = 0;
          const until = Date.now() + 1500;
          do {
            waiting = (
              await f.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%rezics_account_recovery_policy%'`)
            ).rows[0].n;
            if (!waiting) await Bun.sleep(10);
          } while (!waiting && Date.now() < until);
          expect(waiting).toBe(1);
          expect(
            (
              await f.pool.query(
                'SELECT generation FROM rezics_account_recovery_policy WHERE id = $1',
                [b.id],
              )
            ).rows[0].generation,
          ).toBe('0');
          resume();
          const verified = await pending;
          expect(verified.status).toBe(200);
          expect((await recovering).status).toBe(200);
          expect(
            await (await request('/api/auth/get-session', undefined, cookies(verified))).json(),
          ).toBeNull();
          // The credential fence deletes these rows. Restore the isolated saved
          // artifact to also prove a delayed value-keyed challenge stays fenced.
          for (const artifact of savedChallenge)
            await f.pool.query(
              `INSERT INTO verification
        (id, identifier, value, "createdAt", "updatedAt", "expiresAt") VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO NOTHING`,
              [
                artifact.id,
                artifact.identifier,
                artifact.value,
                artifact.createdAt,
                artifact.updatedAt,
                artifact.expiresAt,
              ],
            );
          expect(
            (
              await request(
                '/api/auth/two-factor/verify-totp',
                { code: await createOTP(secret).totp() },
                `${aChallenge}; ${retained}`,
              )
            ).status,
          ).toBe(403);
        } finally {
          resume();
          await Promise.allSettled([pending, recovering]);
          context.internalAdapter.consumeVerificationValue = consume;
          await f.close();
        }
      }, 60_000);
    }

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
    const paused = new Promise<'paused'>((resolve) => {
      entered = () => resolve('paused');
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    context.password.verify = async (input) => {
      // The provider has already read the old hash when it calls verify.
      entered();
      await released;
      return verify(input);
    };
    const pending = fetch(`${f.baseURL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: f.baseURL, 'content-type': 'application/x-www-form-urlencoded' },
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
    expect(
      (
        await f.request('/api/auth/sign-in/email', {
          email: member.email,
          password: 'new independently bound password',
        })
      ).status,
    ).toBe(200);
  } finally {
    resume();
    await f.close();
  }
}, 60_000);

test('every JSON authentication admission rejects ambiguous keys before lock or provider selection', async () => {
  const f = await accountFixture();
  const handler = f.auth.handler;
  let providerCalls = 0;
  try {
    // Every request below is rejected before the provider runs. Finish its
    // background initialization before teardown closes the fixture database.
    await f.auth.$context;
    f.auth.handler = async (request) => {
      providerCalls++;
      return handler(request);
    };
    const ambiguous = [
      '{"email":"first@example.test","email":"last@example.test"}',
      '{"email":"first@example.test","\\u0065mail":"last@example.test"}',
      '{"email":"first@example.test","Email":"last@example.test"}',
      '{"email":"first@example.test"," email ":"last@example.test"}',
      '{"EMAIL":"last@example.test"}',
      '{"token ":"last"}',
      '{"Response":{"id":"last"}}',
      '{"token":"first","token":"last"}',
      '{"response":{"id":"first"},"response":{"id":"last"}}',
      '{"response":{"id":"first","id":"last"}}',
      '{"response":{" ID ":"last"}}',
      '{"code":"first","code":"last"}',
      '{"password":"first","password":"last"}',
      '{"unused":1,"unused":2}',
    ];
    for (const path of [
      '/api/auth/sign-in/email',
      '/api/auth/request-password-reset',
      '/api/auth/reset-password',
      '/api/auth/passkey/verify-authentication',
      '/api/auth/passkey/verify-registration',
      '/api/auth/two-factor/verify-totp',
      '/api/auth/two-factor/verify-backup-code',
      '/api/auth/two-factor/verify-otp',
    ]) {
      for (const body of ambiguous) {
        const response = await fetch(`${f.baseURL}${path}`, {
          method: 'POST',
          headers: { origin: f.baseURL, 'content-type': 'application/json' },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_request' });
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    expect(providerCalls).toBe(0);
    expect(
      (await f.pool.query('SELECT count(*)::int AS count FROM rezics_account_rate_limit')).rows[0]
        .count,
    ).toBe(0);
  } finally {
    f.auth.handler = handler;
    await f.close();
  }
}, 60_000);

test('strict authentication parsing preserves provider values and binds the same email lock owner', async () => {
  const request = new Request('http://account.test/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"\\u0065mail":"MEMBER@example.test","password":"quoted\\\" \\u4f60\\n", "rememberMe":false}',
  });
  const body = await authenticationBody(request);
  expect(body).toEqual(await request.clone().json());
  const owners: unknown[][] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('AS stale_verification')) owners.push(values);
      if (sql.includes('WHERE email = $1')) return { rows: [{ id: 'member-owner' }] };
      return { rows: [{ stale_verification: false, stale_session: false, stale_trust: false }] };
    },
    release: () => {},
  };
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      expect(values).toEqual([(body.email as string).toLowerCase()]);
      return { rows: [{ id: 'member-owner' }] };
    },
    connect: async () => db,
  } as unknown as Pool;
  const auth = betterAuth({ baseURL: 'http://account.test', secret: 'strict-json-test-at-least-thirty-two-characters',
    emailAndPassword: { enabled: true } });
  const prepared = await prepareAuthentication(auth, request);
  if (prepared.kind === 'reject') throw new Error('valid body refused');
  const subject = await resolveAuthenticationSubject(auth, pool, prepared.input);
  const response = await withRecoveryAuthentication(
    auth,
    pool,
    request,
    prepared.input,
    subject,
    async (held) => {
      expect(held as unknown).toBe(db);
      const providerBody = await request.json();
      expect(providerBody).toEqual(body);
      expect(owners).toEqual([['member-owner', null, null, null]]);
      return Response.json({ status: true });
    },
  );
  expect(response.status).toBe(200);
});

test('strict authentication parsing rejects malformed JSON without changing JSON scalar semantics', async () => {
  const request = (body: string) =>
    new Request('http://account.test/api/auth/sign-in/email', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
  for (const body of [
    'null',
    '[]',
    '{"email":true,}',
    '{"email":01}',
    '{"email":"\\x65"}',
    '{"email":"unfinished}',
    '{"email":"line\nbreak"}',
    '{} trailing',
    '{"email":1e999}',
  ]) {
    await expect(authenticationBody(request(body))).rejects.toThrow('invalid authentication JSON');
  }
  const body =
    '{"email":"a@example.test","extra":[null,true,false,-1.5e2,{"a":"\\t\\r\\b\\f\\/\\\\\\uD83D\\uDE00"}]}';
  expect(await authenticationBody(request(body))).toEqual(JSON.parse(body));
});

test('authentication rejects non-JSON media types before provider proof verification', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('auth-media@example.test');
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'text/plain',
      'application/json-invalid',
      'text/application/json',
    ]) {
      for (const path of [
        '/api/auth/sign-in/email',
        '/api/auth/reset-password',
        '/api/auth/passkey/verify-authentication',
        '/api/auth/two-factor/verify-totp',
        '/api/auth/two-factor/verify-backup-code',
      ]) {
        const response = await fetch(`${f.baseURL}${path}`, {
          method: 'POST',
          headers: { origin: f.baseURL, 'content-type': contentType },
          body: JSON.stringify({ email: member.email, password: member.password, code: 'invalid' }),
        });
        expect(response.status).toBe(415);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    expect(
      (
        await f.request(
          '/api/auth/sign-in/email',
          {
            email: member.email.toUpperCase(),
            password: member.password,
          },
          undefined,
          { 'content-type': 'application/json; charset=utf-8' },
        )
      ).status,
    ).toBe(200);
  } finally {
    await f.close();
  }
}, 60_000);
