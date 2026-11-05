import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import type { OriginalLifecycleRequest } from '@rezics/auth-contract';
import { failNativeQueries, nativeFixture, password, scopes, type Person } from './support/erasure-native.ts';

async function eventually(probe: () => Promise<boolean>, timeout = 120_000) {
  const until = Date.now() + timeout;
  while (!(await probe())) {
    if (Date.now() >= until) throw new Error('Default native consumer did not progress');
    await Bun.sleep(100);
  }
}
let f: Awaited<ReturnType<typeof nativeFixture>>;
let governor: Person;
let expiredStage: {
  registration_id: string;
  account_id: string;
  handle: string;
  reservation_id: string;
  expires_at: Date;
  consumer_workflow_id: string;
  operator_reservation_id: string;
  activation_key: string;
};
let creator: Person;
let operatorId: string;
let originalBarrier: number;
let restoreExpiryObservation: (() => void) | undefined;
const originalExpiryOutputs: { source?: unknown; handle?: unknown; retired?: unknown; released?: unknown } = {};
let expiredInput: Parameters<Awaited<ReturnType<typeof nativeFixture>>['host']['workflows']['createAutomated']>[0];
beforeAll(async () => {
  f = await nativeFixture();
  governor = await f.person('native-consumer-governor');
  await f.bootstrapGovernance(governor.accountId);
  const requested = [...scopes, 'access:grant', 'organization:create', 'client:manage'];
  await f.host.service.internal.registerClient({ clientId: 'native-governance', firstParty: true, scopes: requested });
  governor = await f.login(governor, 'native-governance', requested);
}, 120_000);
afterAll(async () => {
  restoreExpiryObservation?.();
  await f?.close();
}, 120_000);

test('a legitimate deleted creator keeps a pending registration secret-free until the real source expiry; a distinct living organization holds responsibility', async () => {
  creator = await f.person('native-consumer-creator');
  const organizationKey = randomUUID();
  const organizationOperation = {
    kind: 'organization' as const,
    handle: `op_${organizationKey.replaceAll('-', '')}`,
    authorization: 'approval-request',
  };
  const organizationApproval = await f.approvals.approve(
    governor.bearer,
    { operationKey: organizationKey, operation: organizationOperation },
    f.context(),
  );
  const organization = await f.host.workflows.createOrganization({
    key: organizationKey,
    handle: organizationOperation.handle,
    authorization: organizationApproval.reference,
  });
  if (!('accountId' in organization)) throw new Error('Missing actual organization result');
  operatorId = organization.accountId;
  const actor = await f.access.authenticate(governor.bearer, f.context());
  await f.bindings.grants.create(
    { ...f.context(), actor },
    {
      resource: { route: f.routeOf(operatorId)!, id: operatorId },
      subjectId: creator.accountId,
      subjectRole: '',
      actions: ['account:manage'],
      valid: '(,)',
      key: randomUUID(),
    },
  );
  const key = randomUUID();
  const operation = {
    kind: 'automated' as const,
    registrationId: '',
    operatorAccountId: operatorId,
    handle: `pending_${key.replaceAll('-', '')}`,
    operationKey: key,
    authorization: 'approval-request',
  };
  const approval = await f.approvals.approve(creator.bearer, { operationKey: key, operation }, f.context());
  const provision = f.bindings.workflowPorts.provisioningReference;
  let source: { accountId: string; reservationId: string } | undefined;
  f.bindings.workflowPorts.provisioningReference = async (input) => {
    source = input;
    throw new Error('Lost registration caller before provisioning');
  };
  expiredInput = {
    key,
    handle: operation.handle,
    operatorAccountId: operatorId,
    authorization: approval.reference,
    credential: { email: `${key}@consumer.test`, password },
  };
  try {
    await expect(f.host.workflows.createAutomated(expiredInput)).rejects.toThrow();
  } finally {
    f.bindings.workflowPorts.provisioningReference = provision;
  }
  expect(source).toBeDefined();
  expiredStage = (
    await f.pool.query(
      'SELECT registration_id,account_id,handle,reservation_id,expires_at,consumer_workflow_id,operator_reservation_id,activation_key FROM auth_registration_stage WHERE account_id=$1 AND reservation_id=$2',
      [source!.accountId, source!.reservationId],
    )
  ).rows[0]!;
  expect(expiredStage.operator_reservation_id).toBeString();
  // Observe actual original command outputs transiently; no persisted audit or
  // replacement result supplies the post-retirement replay oracle.
  const ports = f.bindings.workflowPorts;
  const expire = ports.expireRegistration;
  const releaseHandle = ports.releaseExpiredRegistrationHandle;
  const retire = ports.retireResponsibility;
  const releaseOperator = ports.releaseResponsibility;
  if (!retire || !releaseOperator) throw new Error('Native responsibility ports missing');
  ports.expireRegistration = async (input) => {
    const result = await expire(input);
    if (input.key === `wf:${expiredStage.consumer_workflow_id}:expire`) originalExpiryOutputs.source ??= result.value;
    return result;
  };
  ports.releaseExpiredRegistrationHandle = async (input) => {
    const result = await releaseHandle(input);
    if (input.key === `wf:${expiredStage.consumer_workflow_id}:release-expired`)
      originalExpiryOutputs.handle ??= result.value;
    return result;
  };
  ports.retireResponsibility = async (input) => {
    const result = await retire(input);
    if (input.key === `wf:${expiredStage.consumer_workflow_id}:retire-operator`)
      originalExpiryOutputs.retired ??= result.value;
    return result;
  };
  ports.releaseResponsibility = async (input) => {
    const result = await releaseOperator(input);
    if (input.key === `wf:${expiredStage.consumer_workflow_id}:release-operator`)
      originalExpiryOutputs.released ??= result.value;
    return result;
  };
  restoreExpiryObservation = () => {
    ports.expireRegistration = expire;
    ports.releaseExpiredRegistrationHandle = releaseHandle;
    ports.retireResponsibility = retire;
    ports.releaseResponsibility = releaseOperator;
  };
  // This is a real approved self deletion. The creator holds no membership or
  // operator responsibility; the separate organization legitimately keeps its hold.
  const creatorHandle = (await f.bindings.workflowPorts.readAccount(creator.accountId))!.handle;
  const redirect = f.bindings.workflowPorts.redirectHandle;
  if (!creatorHandle || !redirect) throw new Error('Native deletion requires its original handle and redirect port');
  let redirected: Parameters<typeof redirect>[0] | undefined;
  f.bindings.workflowPorts.redirectHandle = async (input) => {
    const result = await redirect(input);
    redirected = input;
    return result;
  };
  try {
    void f.delete(creator).catch(() => {});
    await eventually(
      async () =>
        (await f.pool.query('SELECT pending_code FROM auth_erasure WHERE account_id=$1', [creator.accountId])).rows[0]
          ?.pending_code === 'native-stage',
    );
  } finally {
    f.bindings.workflowPorts.redirectHandle = redirect;
  }
  // The actual source result precedes the long native wait; no expired
  // continuation or replacement approval is needed after registration expiry.
  expect(redirected?.accountId).toBe(creator.accountId);
  expect(redirected?.handle).toBe(creatorHandle);
  expect((await f.bindings.workflowPorts.readAccount(creator.accountId))!.state).toBe('deleted');
  expect((await f.bindings.workflowPorts.readAccount(operatorId))!.state).toBe('active');
  expect((await f.bindings.workflowPorts.readAccount(expiredStage.account_id))!.state).toBe('pending');
  expect(
    (
      await f.pool.query(
        'SELECT ciphertext,credential_digest,erasure_release_at FROM auth_registration_stage WHERE registration_id=$1',
        [expiredStage.registration_id],
      )
    ).rows[0],
  ).toEqual({ ciphertext: null, credential_digest: null, erasure_release_at: null });
  expect(
    (
      await f.pool.query("SELECT 1 FROM auth_native_consumer_proof WHERE store='registration' AND key=$1", [
        expiredStage.registration_id,
      ])
    ).rowCount,
  ).toBe(0);
  originalBarrier = (await f.pool.query('SELECT barrier FROM auth_erasure WHERE account_id=$1', [creator.accountId]))
    .rows[0]!.barrier;
}, 180_000);

test('Consume genuine original lifecycle result for terminal Auth continuation', async () => {
  const key = randomUUID();
  const email = `${key}@consumer.test`;
  const ports = f.bindings.workflowPorts;
  const activate = ports.activate;
  let committed: Awaited<ReturnType<typeof activate>> | undefined;
  let original: Parameters<typeof activate>[0] | undefined;
  ports.activate = async (input) => {
    original = input;
    committed = await activate(input);
    throw new Error('Lost original committed activation reply');
  };
  try {
    await expect(
      f.host.workflows.register({ key, handle: `original_${key.replaceAll('-', '')}`, email, password }),
    ).rejects.toThrow();
  } finally {
    ports.activate = activate;
  }
  if (!committed || !original) throw new Error('Missing actual original activation');
  const accountId = committed.value.accountId;
  const stage = (
    await f.pool.query<{
      registration_id: string;
      consumer_workflow_id: string;
      activation_key: string;
      reservation_id: string;
    }>(
      'SELECT registration_id,consumer_workflow_id,activation_key,reservation_id FROM auth_registration_stage WHERE account_id=$1',
      [accountId],
    )
  ).rows[0]!;
  const request: OriginalLifecycleRequest = {
    kind: 'activation',
    accountId,
    reservationId: stage.reservation_id,
    operationKey: original.key,
    source: {
      registrationId: stage.registration_id,
      provisioningReceiptKey: `registration:${stage.registration_id}`,
    },
  };
  const read = ports.readOriginalLifecycleResult;
  if (!read) throw new Error('Missing installed original lifecycle result reader');
  const result = await read(request);
  expect(result).toMatchObject({
    kind: 'activation',
    accountId,
    reservationId: stage.reservation_id,
    authnEpoch: 1,
    outcome: { value: committed.value },
  });
  expect(result?.outcome.position).toMatch(/^[1-9][0-9]*$/);
  expect(result?.outcome.transactionId).toBeString();
  const person = await f.login({ accountId, email });
  const evidence = ports.provisioningEvidence;
  let activationAttempts = 0;
  ports.provisioningEvidence = async () => null;
  ports.activate = async () => {
    activationAttempts++;
    throw new Error('Terminal consumption must not execute activation');
  };
  try {
    // The original reader remains available independently of transient evidence.
    // No caller retry or replacement approval is allowed to supply its result.
    expect(await read(request)).toEqual(result);
    void f.delete(person).catch(() => {});
    await eventually(
      async () =>
        !(await f.pool.query('SELECT 1 FROM auth_registration_stage WHERE registration_id=$1', [stage.registration_id]))
          .rowCount,
    );
    const proof = (
      await f.pool.query(
        "SELECT binding,result FROM auth_native_consumer_proof WHERE store='registration' AND key=$1",
        [stage.registration_id],
      )
    ).rows[0]!;
    expect(proof.binding.slice(0, 4)).toEqual([
      stage.registration_id,
      stage.consumer_workflow_id,
      stage.activation_key,
      accountId,
    ]);
    expect(proof.result).toEqual({ outcome: 'activated', sourceResult: committed.value });
    expect(activationAttempts).toBe(0);
  } finally {
    ports.provisioningEvidence = evidence;
    ports.activate = activate;
  }
}, 180_000);

test('terminal activation consumption preserves the exact original native outcome and receipt provenance', async () => {
  const key = randomUUID();
  const email = `${key}@consumer.test`;
  const ports = f.bindings.workflowPorts;
  const activate = ports.activate;
  let committed: Awaited<ReturnType<typeof activate>> | undefined;
  ports.activate = async (input) => {
    committed = await activate(input);
    throw new Error('Lost activation reply before native terminal consumption');
  };
  try {
    await expect(
      f.host.workflows.register({ key, handle: `receipt_${key.replaceAll('-', '')}`, email, password }),
    ).rejects.toThrow();
  } finally {
    ports.activate = activate;
  }
  if (!committed) throw new Error('Missing actual native activation');
  const accountId = committed.value.accountId;
  const stage = (
    await f.pool.query<{
      registration_id: string;
      activation_key: string;
      reservation_id: string;
    }>('SELECT registration_id,activation_key,reservation_id FROM auth_registration_stage WHERE account_id=$1', [
      accountId,
    ])
  ).rows[0]!;
  const request: OriginalLifecycleRequest = {
    kind: 'activation',
    accountId,
    reservationId: stage.reservation_id,
    operationKey: stage.activation_key,
    source: {
      registrationId: stage.registration_id,
      provisioningReceiptKey: `registration:${stage.registration_id}`,
    },
  };
  const read = ports.readOriginalLifecycleResult;
  if (!read) throw new Error('Missing installed original lifecycle result reader');
  const original = await read(request);
  if (!original || original.kind !== 'activation') throw new Error('Missing genuine original activation result');
  const receipt = (
    await f.kernel.query<{
      epoch: number;
      position: string;
      transaction_id: string;
      response: typeof original.outcome.value;
    }>(
      `SELECT epoch,position::text,transaction_id,response FROM core.receipt
       WHERE partition_no=$1 AND transaction_id=$2 AND command_kind='access.actor-activated'`,
      [original.outcome.partition, original.outcome.transactionId],
    )
  ).rows[0]!;
  expect(original).toEqual({
    kind: 'activation',
    accountId,
    reservationId: stage.reservation_id,
    authnEpoch: 1,
    outcome: {
      partition: original.outcome.partition,
      epoch: receipt.epoch,
      position: receipt.position,
      transactionId: receipt.transaction_id,
      value: receipt.response,
    },
  });
  expect(original.outcome.value).toEqual(committed.value);
  expect(await read({ ...request, operationKey: `${stage.activation_key}:foreign` })).toBeNull();
  expect(
    await read({ ...request, source: { ...request.source, provisioningReceiptKey: `registration:${randomUUID()}` } }),
  ).toBeNull();
  const person = await f.login({ accountId, email });
  const evidence = ports.provisioningEvidence;
  let activationAttempts = 0;
  ports.provisioningEvidence = async () => null;
  ports.activate = async () => {
    activationAttempts++;
    throw new Error('Original outcome consumption must execute no activation');
  };
  try {
    expect(await read(request)).toEqual(original);
    void f.delete(person).catch(() => {});
    await eventually(
      async () =>
        !(await f.pool.query('SELECT 1 FROM auth_registration_stage WHERE registration_id=$1', [stage.registration_id]))
          .rowCount,
    );
    const proof = (
      await f.pool.query(
        "SELECT binding,result FROM auth_native_consumer_proof WHERE store='registration' AND key=$1",
        [stage.registration_id],
      )
    ).rows[0]!;
    expect(proof.binding[2]).toBe(request.operationKey);
    expect(proof.result).toEqual({ outcome: 'activated', sourceResult: receipt.response });
    expect(activationAttempts).toBe(0);
    const after = (
      await f.kernel.query(
        'SELECT epoch,position::text,transaction_id,response FROM core.receipt WHERE partition_no=$1 AND transaction_id=$2 AND command_kind=$3',
        [original.outcome.partition, receipt.transaction_id, 'access.actor-activated'],
      )
    ).rows[0];
    expect(after).toEqual(receipt);
  } finally {
    ports.provisioningEvidence = evidence;
    ports.activate = activate;
  }
}, 180_000);

test('a lost activation reply is replayed with its original key, unavailable evidence remains pending, and default restart removes the actual release witness', async () => {
  const key = randomUUID();
  const email = `${key}@consumer.test`;
  const activate = f.bindings.workflowPorts.activate;
  let committed: Awaited<ReturnType<typeof activate>> | undefined;
  let originalInput: Parameters<typeof activate>[0] | undefined;
  f.bindings.workflowPorts.activate = async (input) => {
    originalInput = input;
    committed = await activate(input);
    throw new Error('Lost native activation reply');
  };
  try {
    await expect(
      f.host.workflows.register({ key, handle: `lost_${key.replaceAll('-', '')}`, email, password }),
    ).rejects.toThrow();
  } finally {
    f.bindings.workflowPorts.activate = activate;
  }
  expect(committed).toBeDefined();
  const accountId = committed!.value.accountId;
  const stage = (
    await f.pool.query(
      'SELECT registration_id,activation_key,consumer_workflow_id FROM auth_registration_stage WHERE account_id=$1',
      [accountId],
    )
  ).rows[0]!;
  expect(stage.activation_key).toBe(originalInput!.key);
  const person = await f.login({ accountId, email });
  const evidence = f.bindings.workflowPorts.provisioningEvidence;
  const readOriginal = f.bindings.workflowPorts.readOriginalLifecycleResult;
  if (!readOriginal) throw new Error('Missing installed original lifecycle result reader');
  f.bindings.workflowPorts.provisioningEvidence = async () => null;
  f.bindings.workflowPorts.readOriginalLifecycleResult = async (input) =>
    input.kind === 'activation' && input.source.registrationId === stage.registration_id ? null : readOriginal(input);
  const deletion = f.delete(person);
  try {
    await eventually(
      async () =>
        (await f.pool.query('SELECT pending_code FROM auth_erasure WHERE account_id=$1', [accountId])).rows[0]
          ?.pending_code === 'native-release',
    );
    expect(
      (
        await f.pool.query("SELECT 1 FROM auth_native_consumer_proof WHERE store='registration' AND key=$1", [
          stage.registration_id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query('SELECT 1 FROM auth_provisioning_receipt WHERE idempotency_key=$1', [
          `registration:${stage.registration_id}`,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    f.bindings.workflowPorts.provisioningEvidence = evidence;
    f.bindings.workflowPorts.readOriginalLifecycleResult = readOriginal;
  }
  // Default maintenance has no live caller and no new approval after restart.
  void deletion.catch(() => {});
  await f.host.workflows.close();
  await f.host.workflows.start();
  await eventually(
    async () =>
      !(await f.pool.query('SELECT 1 FROM auth_registration_stage WHERE registration_id=$1', [stage.registration_id]))
        .rowCount,
  );
  const proof = (
    await f.pool.query("SELECT binding,result FROM auth_native_consumer_proof WHERE store='registration' AND key=$1", [
      stage.registration_id,
    ])
  ).rows[0]!;
  expect(proof.binding.slice(0, 4)).toEqual([
    stage.registration_id,
    stage.consumer_workflow_id,
    originalInput!.key,
    accountId,
  ]);
  expect(proof.result).toEqual({ outcome: 'activated', sourceResult: committed!.value });
  expect(
    (
      await f.pool.query('SELECT 1 FROM auth_provisioning_receipt WHERE idempotency_key=$1', [
        `registration:${stage.registration_id}`,
      ])
    ).rowCount,
  ).toBe(0);
  await expect(activate(originalInput!)).rejects.toThrow();
  expect((await f.bindings.workflowPorts.readAccount(accountId))!.state).toBe('deleted');
  const independent = await f.person('native-independent-registration');
  expect((await f.bindings.workflowPorts.readAccount(independent.accountId))!.state).toBe('active');
}, 240_000);

test('real committed credential results win while fenced uncommitted effects cannot apply, and surviving authorized credentials and independent effects remain usable', async () => {
  const owner = await f.person('native-effect-owner');
  const survivor = await f.person('native-effect-subject');
  const clientId = randomUUID();
  await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes });
  await f.pool.query('UPDATE auth_client SET "userId"=$2 WHERE client_id=$1', [clientId, owner.accountId]);
  const clientSession = await f.login(survivor, clientId);
  const headers = new Headers({ cookie: clientSession.cookie });
  const pending = await f.host.service.internal.stageCredentialEffect({
    key: randomUUID(),
    subjectAccountId: survivor.accountId,
    headers,
    credential: { kind: 'password', password: 'must never become a surviving credential' },
  });
  const pendingInput = { ...pending, subjectAccountId: survivor.accountId, headers };
  const approval = await f.host.service.internal.approveCredentialEffect(pendingInput);
  const key = await generateKeyPair('ES256', { extractable: true });
  const kid = randomUUID();
  const committed = await f.host.service.internal.stageCredentialEffect({
    key: randomUUID(),
    subjectAccountId: survivor.accountId,
    headers,
    credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(key.publicKey)), alg: 'ES256', kid } },
  });
  const committedInput = { ...committed, subjectAccountId: survivor.accountId, headers };
  const committedApproval = await f.host.service.internal.approveCredentialEffect(committedInput);
  const result = await f.host.service.internal.applyCredentialEffect({
    ...committedInput,
    authorization: committedApproval.reference,
  });
  const expected = (
    await f.pool.query(
      'SELECT receipt_id,operation_key,effect_reference,effect_digest,committed_result FROM auth_effect_receipt WHERE effect_reference=$1',
      [pending.effectRef],
    )
  ).rows[0]!;
  const before = (
    await f.pool.query('SELECT id,password,"updatedAt" FROM account WHERE "userId"=$1 ORDER BY id', [
      survivor.accountId,
    ])
  ).rows;
  const publicBefore = (
    await f.pool.query('SELECT * FROM auth_public_key WHERE account_id=$1 AND kid=$2', [survivor.accountId, kid])
  ).rows;
  const unrelated = await f.host.service.internal.stageCredentialEffect({
    key: randomUUID(),
    subjectAccountId: survivor.accountId,
    headers: new Headers({ cookie: survivor.cookie }),
    credential: {
      kind: 'key',
      kid: 'independent-native-key',
      publicJwk: { ...(await exportJWK(key.publicKey)), alg: 'ES256', kid: 'independent-native-key' },
    },
  });
  let changed = false;
  const restore = failNativeQueries(f.pool, (sql) => {
    if (sql.startsWith('DELETE FROM "auth_effect_receipt"')) changed = true;
    return changed && sql.startsWith('UPDATE auth_erasure SET phase=');
  });
  try {
    expect((await f.delete(owner)).status).toBe(503);
  } finally {
    restore();
  }
  // The proof and both source deletions roll back with the page checkpoint.
  expect(
    (
      await f.pool.query('SELECT 1 FROM auth_effect_receipt WHERE receipt_id=ANY($1)', [
        [expected.receipt_id, result.receiptId],
      ])
    ).rowCount,
  ).toBe(2);
  expect(
    (
      await f.pool.query('SELECT 1 FROM auth_native_credential_terminal WHERE receipt_id=ANY($1)', [
        [expected.receipt_id, result.receiptId],
      ])
    ).rowCount,
  ).toBe(0);
  await f.host.workflows.close();
  await f.host.workflows.start();
  await eventually(
    async () =>
      !(
        await f.pool.query('SELECT 1 FROM auth_effect_receipt WHERE receipt_id=ANY($1)', [
          [expected.receipt_id, result.receiptId],
        ])
      ).rowCount,
  );
  const refused = (
    await f.pool.query(
      'SELECT operation_key,effect_reference,effect_digest,outcome,committed_result FROM auth_native_credential_terminal WHERE receipt_id=$1',
      [expected.receipt_id],
    )
  ).rows[0];
  expect(refused).toEqual({
    operation_key: expected.operation_key,
    effect_reference: expected.effect_reference,
    effect_digest: expected.effect_digest,
    outcome: 'fenced-refusal',
    committed_result: null,
  });
  expect(
    (
      await f.pool.query('SELECT outcome,committed_result FROM auth_native_credential_terminal WHERE receipt_id=$1', [
        result.receiptId,
      ])
    ).rows[0],
  ).toEqual({ outcome: 'committed', committed_result: { receiptId: result.receiptId, replayed: false } });
  expect(
    (
      await f.pool.query('SELECT 1 FROM auth_effect_receipt WHERE receipt_id=ANY($1)', [
        [expected.receipt_id, result.receiptId],
      ])
    ).rowCount,
  ).toBe(0);
  await expect(
    f.host.service.internal.applyCredentialEffect({ ...pendingInput, authorization: approval.reference }),
  ).rejects.toThrow();
  await expect(
    f.host.service.internal.applyCredentialEffect({ ...committedInput, authorization: committedApproval.reference }),
  ).rejects.toThrow();
  await expect(
    f.host.service.internal.stageCredentialEffect({
      key: pending.key,
      subjectAccountId: survivor.accountId,
      headers,
      credential: { kind: 'password', password },
    }),
  ).rejects.toThrow();
  await f.host.workflows.redriveNativeErasure();
  await f.host.workflows.redriveNativeErasure();
  expect(
    (
      await f.pool.query('SELECT id,password,"updatedAt" FROM account WHERE "userId"=$1 ORDER BY id', [
        survivor.accountId,
      ])
    ).rows,
  ).toEqual(before);
  expect(
    (await f.pool.query('SELECT * FROM auth_public_key WHERE account_id=$1 AND kid=$2', [survivor.accountId, kid]))
      .rows,
  ).toEqual(publicBefore);
  const unrelatedInput = {
    ...unrelated,
    subjectAccountId: survivor.accountId,
    headers: new Headers({ cookie: survivor.cookie }),
  };
  const unrelatedApproval = await f.host.service.internal.approveCredentialEffect(unrelatedInput);
  await f.host.service.internal.applyCredentialEffect({
    ...unrelatedInput,
    authorization: unrelatedApproval.reference,
  });
  expect((await f.login(survivor)).accountId).toBe(survivor.accountId);
}, 180_000);

test('an unknown historical native request keeps its exact witness and applicability without inferred terminality or acknowledgement', async () => {
  const owner = await f.person('native-unknown-request');
  const workflowId = `unknown-native-${randomUUID()}`;
  const payload = { legacy: 'unrecognized release binding' };
  await f.pool.query(
    'INSERT INTO auth_workflow_request (workflow_id,digest,request,erasure_subject_id) VALUES ($1,$2,$3,$4)',
    [workflowId, Buffer.alloc(32, 7), payload, owner.accountId],
  );
  expect((await f.delete(owner)).status).toBe(200);
  await eventually(
    async () =>
      (await f.pool.query('SELECT pending_code FROM auth_erasure WHERE account_id=$1', [owner.accountId])).rows[0]
        ?.pending_code === 'native-request',
  );
  await f.host.workflows.redriveNativeErasure();
  expect(
    (await f.pool.query('SELECT request,terminal_at FROM auth_workflow_request WHERE workflow_id=$1', [workflowId]))
      .rows[0],
  ).toEqual({ request: payload, terminal_at: null });
  const obligation = (
    await f.pool.query('SELECT applicable,native_completed_at FROM auth_erasure WHERE account_id=$1', [owner.accountId])
  ).rows[0];
  expect(obligation).toEqual({ applicable: true, native_completed_at: null });
}, 180_000);

test('real recovery establishment survives a lost committed source reply and obtains terminal source proof before its native witness is removed', async () => {
  const subject = await f.person('native-recovery-subject');
  // Native recovery establishes a human whose existing source fence must be
  // cleared. Use the real command, as in Access's recovery-completion contract.
  await f.bindings.workflowPorts.raiseFence({ accountId: subject.accountId, key: randomUUID() });
  expect((await f.call('/recovery/start', { email: subject.email })).status).toBe(200);
  await eventually(async () => f.deliveries.some((message) => message.accountId === subject.accountId));
  const token = f.deliveries.find((message) => message.accountId === subject.accountId)!.token;
  const complete = f.bindings.trustedAccess.completeRecovery!;
  let completionCalls = 0;
  let reference = '';
  f.bindings.trustedAccess.completeRecovery = async (value) => {
    completionCalls++;
    reference = value;
    await complete(value);
    throw new Error('Lost real recovery completion reply');
  };
  const replacement = 'native completed recovery replacement password';
  try {
    expect(
      (await f.call('/recovery/complete', { account_id: subject.accountId, token, new_password: replacement })).status,
    ).toBe(503);
  } finally {
    f.bindings.trustedAccess.completeRecovery = complete;
  }
  expect(reference).toBeString();
  expect(reference.length).toBe(64);
  const witness = (
    await f.pool.query(
      'SELECT reference,receipt_id,account_id,establishment_id,effect_commitment,authn_epoch FROM auth_recovery_establishment WHERE reference=$1',
      [reference],
    )
  ).rows[0]!;
  expect(witness).toBeDefined();
  const readOriginal = f.bindings.trustedAccess.readOriginalLifecycleResult;
  if (!readOriginal) throw new Error('Missing installed original recovery result reader');
  const observed: { request?: OriginalLifecycleRequest } = {};
  f.bindings.trustedAccess.readOriginalLifecycleResult = async (input) => {
    observed.request = structuredClone(input);
    return readOriginal(input);
  };
  let result;
  try {
    result = await f.host.nativeLifecycleResults.readRecoveryResult(reference);
  } finally {
    f.bindings.trustedAccess.readOriginalLifecycleResult = readOriginal;
  }
  if (!result || result.kind !== 'recovery' || !observed.request || observed.request.kind !== 'recovery')
    throw new Error('Missing genuine original recovery outcome');
  const original = result;
  const request = observed.request;
  expect(request).toEqual({
    kind: 'recovery',
    accountId: subject.accountId,
    operationKey: createHash('sha256')
      .update(
        JSON.stringify([
          'access-recovery-completion-v1',
          witness.account_id,
          witness.receipt_id,
          witness.establishment_id,
        ]),
      )
      .digest('hex'),
    source: { establishmentReference: reference },
  });
  expect(original.accountId).toBe(witness.account_id);
  expect(original.establishmentId).toBe(witness.establishment_id);
  expect(original.outcome.value).toEqual({
    accountId: witness.account_id,
    receiptId: witness.receipt_id,
    minimumAuthnEpoch: String(witness.authn_epoch),
  });
  const receipt = (
    await f.kernel.query(
      `SELECT epoch,position::text,transaction_id,response FROM core.receipt
       WHERE partition_no=$1 AND transaction_id=$2 AND command_kind='access.authentication-established'`,
      [original.outcome.partition, original.outcome.transactionId],
    )
  ).rows[0]!;
  expect(original.outcome).toEqual({
    partition: original.outcome.partition,
    epoch: receipt.epoch,
    position: receipt.position,
    transactionId: receipt.transaction_id,
    value: receipt.response,
  });
  expect(await readOriginal(request)).toEqual(original);
  expect(
    (await f.pool.query("SELECT 1 FROM auth_native_consumer_proof WHERE store='recovery' AND key=$1", [reference]))
      .rowCount,
  ).toBe(0);
  const recovered = await f.login(subject, 'erasure-web', scopes, replacement);
  const ports = f.bindings.workflowPorts;
  const consumerReader = ports.readOriginalLifecycleResult;
  if (!consumerReader) throw new Error('Missing installed native consumer reader');
  // The host retains the actual completion function. Its first effect-path
  // source read observes every invocation, including that retained function.
  const resolve = f.host.service.internal.resolveRecoveryEstablishment;
  let completionEffectReads = 0;
  f.host.service.internal.resolveRecoveryEstablishment = async (value) => {
    completionEffectReads++;
    return resolve(value);
  };
  try {
    ports.readOriginalLifecycleResult = async (input) =>
      input.kind === 'recovery' && input.source.establishmentReference === reference ? null : consumerReader(input);
    try {
      expect((await f.delete(recovered)).status).toBe(200);
      await eventually(
        async () =>
          (await f.pool.query('SELECT pending_code FROM auth_erasure WHERE account_id=$1', [subject.accountId])).rows[0]
            ?.pending_code === 'native-release',
      );
      expect((await ports.readAccount(subject.accountId))!).toMatchObject({ state: 'deleted', fenced: true });
      expect(
        (await f.pool.query("SELECT 1 FROM auth_native_consumer_proof WHERE store='recovery' AND key=$1", [reference]))
          .rowCount,
      ).toBe(0);
      expect(
        (await f.pool.query('SELECT 1 FROM auth_recovery_establishment WHERE reference=$1', [reference])).rowCount,
      ).toBe(1);
      expect(completionEffectReads).toBe(0);
    } finally {
      ports.readOriginalLifecycleResult = consumerReader;
    }
    expect(await consumerReader(request)).toEqual(original);
    await f.host.workflows.close();
    await f.host.workflows.start();
    await eventually(
      async () =>
        !(await f.pool.query('SELECT 1 FROM auth_recovery_establishment WHERE reference=$1', [reference])).rowCount,
    );
    expect(completionCalls).toBe(1);
    expect(completionEffectReads).toBe(0);
  } finally {
    f.host.service.internal.resolveRecoveryEstablishment = resolve;
  }
  expect(
    (await f.pool.query('SELECT 1 FROM auth_recovery_establishment WHERE reference=$1', [reference])).rowCount,
  ).toBe(0);
  const proof = (
    await f.pool.query("SELECT binding,result FROM auth_native_consumer_proof WHERE store='recovery' AND key=$1", [
      reference,
    ])
  ).rows[0]!;
  expect(proof.binding).toEqual([
    witness.reference,
    witness.receipt_id,
    witness.account_id,
    witness.establishment_id,
    witness.effect_commitment,
    witness.authn_epoch,
  ]);
  expect(proof.result).toEqual({
    outcome: 'released',
    sourceResult: original.outcome.value,
  });
  expect(
    (
      await f.kernel.query(
        `SELECT epoch,position::text,transaction_id,response FROM core.receipt
         WHERE partition_no=$1 AND transaction_id=$2 AND command_kind='access.authentication-established'`,
        [original.outcome.partition, original.outcome.transactionId],
      )
    ).rows[0],
  ).toEqual(receipt);
  await expect(complete(reference)).rejects.toThrow();
}, 180_000);

test('an interrupted real reduction finishes through the default consumer using the original source barrier, without changing surviving credentials', async () => {
  const owner = await f.person('native-reduction-owner');
  const subject = await f.person('native-reduction-subject');
  const clientId = randomUUID();
  await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes });
  await f.pool.query('UPDATE auth_client SET "userId"=$2 WHERE client_id=$1', [clientId, owner.accountId]);
  await f.login(subject, clientId);
  const before = (
    await f.pool.query('SELECT id,password,"updatedAt" FROM account WHERE "userId"=$1 ORDER BY id', [subject.accountId])
  ).rows;
  const key = randomUUID();
  const operation = {
    kind: 'client-reduction' as const,
    clientId,
    firstParty: false,
    scopes: ['account:read'],
    authorization: 'approval-request',
  };
  const approval = await f.approvals.approve(governor.bearer, { operationKey: key, operation }, f.context());
  const raise = f.bindings.workflowPorts.raiseFence;
  let barrier: Awaited<ReturnType<typeof raise>> | undefined;
  let sourceKey = '';
  f.bindings.workflowPorts.raiseFence = async (input) => {
    sourceKey = input.key;
    barrier = await raise(input);
    throw new Error('Lost committed reduction barrier reply');
  };
  try {
    await expect(
      f.host.workflows.reduceClientScopes({
        key,
        authorization: approval.reference,
        clientId,
        firstParty: false,
        scopes: operation.scopes,
      }),
    ).rejects.toThrow();
  } finally {
    f.bindings.workflowPorts.raiseFence = raise;
  }
  const progress = (
    await f.pool.query(
      'SELECT operation_id,page_count,completed_count FROM auth_client_reduction_progress WHERE client_id=$1',
      [clientId],
    )
  ).rows[0]!;
  expect(progress.page_count).toBe(1);
  expect(progress.completed_count).toBe(0);
  expect(sourceKey).toBe(`wf:${progress.operation_id}:fence:${subject.accountId}`);
  expect(barrier).toBeDefined();
  await f.host.workflows.close();
  await f.host.workflows.start();
  expect((await f.delete(owner)).status).toBe(200);
  expect(
    (await f.pool.query('SELECT 1 FROM auth_client_reduction_progress WHERE operation_id=$1', [progress.operation_id]))
      .rowCount,
  ).toBe(0);
  expect(
    (await f.pool.query('SELECT 1 FROM auth_workflow_request WHERE workflow_id=$1', [progress.operation_id])).rowCount,
  ).toBe(0);
  expect((await f.bindings.trustedAccess.readFencedAccount(subject.accountId))!.authnEpoch).toBe(
    Number(barrier!.value.minimumAuthnEpoch),
  );
  expect((await raise({ accountId: subject.accountId, key: sourceKey })).value).toEqual(barrier!.value);
  expect(
    (
      await f.pool.query('SELECT id,password,"updatedAt" FROM account WHERE "userId"=$1 ORDER BY id', [
        subject.accountId,
      ])
    ).rows,
  ).toEqual(before);
}, 180_000);

test('Retire exact Access authorization witnesses after genuine complete Auth consumer and copy custody', async () => {
  let owner = await f.person('native-access-witness-owner');
  const survivor = await f.person('native-access-witness-survivor');
  const survivorBefore = (
    await f.pool.query('SELECT id,password,"updatedAt" FROM account WHERE "userId"=$1 ORDER BY id', [
      survivor.accountId,
    ])
  ).rows;
  // Own-human credential authorization uses its original workflow approval,
  // never a fabricated self-operator opening or an inserted proof row.
  const effect = await f.host.service.internal.stageCredentialEffect({
    key: randomUUID(),
    subjectAccountId: owner.accountId,
    headers: new Headers({ cookie: owner.cookie }),
    credential: { kind: 'password', password },
  });
  const input = { ...effect, subjectAccountId: owner.accountId, headers: new Headers({ cookie: owner.cookie }) };
  const approval = await f.host.service.internal.approveCredentialEffect(input);
  await f.host.service.internal.applyCredentialEffect({ ...input, authorization: approval.reference });
  owner = await f.login(owner);
  const route = f.routeOf(owner.accountId)!;
  const floor = (
    await f.kernel.query<{ opening_receipt_id: string }>(
      'SELECT opening_receipt_id FROM access.credential_floor_receipt WHERE route=$1 AND account_id=$2',
      [route, owner.accountId],
    )
  ).rows;
  expect(floor).toHaveLength(1);
  const openingId = floor[0]!.opening_receipt_id;
  const witness = () =>
    f.kernel.query(
      'SELECT row_to_json(a)::text AS value FROM access.workflow_approval a WHERE route=$1 AND approval_id=$2',
      [route, openingId],
    );
  const floorWitness = () =>
    f.kernel.query(
      `SELECT row_to_json(r)::text AS value FROM access.credential_floor_receipt r
       WHERE route=$1 AND account_id=$2 AND opening_receipt_id=$3`,
      [route, owner.accountId, openingId],
    );
  // A real local read failure holds copy completion while the original source
  // and native consumers run. Restoring the query invokes the default publisher.
  const release = failNativeQueries(f.pool, (sql) => sql.includes('SELECT 1 FROM auth_copy_coverage'));
  const native = await import('../../kernel/src/access/erasure-native.ts');
  const phase = native.NATIVE_ERASURE_GROUPS.findIndex(
    ([store, role]) => store === 'workflow_approval' && role === 'actor_id',
  );
  let progressId = '';
  const until = Date.now() + 1_800_000;
  const advanceUntil = async (done: () => Promise<boolean>) => {
    while (!(await done())) {
      if (Date.now() >= until) throw new Error('Access witness native page did not progress');
      await native.advanceNativeErasure(f.kernel, progressId);
    }
  };
  try {
    expect((await f.delete(owner)).status).toBe(200);
    await eventually(
      async () =>
        !!(
          await f.kernel.query(
            `SELECT 1 FROM access.auth_history_proof WHERE route=$1 AND account_id=$2 AND phase='native-consumed'`,
            [route, owner.accountId],
          )
        ).rowCount,
    );
    progressId = await native.openNativeErasure(f.kernel, owner.accountId);
    await advanceUntil(
      async () =>
        !!(
          await f.kernel.query(
            `SELECT 1 FROM access.erasure_native_blocked WHERE progress_id=$1 AND phase=$2
         AND reason='approval-consumer-proof-unavailable'`,
            [progressId, phase],
          )
        ).rowCount,
    );
    expect(
      (
        await f.kernel.query(
          `SELECT 1 FROM access.auth_history_proof WHERE route=$1 AND account_id=$2 AND phase='copies-erased'`,
          [route, owner.accountId],
        )
      ).rowCount,
    ).toBe(0);
    const original = (await witness()).rows;
    const originalFloor = (await floorWitness()).rows;
    expect(original).toHaveLength(1);
    expect(originalFloor).toHaveLength(1);
    const page = (
      await f.kernel.query(
        `SELECT result FROM access.erasure_progress
       WHERE route=$1 AND account_id=$2 AND store='workflow_approval' AND role='actor_id'`,
        [route, owner.accountId],
      )
    ).rows[0]!.result;
    expect(page.keys).toContainEqual([String(route), openingId]);
    await native.advanceNativeErasure(f.kernel, progressId);
    expect((await witness()).rows).toEqual(original);
    expect((await floorWitness()).rows).toEqual(originalFloor);
  } finally {
    release();
  }
  // No consent clock adjustment or manufactured copy readiness: the real
  // producer must publish its later account/version/T after physical retirement.
  await eventually(
    async () =>
      !!(
        await f.kernel.query(
          `SELECT 1 FROM access.auth_history_proof p JOIN access.erasure e USING(route,account_id)
       WHERE p.route=$1 AND p.account_id=$2 AND p.phase='copies-erased'
       AND p.version=e.version AND p.at=e.at`,
          [route, owner.accountId],
        )
      ).rowCount,
    450_000,
  );
  // Historical copy publication cannot stand in for a current receiving owner.
  // Observe the original producer; never install an identity or insert a proof.
  const receiving = await import('../../kernel/src/access/shared-history-auth.ts');
  const barrier = (
    await f.kernel.query<{ accountId: string; version: number; at: string }>(
      'SELECT account_id AS "accountId",version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
      [route, owner.accountId],
    )
  ).rows[0]!;
  const prepare = (expected: typeof barrier) =>
    receiving.prepareCurrentAuthReceivingClosure({ pool: f.kernel }, expected, { deadline: Date.now() + 5000 });
  if (!(await prepare(barrier))) {
    const original = (await witness()).rows;
    const originalFloor = (await floorWitness()).rows;
    await native.advanceNativeErasure(f.kernel, progressId);
    expect((await witness()).rows).toEqual(original);
    expect((await floorWitness()).rows).toEqual(originalFloor);
  }
  await eventually(async () => (await prepare(barrier)) !== null, 450_000);
  expect(await prepare({ ...barrier, version: barrier.version + 1 })).toBeNull();
  expect(await prepare({ ...barrier, at: new Date(Date.parse(barrier.at) + 1).toISOString() })).toBeNull();
  await advanceUntil(
    async () =>
      !!(
        await f.kernel.query(
          `SELECT 1 FROM access.erasure_native_progress WHERE progress_id=$1 AND phase=$2 AND retry_phase=$3`,
          [progressId, native.NATIVE_ERASURE_GROUPS.length, phase],
        )
      ).rowCount,
  );
  expect((await witness()).rows).toEqual([]);
  await advanceUntil(async () => (await floorWitness()).rowCount === 0);
  expect(await native.openNativeErasure(f.kernel, owner.accountId)).toBe(progressId);
  await native.advanceNativeErasure(f.kernel, progressId);
  expect((await witness()).rows).toEqual([]);
  expect((await floorWitness()).rows).toEqual([]);
  await expect(f.access.authenticate(owner.bearer, f.context())).rejects.toThrow();
  expect(
    (
      await f.pool.query('SELECT id,password,"updatedAt" FROM account WHERE "userId"=$1 ORDER BY id', [
        survivor.accountId,
      ])
    ).rows,
  ).toEqual(survivorBefore);
  expect((await f.login(survivor)).accountId).toBe(survivor.accountId);
}, 2_000_000);

test('default native expiry releases the exact registration, handle and operator slot after the source deadline, across restart and duplicate delivery', async () => {
  try {
    // The source owns its thirty-minute pending lifetime. No test clock, source T,
    // terminal column, hold deletion or trigger bypass makes this case eligible.
    await eventually(
      async () =>
        !!(
          await f.pool.query("SELECT 1 FROM auth_native_consumer_proof WHERE store='registration' AND key=$1", [
            expiredStage.registration_id,
          ])
        ).rowCount,
      Math.max(120_000, expiredStage.expires_at.getTime() - Date.now() + 120_000),
    );
    await eventually(
      async () =>
        !(
          await f.pool.query('SELECT 1 FROM auth_registration_stage WHERE registration_id=$1', [
            expiredStage.registration_id,
          ])
        ).rowCount,
    );
    await eventually(
      async () =>
        !(
          await f.pool.query('SELECT 1 FROM auth_workflow_request WHERE workflow_id=$1', [
            expiredStage.consumer_workflow_id,
          ])
        ).rowCount,
    );
    const proof = (
      await f.pool.query(
        "SELECT binding,result FROM auth_native_consumer_proof WHERE store='registration' AND key=$1",
        [expiredStage.registration_id],
      )
    ).rows[0]!;
    expect(proof).toEqual({ binding: null, result: { outcome: 'expired' } });
    expect(originalExpiryOutputs.source).toBeDefined();
    const claim = {
      accountId: expiredStage.account_id,
      handle: expiredStage.handle,
      reservationId: expiredStage.reservation_id,
      expiresAt: expiredStage.expires_at.toISOString(),
    };
    expect(
      (
        await f.bindings.workflowPorts.expireRegistration({
          ...claim,
          key: `wf:${expiredStage.consumer_workflow_id}:expire`,
        })
      ).value,
    ).toEqual(originalExpiryOutputs.source);
    expect(
      (
        await f.bindings.workflowPorts.releaseExpiredRegistrationHandle({
          ...claim,
          key: `wf:${expiredStage.consumer_workflow_id}:release-expired`,
        })
      ).value,
    ).toEqual(originalExpiryOutputs.handle);
    expect(originalExpiryOutputs.handle).toEqual({ accountId: expiredStage.account_id, handle: expiredStage.handle });
    const responsibility = {
      operatorAccountId: operatorId,
      subjectAccountId: expiredStage.account_id,
      reservationId: expiredStage.operator_reservation_id,
    };
    expect({ retired: originalExpiryOutputs.retired, released: originalExpiryOutputs.released }).toEqual({
      retired: responsibility,
      released: responsibility,
    });
    const retire = f.bindings.workflowPorts.retireResponsibility;
    const release = f.bindings.workflowPorts.releaseResponsibility;
    if (!retire || !release) throw new Error('Native responsibility ports missing');
    expect(
      (await retire({ ...responsibility, key: `wf:${expiredStage.consumer_workflow_id}:retire-operator` })).value,
    ).toEqual(originalExpiryOutputs.retired);
    expect(
      (await release({ ...responsibility, key: `wf:${expiredStage.consumer_workflow_id}:release-operator` })).value,
    ).toEqual(originalExpiryOutputs.released);
    expect(
      (
        await f.kernel.query(
          'SELECT terminal,operator_account_id FROM access.operator_relation_slot WHERE route=$1 AND subject_account_id=$2 AND reservation_id=$3',
          [f.routeOf(expiredStage.account_id), expiredStage.account_id, expiredStage.operator_reservation_id],
        )
      ).rows[0],
    ).toEqual({ terminal: true, operator_account_id: operatorId });
    expect(
      (
        await f.kernel.query(
          'SELECT 1 FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
          [f.routeOf(operatorId), operatorId, expiredStage.operator_reservation_id],
        )
      ).rowCount,
    ).toBe(0);
    expect((await f.bindings.workflowPorts.readAccount(expiredStage.account_id))!.state).toBe('deleted');
    await eventually(
      async () =>
        !!(await f.pool.query('SELECT native_completed_at FROM auth_erasure WHERE account_id=$1', [creator.accountId]))
          .rows[0]?.native_completed_at,
    );
    expect(
      (
        await f.pool.query('SELECT 1 FROM auth_workflow_request WHERE workflow_id=$1', [
          expiredStage.consumer_workflow_id,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(f.host.workflows.createAutomated(expiredInput)).rejects.toThrow();
    expect((await f.pool.query('SELECT 1 FROM "user" WHERE id=$1', [expiredStage.account_id])).rowCount).toBe(0);
    await f.host.workflows.redriveNativeErasure();
    await f.host.workflows.redriveNativeErasure();
    expect(
      (
        await f.pool.query(
          "SELECT binding,result FROM auth_native_consumer_proof WHERE store='registration' AND key=$1",
          [expiredStage.registration_id],
        )
      ).rows[0],
    ).toEqual(proof);
    const erasure = (
      await f.pool.query(
        "SELECT barrier,consent_due_at>=accepted_at+interval '310 seconds' AS retained_cutoff,native_completed_at,pending_code FROM auth_erasure WHERE account_id=$1",
        [creator.accountId],
      )
    ).rows[0]!;
    expect(erasure.barrier).toBe(originalBarrier);
    expect(erasure.native_completed_at).toBeInstanceOf(Date);
    expect(erasure.retained_cutoff).toBe(true);
    expect(erasure.pending_code).not.toBe('none');
    expect((await f.bindings.workflowPorts.readAccount(operatorId))!.state).toBe('active');
  } finally {
    restoreExpiryObservation?.();
  }
}, 2_000_000);

// UNRUN receiving regression: neither the early transfer nor an old immutable
// copy publication authorizes removal of the native held tombstone witness.
test('native Auth fence witness survives historical closure without an independently installed receiver', async () => {
  const person = await f.person('native-receiving-witness');
  expect((await f.delete(person)).status).toBe(200);
  const barrier = await f.bindings.trustedAccess.readAuthErasureBarrier!(person.accountId);
  if (!barrier) throw new Error('Missing original deletion barrier');
  const route = f.routeOf(person.accountId)!;
  const selected = (
    await f.kernel.query<{ receipt_id: string }>(
      "SELECT receipt_id FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2 AND kind='tombstone'",
      [route, person.accountId],
    )
  ).rows[0];
  if (!selected) throw new Error('Missing original tombstone witness');
  await f.kernel.query(
    `INSERT INTO access.auth_history_proof(route,account_id,phase,version,at)
    VALUES($1,$2,'copies-erased',$3,$4) ON CONFLICT DO NOTHING`,
    [route, person.accountId, barrier.version, barrier.at],
  );
  const { terminalStoreBlocker } = await import('../../kernel/src/access/erasure-native-consumers.ts');
  const tx = await f.kernel.connect();
  try {
    await tx.query('BEGIN');
    expect(
      await terminalStoreBlocker(
        tx,
        'lifecycle_fence_receipt',
        'account_id',
        [String(route), person.accountId, selected.receipt_id],
        person.accountId,
        randomUUID(),
        -1,
        true,
      ),
    ).not.toBeNull();
    await expect(
      tx.query('DELETE FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2 AND receipt_id=$3', [
        route,
        person.accountId,
        selected.receipt_id,
      ]),
    ).rejects.toThrow('Auth current receiving closure unavailable');
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  expect(
    (
      await f.kernel.query(
        'SELECT 1 FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2 AND receipt_id=$3',
        [route, person.accountId, selected.receipt_id],
      )
    ).rowCount,
  ).toBe(1);
}, 120_000);
