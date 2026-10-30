import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { betterAuth } from 'better-auth';
import { betterAuthOptions } from '../src/better-auth.ts';
import { nativeAttemptRequest, pruneAuthAttempts, withAuthTransport } from '../src/rate-limit.ts';
import { testDatabase } from '../scripts/database.ts';
import { runPlacedTests } from '../scripts/placed-tests.ts';
import {
  createAuthService,
  createRecoveryEstablishmentVerifier,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
} from '../src/index.ts';

// Run production defaults in a fresh module graph; the frozen foundation suite
// keeps Better Auth's native test-mode defaults.
if (process.env.AUTH_ATTEMPT_TEST_CHILD !== '1') {
  test('production native attempt limits and cost on a real Auth database', async () => {
    const child = await runPlacedTests(['bun', 'test', 'test/rate-limit.test.ts', 'test/rate-limit-cost.test.ts'], {
      cwd: import.meta.dir + '/..',
      env: { ...process.env, NODE_ENV: 'production', AUTH_ATTEMPT_TEST_CHILD: '1' },
    });
    if (child.output) console.info(child.output);
    expect(child.code).toBe(0);
  }, 120000);
} else {
  let fixture: Awaited<ReturnType<typeof attemptFixture>>;
  beforeAll(async () => {
    fixture = await attemptFixture();
  }, 30000);
  afterAll(async () => {
    await fixture?.close();
  });
  let sequence = 1;
  beforeEach(() => {
    fixture.setPeer(`192.0.2.${sequence++}`);
  });

  test('failed native passwords consume the shared budget before any session effect', async () => {
    const first = await fixture.signin(fixture.first, 'wrong password');
    expect(first.status).toBe(401);
    expect((await fixture.signin(fixture.second, 'wrong password')).status).toBe(401);
    expect((await fixture.signin(fixture.first)).status).toBe(200);
    const before = await fixture.effects();
    const denied = await fixture.signin(fixture.second);
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect(await fixture.effects()).toEqual(before);
  });

  test('two service processes cannot overspend and a new service retains the same counter', async () => {
    const workerSource = `
      import { createAuthService } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
      import { withAuthTransport } from ${JSON.stringify(new URL('../src/rate-limit.ts', import.meta.url).href)};
      import { trustedAccessPorts } from ${JSON.stringify(new URL('./support/trusted-access.ts', import.meta.url).href)};
      import { Pool } from 'pg';
      const input = await Bun.stdin.json();
      const pool = new Pool({ connectionString: input.url });
      const service = await createAuthService({ ...input.options, database: pool,
        trustedAccess: trustedAccessPorts({ async readAccount() { return input.account; },
          async authorizeProvisioning() { throw new Error('Not provisioning'); } }) });
      const statuses = await Promise.all(Array.from({ length: 8 }, () => withAuthTransport(input.peer,
        () => service.handler(new Request(input.options.issuer + '/signin', {
          method: 'POST', headers: { origin: input.options.issuer, 'content-type': 'application/json' },
          body: JSON.stringify(input.body) }))).then(response => response.status)));
      await pool.end();
      process.stdout.write(JSON.stringify(statuses));
    `;
    const child = Bun.spawn(['bun', '--eval', workerSource], {
      cwd: import.meta.dir + '/..',
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    child.stdin.write(
      JSON.stringify({
        url: fixture.pool.options.connectionString,
        peer: fixture.peer,
        account: fixture.account,
        options: {
          issuer: fixture.options.issuer,
          audience: fixture.options.audience,
          signing: fixture.options.signing,
          secret: fixture.options.secret,
        },
        body: { email: 'attempt@example.test', password: 'wrong password', client_id: 'attempt-web', scope: ['read'] },
      }),
    );
    child.stdin.end();
    const local = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fixture
          .signin(index % 2 ? fixture.first : fixture.second, 'wrong password')
          .then((response) => response.status),
      ),
    );
    const remote = JSON.parse(await new Response(child.stdout).text()) as number[];
    expect(await child.exited).toBe(0);
    expect([...local, ...remote].filter((status) => status === 401)).toHaveLength(3);
    expect([...local, ...remote].filter((status) => status === 429)).toHaveLength(13);
    const restarted = await createAuthService(fixture.options);
    expect((await fixture.signin(restarted)).status).toBe(429);
  });

  test('native paths and login aliases share policy; recovery and step-up have separate budgets', async () => {
    expect(
      (await fixture.native('/sign-in/email', { email: 'attempt@example.test', password: 'wrong password' })).status,
    ).toBe(401);
    expect(
      (
        await fixture.request(fixture.first, '/signin', {
          account_id: fixture.account.accountId,
          password: 'wrong password',
          client_id: 'attempt-web',
          scope: ['read'],
        })
      ).status,
    ).toBe(401);
    // The key alias is part of the same login family, before key or actor lookup.
    expect(
      (
        await fixture.request(fixture.second, '/signin/key', {
          account_id: 'unknown',
          assertion: 'invalid',
          client_id: 'attempt-web',
          scope: ['read'],
        })
      ).status,
    ).toBe(401);
    expect((await fixture.signin(fixture.second)).status).toBe(429);
    const before = fixture.deliveries.length;
    for (let i = 0; i < 3; i++) {
      expect((await fixture.request(fixture.first, '/recovery/start', { email: 'attempt@example.test' })).status).toBe(
        200,
      );
      await fixture.drain();
    }
    expect(fixture.deliveries).toHaveLength(before + 1);
    const effects = await fixture.effects();
    expect((await fixture.request(fixture.second, '/recovery/start', { email: 'unknown@example.test' })).status).toBe(
      429,
    );
    await fixture.drain();
    expect(fixture.deliveries).toHaveLength(before + 1);
    expect(await fixture.effects()).toEqual(effects);
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await fixture.request(fixture.first, '/recovery/complete', {
            account_id: fixture.account.accountId,
            token: 'invalid',
            new_password: 'new correct horse password',
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await fixture.request(fixture.second, '/recovery/complete', {
          account_id: fixture.account.accountId,
          token: fixture.deliveries.at(-1),
          new_password: 'new correct horse password',
        })
      ).status,
    ).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await fixture.native('/verify-password', { password: 'wrong password' })).status).toBe(401);
    }
    const step = await fixture.native('/verify-password', { password: 'wrong password' });
    expect(step.status).toBe(429);
    expect(Number(step.headers.get('x-retry-after'))).toBeGreaterThan(290);
    expect(await fixture.effects()).toEqual(effects);
  });

  test('native password step-up charges wrong passwords and succeeds below its separate budget', async () => {
    const signed = await fixture.signin(fixture.first);
    expect(signed.status).toBe(200);
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const before = await fixture.effects();
    for (let i = 0; i < 4; i++) {
      expect((await fixture.native('/verify-password', { password: 'wrong password' }, { cookie })).status).toBe(400);
    }
    expect(
      (await fixture.native('/verify-password', { password: 'correct horse battery staple' }, { cookie })).status,
    ).toBe(200);
    expect(
      (await fixture.native('/verify-password', { password: 'correct horse battery staple' }, { cookie })).status,
    ).toBe(429);
    expect(await fixture.effects()).toEqual(before);
  });

  test('successful recovery below budget retains native reset and epoch semantics', async () => {
    const password = 'correct horse battery staple';
    await fixture.pool.query('DELETE FROM auth_attempt_counter WHERE key=$1', [fixture.mailKey()]);
    const before = fixture.deliveries.length;
    expect((await fixture.request(fixture.first, '/recovery/start', { email: 'attempt@example.test' })).status).toBe(
      200,
    );
    await fixture.drain();
    expect(fixture.deliveries).toHaveLength(before + 1);
    const epoch = fixture.account.authnEpoch;
    expect(
      (
        await fixture.request(fixture.second, '/recovery/complete', {
          account_id: fixture.account.accountId,
          token: fixture.deliveries.at(-1),
          new_password: password,
        })
      ).status,
    ).toBe(200);
    expect(fixture.account.authnEpoch).toBe(epoch + 1);
    expect((await fixture.signin(fixture.first, password)).status).toBe(200);
  });

  test('Origin rejects before charging and untrusted forwarding headers cannot rotate identity', async () => {
    const body = {
      email: 'attempt@example.test',
      password: 'wrong password',
      client_id: 'attempt-web',
      scope: ['read'],
    };
    const before = await fixture.pool.query('SELECT count(*) FROM auth_attempt_counter');
    for (const origin of ['', 'https://hostile.test']) {
      expect((await fixture.request(fixture.first, '/signin', body, { origin })).status).toBe(403);
    }
    const missing = new Request(`${fixture.options.issuer}/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await fixture.first.handler(missing)).status).toBe(403);
    expect((await fixture.request(fixture.first, '/signin', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(
      403,
    );
    expect((await fixture.pool.query('SELECT count(*) FROM auth_attempt_counter')).rows).toEqual(before.rows);
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await fixture.request(fixture.first, '/signin', body, {
            'x-forwarded-for': `198.51.100.${i + 1}`,
            'x-rezics-auth-peer': `203.0.113.${i + 1}`,
          })
        ).status,
      ).toBe(401);
    }
    const known = await fixture.request(fixture.first, '/signin', body);
    const unknown = await fixture.request(fixture.second, '/signin', { ...body, email: 'absent@example.test' });
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(await known.text()).toBe(await unknown.text());
    expect(known.headers.get('retry-after')).toBe(unknown.headers.get('retry-after'));
  });

  test('missing trusted transport shares the native fallback despite forged peer headers', async () => {
    const before = await fixture.effects();
    for (let i = 0; i < 5; i++) {
      const response = await fixture.first.handler(
        new Request(`${fixture.options.issuer}/signin`, {
          method: 'POST',
          headers: {
            origin: fixture.options.issuer,
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${i + 1}`,
            'x-rezics-auth-peer': `203.0.113.${i + 1}`,
          },
          body: JSON.stringify({
            email: 'attempt@example.test',
            password: 'wrong password',
            client_id: 'attempt-web',
            scope: ['read'],
          }),
        }),
      );
      expect(response.status).toBe(i < 3 ? 401 : 429);
    }
    expect(await fixture.effects()).toEqual(before);
  });

  test('unavailable counter fails closed before credentials, sessions, recovery delivery or epoch effects', async () => {
    const before = await fixture.effects();
    const epoch = fixture.account.authnEpoch;
    const delivered = fixture.deliveries.length;
    await fixture.pool.query('ALTER TABLE auth_attempt_counter RENAME TO unavailable_counter');
    try {
      for (const [path, body] of [
        [
          '/signin',
          {
            email: 'attempt@example.test',
            password: 'correct horse battery staple',
            client_id: 'attempt-web',
            scope: ['read'],
          },
        ],
        [
          '/signin',
          {
            account_id: fixture.account.accountId,
            password: 'correct horse battery staple',
            client_id: 'attempt-web',
            scope: ['read'],
          },
        ],
        [
          '/signin/key',
          { account_id: fixture.account.accountId, assertion: 'invalid', client_id: 'attempt-web', scope: ['read'] },
        ],
        ['/recovery/start', { email: 'attempt@example.test' }],
        [
          '/recovery/complete',
          {
            account_id: fixture.account.accountId,
            token: fixture.deliveries.at(-1),
            new_password: 'new correct horse password',
          },
        ],
      ] as const) {
        const response = await fixture.request(fixture.second, path, body);
        expect(response.status).toBe(503);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await response.text()).toBe('{"error":"authentication_denied"}');
      }
      expect(await fixture.effects()).toEqual(before);
      expect(fixture.account.authnEpoch).toBe(epoch);
      expect(fixture.deliveries).toHaveLength(delivered);
    } finally {
      await fixture.pool.query('ALTER TABLE unavailable_counter RENAME TO auth_attempt_counter');
    }
    expect((await fixture.signin(fixture.first)).status).toBe(200);
  });

  test('database clock, rejected window stability, opaque keys and bounded 48-hour maintenance', async () => {
    for (let i = 0; i < 3; i++) await fixture.signin(fixture.first, 'wrong password');
    const before = (await fixture.pool.query('SELECT * FROM auth_attempt_counter ORDER BY key')).rows;
    expect((await fixture.signin(fixture.second)).status).toBe(429);
    const after = (await fixture.pool.query('SELECT * FROM auth_attempt_counter ORDER BY key')).rows;
    expect(after).toEqual(
      before.map((row) => ({
        ...row,
        accepted: row.key === fixture.counterKey('/sign-in/email') ? false : row.accepted,
      })),
    );
    for (const row of after) expect(row.key).toMatch(/^[0-9a-f]{64}$/);
    const key = fixture.counterKey('/sign-in/email');
    await fixture.pool.query(
      "UPDATE auth_attempt_counter SET last_request=statement_timestamp()-interval '11 seconds' WHERE key=$1",
      [key],
    );
    expect((await fixture.signin(fixture.first)).status).toBe(200);
    const row = (
      await fixture.pool.query(
        'SELECT count, extract(epoch FROM statement_timestamp()-last_request)::float AS age FROM auth_attempt_counter WHERE key=$1',
        [key],
      )
    ).rows[0];
    expect(row.count).toBe(1);
    expect(row.age).toBeGreaterThanOrEqual(0);
    expect(row.age).toBeLessThan(2);
    await fixture.pool.query(
      "UPDATE auth_attempt_counter SET count=3, last_request=statement_timestamp()-interval '11 seconds' WHERE key=$1",
      [key],
    );
    const resetRace = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fixture
          .signin(index % 2 ? fixture.first : fixture.second, 'wrong password')
          .then((response) => response.status),
      ),
    );
    expect(resetRace.filter((status) => status === 401)).toHaveLength(3);
    expect(resetRace.filter((status) => status === 429)).toHaveLength(5);
    expect(
      (await fixture.pool.query("SELECT relpersistence FROM pg_class WHERE oid='auth_attempt_counter'::regclass"))
        .rows[0].relpersistence,
    ).toBe('u');
    await fixture.pool.query(`INSERT INTO auth_attempt_counter
      SELECT md5(i::text)||md5(i::text), 1, statement_timestamp()-interval '49 hours', true FROM generate_series(1, 5) i`);
    expect(await pruneAuthAttempts(fixture.pool, 2)).toBe(2);
    expect(await pruneAuthAttempts(fixture.pool, 1000)).toBe(3);
    expect(await pruneAuthAttempts(fixture.pool, 1000)).toBe(0);
  });
}

function trackQueries(target: Pool) {
  let inflight = 0;
  const query = target.query.bind(target);
  const connect = target.connect.bind(target) as {
    (): Promise<PoolClient>;
    (...args: unknown[]): void;
  };
  const tracked = (run: () => unknown) => {
    inflight++;
    try {
      return Promise.resolve(run()).finally(() => {
        inflight--;
      });
    } catch (error) {
      inflight--;
      throw error;
    }
  };
  const hasCallback = (args: unknown[]) => typeof args.at(-1) === 'function';
  const trackClient = (client: PoolClient) => {
    if (Object.hasOwn(client, 'trackedQuery')) return client;
    const clientQuery = client.query.bind(client);
    Object.defineProperty(client, 'trackedQuery', { value: true });
    client.query = ((...args: unknown[]) =>
      hasCallback(args)
        ? clientQuery(...(args as [string]))
        : tracked(() => clientQuery(...(args as [string])))) as PoolClient['query'];
    return client;
  };
  target.query = ((...args: unknown[]) =>
    hasCallback(args) ? query(...(args as [string])) : tracked(() => query(...(args as [string])))) as Pool['query'];
  target.connect = ((...args: unknown[]) =>
    hasCallback(args) ? connect(...args) : connect().then(trackClient)) as Pool['connect'];
  return async function settled() {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inflight === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (inflight === 0) return;
      }
    }
  };
}

export async function attemptFixture() {
  const db = testDatabase();
  const pool = new Pool({ connectionString: db.url });
  const drain = trackQueries(pool);
  const account: AccessAccount = {
    accountId: 'attempt-person',
    kind: 'actor',
    state: 'pending',
    authnEpoch: 1,
    automated: false,
  };
  const key = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(key.privateKey)), kid: 'attempt-signer', alg: 'ES256' };
  const deliveries: string[] = [];
  const options: AuthServiceOptions = {
    database: pool,
    issuer: 'https://attempt.auth.test',
    audience: 'https://attempt.api.test',
    secret: 'attempt-only-persistent-secret-with-at-least-32-bytes',
    signing: { activeKid: jwk.kid, privateKeys: [jwk] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      async readAccount(id) {
        return id === account.accountId ? account : null;
      },
      async readRecoveryAccount(id) {
        return id === account.accountId ? account : null;
      },
      async authorizeProvisioning() {
        return { accountId: account.accountId };
      },
      async authorizeRecovery({ accountId, proofEpoch }) {
        if (accountId !== account.accountId || proofEpoch !== account.authnEpoch) throw new Error('Stale recovery');
        account.authnEpoch++;
        return { receiptId: `recovery-${account.authnEpoch}`, accountId, minimumAuthnEpoch: account.authnEpoch };
      },
      async completeRecovery(reference) {
        const evidence = await createRecoveryEstablishmentVerifier({ database: pool }).resolve(reference);
        expect(evidence?.accountId).toBe(account.accountId);
        expect(evidence?.authnEpoch).toBe(account.authnEpoch);
      },
    }),
    recoveryDelivery: {
      async deliver({ token }) {
        deliveries.push(token);
      },
    },
  };
  const first = await createAuthService(options);
  await first.internal.provisionPassword({
    authorization: 'approved',
    email: 'attempt@example.test',
    password: 'correct horse battery staple',
  });
  account.state = 'active';
  await first.internal.registerClient({ clientId: 'attempt-web', firstParty: true, scopes: ['read'] });
  const secondPool = new Pool({ connectionString: db.url });
  const second = await createAuthService({ ...options, database: secondPool });
  let peer = '192.0.2.1';
  const native = betterAuth(betterAuthOptions(pool, options.issuer, options.secret));
  function request(target: AuthService, path: string, body: unknown, headers: Record<string, string> = {}) {
    return withAuthTransport(peer, () =>
      target.handler(
        new Request(`${options.issuer}${path}`, {
          method: 'POST',
          headers: { origin: options.issuer, 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      ),
    );
  }
  return {
    pool,
    options,
    first,
    second,
    account,
    deliveries,
    drain,
    mailKey() {
      return createHmac('sha256', options.secret)
        .update(JSON.stringify(['auth-recovery-mail-v1', account.accountId]))
        .digest('hex');
    },
    request,
    get peer() {
      return peer;
    },
    setPeer(value: string) {
      peer = value;
    },
    counterKey(path: string) {
      return createHmac('sha256', options.secret)
        .update(JSON.stringify([options.issuer, `${peer}|${path}`]))
        .digest('hex');
    },
    native(path: string, body: unknown, headers: Record<string, string> = {}) {
      return withAuthTransport(peer, () => {
        const request = new Request(options.issuer, {
          method: 'POST',
          headers: { origin: options.issuer, 'content-type': 'application/json', ...headers },
        });
        return native.handler(
          new Request(nativeAttemptRequest(request, options.issuer, path), { body: JSON.stringify(body) }),
        );
      });
    },
    signin(target: AuthService, password = 'correct horse battery staple') {
      return request(target, '/signin', {
        email: 'attempt@example.test',
        password,
        client_id: 'attempt-web',
        scope: ['read'],
      });
    },
    async effects() {
      const tables = [
        'account',
        'session',
        'verification',
        'auth_recovery',
        'auth_effect_receipt',
        'auth_key_assertion',
      ];
      return Promise.all(
        tables.map(
          async (table) =>
            (
              await pool.query(
                `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') AS rows FROM ${table} t`,
              )
            ).rows,
        ),
      );
    },
    async close() {
      await secondPool.end();
      await pool.end();
      db.close();
    },
  };
}
