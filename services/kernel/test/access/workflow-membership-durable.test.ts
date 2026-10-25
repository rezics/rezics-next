import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../../../auth/scripts/database.ts';
import { handleFixture } from './workflow-handle-fixture.ts';
import { routeOf } from '../../src/route/route.ts';

let deployment: ReturnType<typeof testDatabase>;
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
    scope: ['account:update', 'account:delete', 'organization:membership'],
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
  deployment = testDatabase();
  const database = new Pool({ connectionString: deployment.url });
  await database.query('CREATE DATABASE membership_workflow_system');
  await database.end();
  const systemUrl = new URL(deployment.url);
  systemUrl.pathname = '/membership_workflow_system';
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
  deployment?.close();
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
  await fixture.workflows.deleteAccount({ key: 'delete_former_member', authorization: 'member', accountId: member });
  expect(await fixture.read(member)).toMatchObject({ state: 'deleted', fenced: true });
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
