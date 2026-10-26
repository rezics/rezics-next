import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthDatabase } from '../support/auth-database.ts';
import { handleFixture } from './workflow-handle-fixture.ts';
import { routeOf } from '../../src/route/route.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `workflow_members_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}_system" WITH (FORCE)`);
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

let deployment: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let fixture: Awaited<ReturnType<typeof handleFixture>>;
let system: Pool;
const password = randomBytes(24).toString('base64url');
const issuer = 'https://durable-handles.auth.test';
async function person(key: string) {
  return (await fixture.workflows.register({ key, handle: key, email: `${key}@example.test`, password })).accountId;
}
async function token(accountId: string) {
  const post = (path: string, body: unknown, cookie = '') =>
    fixture.auth.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  const signin = await post('/signin', {
    account_id: accountId,
    password,
    client_id: 'durable-web',
    scope: ['account:update', 'account:delete', 'organization:create', 'organization:membership'],
  });
  expect(signin.status).toBe(200);
  const response = await post(
    '/token',
    {},
    signin.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function holds(accountId: string) {
  return (
    await fixture.kernel.query<{ reservation_id: string }>(
      "SELECT reservation_id::text FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND purpose='membership' ORDER BY reservation_id",
      [routeOf(accountId), accountId],
    )
  ).rows.map((r) => r.reservation_id);
}
beforeAll(async () => {
  deployment = await cloneAuthDatabase();
  const database = new Pool({ connectionString: deployment.url });
  const systemName = `${new URL(deployment.url).pathname.slice(1)}_system`;
  await database.query(`CREATE DATABASE "${systemName}"`);
  await database.end();
  const systemUrl = new URL(deployment.url);
  systemUrl.pathname = `/${systemName}`;
  system = new Pool({ connectionString: systemUrl.href });
  const signing = await generateKeyPair('ES256', { extractable: true });
  fixture = await handleFixture({
    kernelUrl: process.env.DATABASE_URL!,
    authUrl: deployment.url,
    systemUrl: systemUrl.href,
    stagingKey: randomBytes(32).toString('hex'),
    secret: randomBytes(48).toString('hex'),
    signing: { ...(await exportJWK(signing.privateKey)), kid: 'membership-signer', alg: 'ES256' },
  });
  await fixture.workflows.start();
}, 60000);
afterAll(async () => {
  await fixture?.close();
  await system?.end();
  await deployment?.close();
});

test('DBOS sequences actual member and organization commands and resumes a lost release acknowledgement once', async () => {
  const owner = await person('membership_owner');
  const member = await person('membership_person');
  fixture.approve('owner', await token(owner));
  const org = (
    await fixture.workflows.createOrganization({
      key: 'membership_org',
      authorization: 'owner',
      handle: 'membership_org',
    })
  ).accountId;
  await fixture.workflows.setMembership({
    key: 'membership_add',
    authorization: 'owner',
    organizationId: org,
    memberAccountId: member,
    role: 'member',
  });
  const [reservationId] = await holds(member);
  expect(reservationId).toBeString();
  expect(
    (
      await fixture.kernel.query(
        'SELECT member_account_id::text FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND member_account_id=$3',
        [routeOf(org), org, member],
      )
    ).rows,
  ).toEqual([{ member_account_id: member }]);
  fixture.failAfter('releaseMembershipCoordination');
  await expect(
    fixture.workflows.setMembership({
      key: 'membership_remove',
      authorization: 'owner',
      organizationId: org,
      memberAccountId: member,
      reservationId: reservationId!,
      role: null,
    }),
  ).rejects.toThrow();
  expect(await holds(member)).toEqual([]);
  const effect = fixture.effects.filter((e) => e.phase === 'releaseMembershipCoordination').at(-1)!;
  expect(effect.replayed).toBe(false);
  await fixture.restart();
  expect(await fixture.workflows.resumeOperation('membership_remove')).toEqual({ accountId: member });
  expect(
    fixture.effects
      .filter((e) => e.phase === 'releaseMembershipCoordination' && e.transactionId === effect.transactionId)
      .map((e) => e.replayed),
  ).toEqual([false, true]);
  const history = (
    await system.query<{ function_name: string }>(
      "SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid IN (SELECT workflow_uuid FROM dbos.workflow_status WHERE name='accounts.operation') ORDER BY workflow_uuid,function_id",
    )
  ).rows.map((r) => r.function_name);
  expect(history).toContain('accounts.change-membership');
  expect(history).toContain('accounts.release-membership');
  fixture.approve('member', await token(member));
  // The member's own deletion removes the standing it relied on: the answer is
  // the workflow's outcome, and the deletion stays committed.
  expect(
    await fixture.workflows.deleteAccount({ key: 'delete_former_member', authorization: 'member', accountId: member }),
  ).toEqual({ accountId: member });
  expect(await fixture.read(member)).toMatchObject({ state: 'deleted', fenced: true });
  expect((await fixture.database.query('SELECT id FROM "user" WHERE id=$1', [member])).rows).toEqual([]);
}, 60000);

test('active hold and last owner cannot be released through the durable workflow', async () => {
  const owner = await person('protected_owner');
  const member = await person('protected_member');
  fixture.approve('protected', await token(owner));
  const org = (
    await fixture.workflows.createOrganization({
      key: 'protected_org',
      authorization: 'protected',
      handle: 'protected_org',
    })
  ).accountId;
  await fixture.workflows.setMembership({
    key: 'protected_add',
    authorization: 'protected',
    organizationId: org,
    memberAccountId: member,
    role: 'member',
  });
  const reservationId = (await holds(member))[0]!;
  await expect(
    fixture.internal.releaseMembershipCoordination({
      organizationId: org,
      memberAccountId: member,
      reservationId,
      key: 'active_release',
    }),
  ).rejects.toThrow();
  const ownerReservation = (await holds(owner))[0]!;
  await expect(
    fixture.workflows.setMembership({
      key: 'last_owner',
      authorization: 'protected',
      organizationId: org,
      memberAccountId: owner,
      reservationId: ownerReservation,
      role: null,
    }),
  ).rejects.toThrow();
  expect(await holds(owner)).toEqual([ownerReservation]);
  expect(await holds(member)).toEqual([reservationId]);
}, 60000);

async function operatorLogin(accountId: string) {
  const signin = await fixture.auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: accountId,
        password,
        client_id: 'durable-web',
        scope: ['account:update', 'account:delete', 'account:manage'],
      }),
    }),
  );
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await fixture.auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(issued.status).toBe(200);
  return { cookie, token: ((await issued.json()) as { access_token: string }).access_token };
}

test('real automated creation and operator session consume native receipts and transfer releases the separately anchored old hold', async () => {
  const owner = await person('workflow_operator');
  const next = await person('workflow_next_operator');
  const login = await operatorLogin(owner);
  fixture.approve('operator', login.token);
  const actor = await fixture.workflows.createAutomated({
    key: 'real_automated',
    authorization: 'operator',
    operatorAccountId: owner,
    handle: 'real_automated',
  });
  expect(await fixture.read(actor.accountId)).toMatchObject({
    kind: 'actor',
    state: 'active',
    operatorAccountId: owner,
  });
  expect(
    (await fixture.database.query('SELECT "userId",password FROM account WHERE "userId"=$1', [actor.accountId])).rows,
  ).toEqual([{ userId: actor.accountId, password: null }]);
  const response = await fixture.workflows.openOperatorSession({
    key: 'real_opening',
    authorization: 'operator',
    operatorAccountId: owner,
    subjectAccountId: actor.accountId,
    headers: new Headers({ cookie: login.cookie, origin: issuer }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ account_id: actor.accountId, amr: ['operator'] });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(
    (
      await fixture.kernel.query(
        'SELECT consumed_at IS NOT NULL AS consumed FROM access.operator_opening_receipt WHERE route=$1 AND operator_account_id=$2 AND subject_account_id=$3',
        [routeOf(owner), owner, actor.accountId],
      )
    ).rows,
  ).toEqual([{ consumed: true }]);
  const relation = (
    await fixture.kernel.query<{ reservation_id: string; version: string }>(
      'SELECT operator_reservation_id::text AS reservation_id,operator_relation_version::text AS version FROM access.account WHERE route=$1 AND account_id=$2',
      [routeOf(actor.accountId), actor.accountId],
    )
  ).rows[0]!;
  const grants = (
    await fixture.kernel.query(
      'SELECT subject_id::text,action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 ORDER BY action,subject_id',
      [routeOf(actor.accountId), actor.accountId],
    )
  ).rows;
  await fixture.workflows.transferOperator({
    key: 'real_transfer',
    authorization: 'operator',
    previous: { operatorAccountId: owner, subjectAccountId: actor.accountId, reservationId: relation.reservation_id },
    expectedVersion: relation.version,
    operatorAccountId: next,
  });
  expect(await fixture.read(actor.accountId)).toMatchObject({ operatorAccountId: next });
  expect(
    (
      await fixture.kernel.query(
        "SELECT reservation_id FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND purpose='operator'",
        [routeOf(owner), owner],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await fixture.kernel.query(
        'SELECT subject_id::text,action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 ORDER BY action,subject_id',
        [routeOf(actor.accountId), actor.accountId],
      )
    ).rows,
  ).toEqual(grants);
  expect(
    (await fixture.auth.handler(new Request(`${issuer}/session`, { headers: { cookie } }))).status,
  ).toBeGreaterThanOrEqual(400);
  await expect(
    fixture.workflows.openOperatorSession({
      key: 'stale_real_opening',
      authorization: 'operator',
      operatorAccountId: owner,
      subjectAccountId: actor.accountId,
      headers: new Headers({ cookie: login.cookie, origin: issuer }),
    }),
  ).rejects.toThrow();
  fixture.approve('next-operator', (await operatorLogin(next)).token);
  const nextLogin = await operatorLogin(next);
  expect(
    (
      await fixture.workflows.openOperatorSession({
        key: 'next_real_opening',
        authorization: 'next-operator',
        operatorAccountId: next,
        subjectAccountId: actor.accountId,
        headers: new Headers({ cookie: nextLogin.cookie, origin: issuer }),
      })
    ).status,
  ).toBe(200);
  let serialized = '';
  for (const { tablename } of (
    await system.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='dbos'")
  ).rows)
    serialized += JSON.stringify(
      (await system.query(`SELECT row_to_json(t) FROM dbos."${tablename.replaceAll('"', '""')}" t`)).rows,
    );
  expect(serialized).not.toContain(login.token);
  expect(serialized).not.toContain(login.cookie);
  expect(serialized).not.toContain(cookie);
}, 60000);

test('successful consent and client reductions invalidate already issued JWTs at the actual kernel account read', async () => {
  const actor = await person('reduction_actor');
  const login = await operatorLogin(actor);
  const post = (path: string, body: unknown, cookie = login.cookie) =>
    fixture.auth.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  await fixture.auth.internal.registerClient({
    clientId: 'reduction-client',
    firstParty: false,
    scopes: ['read', 'write'],
  });
  expect((await post('/consent', { client_id: 'reduction-client', scope: ['read', 'write'] })).status).toBe(200);
  const signin = await post(
    '/signin',
    { account_id: actor, password, client_id: 'reduction-client', scope: ['read', 'write'] },
    '',
  );
  expect(signin.status).toBe(200);
  const tokenResponse = await post(
    '/token',
    {},
    signin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; '),
  );
  const old = ((await tokenResponse.json()) as { access_token: string }).access_token;
  expect((await fixture.authenticate(old)).kind).toBe('account');
  fixture.approve('consent-reduction', login.token);
  // The reduction commits its fence and effect and removes the caller's own
  // standing: the answer is the workflow's outcome, not a refusal.
  expect(
    await fixture.workflows.reduceConsent({
      key: 'native_consent_reduction',
      authorization: 'consent-reduction',
      accountId: actor,
      clientId: 'reduction-client',
      scopes: ['read'],
    }),
  ).toEqual({ accountId: actor });
  await expect(fixture.authenticate(old)).rejects.toThrow();
  expect(
    (
      await fixture.database.query('SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
        actor,
        'reduction-client',
      ])
    ).rows,
  ).toEqual([{ scopes: ['read'] }]);
  const receipt = (
    await fixture.database.query<{ receipt_id: string }>(
      "SELECT receipt_id FROM auth_effect_receipt WHERE account_id=$1 AND purpose='consent-reduction'",
      [actor],
    )
  ).rows[0]!;
  expect(await fixture.internal.readFenceReceipt(actor, receipt.receipt_id)).toMatchObject({
    receiptId: receipt.receipt_id,
  });

  const deleted = await person('deleted_reduction_owner');
  const deletedLogin = await operatorLogin(deleted);
  fixture.approve('delete-reduction-owner', deletedLogin.token);
  expect(
    await fixture.workflows.deleteAccount({
      key: 'delete_reduction_owner',
      authorization: 'delete-reduction-owner',
      accountId: deleted,
    }),
  ).toEqual({ accountId: deleted });
  await expect(fixture.authenticate(deletedLogin.token)).rejects.toThrow();
  const deletedAccount = await fixture.read(deleted);
  expect(deletedAccount).toMatchObject({ state: 'deleted' });
  expect(
    (
      await fixture.database.query('SELECT account_id FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
        deleted,
        'durable-web',
      ])
    ).rows,
  ).toEqual([{ account_id: deleted }]);
  const deletedFences = await fixture.kernel.query(
    'SELECT receipt_id FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2 ORDER BY receipt_id',
    [routeOf(deleted), deleted],
  );

  const administrator = await person('client_reduction_admin');
  const adminLogin = await operatorLogin(administrator);
  fixture.approve('client-reduction', adminLogin.token);
  expect((await fixture.authenticate(adminLogin.token)).kind).toBe('account');
  await fixture.workflows.reduceClientScopes({
    key: 'native_client_reduction',
    authorization: 'client-reduction',
    clientId: 'durable-web',
    firstParty: true,
    scopes: ['account:update'],
  });
  await expect(fixture.authenticate(adminLogin.token)).rejects.toThrow();
  expect(
    (await fixture.database.query('SELECT scopes FROM auth_client WHERE client_id=$1', ['durable-web'])).rows,
  ).toEqual([{ scopes: ['account:update'] }]);
  expect((await fixture.database.query('SELECT client_id FROM auth_client_reduction')).rows).toEqual([]);
  expect(await fixture.read(deleted)).toEqual(deletedAccount);
  expect(
    (
      await fixture.kernel.query(
        'SELECT receipt_id FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2 ORDER BY receipt_id',
        [routeOf(deleted), deleted],
      )
    ).rows,
  ).toEqual(deletedFences.rows);
  expect(
    (
      await fixture.database.query(
        "SELECT receipt_id FROM auth_effect_receipt WHERE account_id=$1 AND purpose='client-reduction'",
        [deleted],
      )
    ).rows,
  ).toEqual([]);
  expect((await fixture.database.query('SELECT id FROM session WHERE "userId"=$1', [deleted])).rows).toEqual([]);
}, 60000);
