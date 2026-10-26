import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { nativeFixture, cookies, password, scopes } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
const clientId = 'native-refusal-client';
const workflowScopes = [...new Set([...scopes, ...LIFECYCLE_ACTIONS.keys()])];
let f: Awaited<ReturnType<typeof nativeFixture>>;

const workflowId = (key: string) =>
  `accounts:${createHash('sha256')
    .update(JSON.stringify(`operation:${key}`))
    .digest('hex')}`;
async function stepError(key: string, name: string) {
  const row = (
    await f.authPool.query<{ error: unknown }>(
      'SELECT error FROM auth_dbos.operation_outputs WHERE workflow_uuid=$1 AND function_name=$2',
      [workflowId(key), `accounts.${name}`],
    )
  ).rows[0];
  expect(row).toBeDefined();
  const envelope = JSON.parse(String(row!.error)) as { json: unknown };
  return JSON.stringify(envelope.json);
}
async function bearer(key: string) {
  const signed = await f.request('/signin', {
    email: `${key}@ordinary.test`,
    password,
    client_id: clientId,
    scope: workflowScopes,
  });
  expect(signed.status).toBe(200);
  const response = await f.request('/token', {}, cookies(signed));
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function approveDelete(key: string, accountId: string, token: string) {
  const operation = { kind: 'delete' as const, accountId, authorization: 'private-approval-input' };
  const approval = await f
    .approval()
    .approve(token, { operationKey: key, operation }, { pool, deadline: Date.now() + 10_000 });
  return { ...operation, authorization: approval.reference, key };
}
async function expectRefusal(work: Promise<unknown>) {
  await expect(work).rejects.toMatchObject({ status: 403 });
}

beforeAll(async () => {
  f = await nativeFixture(pool);
  await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes: workflowScopes });
});
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});

test('an operated account tombstone is a sanitized native refusal', async () => {
  const key = 'native-refusal-operated-owner';
  const owner = await f.person(key);
  await f.automated(`${key}-bot`, owner);
  const operationKey = `${key}-delete`;
  await expectRefusal(
    f.host.workflows.deleteAccount(await approveDelete(operationKey, owner.accountId, await bearer(key))),
  );
  const persisted = await stepError(operationKey, 'tombstone-account');
  expect(persisted).toContain('"status":403');
  expect(persisted).not.toContain('Account lifecycle command denied');
  expect(persisted).not.toContain('private-approval-input');
  expect(persisted).not.toContain(owner.accountId);
});

test('a last owner tombstone is the same sanitized native refusal', async () => {
  const key = 'native-refusal-last-owner';
  const owner = await f.person(key);
  const token = await bearer(key);
  const organizationId = newId(routeOf(owner.accountId)!);
  const reservation = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: `${key}-organization`,
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: owner.accountId,
    ownerReservationId: reservation.value.reservationId,
    key: `${key}-create-organization`,
  });
  const operationKey = `${key}-delete`;
  await expectRefusal(f.host.workflows.deleteAccount(await approveDelete(operationKey, owner.accountId, token)));
  const persisted = await stepError(operationKey, 'tombstone-account');
  expect(persisted).toContain('"status":403');
  expect(persisted).not.toContain('Account lifecycle command denied');
  expect(persisted).not.toContain(owner.accountId);
});

test('other native denials are sanitized while ordinary failures have no status', async () => {
  const key = 'native-refusal-kinds';
  const account = await f.person(key);
  const token = await bearer(key);
  const tombstone = f.bindings.workflowPorts.tombstone!;
  f.bindings.workflowPorts.tombstone = async () => {
    throw Object.assign(new GrantDeniedError(), {
      commandInput: 'private-command-input',
      permissionContext: 'private-permission-context',
    });
  };
  const deniedKey = `${key}-grant`;
  await expectRefusal(f.host.workflows.deleteAccount(await approveDelete(deniedKey, account.accountId, token)));
  const denied = await stepError(deniedKey, 'tombstone-account');
  expect(denied).toContain('"status":403');
  expect(denied).not.toContain('Access grant administration denied');
  expect(denied).not.toContain('private-command-input');
  expect(denied).not.toContain('private-permission-context');

  f.bindings.workflowPorts.tombstone = async () => {
    throw new Error('private generic crash');
  };
  const failedKey = `${key}-generic`;
  const failure = f.host.workflows.deleteAccount(await approveDelete(failedKey, account.accountId, token));
  await expect(failure).rejects.toThrow('Account workflow step failed: tombstone-account');
  const failed = await stepError(failedKey, 'tombstone-account');
  expect(failed).not.toContain('"status"');
  expect(failed).not.toContain('private generic crash');
  f.bindings.workflowPorts.tombstone = tombstone;
});

test('the native grant HTTP denial remains forbidden', async () => {
  const key = 'native-refusal-http';
  const account = await f.person(key);
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(41),
    tokens: f.referenceKeys,
    access: () => f.access,
    writeRate: { spend: async () => ({ allowed: true }) },
  });
  const response = await kernel.handle(
    new Request('https://kernel.test/v1/grants', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await bearer(key)}`,
        'content-type': 'application/json',
        'idempotency-key': '"native-refusal-http"',
      },
      body: JSON.stringify({
        resource: { route: (routeOf(account.accountId)! + 1) % 65_536, id: account.accountId },
        subject: { kind: 'account', id: account.accountId },
        actions: ['account:read'],
        valid: '(,)',
      }),
    }),
  );
  expect(response.status).toBe(403);
});
