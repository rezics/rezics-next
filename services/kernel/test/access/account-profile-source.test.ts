import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { AuthBindingDeniedError } from '../../src/access/auth-bindings.ts';
import type { RenameAccountPageAccess } from '../../src/access/account-profile-source.ts';
import { cookies, nativeFixture, password } from './native-account-bindings-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const accountManagementClient = 'rezics-auth-account-management';
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let accountId: string;
let human: Awaited<ReturnType<typeof proof>>;

async function proof() {
  const signed = await auth.request('/signin', {
    email: 'rename-source@ordinary.test',
    password,
    client_id: accountManagementClient,
    scope: ['account:update'],
  });
  expect(signed.status).toBe(200);
  return auth.host.service.internal.withFreshHuman(
    { headers: cookies(signed), fresh: false },
    async (current) => current,
  );
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
  human = await proof();
});
afterAll(async () => {
  await auth?.close();
  await pool.end();
});

test('native page composes a handleless profile with the real current rename action and rejects stale proofs', async () => {
  const access = auth.bindings.trustedAccess as unknown as RenameAccountPageAccess;
  const deadline = Date.now() + 10000;
  const page = await access.readRenameAccountPage({ human, accountId, deadline });
  expect(page).toMatchObject({
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
  await expect(
    access.readRenameAccountPage({
      human: { ...human, scope: ['account:update', 'account:read'] },
      accountId,
      deadline,
    }),
  ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  await expect(
    access.readRenameAccountPage({ human, accountId: '00000000-0000-4000-8000-000000000002', deadline }),
  ).rejects.toBeInstanceOf(AuthBindingDeniedError);
  await pool.query(
    'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2',
    [routeOf(accountId), accountId],
  );
  await expect(access.readRenameAccountPage({ human, accountId, deadline: Date.now() + 10000 })).rejects.toThrow();
});
