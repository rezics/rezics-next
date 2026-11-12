import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals, LIFECYCLE_ACTIONS, type ProvisioningEvidence } from '../../src/access/lifecycle.ts';
import { accessCheck, AuthenticationError, type AccountActor } from '../../src/request/access.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { delegatedAssignmentFixture } from './delegated-auth-fixture.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = createPool(url);
const receiptKeys = testReceiptKeys();
configureTestReceiptKeys(pool, receiptKeys);
configureTestReceiptKeys(admin, receiptKeys);
let assignments: Awaited<ReturnType<typeof delegatedAssignmentFixture>>;
beforeAll(async () => {
  assignments = await delegatedAssignmentFixture(admin, receiptKeys);
}, 30000);
afterAll(async () => {
  await assignments?.close();
  await pool.end();
  await admin.end();
}, 30000);
const keys = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'native-self-read', alg: 'ES256' };
const issuer = 'https://auth.example.test';
const audience = 'https://api.example.test';
const access = createAccess({
  actions: LIFECYCLE_ACTIONS,
  auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
});
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(79),
  provisioningEvidence: async (proof) => proof as ProvisioningEvidence,
  recoveryEvidence: async () => null,
});
const key = () => Bun.randomUUIDv7();
let sequence = 0;
async function person() {
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  const handle = `self_read_${++sequence}`;
  const reservation = await internal.reserveHandle({ accountId, handle, key: registrationKey });
  await internal.createPending({
    accountId,
    handle,
    reservationId: reservation.value.reservationId,
    key: registrationKey,
  });
  const input = {
    accountId,
    key: key(),
    evidence: { accountId, authIdentityId: accountId, registrationId: reservation.value.reservationId, authnEpoch: 1 },
  };
  const activation = await internal.activate(input);
  return { accountId, input, activation };
}
async function authenticate(
  accountId: string,
  scope = 'account:read',
  requestedBy: string | null = null,
  expired = false,
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    client_id: 'site',
    scope,
    authn_epoch: 1,
    auth_time: now,
    amr: ['pwd'],
    ...(requestedBy ? { requested_by: requestedBy } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'native-self-read', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt(now)
    .setExpirationTime(now + (expired ? -1 : 300))
    .sign(keys.privateKey);
  return access.authenticate(token, { pool, deadline: Date.now() + 3000 });
}
async function prepare(actor: AccountActor, accountId = actor.accountId) {
  return accessCheck(
    access,
    actor,
    'account:read',
    { route: routeOf(accountId)!, id: accountId },
    { pool, deadline: Date.now() + 3000 },
  );
}
async function read(actor: AccountActor, accountId = actor.accountId) {
  const check = await prepare(actor, accountId);
  return (
    await runCommand(pool, { partition: partitionOf(routeOf(accountId)!) }, async (tx, { time }) => ({
      value: await check(tx, time),
      events: [{ type: 'com.rezics.test.checked.v1', data: {} }],
    }))
  ).value;
}
async function grant(resourceId: string, subjectId: string) {
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:read','(,)',$4)`,
    [routeOf(resourceId), resourceId, subjectId, key()],
  );
}
async function revoke(resourceId: string, subjectId: string) {
  await admin.query(
    `DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='account:read'`,
    [routeOf(resourceId), resourceId, subjectId],
  );
}

test('native account activation installs its own account read grant', async () => {
  const f = await person();
  expect(LIFECYCLE_ACTIONS.get('account:read')).toEqual({ anonymous: false });
  const grants = async () =>
    (
      await admin.query(
        `SELECT route, resource_id, subject_kind, subject_id, subject_role, action, valid::text, transaction_id
    FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action='account:read'`,
        [routeOf(f.accountId), f.accountId],
      )
    ).rows;
  expect(await grants()).toEqual([
    {
      route: routeOf(f.accountId),
      resource_id: f.accountId,
      subject_kind: 'identity',
      subject_id: f.accountId,
      subject_role: '',
      action: 'account:read',
      valid: '(,)',
      transaction_id: f.activation.transactionId,
    },
  ]);
  expect(await internal.activate(f.input)).toEqual({ ...f.activation, replayed: true });
  expect(await grants()).toHaveLength(1);
  expect(await read(await authenticate(f.accountId))).toBe(true);
});

test('own account read requires scope and intersects the principal and current denials', async () => {
  const f = await person();
  const principal = await person();
  const actor = await authenticate(f.accountId);
  expect(await read(actor)).toBe(true);
  expect(await read(await authenticate(f.accountId, 'account:update'))).toBe(false);
  await revoke(f.accountId, f.accountId);
  expect(await read(actor)).toBe(false);
  await grant(f.accountId, f.accountId);
  const assignmentId = newId(routeOf(principal.accountId)!);
  await assignments.create({
    principalId: principal.accountId,
    requestId: assignmentId,
    assignedActorId: f.accountId,
    valid: '(,)',
  });
  const delegated = await authenticate(
    f.accountId,
    'account:read',
    `urn:rezics:request:${principal.accountId}:${assignmentId}`,
  );
  // The principal's own native read row is on a different resource anchor.
  expect(await read(delegated)).toBe(false);
  await grant(f.accountId, principal.accountId);
  expect(await read(delegated)).toBe(true);
  await revoke(f.accountId, f.accountId);
  expect(await read(delegated)).toBe(false);
  await grant(f.accountId, f.accountId);
  for (const subject of [f.accountId, principal.accountId]) {
    for (const reason of ['resource', 'suspension', 'realm_ban']) {
      const check = await prepare(delegated);
      await admin.query(
        `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
        VALUES ($1,$2,$3,'account:read',$4,'(,)',$5)`,
        [routeOf(f.accountId), f.accountId, subject, reason, key()],
      );
      const result = await runCommand(
        pool,
        { partition: partitionOf(routeOf(f.accountId)!) },
        async (tx, { time }) => ({
          value: await check(tx, time),
          events: [{ type: 'com.rezics.test.checked.v1', data: {} }],
        }),
      );
      expect(result.value).toBe(false);
      await admin.query(
        `DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND reason=$4`,
        [routeOf(f.accountId), f.accountId, subject, reason],
      );
      expect(await read(delegated)).toBe(true);
    }
  }
});

test('another account grant cannot authorize initiating-account operation status', async () => {
  const f = await person();
  const other = await person();
  const actor = await authenticate(f.accountId);
  // A consumer composes the shared check with its own exact initiator equality.
  const status = async (initiatorAccountId: string) => initiatorAccountId === actor.accountId && (await read(actor));
  expect(await status(f.accountId)).toBe(true);
  await grant(other.accountId, f.accountId);
  expect(await read(actor, other.accountId)).toBe(true);
  expect(await status(other.accountId)).toBe(false);
  await revoke(f.accountId, f.accountId);
  expect(await status(f.accountId)).toBe(false);
  expect(await read(actor, newId(routeOf(f.accountId)!))).toBe(false);
  expect(await read(actor, newId(routeOf(other.accountId)!))).toBe(false);
});

test('native self grants confer no anonymous or organization actor eligibility or expired authentication', async () => {
  const f = await person();
  const check = await accessCheck(
    access,
    { kind: 'anonymous' },
    'account:read',
    { route: routeOf(f.accountId)!, id: f.accountId },
    { pool, deadline: Date.now() + 3000 },
  );
  expect(await check(admin)).toBe(false);
  await expect(authenticate(f.accountId, 'account:read', null, true)).rejects.toBeInstanceOf(AuthenticationError);
  for (const change of ['authn_fenced=true', 'minimum_authn_epoch=2', "state='deleted'"]) {
    const p = await person();
    await admin.query(`UPDATE access.account SET ${change} WHERE route=$1 AND account_id=$2`, [
      routeOf(p.accountId),
      p.accountId,
    ]);
    await expect(authenticate(p.accountId)).rejects.toBeInstanceOf(AuthenticationError);
  }
  const organizationId = newId(0xb312);
  const held = await internal.reserveCoordination({
    accountId: f.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await internal.createOrganization({
    organizationId,
    ownerAccountId: f.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  await expect(authenticate(organizationId)).rejects.toBeInstanceOf(AuthenticationError);
});
