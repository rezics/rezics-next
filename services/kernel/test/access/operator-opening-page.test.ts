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
  const stranger = await person();
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
  expect((await page(subject.accountId, stranger.accountId, headers)).status).toBe(403);
  expect((await page(subject.accountId, human.accountId, await login(stranger))).status).toBe(403);
  expect((await page(human.accountId, human.accountId, headers)).status).toBe(403);
});
