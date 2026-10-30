import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { Client, Pool } from 'pg';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { createAuthService, type AuthService, type AuthServiceOptions } from '@rezics/auth';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createDelegationCommands, readAssignment } from '../../src/access/delegation-commands.ts';
import { runCommand, IdempotencyConflictError } from '../../src/command/command.ts';
import { accessCheck, accessCommandAuthorization, AuthenticationError } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `delegated_auth_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const reader = new Pool({ connectionString: url, max: 1 });
const issuer = 'https://delegation.auth.test';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const actorId = newId(0x1234);
const principalId = newId(0x2345);
const otherId = newId(0x3456);
const robotId = newId(0x4567);
const resource = { route: 0x6789, id: newId(0x6789) };
const action = 'subject:update';
const actions = [action, 'account:delegate'];
let fixture: Awaited<ReturnType<typeof cloneAuthDatabase>> | undefined;
let database: Pool;
let service: AuthService;
let options: AuthServiceOptions;
let key: Awaited<ReturnType<typeof exportJWK>>;
let access: ReturnType<typeof createAccess>;
let assignments: ReturnType<typeof createDelegationCommands>;
let actorCookie: string;
let principalCookie: string;
let otherCookie: string;
let reference: string;
let outage = false;
let proofReads = 0;
const context = () => ({ pool, deadline: Date.now() + 5000 });

function request(path: string, body?: unknown, cookie = '', target = service) {
  return target.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function login(id: string, clientId = 'web', scope = actions) {
  const response = await request('/signin', { account_id: id, password, client_id: clientId, scope });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function token(cookie: string, requestedBy?: unknown, target = service) {
  const response = await request(
    '/token',
    requestedBy === undefined ? {} : { requested_by: requestedBy },
    cookie,
    target,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function authenticated(cookie: string, requestedBy?: string) {
  const ctx = context();
  return { ...ctx, actor: await access.authenticate(await token(cookie, requestedBy), ctx) };
}
async function grant(id: string, target = resource, permission = action, valid = '(,)') {
  await reader.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,$5::tstzrange,$3)`,
    [target.route, target.id, id, permission, valid],
  );
}
async function ungrant(id: string) {
  await reader.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    resource.route,
    resource.id,
    id,
  ]);
}
async function assignment(valid = '(,)', assignedActorId = actorId) {
  const input = { principalId, assignedActorId, requestId: newId(0x2345), valid, key: Bun.randomUUIDv7() };
  const created = await assignments.create(await authenticated(principalCookie), input);
  return { input, reference: created.value.requestedBy };
}
async function invalid(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(error).toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
}
async function signed(base: string, requestedBy: unknown, extra: Record<string, unknown> = {}) {
  return new SignJWT({ ...decodeJwt<Record<string, unknown>>(base), requested_by: requestedBy, ...extra })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid!, typ: 'at+jwt' })
    .sign(await importJWK(key, 'ES256'));
}
class Denied extends Error {}
async function operation(bearer: string, receiptKey = Bun.randomUUIDv7()) {
  const ctx = context();
  const actor = await access.authenticate(bearer, ctx);
  const authorization = await accessCommandAuthorization(access, actor, action, resource, ctx, () => new Denied());
  const basis = { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy };
  const digest = createHash('sha256')
    .update(canonicalize([resource, basis, 'update'])!)
    .digest();
  return runCommand(
    pool,
    {
      partition: partitionOf(resource.route),
      deadline: ctx.deadline,
      basis,
      authorization,
      receipt: { actorAccountId: actor.accountId, kind: 'test.delegated.update', key: receiptKey, digest },
    },
    async (tx) => {
      await tx.query('UPDATE delegated_operation SET executions=executions+1 WHERE id=1');
      return { value: 'updated', events: [{ type: 'com.rezics.test.updated.v1', data: {} }] };
    },
  );
}

beforeAll(async () => {
  fixture = await cloneAuthDatabase();
  database = new Pool({ connectionString: fixture.url });
  key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'delegation',
    alg: 'ES256',
  };
  const approvals = new Set([actorId, principalId, otherId, robotId]);
  options = {
    database,
    issuer,
    audience,
    secret: 'delegation-test-secret-at-least-thirty-two-characters',
    signing: { activeKid: key.kid!, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await readAccount(reader, routeOf(id)!, id);
        return (
          account && {
            accountId: id,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: account.operatorAccountId !== null,
            fenced: account.fenced,
          }
        );
      },
      async authorizeProvisioning(approval) {
        if (!approvals.delete(approval)) throw new Error('Missing provisioning approval');
        return { accountId: approval };
      },
      ...{
        async readAssignment(requestedBy: string, assignedActorId: string) {
          proofReads++;
          if (outage) throw new Error('Assignment dependency unavailable');
          return readAssignment(reader, requestedBy, assignedActorId);
        },
      },
    }),
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: actions });
  await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes: actions });
  for (const id of [actorId, principalId, otherId, robotId]) {
    await reader.query(
      `INSERT INTO access.account (route,account_id,kind,state,operator_account_id,transaction_id)
      VALUES ($1,$2,'actor','pending',$3,$2)`,
      [routeOf(id), id, id === robotId ? principalId : null],
    );
    await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await reader.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    await grant(id, { route: routeOf(id)!, id }, 'account:delegate');
  }
  access = createAccess({
    actions: new Map(actions.map((name) => [name, { anonymous: false }])),
    auth: {
      issuer,
      audience,
      jwksUrl: service.verifier.jwksUrl,
      fetch: async (url, init) => service.handler(new Request(url, init)),
    },
  });
  assignments = createDelegationCommands({ pool, access, action: 'account:delegate' });
  const firstParty = await login(actorId);
  expect((await request('/consent', { client_id: 'external', scope: actions }, firstParty)).status).toBe(200);
  actorCookie = await login(actorId, 'external');
  principalCookie = await login(principalId);
  otherCookie = await login(otherId);
  reference = (await assignment()).reference;
  await grant(actorId);
  await grant(principalId);
  await reader.query('CREATE TABLE delegated_operation (id integer PRIMARY KEY, executions integer NOT NULL)');
  await reader.query('INSERT INTO delegated_operation VALUES (1,0)');
}, 60000);
afterAll(async () => {
  await database?.end();
  await fixture?.close();
  await pool.end();
  await reader.end();
});

test('Auth issues the canonical assignment while retaining the real actor, consented client, scope and epoch', async () => {
  const direct = decodeJwt(await token(actorCookie));
  const bearer = await token(actorCookie, reference);
  const claims = decodeJwt(bearer);
  expect(claims).toMatchObject({
    sub: actorId,
    client_id: 'external',
    scope: [...actions].sort().join(' '),
    authn_epoch: direct.authn_epoch,
    requested_by: reference,
    aud: audience,
    iss: issuer,
  });
  expect(claims.exp! - claims.iat!).toBe(300);
  expect(claims).not.toHaveProperty('act');
  expect(direct).not.toHaveProperty('requested_by');
  expect(await access.authenticate(bearer, context())).toMatchObject({
    accountId: actorId,
    clientId: 'external',
    requestedBy: reference,
  });
  expect(proofReads).toBeGreaterThan(0);
  const jwks = await (await request('/.well-known/jwks.json')).json();
  expect(jwks).toMatchObject({ keys: [{ kid: key.kid, alg: 'ES256', use: 'sig' }] });
  expect(JSON.stringify(jwks)).not.toContain(key.d!);
});

test('real principal sessions create immutable assignment provenance and a native receipt', async () => {
  const created = await assignment();
  const bearer = await token(actorCookie, created.reference);
  const rows = await reader.query(
    `SELECT creator_principal_id, assigned_actor_id, issued_valid::text, valid::text, revoked_at, transaction_id
    FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3`,
    [routeOf(principalId), principalId, created.input.requestId],
  );
  expect(rows.rows).toHaveLength(1);
  const row = rows.rows[0]!;
  expect(row).toMatchObject({
    creator_principal_id: principalId,
    assigned_actor_id: actorId,
    issued_valid: '(,)',
    valid: '(,)',
    revoked_at: null,
  });
  const receipts = await reader.query(
    `SELECT r.principal_id, r.command_kind, octet_length(r.request_digest) AS digest_length,
    b.client_id, b.requested_by
    FROM core.receipt r JOIN editorial.write_basis b
      ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
    WHERE r.partition_no=$1 AND r.transaction_id=$2`,
    [partitionOf(routeOf(principalId)!), row.transaction_id],
  );
  expect(receipts.rows).toEqual([
    {
      principal_id: principalId,
      command_kind: 'access.assignment.create',
      digest_length: 32,
      client_id: 'web',
      requested_by: null,
    },
  ]);
  for (const [column, value] of [
    ['assigned_actor_id', otherId],
    ['creator_principal_id', otherId],
    ['request_id', newId(0x2345)],
    ['valid', '[2000-01-01,2001-01-01)'],
  ]) {
    await expect(
      reader.query(
        `UPDATE access.principal_assignment SET ${column}=$4 WHERE route=$1 AND principal_id=$2 AND request_id=$3`,
        [routeOf(principalId), principalId, created.input.requestId, value],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
  expect(await readAssignment(reader, created.reference, actorId)).toMatchObject({ kind: 'resolved' });
  expect((await operation(bearer)).value).toBe('updated');
  await assignments.revoke(await authenticated(principalCookie), {
    principalId,
    requestId: created.input.requestId,
    key: Bun.randomUUIDv7(),
  });
  await invalid(operation(bearer));
  expect((await request('/token', { requested_by: created.reference }, actorCookie)).status).toBeGreaterThanOrEqual(
    400,
  );
});

test('real execution requires actor grants, approved scopes and independently current principal grants', async () => {
  const bearer = await token(actorCookie, reference);
  expect((await operation(bearer)).value).toBe('updated');
  const ctx = context();
  const actor = await access.authenticate(bearer, ctx);
  const check = await accessCheck(access, actor, action, resource, ctx);
  expect(await check(pool)).toBe(true);
  await ungrant(principalId);
  try {
    expect(await check(pool)).toBe(false);
    await expect(operation(bearer)).rejects.toBeInstanceOf(Denied);
  } finally {
    await grant(principalId);
  }
  expect((await operation(bearer)).value).toBe('updated');
  await ungrant(actorId);
  try {
    await expect(operation(bearer)).rejects.toBeInstanceOf(Denied);
  } finally {
    await grant(actorId);
  }
  const limited = await token(await login(actorId, 'external', ['account:delegate']), reference);
  await expect(operation(limited)).rejects.toBeInstanceOf(Denied);
  await ungrant(principalId);
  await grant(principalId, resource, action, '[2000-01-01,2001-01-01)');
  try {
    await expect(operation(bearer)).rejects.toBeInstanceOf(Denied);
  } finally {
    await ungrant(principalId);
    await grant(principalId);
  }
  await reader.query(
    `INSERT INTO access.resource_denial (route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'resource','(,)',$3)`,
    [resource.route, resource.id, principalId, action],
  );
  try {
    await expect(operation(bearer)).rejects.toBeInstanceOf(Denied);
  } finally {
    await reader.query('DELETE FROM access.resource_denial WHERE route=$1', [resource.route]);
  }
});

test('issuance refuses missing, malformed, expired, future, wrong-actor and unavailable assignment evidence', async () => {
  const expired = await assignment('[2000-01-01,2001-01-01)');
  const future = await assignment('[2099-01-01,2100-01-01)');
  for (const value of [
    null,
    false,
    {},
    '',
    principalId,
    `${reference}:extra`,
    reference.toUpperCase(),
    `urn:rezics:request:${principalId}:${newId(0x2345)}`,
    expired.reference,
    future.reference,
  ]) {
    expect((await request('/token', { requested_by: value }, actorCookie)).status).toBeGreaterThanOrEqual(400);
  }
  expect((await request('/token', { requested_by: reference }, otherCookie)).status).toBeGreaterThanOrEqual(400);
  outage = true;
  try {
    expect((await request('/token', { requested_by: reference }, actorCookie)).status).toBeGreaterThanOrEqual(400);
  } finally {
    outage = false;
  }
  const { readAssignment: _proof, ...withoutProof } = options.trustedAccess as typeof options.trustedAccess & {
    readAssignment: unknown;
  };
  const unbound = await createAuthService({ ...options, trustedAccess: withoutProof });
  expect((await request('/token', { requested_by: reference }, actorCookie, unbound)).status).toBeGreaterThanOrEqual(
    400,
  );
  for (const extra of [
    { sub: principalId },
    { client_id: 'web' },
    { scope: ['media:complete'] },
    { act: { sub: principalId } },
  ]) {
    expect((await request('/token', { requested_by: reference, ...extra }, actorCookie)).status).toBeGreaterThanOrEqual(
      400,
    );
  }
});

test('actual signed malformed, mismatched and unsupported claims always reject as invalid bearer', async () => {
  const base = await token(actorCookie);
  const mismatch = await assignment('(,)', otherId);
  for (const value of [
    null,
    false,
    [],
    {},
    '',
    principalId,
    `${reference}:extra`,
    reference.toUpperCase(),
    reference.replace(principalId, principalId.replaceAll('-', '0').slice(0, 36)),
    `urn:rezics:request:${principalId}:${newId(0x2345)}`,
    mismatch.reference,
  ]) {
    await invalid(access.authenticate(await signed(base, value), context()));
  }
  await invalid(access.authenticate(await signed(base, reference, { act: { sub: principalId } }), context()));
});

test('unproven bootstrap rows and unavailable proof reads cannot authenticate a present delegation claim', async () => {
  const requestId = newId(0x2345);
  await reader.query(
    `INSERT INTO access.principal_assignment
    (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$4)`,
    [routeOf(principalId), principalId, requestId, actorId],
  );
  const unproven = `urn:rezics:request:${principalId}:${requestId}`;
  expect((await request('/token', { requested_by: unproven }, actorCookie)).status).toBeGreaterThanOrEqual(400);
  await invalid(access.authenticate(await signed(await token(actorCookie), unproven), context()));
  const bearer = await token(actorCookie, reference);
  await reader.query('ALTER TABLE access.principal_assignment RENAME TO unavailable_assignment');
  try {
    await invalid(operation(bearer));
    expect((await request('/token', { requested_by: reference }, actorCookie)).status).toBeGreaterThanOrEqual(400);
  } finally {
    await reader.query('ALTER TABLE access.unavailable_assignment RENAME TO principal_assignment');
  }
});

test('principal changes and assignment revocation invalidate the next request without dropping principal evidence', async () => {
  const current = await assignment();
  const bearer = await token(actorCookie, current.reference);
  expect((await operation(bearer)).value).toBe('updated');
  for (const state of ['pending', 'suspended', 'deleted']) {
    await setFixtureAccountState(reader, principalId, state);
    try {
      await invalid(operation(bearer));
      expect((await request('/token', { requested_by: current.reference }, actorCookie)).status).toBeGreaterThanOrEqual(
        400,
      );
    } finally {
      await setFixtureAccountState(reader, principalId, 'active');
    }
  }
  await reader.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(principalId),
    principalId,
  ]);
  try {
    await invalid(operation(bearer));
    expect((await request('/token', { requested_by: current.reference }, actorCookie)).status).toBeGreaterThanOrEqual(
      400,
    );
  } finally {
    await reader.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
      routeOf(principalId),
      principalId,
    ]);
  }
  await assignments.revoke(await authenticated(principalCookie), {
    principalId,
    requestId: current.input.requestId,
    key: Bun.randomUUIDv7(),
  });
  await invalid(operation(bearer));
  expect((await request('/token', { requested_by: current.reference }, actorCookie)).status).toBeGreaterThanOrEqual(
    400,
  );
  const disappearing = await assignment();
  const missing = await token(actorCookie, disappearing.reference);
  await reader.query('DELETE FROM access.principal_assignment WHERE route=$1 AND request_id=$2', [
    routeOf(principalId),
    disappearing.input.requestId,
  ]);
  await invalid(operation(missing));
  expect((await operation(await token(actorCookie))).value).toBe('updated');
});

test('ordinary human and automated own-credential sessions preserve subject and never inherit operator grants', async () => {
  const human = await access.authenticate(await token(principalCookie), context());
  expect(human).toMatchObject({ accountId: principalId, requestedBy: null });
  const robotCookie = await login(robotId);
  const direct = await token(robotCookie);
  expect(await access.authenticate(direct, context())).toMatchObject({ accountId: robotId, requestedBy: null });
  await expect(operation(direct)).rejects.toBeInstanceOf(Denied);
  const delegated = await token(robotCookie, (await assignment('(,)', robotId)).reference);
  expect(await access.authenticate(delegated, context())).toMatchObject({ accountId: robotId });
  await expect(operation(delegated)).rejects.toBeInstanceOf(Denied);
  await grant(robotId);
  expect((await operation(delegated)).value).toBe('updated');
});

test('client and assignment bind the real command receipt digest', async () => {
  const receiptKey = Bun.randomUUIDv7();
  const bearer = await token(actorCookie, reference);
  const first = await operation(bearer, receiptKey);
  expect(await operation(bearer, receiptKey)).toEqual({ ...first, replayed: true });
  const another = await token(actorCookie, (await assignment()).reference);
  await expect(operation(another, receiptKey)).rejects.toBeInstanceOf(IdempotencyConflictError);
  const otherClient = await token(await login(actorId), reference);
  await expect(operation(otherClient, receiptKey)).rejects.toBeInstanceOf(IdempotencyConflictError);
});
