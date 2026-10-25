import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair } from 'jose';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';

// The focused acceptance command also runs from the repository root.
await import('reylo/register');
const { readAccount } = await import('../../src/access/account-data.ts');
const { createKernel } = await import('../../src/http/kernel.ts');
const { cookies, nativeFixture, password, scopes } = await import('./native-account-bindings-fixture.ts');

const url = process.env.DATABASE_URL!;
const pool = createPool(url);
let f: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;
type Person = Awaited<ReturnType<typeof person>>;
let owner: Person;
let member: Person;
let outsider: Person;
let organizationId: string;
let subjectAccountId: string;
const key = () => Bun.randomUUIDv7();

async function person(name: string) {
  const registered = await f.person(`management_${name}`);
  const signed = await f.request('/signin', {
    email: `management_${name}@ordinary.test`,
    password,
    client_id: 'organization-management',
    scope: [...scopes, 'organization:membership'],
  });
  expect(signed.status).toBe(200);
  const headers = cookies(signed);
  const token = await f.request('/token', {}, headers);
  expect(token.status).toBe(200);
  const { access_token: bearer } = (await token.json()) as { access_token: string };
  return { accountId: registered.accountId, bearer, headers };
}
async function context(human: Person) {
  const deadline = Date.now() + 10000;
  const actor = await f.access.authenticate(human.bearer, { pool, deadline });
  return { actor, account: await readAccount(pool, routeOf(actor.accountId)!, actor.accountId), deadline };
}
async function membership(human: Person, role: 'owner' | 'member') {
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: human.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: human.accountId,
    reservationId: held.value.reservationId,
    role,
    key: key(),
  });
}
const grantInput = (human: Person, actions = ['account:manage']) => ({
  resource: { route: routeOf(organizationId)!, id: organizationId },
  subject: { kind: 'account', id: human.accountId },
  actions,
  valid: '(,)',
});
async function grant(human: Person, recipient: Person, path = '/v1/grants', actions = ['account:manage']) {
  return kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${human.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      body: JSON.stringify(grantInput(recipient, actions)),
    }),
  );
}
async function opening(human: Person) {
  return f.bindings.workflowPorts.authorizeOpening!(await context(human), {
    operatorAccountId: organizationId,
    subjectAccountId,
    purpose: 'session',
    key: key(),
  });
}
async function consume(human: Person, authorization: string) {
  return f.host.service.internal.openAutomatedSession({ authorization, subjectAccountId, headers: human.headers });
}
async function manages(human: Person) {
  const approved = await opening(human);
  const response = await consume(human, approved.value.receiptId);
  expect(response.status).toBe(200);
  const token = await f.request('/token', {}, cookies(response));
  expect(token.status).toBe(200);
  const { access_token } = (await token.json()) as { access_token: string };
  const actor = await f.access.authenticate(access_token, { pool, deadline: Date.now() + 10000 });
  expect(actor.accountId).toBe(subjectAccountId);
}

beforeAll(async () => {
  // Use only the caller's isolated test database; no shared-container cleanup.
  migrateAuth(url);
  const pair = await generateKeyPair('ES256', { extractable: true });
  f = await nativeFixture(pool, undefined, {
    database: { url, container: '', close() {} },
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'organization-management' },
  });
  await f.host.service.internal.registerClient({
    clientId: 'organization-management',
    firstParty: true,
    scopes: [...scopes, 'organization:membership'],
  });
  kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(91),
    tokens: f.referenceKeys,
    access: () => f.access,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  owner = await person('owner');
  member = await person('member');
  outsider = await person('outsider');
  organizationId = newId(0x9200);
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: owner.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  await membership(member, 'member');
  const subject = await f.automated('management_automation', { accountId: organizationId, bearer: owner.bearer });
  subjectAccountId = subject.accountId;
}, 60000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

test("a new organization's owners hold account manage and access grant on the organization resource", async () => {
  const grants = await pool.query(
    `SELECT action FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND subject_role='owner' ORDER BY action`,
    [routeOf(organizationId), organizationId],
  );
  expect(grants.rows.map((row) => row.action)).toEqual([
    'access:grant',
    'account:delete',
    'account:manage',
    'account:update',
    'organization:membership',
  ]);
  await manages(owner);
  const nextOwner = await person('next_owner');
  await membership(nextOwner, 'owner');
  await manages(nextOwner);
  expect((await grant(nextOwner, owner)).status).toBe(201);
});

test('an owner grants a member account manage through the ordinary grant routes and the member can then manage organization-operated automation', async () => {
  await expect(opening(member)).rejects.toThrow();
  expect((await grant(owner, member)).status).toBe(201);
  await manages(member);
});

test('an owner revokes it and the member is denied from T', async () => {
  const approved = await opening(member);
  const revoked = await grant(owner, member, '/v1/grants:revoke');
  expect(revoked.status).toBe(200);
  // Even the opening approved before the committed revocation loses authority.
  await expect(consume(member, approved.value.receiptId)).rejects.toThrow();
  await expect(opening(member)).rejects.toThrow();
});

test('a member without access grant cannot grant management', async () => {
  expect((await grant(owner, member)).status).toBe(201);
  await manages(member);
  expect((await grant(member, outsider)).status).toBe(403);
  expect((await grant(member, member, '/v1/grants', ['access:grant'])).status).toBe(403);
  // Grant administration also checks the grantor's ceiling for the granted action.
  expect((await grant(owner, member, '/v1/grants', ['subject:create'])).status).toBe(403);
});

test("a non-member holding a grant still cannot manage the organization's automation", async () => {
  expect((await grant(owner, outsider)).status).toBe(201);
  await expect(opening(outsider)).rejects.toThrow();
  const pair = await generateKeyPair('ES256', { extractable: true });
  const kid = key();
  const stage = await f.host.service.internal.stageCredentialEffect({
    key: key(),
    subjectAccountId,
    headers: outsider.headers,
    credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
  });
  await expect(
    f.host.service.internal.approveCredentialEffect({
      ...stage,
      subjectAccountId,
      headers: outsider.headers,
    }),
  ).rejects.toThrow();
  expect(
    (await f.authPool.query('SELECT kid FROM auth_public_key WHERE account_id=$1', [subjectAccountId])).rows,
  ).toEqual([]);
});
