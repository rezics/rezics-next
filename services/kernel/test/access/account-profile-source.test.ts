import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { cookies, issuer, nativeFixture, password } from './native-account-bindings-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const accountManagementClient = 'rezics-auth-account-management';
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let accountId: string;

function pageRequest(headers: Headers) {
  return auth.host.handler(
    new Request(`${issuer}/account-management/rename-page`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
      body: '{}',
    }),
  );
}

async function signIn() {
  return auth.request('/signin', {
    email: 'rename-source@ordinary.test',
    password,
    client_id: accountManagementClient,
    scope: ['account:update'],
  });
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  auth = await nativeFixture(pool);
  const person = await auth.person('rename-source');
  accountId = person.accountId;
  await pool.query('UPDATE access.account SET handle=NULL WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
  ]);
});
afterAll(async () => {
  await auth?.close();
  await pool.end();
});

test('native page composes a handleless profile with the real current rename action and rejects stale proofs', async () => {
  const signed = await signIn();
  expect(signed.status).toBe(200);
  const session = cookies(signed);
  const admitted = await pageRequest(session);
  expect(await admitted.json()).toMatchObject({
    state: 'ready',
    viewer: { accountId, kind: 'actor' },
    profile: { id: accountId, kind: 'actor', handle: null },
    authActions: {
      state: 'ready',
      operations: [
        {
          operationId: 'auth.account.rename',
          action: 'account:update',
          resource: { id: accountId },
        },
      ],
    },
  });
  await pool.query(
    'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2',
    [routeOf(accountId), accountId],
  );
  const stale = await pageRequest(session);
  expect(await stale.json()).toEqual({ state: 'refused' });
});
