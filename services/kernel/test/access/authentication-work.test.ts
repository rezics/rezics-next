import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool, type QueryConfig } from 'pg';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/request/derived-access.ts';
import { authenticationWorkBound } from '../../src/request/authentication-work.ts';
import { PROBLEMS } from '../../src/http/problem.ts';
import {
  AccessWorkUnavailableError,
  AccessWorkAccounting,
  EMPTY_ACCESS_WORK,
  type AccessWork,
  type AccessWorkSink,
} from '../../src/work/access-work.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { actorOf, type Access } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const actorId = newId(0x4a31);
const principalId = newId(0x4a32);
const requestId = newId(0x4a32);
const issuer = 'https://authentication-work.test';
const audience = 'https://api.authentication-work.test';
const actions = new Map([['account:manage', { anonymous: false }]]);
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk: JWK = { ...(await exportJWK(signing.publicKey)), kid: 'work-test', alg: 'ES256', use: 'sig' };
let access: Access;
let derived: Access;
let fetches = 0;
const statements: string[] = [];
const observedPool = Object.create(pool) as Pool;
observedPool.query = (async (query: QueryConfig | string, values?: unknown[]) => {
  statements.push(typeof query === 'string' ? query : query.text);
  return pool.query(query as never, values as never);
}) as Pool['query'];

type Reservation = { operation: string; bound: AccessWork; kind: 'native' | 'owner'; actual?: AccessWork };
function accounting(deadline: number) {
  const reservations: Reservation[] = [];
  const sink: AccessWorkSink = {
    reserve(operation, bound, kind) {
      const entry: Reservation = { operation, bound, kind };
      reservations.push(entry);
      return {
        settle(actual) {
          entry.actual = actual;
        },
      };
    },
  };
  return { work: new AccessWorkAccounting(sink, deadline), reservations };
}

async function token(extra: Record<string, unknown> = {}, tokenAudience = audience, kid = jwk.kid!) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: tokenAudience,
    sub: actorId,
    client_id: 'web',
    scope: 'account:manage',
    authn_epoch: 1,
    iat: issuedAt,
    exp: issuedAt + 300,
    auth_time: issuedAt,
    amr: ['pwd'],
    ...extra,
  })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
    .sign(signing.privateKey);
}

function bearer(value: string) {
  return new Request(audience, { headers: { authorization: `Bearer ${value}` } });
}

beforeAll(async () => {
  for (const id of [actorId, principalId]) {
    await pool.query(
      `INSERT INTO access.account
       (route,account_id,kind,state,transaction_id,membership_inverse_complete)
       VALUES ($1,$2,'actor','active',$2,true)`,
      [routeOf(id), id],
    );
  }
  await pool.query(
    `INSERT INTO access.principal_assignment
     (route,principal_id,request_id,assigned_actor_id,creator_principal_id,valid,issued_valid,transaction_id)
     VALUES ($1,$2,$3,$4,$2,'(,)','(,)',$3)`,
    [routeOf(principalId), principalId, requestId, actorId],
  );
  await pool.query(
    `INSERT INTO access.resource_grant
     (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'account:manage','(,)',$2)`,
    [routeOf(actorId), actorId],
  );
  access = createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      async fetch() {
        fetches++;
        return Response.json({ keys: [jwk] });
      },
    },
  });
  derived = deriveAccess(access, {});
});

afterAll(async () => {
  await pool.query('DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2', [
    routeOf(principalId),
    principalId,
  ]);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [routeOf(actorId), actorId]);
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(actorId), actorId]);
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(principalId), principalId]);
  await pool.end();
});

test('fresh Bearer authentication charges the original verifier and exact native account and assignment reads', async () => {
  const unknownKidToken = await token({}, audience, 'not-published');
  const unknownKidDeadline = Date.now() + 5000;
  const unknownKidAccounting = accounting(unknownKidDeadline);
  await expect(
    actorOf(derived, bearer(unknownKidToken), {
      pool: observedPool,
      deadline: unknownKidDeadline,
      work: unknownKidAccounting.work,
    }),
  ).rejects.toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
  expect(fetches).toBe(2);
  expect(unknownKidAccounting.reservations).toHaveLength(1);
  expect(unknownKidAccounting.reservations[0]).toMatchObject({
    operation: 'access.authenticate',
    actual: unknownKidAccounting.work.usage(),
  });
  expect(unknownKidAccounting.work.usage()).toMatchObject({ points: 3, keys: 2, rows: 2 });
  expect(JSON.stringify(unknownKidAccounting.reservations)).not.toContain(unknownKidToken);

  const directToken = await token();
  const directDeadline = Date.now() + 5000;
  const directAccounting = accounting(directDeadline);
  statements.length = 0;
  const actor = await actorOf(derived, bearer(directToken), {
    pool: observedPool,
    deadline: directDeadline,
    work: directAccounting.work,
  });
  expect(actor).toMatchObject({ kind: 'account', accountId: actorId, requestedBy: null });
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('access.account');
  expect(fetches).toBe(2);
  expect(directAccounting.reservations).toHaveLength(1);
  expect(directAccounting.reservations[0]).toMatchObject({
    operation: 'access.authenticate',
    kind: 'owner',
    bound: authenticationWorkBound(directToken),
    actual: directAccounting.work.usage(),
  });
  for (const axis of Object.keys(EMPTY_ACCESS_WORK) as (keyof AccessWork)[]) {
    expect(Number.isSafeInteger(directAccounting.reservations[0]!.actual![axis])).toBe(true);
    expect(directAccounting.reservations[0]!.actual![axis]).toBeLessThanOrEqual(
      directAccounting.reservations[0]!.bound[axis],
    );
  }
  expect(JSON.stringify(directAccounting.reservations)).not.toContain(directToken);
  expect(JSON.stringify(directAccounting.reservations)).not.toContain(actorId);

  const privateEvidence = await access.prepare!(
    actor,
    'account:manage',
    { route: routeOf(actorId)!, id: actorId },
    {
      pool: observedPool,
      deadline: Date.now() + 5000,
    },
  );
  expect(privateEvidence).not.toBeNull();
  expect(
    await access.prepare!(
      { ...actor },
      'account:manage',
      { route: routeOf(actorId)!, id: actorId },
      {
        pool: observedPool,
        deadline: Date.now() + 5000,
      },
    ),
  ).toBeNull();

  const reference = `urn:rezics:request:${principalId}:${requestId}`;
  const delegatedToken = await token({ requested_by: reference });
  const delegatedDeadline = Date.now() + 5000;
  const delegatedAccounting = accounting(delegatedDeadline);
  statements.length = 0;
  const delegated = await actorOf(derived, bearer(delegatedToken), {
    pool: observedPool,
    deadline: delegatedDeadline,
    work: delegatedAccounting.work,
  });
  expect(delegated).toMatchObject({ kind: 'account', accountId: actorId, requestedBy: reference });
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain('access.account');
  expect(statements[1]).toContain('principal_assignment');
  expect(fetches).toBe(2);
  expect(delegatedAccounting.reservations[0]).toMatchObject({
    operation: 'access.authenticate',
    bound: authenticationWorkBound(delegatedToken),
    actual: delegatedAccounting.work.usage(),
  });
  expect(delegatedAccounting.work.usage().rows).toBe(4);
  expect(JSON.stringify(delegatedAccounting.reservations)).not.toContain(reference);
  expect(JSON.stringify(delegatedAccounting.reservations)).not.toContain(delegatedToken);
});

test('invalid and unresolved delegated Bearers settle their reached reads without exposing identity', async () => {
  const invalidToken = await token({}, 'https://wrong-audience.authentication-work.test');
  const invalidDeadline = Date.now() + 5000;
  const invalidAccounting = accounting(invalidDeadline);
  statements.length = 0;
  await expect(
    actorOf(derived, bearer(invalidToken), {
      pool: observedPool,
      deadline: invalidDeadline,
      work: invalidAccounting.work,
    }),
  ).rejects.toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
  expect(statements).toHaveLength(0);
  expect(invalidAccounting.reservations).toHaveLength(1);
  expect(invalidAccounting.reservations[0]!.actual).toEqual(invalidAccounting.work.usage());

  const absentReference = `urn:rezics:request:${principalId}:${newId(0x4a32)}`;
  const unresolvedToken = await token({ requested_by: absentReference });
  const unresolvedDeadline = Date.now() + 5000;
  const unresolvedAccounting = accounting(unresolvedDeadline);
  statements.length = 0;
  await expect(
    actorOf(derived, bearer(unresolvedToken), {
      pool: observedPool,
      deadline: unresolvedDeadline,
      work: unresolvedAccounting.work,
    }),
  ).rejects.toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
  expect(statements).toHaveLength(2);
  expect(unresolvedAccounting.work.usage().emptySeeks).toBeGreaterThan(0);
  expect(unresolvedAccounting.reservations[0]!.actual).toEqual(unresolvedAccounting.work.usage());
  expect(JSON.stringify(unresolvedAccounting.reservations)).not.toContain(absentReference);
});

test('metered original authentication keeps suspended-account denial after charging its anchored read', async () => {
  const value = await token();
  const deadline = Date.now() + 5000;
  const metered = accounting(deadline);
  statements.length = 0;
  try {
    await pool.query('UPDATE access.account SET state = $3 WHERE route = $1 AND account_id = $2', [
      routeOf(actorId),
      actorId,
      'suspended',
    ]);
    await expect(
      actorOf(derived, bearer(value), { pool: observedPool, deadline, work: metered.work }),
    ).rejects.toMatchObject({ code: 'account_suspended' });
    expect(PROBLEMS.account_suspended.status).toBe(403);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('access.account');
    expect(metered.reservations).toHaveLength(1);
    expect(metered.reservations[0]).toMatchObject({
      operation: 'access.authenticate',
      bound: authenticationWorkBound(value),
      actual: metered.work.usage(),
    });
    expect(metered.work.usage().rows).toBe(2);
    expect(JSON.stringify(metered.reservations)).not.toContain(value);
    expect(JSON.stringify(metered.reservations)).not.toContain(actorId);
  } finally {
    await pool.query('UPDATE access.account SET state = $3 WHERE route = $1 AND account_id = $2', [
      routeOf(actorId),
      actorId,
      'active',
    ]);
  }
});

test('a dispatched account-read failure burns the original finite authentication declaration', async () => {
  const failedPool = Object.create(pool) as Pool;
  failedPool.query = (async (query: QueryConfig | string, values?: unknown[]) => {
    const text = typeof query === 'string' ? query : query.text;
    if (text.includes('FROM access.account')) throw new Error('account read unavailable');
    return pool.query(query as never, values as never);
  }) as Pool['query'];
  const failingAccess = deriveAccess(
    createAccess({
      actions,
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        async fetch() {
          fetches++;
          return Response.json({ keys: [jwk] });
        },
      },
    }),
    {},
  );
  const value = await token();
  const deadline = Date.now() + 5000;
  const metered = accounting(deadline);
  const bound = authenticationWorkBound(value);
  await expect(
    actorOf(failingAccess, bearer(value), { pool: failedPool, deadline, work: metered.work }),
  ).rejects.toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
  expect(metered.reservations).toHaveLength(1);
  expect(metered.reservations[0]).toMatchObject({ operation: 'access.authenticate', bound, actual: bound });
  expect(metered.work.usage()).toEqual(bound);
  expect(JSON.stringify(metered.reservations)).not.toContain(value);
});

test('custom authenticate callbacks remain unavailable when a request supplies accounting', async () => {
  let invoked = false;
  const custom = {
    async authenticate() {
      invoked = true;
      return { kind: 'account', accountId: actorId, clientId: 'web', scopes: [], requestedBy: null, authnEpoch: 1 };
    },
    async authorize() {
      return false;
    },
  } as Access;
  const deadline = Date.now() + 5000;
  const metered = accounting(deadline);
  await expect(actorOf(custom, bearer(await token()), { pool, deadline, work: metered.work })).rejects.toBeInstanceOf(
    AccessWorkUnavailableError,
  );
  expect(invoked).toBe(false);
  expect(metered.reservations).toEqual([]);
});

test('the original producer refuses a caller deadline that differs from its Access frame before dispatch', async () => {
  const value = await token();
  const frameDeadline = Date.now() + 5000;
  const metered = accounting(frameDeadline);
  const fetchCount = fetches;
  await expect(
    actorOf(derived, bearer(value), {
      pool: observedPool,
      deadline: frameDeadline + 1,
      work: metered.work,
    }),
  ).rejects.toBeInstanceOf(AccessWorkUnavailableError);
  expect(fetches).toBe(fetchCount);
  expect(metered.reservations).toEqual([]);
});
