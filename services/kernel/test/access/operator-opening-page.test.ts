import { beforeAll, afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { managementOperationProfile } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { cookies, issuer, nativeFixture, password } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture(pool);
});
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});
const key = () => `opening-page-${randomUUID()}`;
async function person() {
  const name = key();
  return { ...(await f.person(name)), email: `${name}@ordinary.test` };
}
async function login(human: Awaited<ReturnType<typeof person>>) {
  const response = await f.request('/signin', {
    email: human.email,
    password,
    ...managementOperationProfile('opening'),
  });
  expect(response.status).toBe(200);
  return cookies(response);
}
async function page(subjectAccountId: string, operatorAccountId: string, headers: Headers) {
  return f.host.handler(
    new Request(`${issuer}/account-management/operators/opening-page`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
      body: JSON.stringify({ subjectAccountId, operatorAccountId }),
    }),
  );
}
test('the installed host observes exact native management without creating approval or credential effects', async () => {
  const human = await person();
  const subject = await f.automated(key(), human);
  const headers = await login(human);
  const counts = async () =>
    (
      await pool.query(`SELECT
    (SELECT count(*) FROM access.workflow_approval)::text approvals,
    (SELECT count(*) FROM core.receipt)::text receipts`)
    ).rows;
  const before = await counts();
  const response = await page(subject.accountId, human.accountId, headers);
  expect(response.status).toBe(200);
  const observed = await response.json();
  expect(observed).toMatchObject({
    stage: 'current',
    viewer: { accountId: human.accountId },
    subject: { id: subject.accountId, kind: 'actor' },
    operator: { id: human.accountId, kind: 'actor' },
    disclosure: 'unavailable',
    allowedActions: ['opening'],
  });
  expect(observed.relation.reservationId).toBeString();
  expect(Object.keys(observed.subject).sort()).toEqual(['id', 'kind']);
  expect(await counts()).toEqual(before);
});

test('changed operators, missing reservations and replaced viewers cannot open an obsolete page', async () => {
  const human = await person();
  const stranger = await person();
  const subject = await f.automated(key(), human);
  const headers = await login(human);
  const changedOperator = await page(subject.accountId, stranger.accountId, headers);
  expect(changedOperator.status).toBe(403);
  expect(await changedOperator.json()).toEqual({ stage: 'refused' });
  const missingReservation = await page(human.accountId, human.accountId, headers);
  expect(missingReservation.status).toBe(403);
  expect(await missingReservation.json()).toEqual({ stage: 'refused' });
  expect((await page(subject.accountId, human.accountId, await login(stranger))).status).toBe(403);
});

test('opening advice requires fresh authentication from the same human', async () => {
  const human = await person();
  const subject = await f.automated(key(), human);
  const headers = await login(human);
  await f.authPool.query('UPDATE session SET "authTime"=$1 WHERE "userId"=$2', [
    Math.floor(Date.now() / 1000) - 601,
    human.accountId,
  ]);

  const response = await page(subject.accountId, human.accountId, headers);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ stage: 'step-up' });
});
