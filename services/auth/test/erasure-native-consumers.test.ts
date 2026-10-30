import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
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
  // This is a real approved self deletion. The creator holds no membership or
  // operator responsibility; the separate organization legitimately keeps its hold.
  void f.delete(creator).catch(() => {});
  await eventually(
    async () =>
      (await f.pool.query('SELECT pending_code FROM auth_erasure WHERE account_id=$1', [creator.accountId])).rows[0]
        ?.pending_code === 'native-stage',
  );
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
  f.bindings.workflowPorts.provisioningEvidence = async () => null;
  const deletion = f.delete(person);
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
  f.bindings.workflowPorts.provisioningEvidence = evidence;
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
  expect((await f.call('/recovery/start', { email: subject.email })).status).toBe(200);
  await eventually(async () => f.deliveries.some((message) => message.accountId === subject.accountId));
  const token = f.deliveries.find((message) => message.accountId === subject.accountId)!.token;
  const complete = f.bindings.trustedAccess.completeRecovery!;
  let reference = '';
  f.bindings.trustedAccess.completeRecovery = async (value) => {
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
  const witness = (
    await f.pool.query(
      'SELECT reference,receipt_id,account_id,establishment_id,effect_commitment,authn_epoch FROM auth_recovery_establishment WHERE reference=$1',
      [reference],
    )
  ).rows[0]!;
  expect(witness).toBeDefined();
  expect(
    (await f.pool.query("SELECT 1 FROM auth_native_consumer_proof WHERE store='recovery' AND key=$1", [reference]))
      .rowCount,
  ).toBe(0);
  const recovered = await f.login(subject, 'erasure-web', scopes, replacement);
  expect((await f.delete(recovered)).status).toBe(200);
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
    outcome: 'source-deleted',
    sourceResult: { accountId: subject.accountId, state: 'deleted', fenced: true },
  });
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

test('default native expiry releases the exact registration, handle and operator slot after the source deadline, across restart and duplicate delivery', async () => {
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
  const proof = (
    await f.pool.query("SELECT binding,result FROM auth_native_consumer_proof WHERE store='registration' AND key=$1", [
      expiredStage.registration_id,
    ])
  ).rows[0]!;
  expect(proof.binding).toEqual([
    expiredStage.registration_id,
    expiredStage.consumer_workflow_id,
    expiredStage.activation_key,
    expiredStage.account_id,
    expiredStage.handle,
    expiredStage.reservation_id,
    operatorId,
    expiredStage.operator_reservation_id,
  ]);
  expect(proof.result.outcome).toBe('expired');
  expect(proof.result.sourceResult.accountId).toBe(expiredStage.account_id);
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
  ).toEqual(proof.result.sourceResult);
  expect(
    (
      await f.bindings.workflowPorts.releaseExpiredRegistrationHandle({
        ...claim,
        key: `wf:${expiredStage.consumer_workflow_id}:release-expired`,
      })
    ).value,
  ).toEqual(proof.result.handleResult);
  const responsibility = {
    operatorAccountId: operatorId,
    subjectAccountId: expiredStage.account_id,
    reservationId: expiredStage.operator_reservation_id,
  };
  expect(proof.result.responsibilityResult).toEqual({ retired: responsibility, released: responsibility });
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
}, 2_000_000);
