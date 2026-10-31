import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { NativeCreationContextRequest, NativeCreationContextResult } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { workflowApprovalBinding } from '../../src/access/workflow-approvals.ts';
import { accessClock, installAccessClock } from '../../src/access/access-clock.ts';
import { nativeFixture, cookies, password, scopes } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
let f: Awaited<ReturnType<typeof nativeFixture>>;
const boundary = () => ({ pool, deadline: Date.now() + 10_000 });
const read = (input: NativeCreationContextRequest) => f.bindings.trustedAccess.readNativeCreationContext!(input);
function available(result: NativeCreationContextResult) {
  expect(result.kind).toBe('available');
  if (result.kind !== 'available') throw new Error(result.reason);
  return result.context;
}
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

async function approvedCreation(key: string) {
  const human = await f.person(`${key}-human`);
  const principal = await f.person(`${key}-principal`);
  const organizationId = newId(routeOf(human.accountId)!);
  const reservation = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: human.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: `${key}-owner`,
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: human.accountId,
    ownerReservationId: reservation.value.reservationId,
    key: `${key}-organization`,
  });
  const humanContext = { ...boundary(), actor: await f.access.authenticate(human.bearer, boundary()) };
  const grant = {
    resource: { route: routeOf(organizationId)!, id: organizationId },
    subject: { kind: 'account' as const, id: principal.accountId },
    actions: ['account:manage'],
    valid: '(,)',
    key: `${key}-grant`,
  };
  await f.bindings.grants.create(humanContext, grant);
  // Reuse the native assignment command's supported own-account management
  // configuration; no fixture inserts an assignment, approval or party column.
  const assignments = createDelegationCommands({ pool, access: f.access, action: 'account:manage' });
  const principalContext = { ...boundary(), actor: await f.access.authenticate(principal.bearer, boundary()) };
  const assignmentInput = {
    principalId: principal.accountId,
    assignedActorId: human.accountId,
    requestId: newId(routeOf(principal.accountId)!),
    valid: '(,)',
    key: `${key}-assignment`,
  };
  const assignment = await assignments.create(principalContext, assignmentInput);
  const response = await f.request('/token', { requested_by: assignment.value.requestedBy }, human.headers);
  expect(response.status).toBe(200);
  const delegated = ((await response.json()) as { access_token: string }).access_token;
  const operation = {
    kind: 'automated' as const,
    registrationId: '',
    operatorAccountId: organizationId,
    handle: key.replaceAll('-', '_'),
    operationKey: key,
    authorization: 'approval-input',
  };
  const approval = await f.approval().approve(delegated, { operationKey: key, operation }, boundary());
  const input = { approvalReference: approval.reference, operationKey: key, operation };
  return { human, principal, organizationId, delegated, approval, input, assignments, assignmentInput, grant };
}

test('Project actual native approved creation party context', async () => {
  const c = await approvedCreation('context-distinct');
  const context = available(await read(c.input));
  const resolved = await f.approval().resolve(c.approval.reference, c.input.operation, boundary());
  const binding = workflowApprovalBinding(resolved)!;
  expect(context).toEqual({
    actorAccountId: c.human.accountId,
    actingHumanId: c.human.accountId,
    operatorAccountId: c.organizationId,
    principalAccountId: c.principal.accountId,
    sourceClientId: 'ordinary-test-client',
    approvalReference: c.approval.reference,
    commandKey: binding.commandKeyPrefix,
    operationKey: c.input.operationKey,
    operationDigest: binding.digest,
    operation: {
      kind: 'automated',
      action: 'account:manage',
      targetResourceId: c.organizationId,
      targetClientId: null,
    },
  });
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.operation)).toBe(true);
  expect(await f.bindings.workflowPorts.copyActors!(resolved)).toEqual([
    { accountId: c.human.accountId, role: 'human' },
    { accountId: c.human.accountId, role: 'initiator' },
    { accountId: c.principal.accountId, role: 'delegate' },
  ]);
  expect(await f.bindings.workflowPorts.readNativeCreationContext!(c.input)).toEqual({ kind: 'available', context });
  for (const changed of [
    { ...c.input, operationKey: 'different-key' },
    { ...c.input, operation: { ...c.input.operation, handle: 'different_handle' } },
    { ...c.input, operation: { ...c.input.operation, operatorAccountId: c.principal.accountId } },
    { ...c.input, operation: { ...c.input.operation, registrationId: 'unbound-stage' } },
    { ...c.input, approvalReference: c.delegated },
  ])
    await expect(read(changed)).rejects.toMatchObject({ status: 403 });

  // The context is available before the real encrypted stage/request copies.
  const created = await f.host.workflows.createAutomated({
    key: c.input.operationKey,
    handle: c.input.operation.handle,
    operatorAccountId: c.organizationId,
    authorization: c.approval.reference,
    credential: { email: 'context-private@ordinary.test', password },
  });
  const stage = (
    await f.authPool.query<{ registration_id: string; erasure_creator_id: string; erasure_operator_id: string }>(
      'SELECT registration_id,erasure_creator_id,erasure_operator_id FROM auth_registration_stage WHERE account_id=$1',
      [created.accountId],
    )
  ).rows[0]!;
  expect(stage.erasure_creator_id).toBe(context.actingHumanId!);
  expect(stage.erasure_operator_id).toBe(context.operatorAccountId!);
  expect(
    available(await read({ ...c.input, operation: { ...c.input.operation, registrationId: stage.registration_id } })),
  ).toEqual(context);
  const serialized = JSON.stringify(context);
  for (const privateValue of [c.delegated, 'context-private@ordinary.test', password, c.input.operation.handle])
    expect(serialized).not.toContain(privateValue);
  expect(context).not.toHaveProperty('ownerAccountId');
  expect(context).not.toHaveProperty('scopes');
  await f.restart();
  expect(available(await read(c.input))).toEqual(context);
  const clock = accessClock(f.access);
  try {
    installAccessClock(f.access, () => new Date(binding.expiresAt));
    await expect(read(c.input)).rejects.toMatchObject({ status: 403 });
  } finally {
    installAccessClock(f.access, clock);
  }
});

test('new copy attribution rechecks current principal grants and assignment without changing the saved binding', async () => {
  const c = await approvedCreation('context-current');
  const original = available(await read(c.input));
  const humanContext = { ...boundary(), actor: await f.access.authenticate(c.human.bearer, boundary()) };
  await f.bindings.grants.revoke(humanContext, { ...c.grant, key: 'context-revoke-grant' });
  await expect(read(c.input)).rejects.toMatchObject({ status: 403 });
  await f.bindings.grants.create(humanContext, { ...c.grant, key: 'context-restore-grant' });
  expect(available(await read(c.input))).toEqual(original);
  await c.assignments.revoke(
    { ...boundary(), actor: await f.access.authenticate(c.principal.bearer, boundary()) },
    { principalId: c.principal.accountId, requestId: c.assignmentInput.requestId, key: 'context-revoke-assignment' },
  );
  await expect(read(c.input)).rejects.toMatchObject({ status: 403 });
  const row = (
    await pool.query('SELECT operation,digest FROM access.workflow_approval WHERE actor_id=$1', [c.human.accountId])
  ).rows[0];
  expect(row.digest).toBe(original.operationDigest);
  expect(row.operation).not.toHaveProperty('authorization');
  expect(
    (
      await f.authPool.query('SELECT registration_id FROM auth_registration_stage WHERE request_key=$1', [
        `automated:${createHash('sha256').update(JSON.stringify(c.input.operationKey)).digest('hex')}`,
      ])
    ).rowCount,
  ).toBe(0);
});

test('historical input and an automated bearer with no source opening locator have typed unavailable provenance', async () => {
  const human = await f.person('context-opening-human');
  const subject = await f.automated('context-opening-bot', human);
  const clientId = 'context-update-client';
  const clientScopes = [...scopes, 'account:update'];
  await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes: clientScopes });
  const signed = await f.request('/signin', {
    email: 'context-opening-human@ordinary.test',
    password,
    client_id: clientId,
    scope: clientScopes,
  });
  expect(signed.status).toBe(200);
  const headers = cookies(signed);
  const token = await f.request('/token', {}, headers);
  const bearer = ((await token.json()) as { access_token: string }).access_token;
  const opening = {
    kind: 'opening' as const,
    operatorAccountId: human.accountId,
    subjectAccountId: subject.accountId,
    authorization: 'approval-input',
  };
  const approval = await f
    .approval()
    .approve(bearer, { operationKey: 'context-session', operation: opening }, boundary());
  const context = available(
    await read({ approvalReference: approval.reference, operationKey: 'context-session', operation: opening }),
  );
  expect(context.actingHumanId).toBe(human.accountId);
  expect(context.operatorAccountId).toBe(human.accountId);
  expect(context.principalAccountId).toBeNull();
  const session = await f.host.workflows.openOperatorSession({
    key: 'context-session',
    authorization: approval.reference,
    operatorAccountId: human.accountId,
    subjectAccountId: subject.accountId,
    headers,
  });
  expect(session.status).toBe(200);
  const automatedToken = await f.request('/token', {}, cookies(session));
  const automatedBearer = ((await automatedToken.json()) as { access_token: string }).access_token;
  const operation = {
    kind: 'rename' as const,
    accountId: subject.accountId,
    handle: 'context_renamed_bot',
    expectedHandle: 'context_opening_bot',
    authorization: 'approval-input',
  };
  const approved = await f
    .approval()
    .approve(automatedBearer, { operationKey: 'context-rename', operation }, boundary());
  const input = { approvalReference: approved.reference, operationKey: 'context-rename', operation };
  expect(await read(input)).toEqual({ kind: 'unavailable', reason: 'opening-provenance' });
  expect(await read({ ...input, approvalReference: null })).toEqual({
    kind: 'unavailable',
    reason: 'historical-provenance',
  });
});
