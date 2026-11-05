import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { managementOperationProfile } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createAccountManagementReadAccess, readOperatorTransferState } from '../../src/access/management-source.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { cookies, issuer, nativeFixture, password } from './native-account-bindings-fixture.ts';
import { accountManagementReadTransport } from '../../../auth/src/account-management-read-transport.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const key = () => `relation-${randomUUID()}`;
const context = () => ({ pool, deadline: Date.now() + 10000 });
let f: Awaited<ReturnType<typeof nativeFixture>>;
type Person = Awaited<ReturnType<typeof f.person>>;
let source: Person;
let destination: Person;
let stranger: Person;
const emails = new Map<string, string>();
async function person() {
  const name = key();
  const value = await f.person(name);
  emails.set(value.accountId, `${name}@ordinary.test`);
  return value;
}
beforeAll(async () => {
  f = await nativeFixture(pool);
  source = await person();
  destination = await person();
  stranger = await person();
});
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});
async function signIn(person: Person, profile = managementOperationProfile('transfer')) {
  const result = await f.request('/signin', {
    email: emails.get(person.accountId),
    password,
    ...profile,
  });
  expect(result.status).toBe(200);
  return cookies(result);
}
async function post(path: string, body: unknown, headers: Headers) {
  return f.host.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
      body: JSON.stringify(body),
    }),
  );
}
async function result(response: Response) {
  expect(response.status).toBe(200);
  return response.json();
}
const read = (subjectAccountId: string, headers: Headers) =>
  post('/account-management/operators/relation', { subjectAccountId }, headers);
async function state(subjectAccountId: string) {
  const row = (
    await pool.query(
      `SELECT operator_account_id,operator_reservation_id,operator_relation_version::text
    FROM access.account WHERE route=$1 AND account_id=$2`,
      [routeOf(subjectAccountId), subjectAccountId],
    )
  ).rows[0];
  return {
    previous: {
      operatorAccountId: row.operator_account_id,
      subjectAccountId,
      reservationId: row.operator_reservation_id,
    },
    expectedVersion: row.operator_relation_version,
  };
}

test('Read the genuine operator relation for the existing transfer journey preserves exact current native authority target privacy and immutable operation readback', async () => {
  const subject = await f.automated(key(), source);
  const sourceHeaders = await signIn(source);
  const destinationHeaders = await signIn(destination);
  const strangerHeaders = await signIn(stranger);
  const before = await state(subject.accountId);
  const response = await read(subject.accountId, sourceHeaders);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await result(response)).toEqual(before);
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM access.workflow_approval)::text approvals,
    (SELECT count(*) FROM core.receipt)::text receipts`)
    ).rows;
  const unchanged = await counts();
  // A source observation is never an approval or a write receipt.
  expect(await result(await read(subject.accountId, sourceHeaders))).toEqual(before);
  expect(await counts()).toEqual(unchanged);
  for (const target of [subject.accountId, newId(0x4567), source.accountId]) {
    const denied = await read(target, strangerHeaders);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'account_management_read_denied' });
  }
  // The same native identity object matters; a copy is not authority.
  const actor = await f.access.authenticate(source.bearer, context());
  await expect(
    readOperatorTransferState(
      { pool, access: f.access },
      { ...actor },
      { subjectAccountId: subject.accountId },
      context(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  const operationKey = key();
  const operation = { kind: 'transfer', ...before, operatorAccountId: destination.accountId };
  const acceptance = await result(
    await post(
      '/account-operations/approve',
      {
        operationKey,
        operation: {
          kind: 'transfer-acceptance',
          ...before,
          operatorAccountId: destination.accountId,
          sourceOperationKey: operationKey,
        },
      },
      destinationHeaders,
    ),
  );
  const acceptedOperation = { ...operation, acceptance: acceptance.reference };
  const approval = await result(
    await post('/account-operations/approve', { operationKey, operation: acceptedOperation }, sourceHeaders),
  );
  const execution = { operationKey, operation: acceptedOperation, reference: approval.reference };
  expect(await result(await post('/account-operations/execute', execution, sourceHeaders))).toEqual({
    accountId: subject.accountId,
  });
  // Old-manager receipt/approval does not grant current destination disclosure.
  expect((await read(subject.accountId, sourceHeaders)).status).toBe(403);
  const after = await state(subject.accountId);
  expect(after.previous.operatorAccountId).toBe(destination.accountId);
  expect(after.previous.reservationId).not.toBe(before.previous.reservationId);
  expect(BigInt(after.expectedVersion)).toBe(BigInt(before.expectedVersion) + 1n);
  expect(await result(await read(subject.accountId, destinationHeaders))).toEqual(after);
  expect(await result(await post('/account-operations/execute', execution, sourceHeaders))).toEqual({
    accountId: subject.accountId,
  });
  expect(
    await post(
      '/account-operations/execute',
      { ...execution, operation: { ...acceptedOperation, expectedVersion: after.expectedVersion } },
      sourceHeaders,
    ).then((r) => r.status),
  ).toBe(403);
  expect(await state(subject.accountId)).toEqual(after);
}, 120000);

test('the native source revalidates tuple, permission and actor floor after released preparation', async () => {
  const subject = await f.automated(key(), source);
  const actor = await f.access.authenticate(source.bearer, context());
  const readAfter = async (change: () => Promise<unknown>) => {
    const access: Access = {
      ...f.access,
      async prepare(...args) {
        const evidence = await f.access.prepare!(...args);
        await change();
        return evidence;
      },
    };
    return readOperatorTransferState({ pool, access }, actor, { subjectAccountId: subject.accountId }, context());
  };
  // This SQL is fixture corruption, not another transfer path.
  const before = await state(subject.accountId);
  await expect(
    readAfter(() =>
      pool.query(
        `UPDATE access.account SET operator_reservation_id=$3
    WHERE route=$1 AND account_id=$2`,
        [routeOf(subject.accountId), subject.accountId, newId(0x4321)],
      ),
    ),
  ).rejects.toThrow();
  await pool.query(`UPDATE access.account SET operator_reservation_id=$3 WHERE route=$1 AND account_id=$2`, [
    routeOf(subject.accountId),
    subject.accountId,
    before.previous.reservationId,
  ]);
  await expect(
    readAfter(() =>
      pool.query(
        `UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1
    WHERE route=$1 AND account_id=$2`,
        [routeOf(source.accountId), source.accountId],
      ),
    ),
  ).rejects.toMatchObject({ status: 403 });
  // Authenticate again through the real Auth session after native floor advance.
  const signed = await signIn(source);
  const token = await result(await f.request('/token', {}, signed));
  const currentActor: AccountActor = await f.access.authenticate(token.access_token, context());
  await pool.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$2,'account:manage','resource','(,)',$3)`,
    [routeOf(source.accountId), source.accountId, randomUUID()],
  );
  try {
    await expect(
      readOperatorTransferState(
        { pool, access: f.access },
        currentActor,
        { subjectAccountId: subject.accountId },
        context(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await pool.query(
      `DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$2
      AND action='account:manage'`,
      [routeOf(source.accountId), source.accountId],
    );
  }
}, 60000);

test('terminal, fenced and unavailable native source stays distinct from absence', async () => {
  const owner = await person();
  const subject = await f.automated(key(), owner);
  const actor = await f.access.authenticate(owner.bearer, context());
  const input = { subjectAccountId: subject.accountId };
  const readNative = () => readOperatorTransferState({ pool, access: f.access }, actor, input, context());
  const current = await state(subject.accountId);
  await pool.query(
    `UPDATE access.operator_relation_slot SET terminal=true WHERE route=$1 AND subject_account_id=$2 AND reservation_id=$3`,
    [routeOf(subject.accountId), subject.accountId, current.previous.reservationId],
  );
  try {
    await expect(readNative()).rejects.toMatchObject({ reason: 'terminal', status: 403 });
  } finally {
    await pool.query(
      `UPDATE access.operator_relation_slot SET terminal=false WHERE route=$1 AND subject_account_id=$2 AND reservation_id=$3`,
      [routeOf(subject.accountId), subject.accountId, current.previous.reservationId],
    );
  }
  await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(subject.accountId),
    subject.accountId,
  ]);
  try {
    await expect(readNative()).rejects.toMatchObject({ reason: 'fenced' });
  } finally {
    await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
      routeOf(subject.accountId),
      subject.accountId,
    ]);
  }
  const partition = partitionOf(routeOf(subject.accountId)!);
  await pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
  try {
    await expect(readNative()).rejects.toMatchObject({ reason: 'fenced', partition });
  } finally {
    await pool.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [partition]);
  }
  expect(
    await readOperatorTransferState({ pool, access: f.access }, actor, { subjectAccountId: newId(0x4321) }, context()),
  ).toBeNull();
}, 60000);

test('Auth requires the real current fresh human with exact management profile and rechecks its session after native reading', async () => {
  const human = await person();
  const subject = await f.automated(key(), human);
  expect((await read(subject.accountId, new Headers())).status).toBe(401);
  expect((await read(subject.accountId, human.headers)).status).toBe(403);
  const rename = await signIn(human, managementOperationProfile('rename'));
  expect((await read(subject.accountId, rename)).status).toBe(403);
  const signed = await signIn(human);
  const sessions = (await f.authPool.query('SELECT id,"authTime" FROM session WHERE "userId"=$1', [human.accountId]))
    .rows;
  await f.authPool.query('UPDATE session SET "authTime"=$2 WHERE "userId"=$1', [
    human.accountId,
    Math.floor(Date.now() / 1000) - 601,
  ]);
  try {
    const stale = await read(subject.accountId, signed);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'step_up_required' });
  } finally {
    for (const row of sessions)
      await f.authPool.query('UPDATE session SET "authTime"=$2 WHERE id=$1', [row.id, row.authTime]);
  }
  // Preserve the actual native read; revoke the real source session before its
  // result could be disclosed. No successful test adapter fabricates authority.
  const nativeReads = createAccountManagementReadAccess({ pool, access: f.access });
  const handler = accountManagementReadTransport(f.host.service, f.host.handler, {
    ...nativeReads,
    async readOperatorTransferState(...args) {
      const value = await nativeReads.readOperatorTransferState(...args);
      await f.authPool.query('DELETE FROM session WHERE "userId"=$1', [human.accountId]);
      return value;
    },
  });
  const denied = await handler(
    new Request(`${issuer}/account-management/operators/relation`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: signed.get('cookie')! },
      body: JSON.stringify({ subjectAccountId: subject.accountId }),
    }),
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: 'account_management_read_denied' });
}, 60000);
