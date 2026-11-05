import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { automatedAccountOperationRequestByteBudgets } from '@rezics/auth-contract';
import { automatedManagementProfile, automatedNativeResult } from '../src/automated-account-transport.ts';

// Reuse the existing real native Auth/Access fixture, including its approval
// source binding. No alternate registration writer, permission or custody world.
let database: ReturnType<typeof testDatabase>;
let pool: Pool;
let f: Awaited<ReturnType<typeof import('../../kernel/test/access/native-account-bindings-fixture.ts').nativeFixture>>;
let fixture: typeof import('../../kernel/test/access/native-account-bindings-fixture.ts');
let human: { accountId: string; headers: Headers; bearer: string };
let foreign: typeof human;
let humanCookie: string;
let foreignCookie: string;
const key = 'original-automated-transport-key';
let operation: {
  kind: 'automated';
  registrationId: '';
  operationKey: string;
  operatorAccountId: string;
  handle: string;
};
const profile = automatedManagementProfile();
function send(path: string, body: unknown, cookie = humanCookie, extra: Record<string, string> = {}) {
  return f.host.handler(
    new Request(`${fixture.issuer}${path}`, {
      method: 'POST',
      headers: { origin: fixture.issuer, 'content-type': 'application/json', cookie, ...extra },
      body: JSON.stringify(body),
    }),
  );
}
const approve = (body = operation, operationKey = key, cookie = humanCookie, accountId = human.accountId) =>
  send('/account-operations/approve', { operationKey, operation: body, accountId }, cookie);
const execute = (
  reference: string,
  body = operation,
  operationKey = key,
  cookie = humanCookie,
  accountId = human.accountId,
) => send('/account-operations/execute', { operationKey, operation: body, reference, accountId }, cookie);
async function signIn(name: string): Promise<string> {
  const signed = await f.request('/signin', { email: `${name}@ordinary.test`, password: fixture.password, ...profile });
  expect(signed.status).toBe(200);
  return fixture.cookies(signed).get('cookie')!;
}
async function counts() {
  return {
    kernel: (await pool.query('SELECT count(*)::int AS accounts FROM access.account')).rows,
    stages: (await f.authPool.query('SELECT count(*)::int AS stages FROM auth_registration_stage')).rows,
    users: (await f.authPool.query('SELECT count(*)::int AS users FROM "user"')).rows,
  };
}
beforeAll(async () => {
  database = testDatabase();
  migrateKernel(database.url);
  pool = new Pool({ connectionString: database.url });
  process.env.DATABASE_URL = database.url;
  await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
  fixture = await import('../../kernel/test/access/native-account-bindings-fixture.ts');
  f = await fixture.nativeFixture(pool);
  human = await f.person('automated-transport-human');
  foreign = await f.person('automated-transport-foreign');
  humanCookie = await signIn('automated-transport-human');
  foreignCookie = await signIn('automated-transport-foreign');
  operation = {
    kind: 'automated',
    registrationId: '',
    operationKey: key,
    operatorAccountId: human.accountId,
    handle: 'transport_operated_actor',
  };
}, 180000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool?.end();
    database?.close();
  }
}, 60000);

test('creating an operated actor uses existing native approved createAutomated workflow exact operator and original key with no owner impersonation or second registration writer', async () => {
  const approvalResponse = await approve();
  expect(approvalResponse.status).toBe(200);
  const approval = (await approvalResponse.json()) as { reference: string };
  const before = await counts();
  // An actual foreign person cannot use the other person's approval, even with
  // the same account:manage client and operation body.
  expect((await execute(approval.reference, operation, key, foreignCookie, foreign.accountId)).status).toBe(403);
  expect(await counts()).toEqual(before);
  const created = await execute(approval.reference);
  expect(created.status).toBe(200);
  expect(created.headers.get('cache-control')).toBe('no-store');
  expect(created.headers.has('set-cookie')).toBe(false);
  const result = (await created.json()) as { accountId: string };
  expect(Object.keys(result)).toEqual(['accountId']);
  expect(result.accountId).not.toBe(human.accountId);
  expect(
    (
      await pool.query('SELECT kind,state,handle,operator_account_id::text FROM access.account WHERE account_id=$1', [
        result.accountId,
      ])
    ).rows,
  ).toEqual([{ kind: 'actor', state: 'active', handle: operation.handle, operator_account_id: human.accountId }]);
  expect(await f.bindings.trustedAccess.readAccount(result.accountId)).toMatchObject({ automated: true });
  expect((await f.authPool.query('SELECT id FROM session WHERE "userId"=$1', [result.accountId])).rowCount).toBe(0);
  expect((await f.authPool.query('SELECT id FROM account WHERE "userId"=$1', [result.accountId])).rowCount).toBe(0);
  const request = (
    await f.authPool.query(
      "SELECT request FROM auth_workflow_request WHERE request->>'kind'='automated' AND request->>'operationKey'=$1",
      [key],
    )
  ).rows;
  expect(request).toHaveLength(1);
  expect(request[0].request).toMatchObject({
    ...operation,
    registrationId: expect.any(String),
    authorization: approval.reference,
  });
  expect(request[0].request.registrationId).not.toBe('');
  const binding = await f.proofs.creationBinding({
    registrationId: request[0].request.registrationId,
    operationKey: key,
  });
  expect(binding).toEqual(operation);
  const completed = await counts();
  // Lost response: exact execute replay and fresh approval reuse the native result.
  expect(await (await execute(approval.reference)).json()).toEqual(result);
  const again = (await (await approve()).json()) as { reference: string };
  expect(await (await execute(again.reference)).json()).toEqual(result);
  expect(await counts()).toEqual(completed);
  const changed = { ...operation, handle: 'substituted_actor' };
  expect((await execute(approval.reference, changed)).status).toBe(403);
  expect((await execute(approval.reference, { ...operation, operatorAccountId: foreign.accountId })).status).toBe(403);
  expect(
    (await execute(approval.reference, { ...operation, operationKey: 'substituted-key' }, 'substituted-key')).status,
  ).toBe(403);
  expect(await counts()).toEqual(completed);
}, 180000);

test('execute input admits the maximum escaped automated reference before native resolution', async () => {
  const operationKey = '\u0002'.repeat(128);
  const boundedOperation = {
    ...operation,
    operationKey,
    handle: `a${'b'.repeat(62)}c`,
  };
  const body = {
    operationKey,
    operation: boundedOperation,
    accountId: human.accountId,
    reference: '\u0001'.repeat(4096),
  };
  expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBe(
    automatedAccountOperationRequestByteBudgets.execute,
  );
  const before = await counts();
  const response = await send('/account-operations/execute', body);
  expect(response.status).not.toBe(200);
  expect(response.status).not.toBe(413);
  expect(await counts()).toEqual(before);
});

test('automated result projection admits only the native accountId-only UUID and incompatible workflow output stays unresolved', async () => {
  expect(automatedNativeResult({ accountId: human.accountId })).toEqual({ accountId: human.accountId });
  for (const value of [
    { accountId: human.accountId, pending: true },
    { accountId: 'not-an-account' },
    { accountId: human.accountId.toUpperCase(), callback: 'pending' },
  ])
    expect(automatedNativeResult(value)).toBeNull();

  const invalidKey = 'incompatible-automated-result';
  const invalidOperation = { ...operation, operationKey: invalidKey, handle: 'invalid_native_result' };
  const approvalResponse = await approve(invalidOperation, invalidKey);
  expect(approvalResponse.status).toBe(200);
  const { reference } = (await approvalResponse.json()) as { reference: string };
  const createAutomated = f.host.workflows.createAutomated;
  f.host.workflows.createAutomated = (async () => ({ accountId: human.accountId, pending: true })) as never;
  try {
    const unresolved = await execute(reference, invalidOperation, invalidKey);
    expect(unresolved.status).toBe(503);
    expect(await unresolved.json()).toEqual({ error: 'account_operation_unresolved' });
  } finally {
    f.host.workflows.createAutomated = createAutomated;
  }

  const thrownKey = 'throwing-automated-result';
  const thrownOperation = { ...operation, operationKey: thrownKey, handle: 'throwing_native_result' };
  const thrownApproval = await approve(thrownOperation, thrownKey);
  expect(thrownApproval.status).toBe(200);
  const thrownReference = ((await thrownApproval.json()) as { reference: string }).reference;
  f.host.workflows.createAutomated = (async () => {
    throw new Error('simulated workflow transport exception');
  }) as never;
  try {
    const unresolved = await execute(thrownReference, thrownOperation, thrownKey);
    expect(unresolved.status).toBe(503);
    expect(await unresolved.json()).toEqual({ error: 'account_operation_unresolved' });
  } finally {
    f.host.workflows.createAutomated = createAutomated;
  }
});

test('closed automated transport refuses invented source, owner impersonation, credentials, bearer, wrong profile and stale authority before staging', async () => {
  const before = await counts();
  for (const bad of [
    { ...operation, registrationId: 'browser-source' },
    { ...operation, operationKey: 'different-key' },
    { ...operation, ownerActor: human.accountId },
    { ...operation, credential: { email: 'x@test.invalid', password: 'never-accepted' } },
  ])
    expect((await approve(bad as typeof operation)).status).toBe(400);
  expect((await send('/account-operations/approve', { operationKey: key, operation })).status).toBe(400);
  expect(
    (
      await send(
        '/account-operations/approve',
        { operationKey: key, operation, accountId: human.accountId },
        humanCookie,
        { authorization: `Bearer ${human.bearer}` },
      )
    ).status,
  ).toBe(400);
  expect((await approve(operation, key, foreignCookie, foreign.accountId)).status).toBe(403);
  expect((await approve(operation, key, human.headers.get('cookie')!)).status).toBe(403);
  await f.authPool.query('UPDATE session SET "authTime"=$2 WHERE "userId"=$1', [
    human.accountId,
    Math.floor(Date.now() / 1000) - 601,
  ]);
  const stale = await approve();
  expect(stale.status).toBe(401);
  expect(await stale.json()).toEqual({ error: 'step_up_required', effect_status: 'not_applied' });
  expect(await counts()).toEqual(before);
}, 60000);
