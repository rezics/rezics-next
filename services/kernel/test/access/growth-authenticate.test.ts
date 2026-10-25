import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { derivedId, routeOf } from '../../src/route/route.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const namespace = '00000000-0000-8000-8000-000000000001';
const principal = '00000000-0000-8000-8000-000000000002';
const actorId = '00000000-0000-8000-8000-000000000003';
const requestId = '00000000-0000-8000-8000-000000000004';
const principalRoute = routeOf(principal)!;
const actorRoute = routeOf(actorId)!;
const accountPartition = actorRoute >>> 4;
const assignmentPartition = principalRoute >>> 4;
const units = 500;
let db: GrowthDatabase | undefined;
let publicJwk: JWK;
let token: string;
let access: ReturnType<typeof createAccess>;

// This population matches account lifecycle inserts: routed actor rows with active state and default account fields.
const accounts: Population = {
  name: 'authenticate-accounts',
  hotPartition: accountPartition,
  hotShare: 1,
  rows: ({ ordinal, route }) => {
    const accountId = derivedId(namespace, `account-${ordinal}`, route);
    return {
      'access.account': [
        {
          route,
          account_id: accountId,
          kind: 'actor',
          state: 'active',
          content_preferences: {},
          minimum_authn_epoch: 1,
          transaction_id: accountId,
        },
      ],
    };
  },
};

// This population matches delegation-create rows: one active assignment and its principal/request identity per ordinal.
const assignments: Population = {
  name: 'authenticate-assignments',
  hotPartition: assignmentPartition,
  hotShare: 1,
  rows: ({ ordinal, route }) => {
    const id = derivedId(namespace, `request-${ordinal}`, principalRoute);
    return {
      'access.principal_assignment': [
        {
          route: principalRoute,
          principal_id: principal,
          creator_principal_id: principal,
          request_id: id,
          assigned_actor_id: actorId,
          valid: '[2000-01-01 00:00:00+00,infinity)',
          issued_valid: '[2000-01-01 00:00:00+00,infinity)',
          transaction_id: id,
        },
      ],
    };
  },
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  const pair = await generateKeyPair('ES256', { extractable: true });
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'growth-key', alg: 'ES256' };
  const privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'growth-key', alg: 'ES256' };
  access = createAccess({
    actions: new Map(),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      async fetch() {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  token = await new SignJWT({
    client_id: 'web',
    scope: 'subject:read',
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
    requested_by: `urn:rezics:request:${principal}:${requestId}`,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'growth-key', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(actorId)
    .setIssuedAt()
    .setExpirationTime('3m')
    .sign(privateJwk as JWK);
  // Fixed authenticated identities are installed with the same account columns and active state used by lifecycle writes.
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, content_preferences, minimum_authn_epoch, transaction_id)
     VALUES ($1, $2, 'actor', 'active', '{}', 1, $2), ($3, $4, 'actor', 'active', '{}', 1, $4)`,
    [principalRoute, principal, actorRoute, actorId],
  );
  await db.admin.query(
    `INSERT INTO access.principal_assignment
       (route, principal_id, creator_principal_id, request_id, assigned_actor_id, valid, issued_valid, transaction_id)
     VALUES ($1, $2, $2, $3, $4, '[2000-01-01,infinity)', '[2000-01-01,infinity)', $3)`,
    [principalRoute, principal, requestId, actorId],
  );
}, 60_000);

afterAll(async () => {
  await db?.close();
});

test('Bearer verification stays within its bound as A grows', async () => {
  const database = db!;
  const population = { ...accounts };
  const assignmentPopulation = { ...assignments };
  const anchor = placement(population, 0);
  const assignmentAnchor = placement(assignmentPopulation, 0);
  expect(anchor.partition).toBe(accountPartition);
  expect(assignmentAnchor.partition).toBe(assignmentPartition);
  const report = await checkGrowth(database, {
    name: 'Bearer verification stays within its bound as A grows',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
        from: previous * units,
        to: scale * units,
      });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, assignmentPopulation, {
        from: previous * units,
        to: scale * units,
      });
    },
    operation: (growthDb) => access.authenticate(token, { pool: growthDb.pool, deadline: Date.now() + 10_000 }),
    repetitions: 3,
    warmups: 1,
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 90_000);
