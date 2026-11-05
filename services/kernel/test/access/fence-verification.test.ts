import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { Pool, type QueryConfig } from 'pg';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
import { createAuthService, type AuthService } from '@rezics/auth';
import { readAccount, readPublicAccount } from '../../src/access/account-data.ts';
import accountRead from '../../src/access/account-read.sql';
import { createAccess } from '../../src/access/index.ts';
import { createAccess as permissionAccess } from '../../src/access/permission.ts';
import { createLifecycleInternals, type RecoveryEvidence } from '../../src/access/lifecycle.ts';
import { accessCheck, AuthenticationError, type AccountActor } from '../../src/request/access.ts';
import { delegatedAssignmentFixture } from './delegated-auth-fixture.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const timeout = 60_000;
const pool = new Pool({ connectionString: url, max: 1 });
const authDatabase = `access_fence_auth_${process.pid}`;
const authUrl = new URL(url);
authUrl.pathname = `/${authDatabase}`;
let authPool: Pool;
let service: AuthService;
let assignments: Awaited<ReturnType<typeof delegatedAssignmentFixture>>;
let signingKey: JWK;
let cookie: string;
let token: string;
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const person = '00000000-0000-7000-8000-123400000001';
const principal = '00000000-0000-7000-8000-234500000002';
const organization = '00000000-0000-7000-8000-345600000003';
const requestId = '00000000-0000-7000-8000-234500000004';
const resource = { route: 0x4567, id: '00000000-0000-7000-8000-456700000005' };
const action = 'subject:read';
const actions = new Map([[action, { anonymous: false }]]);
const routeOf = (id: string) => Number.parseInt(id.slice(24, 28), 16);
const queries: QueryConfig[] = [];
let resourceCheckedOut = false;
const counted = Object.create(pool) as Pool;
counted.query = ((query: QueryConfig) => {
  if (resourceCheckedOut) throw new Error('Evidence must precede resource checkout');
  queries.push(query);
  return pool.query(query);
}) as Pool['query'];
// Permission preparation releases each separate anchor's borrowed connection.
// Observe those queries as well as direct pool queries before resource checkout.
counted.connect = (async () => {
  const client = await pool.connect();
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query')
        return (query: QueryConfig) => {
          if (resourceCheckedOut) throw new Error('Evidence must precede resource checkout');
          queries.push(query);
          return target.query(query);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}) as Pool['connect'];
const context = () => ({ pool: counted, deadline: Date.now() + 3000 });
const recovery = new Map<object, RecoveryEvidence>();
const lifecycle = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(41),
  provisioningEvidence: async () => null,
  recoveryEvidence: async (proof) => recovery.get(proof as object) ?? null,
});
const fence = (accountId: string) => lifecycle.raiseFence({ accountId, key: crypto.randomUUID() });
async function restore(receipt: Awaited<ReturnType<typeof fence>>['value']) {
  const proof = {};
  recovery.set(proof, {
    ...receipt,
    authnEpoch: Number(receipt.minimumAuthnEpoch),
    establishmentId: crypto.randomUUID(),
  });
  await lifecycle.clearFence({ accountId: receipt.accountId, key: crypto.randomUUID(), evidence: proof });
}
async function trustedAccount(id: string) {
  const account = await readAccount(counted, routeOf(id), id);
  return account && !account.fenced
    ? {
        accountId: id,
        kind: account.kind,
        state: account.state,
        authnEpoch: Number(account.minimumAuthnEpoch),
        automated: account.operatorAccountId !== null,
      }
    : null;
}
function request(path: string, body: unknown, session = cookie) {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: session },
      body: JSON.stringify(body),
    }),
  );
}
const signin = () =>
  request('/signin', { email: `${person}@example.test`, password, client_id: 'web', scope: [action] }, '');
async function issue() {
  const response = await request('/token', {});
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
function verifier() {
  return createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (url, init) => service.handler(new Request(url, init)),
    },
  });
}
async function invalid(result: Promise<unknown>) {
  const error = await result.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(error).toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
}
async function account(id: string, state = 'active') {
  await pool.query(
    `INSERT INTO access.account (route,account_id,kind,state,display_name,transaction_id)
    VALUES ($1,$2,$3,$4,'Public name',$2)`,
    [routeOf(id), id, id === organization ? 'organization' : 'actor', state],
  );
}
async function grant(id: string, role = '') {
  await pool.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,subject_role,action,valid,transaction_id) VALUES ($1,$2,$3,$4,$5,'(,)',$3)`,
    [resource.route, resource.id, id, role, action],
  );
}
async function membership(accountId: string, organizationId: string) {
  const transactionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO access.membership_inverse
      (route,account_id,kind,group_id,reservation_id,transaction_id)
     VALUES ($1,$2,'organization',$3,$4,$4)`,
    [routeOf(accountId), accountId, organizationId, transactionId],
  );
  await pool.query(
    `INSERT INTO access.organization_member
      (route,organization_id,member_account_id,role,valid,transaction_id)
     VALUES ($1,$2,$3,'owner','(,)',$4)`,
    [routeOf(organizationId), organizationId, accountId, transactionId],
  );
}
async function delegatedToken() {
  // Preserve the actor claims while exercising verification of the command-created assignment.
  const claims = decodeJwt(token);
  return new SignJWT({ ...claims, requested_by: `urn:rezics:request:${principal}:${requestId}` })
    .setProtectedHeader({ alg: 'ES256', kid: signingKey.kid!, typ: 'at+jwt' })
    .sign(await importJWK(signingKey, 'ES256'));
}
async function run(access = verifier(), jwt = token) {
  const ctx = context();
  const actor = await access.authenticate(jwt, ctx);
  const check = await accessCheck(access, actor, action, resource, ctx);
  return check(pool);
}

beforeAll(async () => {
  assignments = await delegatedAssignmentFixture(pool);
  await pool.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'fence-signing-key',
    alg: 'ES256',
  };
  const approvals = new Set([person]);
  service = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'test-only-fence-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid!, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      readAccount: trustedAccount,
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('No provisioning approval');
        return { accountId: reference };
      },
    }),
  });
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: [action] });
  await account(person, 'pending');
  await service.internal.provisionPassword({ authorization: person, email: `${person}@example.test`, password });
}, timeout);

beforeEach(async () => {
  // Reset this isolated fixture without pretending inverse cleanup has a
  // terminal compensation proof. Production DELETE remains guarded.
  await pool.query(`TRUNCATE access.resource_grant, access.resource_denial,
    access.principal_assignment, access.organization_member, access.membership_inverse,
    access.account CASCADE`);
  for (const id of [person, principal, organization]) await account(id);
  await assignments.create({ principalId: principal, requestId, assignedActorId: person, valid: '(,)' });
  await grant(person);
  await grant(principal);
  const response = await signin();
  expect(response.status).toBe(200);
  cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  token = await issue();
  queries.length = 0;
});

afterAll(async () => {
  await assignments?.close();
  await authPool?.end();
  await dropTestDatabase(pool, authDatabase);
  await pool.end();
});

for (const epoch of [2, 3])
  test(`active actor fence denies an unchanged Auth token at epoch ${epoch} with floor 2`, async () => {
    // Privileged fixture: seed a newer established session, then let production
    // Auth issue the token. Neither its claims nor epoch change when the fence rises.
    await authPool.query('UPDATE session SET "authnEpoch"=$1 WHERE "userId"=$2', [epoch, person]);
    const jwt = await issue();
    const claims = decodeJwt(jwt);
    expect(claims.authn_epoch).toBe(epoch);
    const access = verifier();
    expect(await run(access, jwt)).toBe(true);
    const receipt = await fence(person);
    expect(receipt.value.minimumAuthnEpoch).toBe('2');
    await invalid(access.authenticate(jwt, context()));
    expect(decodeJwt(jwt)).toEqual(claims);
    await restore(receipt.value);
    expect(await run(access, jwt)).toBe(true);
  });

test('durable fence survives Auth failure and the ordinary read supplies the trusted port without another query', async () => {
  expect(await run()).toBe(true);
  const receipt = await fence(person);
  await invalid(verifier().authenticate(token, context())); // Independent stale-epoch denial.
  queries.length = 0;
  expect(await trustedAccount(person)).toBeNull();
  expect(queries).toHaveLength(1);
  expect((await request('/token', {})).status).toBe(401);
  expect((await signin()).status).toBe(401);
  expect(await readAccount(pool, routeOf(person), person)).toMatchObject({
    state: 'active',
    minimumAuthnEpoch: 2n,
    fenced: true,
  });
  expect(await lifecycle.readFenceReceipt(person, receipt.value.receiptId)).toEqual(receipt.value);
  await restore(receipt.value);
  expect(await trustedAccount(person)).toMatchObject({ state: 'active', authnEpoch: 2 });
  // An old session must not acquire the new floor during reads or recovery.
  expect((await request('/token', {})).status).toBe(401);
  const fresh = await signin();
  expect(fresh.status).toBe(200);
  cookie = fresh.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(await run(verifier(), await issue())).toBe(true);
});

test('thin permission eligibility rejects a fenced active actor at the floor', async () => {
  const access = permissionAccess({ actions, accountEvidence: (_actor, ctx) => ctx.account });
  const actor: AccountActor = {
    kind: 'account',
    accountId: person,
    clientId: 'web',
    scopes: [action],
    requestedBy: null,
    authnEpoch: 2,
  };
  async function allowed() {
    const ctx = {
      ...context(),
      account: await readAccount(pool, routeOf(person), person),
    };
    const check = await accessCheck(access, actor, action, resource, ctx);
    return check(pool);
  }
  expect(await allowed()).toBe(true);
  const receipt = await fence(person);
  expect(await allowed()).toBe(false);
  await restore(receipt.value);
  expect(await allowed()).toBe(true);
});

test('fenced or missing principal cannot establish requested_by in authentication or permission preparation', async () => {
  const access = verifier();
  const jwt = await delegatedToken();
  const ctx = context();
  const actor = await access.authenticate(jwt, ctx);
  const allowed = async () => (await accessCheck(access, actor, action, resource, ctx))(pool);
  expect(await allowed()).toBe(true);
  const receipt = await fence(principal);
  await invalid(access.authenticate(jwt, context()));
  expect(await allowed()).toBe(false);
  expect(await run(access)).toBe(true); // Actor grant and client scope remain usable.
  await restore(receipt.value);
  expect(await run(access, jwt)).toBe(true);
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(principal), principal]);
  await invalid(access.authenticate(jwt, context()));
  expect(await allowed()).toBe(false);
  await account(principal);
  expect(await run(access, jwt)).toBe(true);
});

test('fenced or missing organization cannot supply a role grant while actor and principal facts remain intact', async () => {
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND subject_id=$2', [resource.route, principal]);
  await grant(organization, 'owner');
  await membership(principal, organization);
  const access = verifier();
  const jwt = await delegatedToken();
  expect(await run(access, jwt)).toBe(true);
  await fence(organization);
  expect(await run(access, jwt)).toBe(false);
  // Human credential recovery cannot clear an organization's fence. Restore
  // the seeded organization directly to isolate its contribution to the ACL.
  await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
    routeOf(organization),
    organization,
  ]);
  expect(await run(access, jwt)).toBe(true);
  await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [
    routeOf(organization),
    organization,
  ]);
  expect(await run(access, jwt)).toBe(false);
  await account(organization);
  expect(await run(access, jwt)).toBe(true);
});

test('one actor anchor reads state floor and fence; separate evidence precedes checkout and public projections stay private', async () => {
  await grant(organization, 'owner');
  await membership(principal, organization);
  const access = verifier();
  const ctx = context();
  const actor = await access.authenticate(await delegatedToken(), ctx);
  expect(Object.isFrozen(actor)).toBe(true);
  const check = await accessCheck(access, actor, action, resource, ctx);
  // The organization anchor also reads access.account; identify the native actor statement exactly.
  const actorReads = queries.filter((q) => q.text === accountRead.sql);
  expect(actorReads).toHaveLength(1);
  expect(actorReads[0]!.values).toEqual([routeOf(person), person]);
  for (const column of ['state', 'minimum_authn_epoch', 'authn_fenced']) expect(actorReads[0]!.text).toContain(column);
  for (const [table, id] of [
    ['principal_assignment', principal],
    ['organization_member', organization],
  ]) {
    const reads = queries.filter((q) => q.text.includes(`access.${table}`));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.values).toContain(routeOf(id!));
      expect(read.values).toContain(id);
      expect(read.text).toContain('authn_fenced');
    }
  }
  expect(queries.some((q) => q.text.includes('lifecycle'))).toBe(false);
  const queryCount = queries.length;
  const client = await pool.connect();
  resourceCheckedOut = true;
  try {
    for (let attempt = 0; attempt < 3; attempt++) expect(await check(client)).toBe(true);
  } finally {
    resourceCheckedOut = false;
    client.release();
  }
  expect(queries).toHaveLength(queryCount);
  await fence(person);
  expect(await readPublicAccount(pool, routeOf(person), person)).toEqual({
    accountId: person,
    kind: 'actor',
    state: 'active',
    handle: null,
    displayName: 'Public name',
    avatarUrl: null,
    biography: null,
    operatorAccountId: null,
  });
  // Isolated privileged fixture exercises the public deleted-row boundary.
  await pool.query("UPDATE access.account SET state='deleted' WHERE route=$1 AND account_id=$2", [
    routeOf(person),
    person,
  ]);
  expect(await readPublicAccount(pool, routeOf(person), person)).toEqual({
    accountId: person,
    kind: 'actor',
    state: 'deleted',
  });
});
