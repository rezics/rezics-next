import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue, IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const issuer = 'https://space-address.auth.test';
const audience = 'https://space-address.api.test';
const routeKey = new Uint8Array(32).fill(91);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
const password = 'space address test password with enough entropy';

type Person = { accountId: string; bearer: string };
type Call = { bearer?: string; body?: unknown; key?: string; headers?: Record<string, string> };

let admin: Pool;
let pool: ReturnType<typeof createPool>;
let authPool: Pool;
let authDatabase = '';
let auth: Awaited<ReturnType<typeof createAuthService>>;
let kernel: ReturnType<typeof createKernel>;
let creator: Person;
let another: Person;
let handleHolder: Person;
let organizationOwner: Person;
let governance: Person;
let suspendedOwner: Person;
let organizationId: string;

async function issue(email: string, scopes: string[]) {
  const signin = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'space-address-test', scope: scopes }),
    }),
  );
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const token = await auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

async function call(method: string, path: string, options: Call = {}) {
  const headers = new Headers(options.headers);
  if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(options.key));
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  return { response, value: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function createSpace(owner: Person) {
  const result = await call('POST', '/v1/spaces', {
    bearer: owner.bearer,
    key: randomUUID(),
    body: { title: 'Address test Space', summary: 'Space address coverage' },
  });
  expect(result.response.status).toBe(201);
  return {
    space: result.value.space as Record<string, unknown>,
    etag: result.response.headers.get('etag')!,
  };
}

async function seedHandle(normalized: string, accountId: string, state: 'active' | 'reserved') {
  const route = createHash('sha256').update(normalized).digest().readUInt16BE(0);
  await admin.query(
    `INSERT INTO access.handle_claim
      (route, normalized_handle, account_id, state, expires_at, reserved_until, transaction_id)
     VALUES ($1,$2,$3,$4,NULL,$5,$3)`,
    [route, normalized, accountId, state, state === 'reserved' ? new Date(Date.now() + 86_400_000) : null],
  );
}

async function claim(spaceId: string, etag: string, owner: Person, address: string) {
  return call('PUT', `/v1/spaces/${spaceId}/address`, {
    bearer: owner.bearer,
    key: randomUUID(),
    headers: { 'if-match': etag },
    body: { address },
  });
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  admin = new Pool({ connectionString: databaseUrl });
  pool = createPool(databaseUrl);
  pool.options.max = 1;
  authDatabase = `space_address_auth_${process.pid}`;
  await admin.query(`CREATE DATABASE ${authDatabase}`);
  const authUrl = new URL(databaseUrl);
  authUrl.pathname = `/${authDatabase}`;
  migrateAuth(authUrl.href);
  authPool = new Pool({ connectionString: authUrl.href });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'space-address',
  };
  const approved = new Set<string>();
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'space-address-auth-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const row = await readAccount(admin, routeOf(id)!, id);
        return (
          row && {
            accountId: row.accountId,
            kind: row.kind,
            state: row.state,
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approved.delete(reference)) throw new Error('Unknown fixture provisioning reference');
        return { accountId: reference };
      },
    }),
  });
  const writeRate = createWriteRateLimiter({
    secret: 'space-address-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({
      anonymous: { write: { maximum: 100_000, seconds: 86_400 } },
      'new-account': { write: { maximum: 100_000, seconds: 86_400 } },
    }),
  });
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    writeRate,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async (url, init) => auth.handler(new Request(url, init)),
        },
      }),
  });
  const scopes = [...actionCatalogue(kernel).keys()].filter((scope) => scope !== 'media:complete');
  await auth.internal.registerClient({ clientId: 'space-address-test', firstParty: true, scopes });
  const people = [
    { name: 'address_creator', accountId: newId(0x3100) },
    { name: 'address_another', accountId: newId(0x3101) },
    { name: 'address_holder', accountId: newId(0x3102) },
    { name: 'address_org_owner', accountId: newId(0x3103) },
    { name: 'address_governance', accountId: newId(0x3104) },
    { name: 'address_suspended', accountId: newId(0x3105) },
  ] as const;
  for (const { name, accountId } of people) {
    approved.add(accountId);
    await admin.query(
      "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'actor','pending',$2)",
      [routeOf(accountId), accountId],
    );
    await auth.internal.provisionPassword({ authorization: accountId, email: `${name}@space-address.test`, password });
    await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(accountId),
      accountId,
    ]);
  }
  creator = { accountId: people[0].accountId, bearer: await issue('address_creator@space-address.test', scopes) };
  another = { accountId: people[1].accountId, bearer: await issue('address_another@space-address.test', scopes) };
  handleHolder = { accountId: people[2].accountId, bearer: await issue('address_holder@space-address.test', scopes) };
  organizationOwner = {
    accountId: people[3].accountId,
    bearer: await issue('address_org_owner@space-address.test', scopes),
  };
  governance = {
    accountId: people[4].accountId,
    bearer: await issue('address_governance@space-address.test', scopes),
  };
  suspendedOwner = {
    accountId: people[5].accountId,
    bearer: await issue('address_suspended@space-address.test', scopes),
  };
  organizationId = newId(0x3200);
  await admin.query(
    "INSERT INTO access.account (route, account_id, kind, state, transaction_id) VALUES ($1,$2,'organization','active',$2)",
    [routeOf(organizationId), organizationId],
  );
  await admin.query(
    `INSERT INTO access.organization_member
      (route, organization_id, member_account_id, role, valid, transaction_id)
     VALUES ($1,$2,$3,'owner','(,)'::tstzrange,$3)`,
    [routeOf(organizationId), organizationId, organizationOwner.accountId],
  );
  for (const person of [creator, another, handleHolder, organizationOwner, suspendedOwner]) {
    await admin.query(
      `INSERT INTO access.resource_grant
        (route, resource_id, subject_id, action, valid, transaction_id)
       VALUES (0,$1,$2,'space:create','(,)'::tstzrange,$2)`,
      [GLOBAL_CONTEXT, person.accountId],
    );
  }
  await bootstrapGovernance(pool, governance.accountId);
}, 60_000);

afterAll(async () => {
  await authPool?.end();
  if (authDatabase) await dropTestDatabase(admin!, authDatabase);
  await pool?.end();
  await admin?.end();
});

test.serial('a Space owner claims, resolves and changes an address while the old address stays reserved', async () => {
  const first = await createSpace(creator);
  const address = `place-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const initial = await claim(String(first.space.spaceId), first.etag, creator, address);
  expect(initial.response.status).toBe(200);
  expect((initial.value.space as Record<string, unknown>).address).toBe(address);
  expect((initial.value.space as Record<string, unknown>).realmId).toBeNull();

  const resolved = await call('GET', `/v1/spaceAddresses/${address}`);
  expect(resolved.response.status).toBe(200);
  expect(resolved.value).toEqual({ spaceId: first.space.spaceId });
  const read = await call('GET', `/v1/spaces/${first.space.spaceId}`);
  expect(read.response.status).toBe(200);
  expect((read.value.space as Record<string, unknown>).address).toBe(address);

  const deniedOwner = await claim(String(first.space.spaceId), initial.response.headers.get('etag')!, another, address);
  expect(deniedOwner.response.status).toBe(403);

  const changedAddress = `new-place-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const changed = await claim(
    String(first.space.spaceId),
    initial.response.headers.get('etag')!,
    creator,
    changedAddress,
  );
  expect(changed.response.status).toBe(200);
  expect((changed.value.space as Record<string, unknown>).address).toBe(changedAddress);
  const current = await call('GET', `/v1/spaceAddresses/${changedAddress}`);
  expect(current.response.status).toBe(200);
  expect(current.value).toEqual({ spaceId: first.space.spaceId });

  const second = await createSpace(another);
  const secondInitialAddress = `other-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const secondClaim = await claim(String(second.space.spaceId), second.etag, another, secondInitialAddress);
  expect(secondClaim.response.status).toBe(200);
  const taken = await claim(String(second.space.spaceId), secondClaim.response.headers.get('etag')!, another, address);
  expect(taken.response.status).toBe(409);
});

test.serial(
  'active and reserved handles block impersonating claims with account and organization-owner exceptions',
  async () => {
    const ownerSpace = await createSpace(creator);
    const otherSpace = await createSpace(another);
    const organizationSpace = await createSpace(organizationOwner);
    await seedHandle('claimed-person', handleHolder.accountId, 'active');
    await seedHandle('claimed-organization', organizationId, 'reserved');
    await seedHandle('creator-own-handle', creator.accountId, 'active');

    const anonymous = await claim(
      String(ownerSpace.space.spaceId),
      ownerSpace.etag,
      { accountId: '', bearer: '' },
      'anonymous-claim',
    );
    expect(anonymous.response.status).toBe(401);
    const impersonation = await claim(String(ownerSpace.space.spaceId), ownerSpace.etag, creator, 'claimed-person');
    expect(impersonation.response.status).toBe(403);
    const reservedImpersonation = await claim(
      String(otherSpace.space.spaceId),
      otherSpace.etag,
      another,
      'claimed-organization',
    );
    expect(reservedImpersonation.response.status).toBe(403);

    const self = await claim(String(ownerSpace.space.spaceId), ownerSpace.etag, creator, 'creator-own-handle');
    expect(self.response.status).toBe(200);
    const organization = await claim(
      String(organizationSpace.space.spaceId),
      organizationSpace.etag,
      organizationOwner,
      'claimed-organization',
    );
    expect(organization.response.status).toBe(200);
  },
);

test.serial('a suspended account cannot claim an address or change its Space', async () => {
  const owned = await createSpace(suspendedOwner);
  const suspended = await call('POST', `/v1/accounts/${suspendedOwner.accountId}:suspend`, {
    bearer: governance.bearer,
    key: randomUUID(),
    body: { reason: 'Space address acceptance test' },
  });
  expect(suspended.response.status).toBe(200);
  expect(suspended.value.suspension).toMatchObject({ accountId: suspendedOwner.accountId, state: 'suspended' });

  const address = `suspended-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rejected = await claim(String(owned.space.spaceId), owned.etag, suspendedOwner, address);
  expect(rejected.response.status).toBe(401);

  const current = await call('GET', `/v1/spaces/${owned.space.spaceId}`);
  expect(current.response.status).toBe(200);
  const currentSpace = current.value.space as Record<string, unknown>;
  expect(currentSpace.address).toBeNull();
  expect(currentSpace.headRevisionId).toBe(owned.space.headRevisionId);

  const resolved = await call('GET', `/v1/spaceAddresses/${address}`);
  expect(resolved.response.status).toBe(404);
  const route = createHash('sha256').update(address).digest().readUInt16BE(0);
  const claims = await admin.query(
    'SELECT 1 FROM community.space_address_claim WHERE route=$1 AND normalized_address=$2',
    [route, address],
  );
  expect(claims.rowCount).toBe(0);
});
