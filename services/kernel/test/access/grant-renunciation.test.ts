import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { accessCheck } from '../../src/request/access.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { cookies, nativeFixture, password, scopes } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
const routeKey = new Uint8Array(32).fill(94);
const key = () => Bun.randomUUIDv7();
let fixture: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: ReturnType<typeof createKernel>;
let root: { accountId: string; bearer: string };
let member: { accountId: string; bearer: string };
let organizationId: string;

async function person(name: string) {
  return fixture.person(`renunciation_${name}`);
}

async function bearer(name: string, clientId: string, requestedScopes: readonly string[]) {
  const signed = await fixture.request('/signin', {
    email: `renunciation_${name}@ordinary.test`,
    password,
    client_id: clientId,
    scope: requestedScopes,
  });
  expect(signed.status).toBe(200);
  const token = await fixture.request('/token', {}, cookies(signed));
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

async function call(token: string, path: string, body: unknown) {
  return kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      body: JSON.stringify(body),
    }),
  );
}

function grantBody(
  subject:
    | { kind: 'account'; id: string }
    | { kind: 'organization'; id: string; role: 'owner' | 'member' }
    | { kind: 'active_accounts' },
  actions = ['subject:create'],
) {
  return { resource: PLATFORM_RESOURCE, subject, actions, valid: '(,)' };
}

async function permit(token: string, action: string) {
  const context = { pool, deadline: Date.now() + 10000 };
  const actor = await fixture.access.authenticate(token, context);
  const check = await accessCheck(fixture.access, actor, action, PLATFORM_RESOURCE, context);
  return check(pool);
}

async function grantRows() {
  return (
    await pool.query(
      `SELECT subject_kind,subject_id,subject_role,action,valid::text
       FROM access.resource_grant WHERE route=0 AND resource_id=$1
       ORDER BY subject_kind,subject_id,subject_role,action,valid`,
      [PLATFORM_RESOURCE.id],
    )
  ).rows;
}

async function effects() {
  return (
    await pool.query(
      `SELECT
         (SELECT count(*)::int FROM core.receipt WHERE partition_no=0) AS receipts,
         (SELECT count(*)::int FROM core.outbox WHERE partition_no=0) AS events,
         (SELECT count(*)::int FROM access.resource_grant WHERE route=0 AND resource_id=$1) AS grants`,
      [PLATFORM_RESOURCE.id],
    )
  ).rows[0];
}

async function context(token: string) {
  const deadline = Date.now() + 10000;
  const actor = await fixture.access.authenticate(token, { pool, deadline });
  return {
    actor,
    account: await readAccount(pool, routeOf(actor.accountId)!, actor.accountId),
    deadline,
  };
}

beforeAll(async () => {
  fixture = await nativeFixture(pool);
  await fixture.host.service.internal.registerClient({
    clientId: 'grant-renunciation-organization',
    firstParty: true,
    scopes: [...scopes, 'organization:membership'],
  });
  kernel = createKernel({
    pool,
    routeKey,
    tokens: fixture.referenceKeys,
    access: () => fixture.access,
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  root = await person('root');
  await bootstrapGovernance(pool, root.accountId);
  member = await person('member');

  const rootWithMembership = {
    ...root,
    bearer: await bearer('root', 'grant-renunciation-organization', [...scopes, 'organization:membership']),
  };
  organizationId = newId(0x9a10);
  const held = await fixture.bindings.internalLifecycle.reserveCoordination({
    accountId: root.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await fixture.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: root.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  const memberHold = await fixture.bindings.internalLifecycle.reserveCoordination({
    accountId: member.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await fixture.bindings.lifecycle.setMembership(await context(rootWithMembership.bearer), {
    organizationId,
    memberAccountId: member.accountId,
    reservationId: memberHold.value.reservationId,
    role: 'member',
    key: key(),
  });
}, 60000);

afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    await pool.end();
  }
});

test('an account can renounce its own direct grant in either request representation and loses it at T', async () => {
  for (const legacy of [false, true]) {
    const actor = await person(legacy ? 'legacy_direct' : 'direct');
    expect((await call(root.bearer, '/v1/grants', grantBody({ kind: 'account', id: actor.accountId }))).status).toBe(
      201,
    );
    expect(await permit(actor.bearer, 'access:grant')).toBe(false);
    expect(await permit(actor.bearer, 'subject:create')).toBe(true);

    const body = legacy
      ? {
          resource: PLATFORM_RESOURCE,
          subjectId: actor.accountId,
          subjectRole: '',
          actions: ['subject:create'],
          valid: '(,)',
        }
      : grantBody({ kind: 'account', id: actor.accountId });
    const before = await effects();
    const revoked = await call(actor.bearer, '/v1/grants:revoke', body);
    expect(revoked.status).toBe(200);
    expect(await effects()).toEqual({
      receipts: before.receipts + 1,
      events: before.events + 1,
      grants: before.grants - 1,
    });
    expect(await permit(actor.bearer, 'subject:create')).toBe(false);
  }
});

test('renunciation requires the acting client to have consented to every revoked action', async () => {
  const actor = await person('narrow_scope');
  for (const action of ['subject:create', 'access:grant'])
    expect(
      (await call(root.bearer, '/v1/grants', grantBody({ kind: 'account', id: actor.accountId }, [action]))).status,
    ).toBe(201);
  const narrow = await bearer('narrow_scope', 'grant-renunciation-organization', ['access:grant']);
  const before = { rows: await grantRows(), effects: await effects() };
  const response = await call(narrow, '/v1/grants:revoke', grantBody({ kind: 'account', id: actor.accountId }));
  expect(response.status).toBe(403);
  expect(await grantRows()).toEqual(before.rows);
  expect(await effects()).toEqual(before.effects);
});

test('renunciation cannot create, change or revoke another account grant', async () => {
  const actor = await person('no_management');
  const other = await person('other_subject');
  expect((await call(root.bearer, '/v1/grants', grantBody({ kind: 'account', id: actor.accountId }))).status).toBe(201);
  expect((await call(root.bearer, '/v1/grants', grantBody({ kind: 'account', id: other.accountId }))).status).toBe(201);
  const before = { rows: await grantRows(), effects: await effects() };
  const attempts = [
    {
      path: '/v1/grants',
      body: {
        ...grantBody({ kind: 'account', id: actor.accountId }),
        valid: '[2030-01-01,2031-01-01)',
      },
    },
    {
      path: '/v1/grants:change',
      body: {
        ...grantBody({ kind: 'account', id: actor.accountId }),
        valid: '[2030-01-01,2031-01-01)',
        previous: { actions: ['subject:create'], valid: '(,)' },
      },
    },
    { path: '/v1/grants:revoke', body: grantBody({ kind: 'account', id: other.accountId }) },
  ];
  for (const attempt of attempts) expect((await call(actor.bearer, attempt.path, attempt.body)).status).toBe(403);
  expect(await grantRows()).toEqual(before.rows);
  expect(await effects()).toEqual(before.effects);
});

test('an organization member cannot renounce organization-role or active-accounts grants', async () => {
  const roleGrant = grantBody({ kind: 'organization', id: organizationId, role: 'member' });
  const activeGrant = grantBody({ kind: 'active_accounts' });
  expect((await call(root.bearer, '/v1/grants', roleGrant)).status).toBe(201);
  expect((await call(root.bearer, '/v1/grants', activeGrant)).status).toBe(201);
  expect(await permit(member.bearer, 'subject:create')).toBe(true);
  const before = { rows: await grantRows(), effects: await effects() };
  for (const body of [roleGrant, activeGrant]) {
    expect((await call(member.bearer, '/v1/grants:revoke', body)).status).toBe(403);
  }
  expect(await grantRows()).toEqual(before.rows);
  expect(await effects()).toEqual(before.effects);
});
