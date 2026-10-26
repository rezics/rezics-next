import { afterAll, expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { createPool } from '../src/database/pool.ts';
import { Admission } from '../src/http/admission.ts';
import { createApp } from '../src/http/app.ts';
import { defineRateLimit } from '../src/http/rate-limit.ts';
import { actionCatalogue, SESSION_HEADER } from '../src/http/request.ts';
import {
  anonymousAccess,
  AuthenticationError,
  type Access,
  type AccountActor,
  type Resource,
} from '../src/request/access.ts';
import type { KeyRing } from '../src/tokens/seal.ts';
import { decodeSession, encodeSession } from '../src/tokens/session.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

const tokens: KeyRing = { current: 2, keys: new Map([[2, new Uint8Array(32).fill(5)]]) };
const account: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'web',
  scopes: ['thing:read', 'thing:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const thing: Resource = { route: 0x1234, id: '019a1b2c-3d4e-7f00-8a00-123400000001' };
const read = {
  operationId: 'thing.get',
  'x-action': 'thing:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};
const writeRate = { spend: async () => ({ allowed: true as const }) };
const create = {
  operationId: 'thing.create',
  'x-action': 'thing:create',
  'x-exposure': 'public',
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  security: [{ bearerAuth: [] }],
};

type Seen = { authenticated: number[]; checks: unknown[][]; prepared: number[] };
function recorder(seen: Seen, admission: Admission, prepare = false): Access {
  return {
    async authenticate(token) {
      seen.authenticated.push(admission.running.reserved);
      if (token === 'refused') throw new AuthenticationError(401, 'Bearer error="invalid_token"');
      return account;
    },
    ...(prepare
      ? {
          async prepare(actor, action, resource, context) {
            seen.prepared.push(admission.running.normal);
            return { actor: actor.kind, action, resource, deadline: typeof context.deadline };
          },
        }
      : {}),
    async authorize(_client, actor, action, resource, evidence) {
      seen.checks.push([actor.kind, action, resource, evidence ?? null]);
      return action === 'thing:read';
    },
  };
}

function thingApp(dependencies: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ pool, tokens, writeRate, ...dependencies })
    .get(
      '/v1/things/:id',
      { params: t.Object({ id: t.String() }), detail: read },
      async ({ actor, authorize, session }) => {
        const check = await authorize(thing);
        session.record({ partition: 7, epoch: 1, position: 40n });
        return { actor: actor.kind, allowed: await check(pool), seen: session.components.length };
      },
    )
    .post('/v1/things', { detail: create }, async ({ actor, authorize, session }) => {
      const check = await authorize(thing);
      const seen = session.components.map((component) => component.partition);
      session.record({ partition: 9, epoch: 2, position: 3n });
      return { actor: actor.kind, allowed: await check(pool), seen };
    })
    .get('/v1/quiet', { detail: { ...read, operationId: 'thing.quiet' } }, () => ({ ok: true }));
}

const call = (app: ReturnType<typeof thingApp>, method: string, path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://kernel.test${path}`, { method, headers }));

test('the action catalogue comes from the route declarations', () => {
  expect(actionCatalogue(thingApp())).toEqual(
    new Map([
      ['thing:read', { anonymous: true }],
      ['thing:create', { anonymous: false }],
    ]),
  );
  expect(actionCatalogue(createApp({ pool }))).toEqual(new Map());
});

test('a route without a well-formed action, operation id or security is refused', () => {
  const route = (detail: Record<string, unknown>) => new Elysia().get('/v1/x', { detail }, () => 'x');
  expect(() => actionCatalogue(route({}))).toThrow('GET /v1/x: routes declare x-action as <resource>:<verb>');
  expect(() => actionCatalogue(route({ ...read, 'x-action': 'thing.read' }))).toThrow(
    'GET /v1/x: routes declare x-action as <resource>:<verb>',
  );
  expect(() => actionCatalogue(route({ ...read, operationId: 'getThing' }))).toThrow(
    'GET /v1/x: routes declare operationId as <resource>.<verb>',
  );
  expect(() => actionCatalogue(route({ ...read, security: [] }))).toThrow('GET /v1/x: routes declare security');
  const mixed = new Elysia()
    .get('/v1/x', { detail: read }, () => 'x')
    .post('/v1/y', { detail: { ...read, security: [{ bearerAuth: [] }] } }, () => 'y');
  expect(() => actionCatalogue(mixed)).toThrow('POST /v1/y: thing:read is declared with different security');
});

test('a request without credentials is anonymous, and a bearer token is verified on a reserved permit', async () => {
  const seen: Seen = { authenticated: [], checks: [], prepared: [] };
  const admission = new Admission();
  const app = thingApp({ admission, access: recorder(seen, admission) });
  expect(await (await call(app, 'GET', `/v1/things/${thing.id}`)).json()).toMatchObject({ actor: 'anonymous' });
  expect(seen.authenticated).toEqual([]);
  const signed = await call(app, 'GET', `/v1/things/${thing.id}`, { authorization: 'Bearer good' });
  expect(await signed.json()).toMatchObject({ actor: 'account' });
  expect(seen.authenticated).toEqual([1]);
  expect(admission.running).toEqual({ normal: 0, reserved: 0 });
});

test('a refused or malformed credential is a problem document with its challenge', async () => {
  const seen: Seen = { authenticated: [], checks: [], prepared: [] };
  const admission = new Admission();
  const app = thingApp({ admission, access: recorder(seen, admission) });
  const refused = await call(app, 'GET', `/v1/things/${thing.id}`, { authorization: 'Bearer refused' });
  expect(refused.status).toBe(401);
  expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect(await refused.json()).toMatchObject({ code: 'invalid_credentials' });
  const basic = await call(app, 'POST', '/v1/things', { authorization: 'Basic dXNlcjpwYXNz' });
  expect(basic.status).toBe(401);
  expect(await basic.json()).toMatchObject({ code: 'authentication_required', effect_status: 'not_applied' });
  expect(seen.checks).toEqual([]);
});

test("authorize checks the serving route's own action on the resource", async () => {
  const seen: Seen = { authenticated: [], checks: [], prepared: [] };
  const admission = new Admission();
  const app = thingApp({ admission, access: recorder(seen, admission) });
  expect(await (await call(app, 'GET', `/v1/things/${thing.id}`)).json()).toMatchObject({ allowed: true });
  const created = await call(app, 'POST', '/v1/things', { authorization: 'Bearer good' });
  expect(await created.json()).toMatchObject({ actor: 'account', allowed: false });
  expect(seen.checks).toEqual([
    ['anonymous', 'thing:read', thing, null],
    ['account', 'thing:create', thing, null],
  ]);

  const evidence: Seen = { authenticated: [], checks: [], prepared: [] };
  const lanes = new Admission();
  const prepared = thingApp({ admission: lanes, access: recorder(evidence, lanes, true) });
  await call(prepared, 'POST', '/v1/things', { authorization: 'Bearer good' });
  expect(evidence.prepared).toEqual([1]);
  expect(evidence.checks).toEqual([
    [
      'account',
      'thing:create',
      thing,
      { actor: 'account', action: 'thing:create', resource: thing, deadline: 'number' },
    ],
  ]);
});

test('until access is installed, only reads are allowed', async () => {
  const client = {} as never;
  const anonymous = { kind: 'anonymous' } as const;
  expect(await anonymousAccess.authorize(client, anonymous, 'subject:read', thing)).toBe(true);
  expect(await anonymousAccess.authorize(client, anonymous, 'subject:create', thing)).toBe(false);
  expect(await anonymousAccess.authorize(client, account, 'subject:create', thing)).toBe(false);
  expect(await anonymousAccess.authorize(client, anonymous, 'subject.read', thing)).toBe(false);
});

test('the session token is read from the request and merged when a route records a position', async () => {
  const seen: Seen = { authenticated: [], checks: [], prepared: [] };
  const admission = new Admission();
  const app = thingApp({ admission, access: recorder(seen, admission) });
  const first = await call(app, 'GET', `/v1/things/${thing.id}`);
  expect(await first.json()).toMatchObject({ seen: 1 });
  const token = first.headers.get(SESSION_HEADER)!;
  expect(decodeSession(tokens, 'anonymous', token)).toEqual([{ partition: 7, epoch: 1, position: 40n }]);

  const anonymousWrite = await call(app, 'POST', '/v1/things', { [SESSION_HEADER]: token });
  expect(await anonymousWrite.json()).toMatchObject({ seen: [7] });
  expect(decodeSession(tokens, 'anonymous', anonymousWrite.headers.get(SESSION_HEADER)!)).toEqual([
    { partition: 7, epoch: 1, position: 40n },
    { partition: 9, epoch: 2, position: 3n },
  ]);

  const foreign = await call(app, 'POST', '/v1/things', { authorization: 'Bearer good', [SESSION_HEADER]: token });
  expect(await foreign.json()).toMatchObject({ seen: [] });
  const own = encodeSession(tokens, `account:${account.accountId}`, [{ partition: 3, epoch: 1, position: 1n }]);
  const signed = await call(app, 'POST', '/v1/things', { authorization: 'Bearer good', [SESSION_HEADER]: own });
  expect(await signed.json()).toMatchObject({ seen: [3] });
  expect(decodeSession(tokens, `account:${account.accountId}`, signed.headers.get(SESSION_HEADER)!)).toHaveLength(2);

  const garbage = await call(app, 'POST', '/v1/things', { [SESSION_HEADER]: 'not.a-token' });
  expect(await garbage.json()).toMatchObject({ seen: [] });
  const quiet = await call(app, 'GET', '/v1/quiet');
  expect(quiet.status).toBe(200);
  expect(quiet.headers.has(SESSION_HEADER)).toBe(false);
});

test('without configured keys, session tokens are signed with a key of the app', async () => {
  const one = createApp({ pool, writeRate }).get('/v1/write', { detail: create }, ({ session }) => {
    const seen = session.components.length;
    session.record({ partition: 1, epoch: 1, position: 1n });
    return { seen };
  });
  const other = createApp({ pool, writeRate }).get('/v1/write', { detail: create }, ({ session }) => ({
    seen: session.components.length,
  }));
  const token = (await one.handle(new Request('http://kernel.test/v1/write'))).headers.get(SESSION_HEADER)!;
  expect(decodeSession(tokens, 'anonymous', token)).toBeUndefined();
  const again = await one.handle(new Request('http://kernel.test/v1/write', { headers: { [SESSION_HEADER]: token } }));
  expect(await again.json()).toEqual({ seen: 1 });
  const elsewhere = await other.handle(
    new Request('http://kernel.test/v1/write', { headers: { [SESSION_HEADER]: token } }),
  );
  expect(await elsewhere.json()).toEqual({ seen: 0 });
});
