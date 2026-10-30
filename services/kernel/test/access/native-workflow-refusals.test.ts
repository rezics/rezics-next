import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
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
    await f.authPool.query<{ output: unknown; error: unknown }>(
      'SELECT output,error FROM auth_dbos.operation_outputs WHERE workflow_uuid=$1 AND function_name=$2',
      [workflowId(key), `accounts.${name}`],
    )
  ).rows[0];
  expect(row).toBeDefined();
  const envelope = JSON.parse(String(row!.output ?? row!.error)) as { json: unknown };
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

test('differently named typed native refusals restore without a private payload or an effect', async () => {
  class NativeBoundaryRefusal extends Error {
    constructor(readonly status: 401 | 403) {
      super('private-native-refusal');
    }
  }
  for (const status of [401, 403] as const) {
    const key = `native-typed-refusal-${status}`;
    const account = await f.person(key);
    const operationKey = `${key}-delete`;
    const input = await approveDelete(operationKey, account.accountId, await bearer(key));
    const prepare = f.access.prepare!.bind(f.access);
    let calls = 0;
    f.access.prepare = async (...args) => {
      if (++calls === 2) throw new NativeBoundaryRefusal(status);
      return prepare(...args);
    };
    const before = await workflowReceipts();
    try {
      await expect(f.host.workflows.deleteAccount(input)).rejects.toMatchObject({ status });
      const persisted = await stepError(operationKey, 'authorize-account-operation');
      expect(JSON.parse(persisted)).toEqual({ authStepOutcome: 'refused-v1', status });
      expect(persisted).not.toContain('private-native-refusal');
      expect(persisted).not.toContain('NativeBoundaryRefusal');
    } finally {
      f.access.prepare = prepare;
    }
    await f.restart();
    await expect(f.host.workflows.deleteAccount(input)).rejects.toMatchObject({ status });
    expect((await stateOf(account.accountId))!.state).toBe('active');
    expect(await workflowReceipts()).toBe(before);
  }
}, 30000);

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

test('workflow approval keeps internal failures and unavailability outside the authorization refusal shape', async () => {
  for (const kind of ['internal', 'unavailable'] as const) {
    const key = `native-refusal-boundary-${kind}`;
    const account = await f.person(key);
    const operationKey = `${key}-delete`;
    const input = await approveDelete(operationKey, account.accountId, await bearer(key));
    const prepare = f.access.prepare!.bind(f.access);
    let calls = 0;
    const secret = `private-${kind}-evidence`;
    f.access.prepare = async (...args) => {
      // The workflow's entry check passes; the protected tombstone step then
      // encounters the injected boundary condition.
      if (++calls === 2) {
        if (kind === 'unavailable') throw Object.assign(new Error(secret), { status: 503 });
        throw new Error(secret);
      }
      return prepare(...args);
    };
    const before = await workflowReceipts();
    try {
      const outcome = f.host.workflows.deleteAccount(input);
      if (kind === 'unavailable') await expect(outcome).rejects.toMatchObject({ status: 503 });
      else await expect(outcome).rejects.toThrow('Account workflow step failed: authorize-account-operation');
      const persisted = await stepError(operationKey, 'authorize-account-operation');
      expect(persisted).not.toContain(secret);
      if (kind === 'unavailable') expect(persisted).toContain('"status":503');
      else expect(persisted).not.toContain('"status"');
      expect((await stateOf(account.accountId))!.state).toBe('active');
      expect(await workflowReceipts()).toBe(before);
    } finally {
      f.access.prepare = prepare;
    }
  }
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

const holds = async (accountId: string) =>
  (
    await pool.query<{ reservation_id: string }>(
      'SELECT reservation_id::text FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    )
  ).rows.map((row) => row.reservation_id);
// Workflow commands key their receipts under a stable `wf:` prefix.
const workflowReceipts = async () =>
  Number(
    (await pool.query<{ count: string }>("SELECT count(*) FROM core.receipt WHERE idempotency_key LIKE '%wf:%'"))
      .rows[0]!.count,
  );
const stateOf = (accountId: string) =>
  withConnection(pool, (client) => readAccount(client, routeOf(accountId)!, accountId));
async function approveOperation(key: string, operation: Record<string, unknown>, token: string) {
  const approval = await f
    .approval()
    .approve(
      token,
      { operationKey: key, operation: { ...operation, authorization: 'private-approval-input' } as never },
      { pool, deadline: Date.now() + 10_000 },
    );
  return approval.reference;
}
async function organizationOwnedBy(key: string, ownerAccountId: string) {
  const organizationId = newId(routeOf(ownerAccountId)!);
  const reservation = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: ownerAccountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: `${key}-organization`,
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId,
    ownerReservationId: reservation.value.reservationId,
    key: `${key}-create-organization`,
  });
  return { organizationId, reservationId: reservation.value.reservationId };
}

test('a registration with a taken handle is refused by its event, not by the elapsed event timeout', async () => {
  const holder = await f.person('native-handle-holder');
  expect(holder.accountId).toBeString();
  await expect(
    f.host.workflows.beginRegistration({ key: 'native-handle-taker', handle: 'native_handle_holder' }),
  ).rejects.toMatchObject({ code: 'handle_unavailable' });
});

test('an owner who leaves after a successor owner exists is permitted and the release completes', async () => {
  const key = 'native-leaving-owner';
  const owner = await f.person(key);
  const successor = await f.person(`${key}-successor`);
  const token = await bearer(key);
  const { organizationId, reservationId } = await organizationOwnedBy(key, owner.accountId);
  const add = { organizationId, memberAccountId: successor.accountId, role: 'owner' as const };
  await f.host.workflows.setMembership({
    ...add,
    key: `${key}-add`,
    authorization: await approveOperation(`${key}-add`, { kind: 'membership', ...add }, token),
  });
  expect(await holds(owner.accountId)).toEqual([reservationId]);
  const leave = { organizationId, memberAccountId: owner.accountId, role: null, reservationId };
  expect(
    await f.host.workflows.setMembership({
      ...leave,
      key: `${key}-leave`,
      authorization: await approveOperation(`${key}-leave`, { kind: 'membership', ...leave }, token),
    }),
  ).toEqual({ accountId: owner.accountId });
  expect(await holds(owner.accountId)).toEqual([]);
  expect((await f.bindings.operators.deletionEligibility(owner.accountId)).safe).toBe(true);
});

test('an account that deletes itself is permitted and the deletion stays committed', async () => {
  const key = 'native-self-deletion';
  const account = await f.person(key);
  const operationKey = `${key}-delete`;
  const input = await approveDelete(operationKey, account.accountId, await bearer(key));
  expect(await f.host.workflows.deleteAccount(input)).toEqual({ accountId: account.accountId });
  expect((await stateOf(account.accountId))!.state).toBe('deleted');
});

test('an operation whose approval is revoked before its first effect is still refused', async () => {
  const key = 'native-revoked-approval';
  const account = await f.person(key);
  const input = await approveDelete(`${key}-delete`, account.accountId, await bearer(key));
  await f.bindings.internalLifecycle.raiseFence({ accountId: account.accountId, key: `${key}-fence` });
  await expectRefusal(f.host.workflows.deleteAccount(input));
  expect((await stateOf(account.accountId))!.state).toBe('active');
});

test('a fence or consent reduction between approval and the operation denies it and writes nothing', async () => {
  const reduced = 'native-reduction-client';
  await f.host.service.internal.registerClient({ clientId: reduced, firstParty: false, scopes: workflowScopes });
  const signin = async (key: string, client: string) => {
    const response = await f.request('/signin', {
      email: `${key}@ordinary.test`,
      password,
      client_id: client,
      scope: workflowScopes,
    });
    expect(response.status).toBe(200);
    return cookies(response);
  };
  for (const change of ['fence', 'consent'] as const) {
    const key = `native-stale-${change}`;
    const owner = await f.person(key);
    const member = await f.person(`${key}-member`);
    const { organizationId } = await organizationOwnedBy(key, owner.accountId);
    expect(
      (await f.request('/consent', { client_id: reduced, scope: workflowScopes }, await signin(key, clientId))).status,
    ).toBe(200);
    const tokenResponse = await f.request('/token', {}, await signin(key, reduced));
    expect(tokenResponse.status).toBe(200);
    const token = ((await tokenResponse.json()) as { access_token: string }).access_token;
    const add = { organizationId, memberAccountId: member.accountId, role: 'member' as const };
    const authorization = await approveOperation(`${key}-add`, { kind: 'membership', ...add }, token);
    if (change === 'fence')
      await f.bindings.internalLifecycle.raiseFence({ accountId: owner.accountId, key: `${key}-fence` });
    else
      expect(
        (await f.request('/consent', { client_id: reduced, scope: ['subject:create'] }, await signin(key, clientId)))
          .status,
      ).toBe(200);
    const before = await workflowReceipts();
    await expectRefusal(f.host.workflows.setMembership({ ...add, key: `${key}-add`, authorization }));
    expect(await holds(member.accountId)).toEqual([]);
    expect(await workflowReceipts()).toBe(before);
  }
});

test('a fence raised while a step is authorized denies it before the step reserves anything', async () => {
  const key = 'native-fence-during-authorization';
  const owner = await f.person(key);
  const member = await f.person(`${key}-member`);
  const { organizationId } = await organizationOwnedBy(key, owner.accountId);
  const add = { organizationId, memberAccountId: member.accountId, role: 'member' as const };
  const authorization = await approveOperation(`${key}-add`, { kind: 'membership', ...add }, await bearer(key));
  const prepare = f.access.prepare!.bind(f.access);
  let calls = 0;
  f.access.prepare = async (...args) => {
    // The first authorization admits the operation; the fence lands inside the second, the step's own.
    if (++calls === 2)
      await f.bindings.internalLifecycle.raiseFence({ accountId: owner.accountId, key: `${key}-fence` });
    return prepare(...args);
  };
  try {
    const before = await workflowReceipts();
    await expectRefusal(f.host.workflows.setMembership({ ...add, key: `${key}-add`, authorization }));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await holds(member.accountId)).toEqual([]);
    expect(await workflowReceipts()).toBe(before);
  } finally {
    f.access.prepare = prepare;
  }
});
