import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { NativeCreationContext, NativeCreationPort } from '../src/creation-party-context.ts';
import { createNativeWorkflowProofPorts } from '../src/native-workflow-proofs.ts';
import { failNativeQueries, nativeFixture, password, scopes } from './support/erasure-native.ts';

let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

const columns = [
  'creation_context_version',
  'creation_scope_digest',
  'creation_context',
  'creation_approval_reference',
  'erasure_creator_id',
  'erasure_operator_id',
  'erasure_actor_id',
  'erasure_human_id',
  'erasure_principal_id',
  'erasure_native_operator_id',
  'erasure_client_id',
  'erasure_source_client_id',
  'erasure_client_owner_id',
  'erasure_source_client_owner_id',
  'erasure_initiator_id',
  'erasure_delegate_id',
  'erasure_actor_version',
];
async function parties(accountId: string) {
  const stage = (await f.pool.query('SELECT * FROM auth_registration_stage WHERE account_id=$1', [accountId])).rows[0]!;
  const receipt = (await f.pool.query('SELECT * FROM auth_provisioning_receipt WHERE account_id=$1', [accountId]))
    .rows[0]!;
  expect(stage).toBeDefined();
  expect(receipt).toBeDefined();
  expect(receipt.erasure_stage_id).toBe(stage.registration_id);
  for (const column of columns) expect(receipt[column]).toEqual(stage[column]);
  expect(stage.creation_context_version).toBe(1);
  expect(stage.creation_scope_digest).toBeInstanceOf(Buffer);
  return { stage, receipt };
}
async function automated(operatorAccountId: string) {
  const key = randomUUID();
  const operation = {
    kind: 'automated' as const,
    registrationId: '',
    operatorAccountId,
    handle: `parties_${key.replaceAll('-', '')}`,
    operationKey: key,
    authorization: 'approval-request',
  };
  return { key, operation };
}

describe('Native stage and provisioning complete creation parties', () => {
  test('public registration retains preselected subject and only applicable native roles on stage and receipt', async () => {
    const key = randomUUID();
    const input = { key, handle: `public_${key.replaceAll('-', '')}`, email: `${key}@creation.test`, password };
    const result = await f.host.workflows.register(input);
    const { stage } = await parties(result.accountId);
    expect(stage.account_id).toBe(f.bindings.workflowPorts.registrationTarget(key));
    expect(stage.creation_context).toBeNull();
    for (const column of columns.filter((c) => c.endsWith('_id'))) expect(stage[column]).toBeNull();
    expect(stage.creation_approval_reference).toBeNull();
    expect(stage.erasure_actor_version).toBe(1);
    expect(await f.host.workflows.register(input)).toEqual(result);
    await expect(f.host.workflows.register({ ...input, password: `${password} changed` })).rejects.toThrow();
    expect((await parties(result.accountId)).stage.creation_scope_digest).toEqual(stage.creation_scope_digest);
  }, 120_000);

  test('missing actual producer refuses before creating a stage or encrypted copy', async () => {
    const person = await f.person('creation-missing-source');
    const { key, operation } = await automated(person.accountId);
    const approval = await f.approvals.approve(person.bearer, { operationKey: key, operation }, f.context());
    const port = f.bindings.workflowPorts as typeof f.bindings.workflowPorts & NativeCreationPort;
    const original = port.readNativeCreationContext;
    delete port.readNativeCreationContext;
    try {
      await expect(
        f.host.workflows.createAutomated({
          key,
          authorization: approval.reference,
          operatorAccountId: person.accountId,
          handle: operation.handle,
          credential: { email: `${key}@creation.test`, password },
        }),
      ).rejects.toMatchObject({ status: 503, message: 'Native creation context unavailable: producer-missing' });
    } finally {
      if (original) port.readNativeCreationContext = original;
    }
    expect(
      (await f.pool.query('SELECT 1 FROM auth_registration_stage WHERE handle=$1', [operation.handle])).rowCount,
    ).toBe(0);
  }, 120_000);

  test('approved automation copies the actual original context, rolls credential failures back, and preserves source keys', async () => {
    let human = await f.person('creation-source-human');
    await f.bootstrapGovernance(human.accountId);
    const clientId = randomUUID();
    const governScopes = [...scopes, 'access:grant', 'organization:create'];
    await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes: governScopes });
    human = await f.login(human, clientId, governScopes);
    const organizationKey = randomUUID();
    const organizationOperation = {
      kind: 'organization' as const,
      handle: `org_${organizationKey.replaceAll('-', '')}`,
      authorization: 'approval-request',
    };
    const organizationApproval = await f.approvals.approve(
      human.bearer,
      { operationKey: organizationKey, operation: organizationOperation },
      f.context(),
    );
    const operator = await f.host.workflows.createOrganization({
      key: organizationKey,
      handle: organizationOperation.handle,
      authorization: organizationApproval.reference,
    });
    const creator = await f.person('creation-source-creator');
    const actor = await f.access.authenticate(human.bearer, f.context());
    await f.bindings.grants.create(
      { ...f.context(), actor },
      {
        resource: { route: f.routeOf(operator.accountId)!, id: operator.accountId },
        subjectId: creator.accountId,
        subjectRole: '',
        actions: ['account:manage'],
        valid: '(,)',
        key: randomUUID(),
      },
    );
    const { key, operation } = await automated(operator.accountId);
    const approval = await f.approvals.approve(creator.bearer, { operationKey: key, operation }, f.context());
    const port = f.bindings.workflowPorts as typeof f.bindings.workflowPorts & NativeCreationPort;
    expect(port.readNativeCreationContext).toBeFunction();
    const source = await port.readNativeCreationContext!({
      approvalReference: approval.reference,
      operationKey: key,
      operation: { ...operation, authorization: approval.reference },
    });
    expect(source.kind).toBe('available');
    if (source.kind !== 'available') throw new Error('Original native creation context unavailable');
    const input = {
      key,
      authorization: approval.reference,
      operatorAccountId: operator.accountId,
      handle: operation.handle,
      credential: { email: `${key}@creation.test`, password },
    };
    const restore = failNativeQueries(f.pool, (sql) => sql.includes('INSERT INTO auth_provisioning_receipt'));
    try {
      await expect(f.host.workflows.createAutomated(input)).rejects.toThrow();
    } finally {
      restore();
    }
    const held = (await f.pool.query('SELECT * FROM auth_registration_stage WHERE handle=$1', [operation.handle]))
      .rows[0]!;
    expect(held.ciphertext).toBeInstanceOf(Buffer);
    expect(held.ciphertext.includes(Buffer.from(input.credential.email))).toBe(false);
    expect(held.creation_context).toEqual(source.context);
    expect(held.account_id).not.toBe(creator.accountId);
    expect(held.account_id).not.toBe(operator.accountId);
    expect((await f.pool.query('SELECT 1 FROM "user" WHERE id=$1', [held.account_id])).rowCount).toBe(0);
    expect(
      (await f.pool.query('SELECT 1 FROM auth_provisioning_receipt WHERE account_id=$1', [held.account_id])).rowCount,
    ).toBe(0);
    await expect(
      f.host.workflows.createAutomated({ ...input, handle: `changed_${key.replaceAll('-', '')}` }),
    ).rejects.toThrow();
    const result = await f.host.workflows.resumeOperation(key);
    if (!result || typeof result !== 'object' || !('accountId' in result) || typeof result.accountId !== 'string')
      throw new Error('Resumed creation did not return its account');
    expect(result).toEqual(await f.host.workflows.createAutomated(input));
    const { stage } = await parties(result.accountId);
    assertSource(stage, source.context);
    expect(stage.creation_scope_digest).toEqual(held.creation_scope_digest);
    expect(stage.creation_binding).toEqual(held.creation_binding);
    expect(stage.activation_key).toBe(held.activation_key);
    expect(stage.reservation_id).toBe(held.reservation_id);
    expect(
      await createNativeWorkflowProofPorts({ database: f.pool }).creationBinding!({
        registrationId: stage.registration_id,
        operationKey: key,
      }),
    ).toEqual(held.creation_binding);
    await expect(
      f.pool.query('UPDATE auth_registration_stage SET erasure_principal_id=$2 WHERE registration_id=$1', [
        stage.registration_id,
        creator.accountId,
      ]),
    ).rejects.toThrow('immutable');
  }, 120_000);

  test('credentialless automated provisioning inherits the same complete native stage', async () => {
    const person = await f.person('creation-credentialless-source');
    const { key, operation } = await automated(person.accountId);
    const approval = await f.approvals.approve(person.bearer, { operationKey: key, operation }, f.context());
    const result = await f.host.workflows.createAutomated({
      key,
      authorization: approval.reference,
      operatorAccountId: person.accountId,
      handle: operation.handle,
    });
    const { stage, receipt } = await parties(result.accountId);
    expect(receipt.provisioning_kind).toBe('credentialless');
    expect(stage.creation_context.operationKey).toBe(key);
    expect(stage.creation_approval_reference).toBe(approval.reference);
    expect(
      (await f.pool.query('SELECT password FROM account WHERE "userId"=$1', [result.accountId])).rows[0]!.password,
    ).toBeNull();
  }, 120_000);
});

function assertSource(stage: Record<string, unknown>, source: NativeCreationContext) {
  expect(stage.creation_context).toEqual(source);
  expect(stage.creation_approval_reference).toBe(source.approvalReference);
  expect(stage.erasure_actor_id).toBe(source.actorAccountId);
  expect(stage.erasure_human_id).toBe(source.actingHumanId);
  expect(stage.erasure_principal_id).toBe(source.principalAccountId);
  expect(stage.erasure_native_operator_id).toBe(source.operatorAccountId);
  expect(stage.erasure_client_id).toBe(source.operation.targetClientId);
  expect(stage.erasure_source_client_id).toBe(source.sourceClientId);
}
