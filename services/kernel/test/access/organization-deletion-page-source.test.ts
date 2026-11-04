import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import {
  createNativeAccountBindings,
  type NativeAccountBindingsConfig,
} from '../../src/access/native-account-bindings.ts';
import { createOrganizationDeletionAccess } from '../../src/access/organization-deletion-source.ts';
import { organizationDeletionReadTransport } from '../../../auth/src/organization-deletion-read-transport.ts';
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
const key = () => Bun.randomUUIDv7();
async function selection() {
  const name = `orgdelete_${key().replaceAll('-', '')}`;
  const person = await f.person(name);
  const signed = await f.request('/signin', {
    email: `${name}@ordinary.test`,
    password,
    client_id: AUTH_PAGE_OPERATION_CLIENT_ID,
    scope: [...AUTH_PAGE_OPERATION_SCOPES.delete],
  });
  expect(signed.status).toBe(200);
  const organizationId = newId(0x9421);
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: person.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: person.accountId,
    ownerReservationId: held.value.reservationId,
    key: key(),
  });
  return { ...person, exact: cookies(signed), organizationId };
}
function request(headers: Headers, organizationId: string) {
  return new Request(issuer + '/account-management/organizations/deletion-review', {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
    body: JSON.stringify({ organizationId }),
  });
}
const source = (access = f.access) =>
  createOrganizationDeletionAccess({
    pool,
    access,
    accessTokenForProof: (proof) => f.host.service.internal.accessTokenForProof(proof),
  });

test('native factory constructs before Auth exists and keeps readiness off workflows', () => {
  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error('Construction performed I/O');
      },
    },
  );
  const bindings = createNativeAccountBindings({
    pool: untouched,
    access: untouched,
    actions: new Map([['account:manage', { anonymous: false }]]),
    routeKey: new Uint8Array(32),
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32)]]) },
    auth() {
      throw new Error('Auth is not constructed');
    },
    proofs: { provisioning: untouched, barriers: untouched, workflow: untouched },
  } as unknown as NativeAccountBindingsConfig);
  expect('readOrganizationDeletionPage' in bindings.trustedAccess).toBe(true);
  expect('readOrganizationDeletionPage' in bindings.workflowPorts).toBe(false);
  expect('readOrganizationForDeletion' in bindings.workflowPorts).toBe(true);
});

test('actual registered host offers safe ordinary authentication, then native review or current refusal without writes', async () => {
  const selected = await selection();
  const counts = async () =>
    (
      await pool.query(`SELECT
    (SELECT count(*) FROM access.workflow_approval)::text approvals,
    (SELECT count(*) FROM core.receipt)::text receipts`)
    ).rows;
  const before = await counts();
  for (const id of [selected.organizationId, newId(0x9421)]) {
    const response = await f.host.handler(request(selected.headers, id));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      kind: 'authentication-required',
      humanAccountId: selected.accountId,
      action: 'authenticate',
    });
  }
  expect(await (await f.host.handler(request(selected.exact, selected.organizationId))).json()).toEqual({
    kind: 'ready',
    humanAccountId: selected.accountId,
    action: 'confirm',
    account: { id: selected.organizationId, kind: 'organization', handle: null, displayName: null },
  });
  expect(await counts()).toEqual(before);
  await f.host.service.internal.withFreshHuman({ headers: selected.headers, fresh: false }, async (human) => {
    await expect(
      source().readOrganizationForDeletion({
        human,
        organizationId: selected.organizationId,
        deadline: Date.now() + 3000,
      }),
    ).rejects.toThrow();
  });
  const other = await selection();
  expect(await (await f.host.handler(request(other.exact, selected.organizationId))).json()).toEqual({
    kind: 'hidden',
  });
  await pool.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
    VALUES ($1,$2,$3,'account:delete','resource','(,)',$4)`,
    [routeOf(selected.organizationId), selected.organizationId, selected.accountId, key()],
  );
  expect(await (await f.host.handler(request(selected.exact, selected.organizationId))).json()).toEqual({
    kind: 'denied',
  });
  // The extra fixture above creates receipts, so compare reads after its setup.
  const deniedCounts = await counts();
  await f.host.handler(request(selected.exact, selected.organizationId));
  expect(await counts()).toEqual(deniedCounts);
  expect(Number(deniedCounts[0].approvals)).toBe(Number(before[0].approvals));
  await f.request('/signout', {}, selected.exact);
  expect(await (await f.host.handler(request(selected.exact, selected.organizationId))).json()).toEqual({
    kind: 'signed-out',
  });
}, 60000);

test.each(['membership', 'floor', 'home', 'session', 'dependency', 'missing-prepare', 'wrong', 'operated'] as const)(
  'native %s replacement or dependency failure never publishes private identity',
  async (change) => {
    const selected = await selection();
    const access: Access = {
      ...f.access,
      async prepare(...args) {
        const evidence = await f.access.prepare!(...args);
        // With max=1 this I/O also proves preparation holds no source checkout.
        if (change === 'membership')
          await pool.query(
            `UPDATE access.organization_member SET role='member'
        WHERE route=$1 AND organization_id=$2 AND member_account_id=$3`,
            [routeOf(selected.organizationId), selected.organizationId, selected.accountId],
          );
        if (change === 'floor')
          await pool.query('UPDATE access.account SET minimum_authn_epoch=999 WHERE route=$1 AND account_id=$2', [
            routeOf(selected.accountId),
            selected.accountId,
          ]);
        if (change === 'home')
          await pool.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [
            partitionOf(routeOf(selected.organizationId)!),
          ]);
        if (change === 'session') await f.request('/signout', {}, selected.exact);
        if (change === 'dependency') throw new Error('Native preparation offline');
        return evidence;
      },
    };
    if (change === 'missing-prepare') delete access.prepare;
    if (change === 'wrong' || change === 'operated') {
      const authenticate = access.authenticate;
      access.authenticate = async (...args) => {
        const actor = await authenticate(...args);
        return {
          ...actor,
          ...(change === 'wrong' ? { accountId: selected.organizationId } : { requestedBy: 'operated' }),
        };
      };
    }
    const route = organizationDeletionReadTransport(f.host.service, f.host.handler, source(access));
    const body = await (await route(request(selected.exact, selected.organizationId))).json();
    expect(body).toEqual({
      kind: ['floor', 'session'].includes(change)
        ? 'signed-out'
        : ['membership', 'home'].includes(change)
          ? 'changed'
          : ['wrong', 'operated'].includes(change)
            ? 'denied'
            : 'unavailable',
    });
  },
  60000,
);
