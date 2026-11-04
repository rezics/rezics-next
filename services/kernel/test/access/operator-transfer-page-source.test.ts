import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { managementOperationProfile } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import { cookies, issuer, nativeFixture, password } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const key = () => `transfer-page-${randomUUID()}`;
let f: Awaited<ReturnType<typeof nativeFixture>>;
type Person = Awaited<ReturnType<typeof f.person>>;
let source: Person;
let destination: Person;
let stranger: Person;
const email = new Map<string, string>();

async function person() {
  const name = key();
  const value = await f.person(name);
  email.set(value.accountId, `${name}@ordinary.test`);
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
  const result = await f.request('/signin', { email: email.get(person.accountId), password, ...profile });
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
async function state(subjectAccountId: string) {
  const row = (
    await pool.query(
      `SELECT operator_account_id,operator_reservation_id,operator_relation_version::text
      FROM access.account WHERE route=$1 AND account_id=$2`,
      [routeOf(subjectAccountId), subjectAccountId],
    )
  ).rows[0]!;
  return {
    previous: {
      operatorAccountId: row.operator_account_id as string,
      subjectAccountId,
      reservationId: row.operator_reservation_id as string,
    },
    expectedVersion: row.operator_relation_version as string,
  };
}
const path = '/account-management/operators/transfer-review';

test('the production Auth host and Access binding separate source and destination admission without writes', async () => {
  const subject = await f.automated(key(), source);
  const sourceCookie = await signIn(source);
  const destinationCookie = await signIn(destination);
  const strangerCookie = await signIn(stranger);
  const before = await state(subject.accountId);
  const request = {
    version: 1,
    ...before,
    operatorAccountId: destination.accountId,
    sourceOperationKey: key(),
  };
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM access.workflow_approval)::text approvals,
      (SELECT count(*) FROM core.receipt)::text receipts`)
    ).rows;
  const unchanged = await counts();

  const sourcePage = await post(path, { kind: 'source', subjectAccountId: subject.accountId }, sourceCookie);
  expect(sourcePage.status).toBe(200);
  expect(await sourcePage.json()).toEqual({
    viewer: { kind: 'ready' },
    review: { kind: 'source', relation: before, action: 'allowed' },
  });

  // The destination cannot use the old source-private read, but its own target admission is independent.
  expect(
    (await post('/account-management/operators/relation', { subjectAccountId: subject.accountId }, destinationCookie))
      .status,
  ).toBe(403);
  const destinationPage = await post(path, { kind: 'destination', request }, destinationCookie);
  expect(await destinationPage.json()).toEqual({
    viewer: { kind: 'ready' },
    review: { kind: 'destination', destinationAccountId: destination.accountId, action: 'allowed' },
  });
  const refusedSource = await post(path, { kind: 'source', subjectAccountId: subject.accountId }, strangerCookie);
  expect(await refusedSource.json()).toMatchObject({ viewer: { kind: 'ready' }, review: { kind: 'refused' } });
  const refusedDestination = await post(path, { kind: 'destination', request }, strangerCookie);
  expect(await refusedDestination.json()).toMatchObject({
    viewer: { kind: 'ready' },
    review: { kind: 'destination', destinationAccountId: destination.accountId, action: 'denied' },
  });

  const ordinary = await signIn(stranger, { client_id: 'login', scope: [] });
  const readiness = await post(path, { kind: 'readiness' }, ordinary);
  expect(await readiness.json()).toEqual({
    viewer: { kind: 'authentication-required', continuation: 'operator-transfer' },
    review: { kind: 'readiness' },
  });
  const privateAttempt = await post(path, { kind: 'source', subjectAccountId: subject.accountId }, ordinary);
  const safe = await privateAttempt.json();
  expect(safe).toMatchObject({ viewer: { kind: 'authentication-required' } });
  expect(JSON.stringify(safe)).not.toContain('reservationId');
  expect(await counts()).toEqual(unchanged);
}, 120000);

test('the native page rereads source and actor observations after preparation and keeps failures distinct', async () => {
  const subject = await f.automated(key(), source);
  const sourceCookie = await signIn(source);
  const destinationCookie = await signIn(destination);
  const before = await state(subject.accountId);
  const request = {
    kind: 'destination',
    request: { version: 1, ...before, operatorAccountId: destination.accountId, sourceOperationKey: key() },
  };
  const access = f.access as Access;
  const original = access.prepare!;
  let changed = false;
  access.prepare = async (...args) => {
    const evidence = await original(...args);
    if (!changed) {
      changed = true;
      await pool.query(
        'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2',
        [routeOf(destination.accountId), destination.accountId],
      );
    }
    return evidence;
  };
  try {
    const response = await post(path, request, destinationCookie);
    expect(await response.json()).toMatchObject({ viewer: { kind: 'ready' }, review: { kind: 'changed' } });
  } finally {
    access.prepare = original;
    await pool.query(
      'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch-1 WHERE route=$1 AND account_id=$2',
      [routeOf(destination.accountId), destination.accountId],
    );
  }

  const originalReservation = before.previous.reservationId;
  let changedRelation = false;
  access.prepare = async (...args) => {
    const evidence = await original(...args);
    if (!changedRelation) {
      changedRelation = true;
      await pool.query('UPDATE access.account SET operator_reservation_id=$3 WHERE route=$1 AND account_id=$2', [
        routeOf(subject.accountId),
        subject.accountId,
        randomUUID(),
      ]);
    }
    return evidence;
  };
  try {
    const response = await post(path, { kind: 'source', subjectAccountId: subject.accountId }, sourceCookie);
    expect(await response.json()).toMatchObject({ viewer: { kind: 'ready' }, review: { kind: 'changed' } });
  } finally {
    access.prepare = original;
    await pool.query('UPDATE access.account SET operator_reservation_id=$3 WHERE route=$1 AND account_id=$2', [
      routeOf(subject.accountId),
      subject.accountId,
      originalReservation,
    ]);
  }

  access.prepare = async () => {
    throw new Error('test dependency unavailable');
  };
  try {
    const response = await post(path, request, destinationCookie);
    expect(await response.json()).toMatchObject({ viewer: { kind: 'ready' }, review: { kind: 'unavailable' } });
  } finally {
    access.prepare = original;
  }
}, 120000);
