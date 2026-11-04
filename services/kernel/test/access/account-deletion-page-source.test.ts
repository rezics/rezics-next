import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import { createAccountDeletionPageAccess } from '../../src/access/account-deletion-page-source.ts';
import { accountDeletionPageTransport } from '../../../auth/src/account-deletion-page.ts';
import { cookies, issuer, nativeFixture, password } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture(pool);
}, 60000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});
async function person() {
  const name = `deletion_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const ordinary = await f.person(name);
  const signed = await f.request('/signin', {
    email: `${name}@ordinary.test`,
    password,
    ...{ client_id: AUTH_PAGE_OPERATION_CLIENT_ID, scope: [...AUTH_PAGE_OPERATION_SCOPES.delete] },
  });
  expect(signed.status).toBe(200);
  return { ...ordinary, exact: cookies(signed) };
}
function request(headers: Headers) {
  return new Request(`${issuer}/account-management/deletion-page`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
    body: '{}',
  });
}
function source(access = f.access) {
  return createAccountDeletionPageAccess({
    pool,
    access,
    accessTokenForProof: (proof) => f.host.service.internal.accessTokenForProof(proof),
  });
}
function read(headers: Headers, access: Access, failed?: (error: unknown) => void) {
  const native = source(access);
  return accountDeletionPageTransport(f.host.service, f.host.handler, f.authPool, {
    async readAccountDeletionAdvice(input) {
      try {
        return await native.readAccountDeletionAdvice(input);
      } catch (error) {
        failed?.(error);
        throw error;
      }
    },
  })(request(headers));
}
function nativeRead(headers: Headers, access = f.access) {
  return f.host.service.internal.withFreshHuman({ headers, fresh: false }, async (human) =>
    source(access).readAccountDeletionAdvice({ human, deadline: Date.now() + 3000 }),
  );
}

test('real host offers authentication before display, then native advice without approvals or execution', async () => {
  const human = await person();
  expect(await (await f.host.handler(request(human.headers))).json()).toEqual({
    kind: 'authentication-required',
    accountId: human.accountId,
  });
  const counts = async () =>
    (
      await pool.query(`SELECT
    (SELECT count(*) FROM access.workflow_approval)::text approvals,
    (SELECT count(*) FROM core.receipt)::text receipts`)
    ).rows;
  const before = await counts();
  const response = await f.host.handler(request(human.exact));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({
    kind: 'review',
    accountId: human.accountId,
    email: expect.stringContaining('@ordinary.test'),
    action: 'available',
    policy: 'personal-deletion',
  });
  expect(await counts()).toEqual(before);
  // A genuine native denial cannot become profile or authentication advice.
  await pool.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$2,'account:delete','resource','(,)',$3)`,
    [routeOf(human.accountId), human.accountId, Bun.randomUUIDv7()],
  );
  expect(await (await f.host.handler(request(human.exact))).json()).toMatchObject({
    kind: 'review',
    action: 'refused',
  });
  expect(await counts()).toEqual(before);
}, 60000);

test('exact-human source rejects ordinary, operated and substituted actors', async () => {
  const human = await person();
  await expect(nativeRead(human.headers)).rejects.toThrow();
  const other = await person();
  const wrong: Access = {
    ...f.access,
    authenticate: async () => f.access.authenticate(other.bearer, { pool, deadline: Date.now() + 3000 }),
  };
  await expect(nativeRead(human.exact, wrong)).rejects.toThrow();
  for (const patch of [
    "state='suspended'",
    'authn_fenced=true',
    'minimum_authn_epoch=999',
    `operator_account_id='${other.accountId}'`,
  ]) {
    const target = await person();
    await f.host.service.internal.withFreshHuman({ headers: target.exact, fresh: false }, async (live) => {
      await pool.query(`UPDATE access.account SET ${patch} WHERE route=$1 AND account_id=$2`, [
        routeOf(target.accountId),
        target.accountId,
      ]);
      await expect(source().readAccountDeletionAdvice({ human: live, deadline: Date.now() + 3000 })).rejects.toThrow();
    });
  }
}, 60000);

test.each(['floor', 'home', 'session', 'dependency'] as const)(
  'released preparation rechecks %s before disclosure',
  async (change) => {
    const human = await person();
    const access: Access = {
      ...f.access,
      async prepare(...args) {
        const evidence = await f.access.prepare!(...args);
        // Pool size one proves the source released its checkout before this I/O.
        if (change === 'floor')
          await pool.query(`UPDATE access.account SET minimum_authn_epoch=999 WHERE route=$1 AND account_id=$2`, [
            routeOf(human.accountId),
            human.accountId,
          ]);
        if (change === 'home')
          await pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [
            partitionOf(routeOf(human.accountId)!),
          ]);
        if (change === 'session') await f.request('/signout', {}, human.exact);
        if (change === 'dependency') throw new Error('Native preparation offline');
        return evidence;
      },
    };
    let nativeFailure: unknown;
    const response = await read(human.exact, access, (error) => { nativeFailure = error; });
    const body = await response.json();
    expect(body.kind, nativeFailure instanceof Error ? nativeFailure.stack : String(nativeFailure)).toBe(
      change === 'home' ? 'changed' : change === 'dependency' ? 'unavailable' : 'signed-out',
    );
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('accountId');
  },
  60000,
);
