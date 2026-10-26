import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool, PoolClient, QueryConfig } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { newId } from '../../src/route/route.ts';
import { createAccess } from '../../src/access/index.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import type { Access } from '../../src/request/access.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { runCommand } from '../../src/command/command.ts';
import { createApp } from '../../src/http/app.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
let fixture: ActorFixture;
let token: string;
let ungrantedToken: string;
let jwks: string;
const issuer = 'https://auth.example.test';
const audience = 'https://api.example.test';
const missing = { route: 0x6789, id: '00000000-0000-8000-8000-678900000000' };
beforeAll(async () => {
  fixture = await actorFixture(pool);
  await pool.query(
    `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
     VALUES ($1,$2,$3,'','subject:update','(,)',$4)`,
    [fixture.resource.route, fixture.resource.id, fixture.actorId, fixture.transactionId],
  );
  const keys = await generateKeyPair('ES256');
  jwks = JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'ES256' }] });
  const now = Math.floor(Date.now() / 1000);
  const ungranted = newId(0x1234);
  await fixture.account(ungranted);
  await fixture.admit(fixture.staleId, ungranted);
  const signed = (accountId: string) =>
    new SignJWT({
      client_id: 'first-party',
      scope: 'subject:read subject:update',
      authn_epoch: 1,
      auth_time: now,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'test' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accountId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
  token = await signed(fixture.actorId);
  ungrantedToken = await signed(ungranted);
});
afterAll(() => pool.end());

type Fault =
  | 'authentication-deadline'
  | 'authorization-deadline'
  | 'connect-timeout'
  | '53300'
  | '57014'
  | 'missing-account'
  | 'missing-resource'
  | 'anchor-not-found'
  | 'no-grant'
  | 'none';

function application(fault: Fault, requestDeadlineMs = 5000, preparationDelayMs = 0, anchored = false) {
  let access: Access;
  let delayed = false;
  let evidenceRead = false;
  let injected = false;
  let executed = 0;
  const failure = (code: string) => Object.assign(new Error(`injected ${code}`), { code });
  const intercept = async (query: QueryConfig | string, values: unknown[] | undefined, client: Pick<Pool, 'query'>) => {
    const sql = typeof query === 'string' ? query : query.text;
    const authentication = sql.includes('FROM access.account') && sql.includes('minimum_authn_epoch::text');
    const preparation = sql.includes('AS "databaseAt"');
    const authorization = sql.includes('clock_timestamp() AS observed_at');
    if (sql.includes('FROM access.membership_inverse_coverage') && preparationDelayMs > 0 && !delayed) {
      delayed = true;
      await Bun.sleep(preparationDelayMs);
    }
    if (authentication && fault === 'missing-account') return { rows: [], rowCount: 0 };
    if (
      !injected &&
      ((authentication && fault === 'authentication-deadline') || (authorization && fault === 'authorization-deadline'))
    ) {
      injected = true;
      // The transport does not finish before the request's configured deadline.
      return new Promise<never>(() => {});
    }
    if (preparation && fault === '53300') {
      injected = true;
      throw failure('53300');
    }
    if (authorization && fault === '57014') {
      injected = true;
      throw failure('57014');
    }
    const result = typeof query === 'string' ? await client.query(query, values) : await client.query(query);
    if (preparation) evidenceRead = true;
    return result;
  };
  const seam = Object.create(pool) as Pool;
  seam.query = ((query: QueryConfig | string, values?: unknown[]) => intercept(query, values, pool)) as Pool['query'];
  seam.connect = (async () => {
    if (evidenceRead && fault === 'connect-timeout') {
      injected = true;
      throw new Error('timeout exceeded when trying to connect');
    }
    const client = await pool.connect();
    const bounded = Object.create(client) as PoolClient;
    bounded.query = ((query: QueryConfig | string, values?: unknown[]) =>
      intercept(query, values, client)) as PoolClient['query'];
    bounded.release = client.release.bind(client);
    return bounded;
  }) as Pool['connect'];
  const resource = fault === 'missing-resource' ? missing : fixture.resource;
  const app = createApp({
    pool: seam,
    requestDeadlineMs,
    writeRate: { spend: async () => ({ allowed: true }) },
    access: (config) =>
      (access = createAccess({
        ...config,
        auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => new Response(jwks) },
      })),
  })
    .get(
      '/read',
      {
        detail: {
          operationId: 'subject.read',
          security: [{ bearerAuth: [] }],
          ...{ 'x-action': 'subject:read', 'x-exposure': 'public' },
        },
      },
      async ({ authorize }) => {
        const check = await authorize(resource);
        if (!(await withConnection(seam, (client) => check(client)))) throw new ProblemError('forbidden');
        return { allowed: true };
      },
    )
    .post(
      '/command',
      {
        detail: {
          operationId: 'subject.update',
          security: [{ bearerAuth: [] }],
          ...{ 'x-action': 'subject:update', 'x-exposure': 'public', 'x-rate-limit': { family: 'write', units: 1 } },
        },
      },
      async ({ authorizeCommand, actor, job }) => {
        if (actor.kind !== 'account') throw new ProblemError('forbidden');
        const authorization = anchored
          ? resourceAuthorization({
              access,
              actor,
              action: 'subject:update',
              anchor: {
                resource,
                async validate() {
                  if (fault === 'anchor-not-found') throw new ProblemError('not_found');
                  return true;
                },
              },
              context: { pool: seam, deadline: job.deadline, partition: 0 },
            })
          : await authorizeCommand(resource, () => new ProblemError('forbidden'));
        await runCommand(
          seam,
          {
            partition: 0,
            deadline: job.deadline,
            authorization,
            basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
          },
          async () => {
            executed++;
            return { value: { applied: true }, events: [{ type: 'com.rezics.test.authorized.v1', data: {} }] };
          },
        ).catch((error: unknown) => {
          if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
          throw error;
        });
        return { applied: true };
      },
    );
  return {
    async request(method: 'GET' | 'POST', bearer = fault === 'no-grant' ? ungrantedToken : token) {
      return app.handle(
        new Request(`http://localhost/${method === 'GET' ? 'read' : 'command'}`, {
          method,
          headers: { authorization: `Bearer ${bearer}` },
        }),
      );
    },
    delayed: () => delayed,
    injected: () => injected,
    executed: () => executed,
  };
}

for (const method of ['GET', 'POST'] as const) {
  for (const fault of [
    'authentication-deadline',
    'authorization-deadline',
    'connect-timeout',
    '53300',
    '57014',
  ] as const) {
    test(`${method}: ${fault} is retryable unavailability, never denial`, async () => {
      const deadline = fault.endsWith('-deadline');
      const app = application(fault, deadline ? 1000 : 5000);
      const response = await app.request(method);
      expect(app.injected()).toBe(true);
      expect(response.status).toBe(503);
      const code = fault === 'connect-timeout' || fault === '53300' ? 'overloaded' : 'deadline_exceeded';
      expect(await response.json()).toMatchObject({
        code,
        retryable: true,
        effect_status: method === 'POST' ? 'not_applied' : 'not_applicable',
      });
      expect(response.headers.get('retry-after')).toBe(code === 'overloaded' ? '1' : null);
      expect(response.headers.get('www-authenticate')).toBeNull();
      expect(app.executed()).toBe(0);
    });
  }
  test(`${method}: a valid grant still allows`, async () => {
    const app = application('none');
    const response = await app.request(method);
    expect(response.status).toBe(200);
  });
  test(`${method}: an actor without a grant still gets 403`, async () => {
    const app = application('no-grant');
    const response = await app.request(method);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'forbidden', retryable: false });
    expect(app.executed()).toBe(0);
  });
  test(`${method}: an invalid token still gets 401`, async () => {
    const response = await application('none').request(method, 'invalid');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
  });
  test(`${method}: a missing account row still denies authentication`, async () => {
    const response = await application('missing-account').request(method);
    expect(response.status).toBe(401);
  });
  test(`${method}: missing permission rows still deny`, async () => {
    const response = await application('missing-resource').request(method);
    expect(response.status).toBe(403);
  });
}

for (const method of ['GET', 'POST'] as const) {
  for (const [fault, status, code] of [
    ['none', 200, undefined],
    ['no-grant', 403, 'forbidden'],
    ...(method === 'POST' ? [['anchor-not-found', 404, 'not_found'] as const] : []),
  ] as const) {
    test(`${method}: 1.5 s preparation within 3 s preserves ${status}`, async () => {
      for (const delay of [0, 1500]) {
        const app = application(fault, 3000, delay, true);
        const response = await app.request(method);
        expect(app.delayed()).toBe(delay > 0);
        expect(response.status).toBe(status);
        if (code) {
          expect(await response.json()).toMatchObject({ code, retryable: false });
          expect(app.executed()).toBe(0);
        } else {
          expect(await response.json()).toEqual(method === 'GET' ? { allowed: true } : { applied: true });
          expect(app.executed()).toBe(method === 'POST' ? 1 : 0);
        }
      }
    });
  }
}
