import { afterAll, beforeAll, expect, test } from 'bun:test';
import { decodeJwt } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { readPublicAccount } from '../../src/access/public-identity.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { routeOf } from '../../src/route/route.ts';
import { nativeFixture, password, scopes, cookies } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
let f: Awaited<ReturnType<typeof nativeFixture>>;
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

test('the native fixture refuses a caller declaration that drops internal delete replay metadata', async () => {
  await expect(
    nativeFixture(pool, undefined, {
      database: f.database,
      privateKey: f.privateKey,
      actions: new Map([['account:delete', { anonymous: false }]]),
    }),
  ).rejects.toThrow('account:delete: declaration conflicts with internal Access action');
});

test('ordinary durable registration composes real pending receipt, Auth credentials and activation across host restart', async () => {
  const ref = await f.host.workflows.beginRegistration({ key: 'ordinary-pending', handle: 'ordinary_pending' });
  expect(await f.bindings.trustedAccess.readAccount(ref.accountId)).toBeNull();
  const stage = (
    await f.authPool.query(
      'SELECT reservation_id,pending_reference FROM auth_registration_stage WHERE registration_id=$1',
      [ref.registrationId],
    )
  ).rows[0];
  expect(stage.pending_reference).toBeString();
  const locator = { accountId: ref.accountId, reservationId: stage.reservation_id };
  const original = await f.proofs.pendingReference(locator);
  await f.restart();
  expect(await f.proofs.pendingReference(locator)).toBe(original);
  await f.host.workflows.installRegistrationCredential({
    registrationId: ref.registrationId,
    email: 'pending@ordinary.test',
    password,
  });
  const witness = await f.proofs.provisioningEvidence(locator);
  expect(await f.bindings.workflowPorts.provisioningEvidence(locator)).toEqual(witness);
  await f.restart();
  expect(await f.proofs.provisioningEvidence(locator)).toEqual(witness);
  expect(await f.host.workflows.activateRegistration(ref.registrationId)).toEqual({ accountId: ref.accountId });
  expect(await f.bindings.trustedAccess.readAccount(ref.accountId)).toMatchObject({
    state: 'active',
    automated: false,
  });
  expect((await f.authPool.query('SELECT id FROM "user" WHERE id=$1', [ref.accountId])).rowCount).toBe(1);
  expect((await f.authPool.query('SELECT id FROM account WHERE "userId"=$1', [ref.accountId])).rowCount).toBe(1);
});

test('real automated registration and operator session mint an ordinary API bearer', async () => {
  const human = await f.person('ordinary-human');
  const subject = await f.automated('ordinary-bot', human);
  expect(await readPublicAccount(pool, routeOf(subject.accountId)!, subject.accountId)).toMatchObject({
    state: 'active',
    operatorAccountId: human.accountId,
  });
  const operation = {
    kind: 'opening' as const,
    operatorAccountId: human.accountId,
    subjectAccountId: subject.accountId,
    authorization: 'approval-request',
  };
  const approved = await f
    .approval()
    .approve(human.bearer, { operationKey: 'ordinary-session', operation }, { pool, deadline: Date.now() + 10000 });
  const response = await f.host.workflows.openOperatorSession({
    key: 'ordinary-session',
    authorization: approved.reference,
    operatorAccountId: human.accountId,
    subjectAccountId: subject.accountId,
    headers: human.headers,
  });
  expect(response.status).toBe(200);
  const token = await f.request('/token', {}, cookies(response));
  expect(token.status).toBe(200);
  const { access_token } = (await token.json()) as { access_token: string };
  expect(decodeJwt(access_token)).toMatchObject({ sub: subject.accountId, client_id: 'ordinary-test-client' });
  const actor = await f.access.authenticate(access_token, { pool, deadline: Date.now() + 10000 });
  expect(actor.accountId).toBe(subject.accountId);
  expect([...actor.scopes].sort()).toEqual([...scopes].sort());
  expect(scopes).not.toContain('media:complete');
  await expect(
    f.host.workflows.openOperatorSession({
      key: 'ordinary-session',
      authorization: approved.reference,
      operatorAccountId: human.accountId,
      subjectAccountId: subject.accountId,
      headers: human.headers,
    }),
  ).rejects.toThrow();
});

test('committed pending, Auth credential, activation and operator proofs survive process death without duplicate identities', async () => {
  const human = await f.person('crash-native-owner');
  for (const phase of ['pending', 'credential', 'activation', 'operator']) {
    const key = `crash-native-${phase}`;
    await f.stop();
    const child = Bun.spawn([process.execPath, 'test/access/native-account-bindings-process.ts'], {
      cwd: import.meta.dir + '/../..',
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    child.stdin.write(
      JSON.stringify({
        phase,
        key,
        kernelUrl: process.env.DATABASE_URL,
        authUrl: f.database.url,
        privateKey: f.privateKey,
        human: { accountId: human.accountId, bearer: human.bearer },
      }),
    );
    child.stdin.end();
    const ready = (async () => {
      const reader = child.stdout.getReader();
      let output = '';
      while (true) {
        const next = await reader.read();
        if (next.done)
          throw new Error(`Host exited before ${phase}: ${output}\n${await new Response(child.stderr).text()}`);
        output += new TextDecoder().decode(next.value);
        if (output.includes('NATIVE_CRASH_READY')) return;
      }
    })();
    try {
      await ready;
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
    await f.restart();
    const result =
      phase === 'operator'
        ? await f.automated(key, human)
        : await f.host.workflows.register({
            key,
            handle: key.replaceAll('-', '_'),
            email: `${key}@ordinary.test`,
            password,
          });
    const row = (
      await f.authPool.query(
        'SELECT reservation_id,pending_reference,automated_reference FROM auth_registration_stage WHERE account_id=$1',
        [result.accountId],
      )
    ).rows[0];
    expect(row.pending_reference).toBeString();
    if (phase === 'operator') expect(row.automated_reference).toBeString();
    const locator = { accountId: result.accountId, reservationId: row.reservation_id };
    const witness = await f.proofs.provisioningEvidence(locator);
    expect(witness).not.toBeNull();
    expect((await f.authPool.query('SELECT id FROM "user" WHERE id=$1', [result.accountId])).rowCount).toBe(1);
    expect(
      (
        await f.authPool.query('SELECT account_id FROM auth_provisioning_receipt WHERE account_id=$1', [
          result.accountId,
        ])
      ).rowCount,
    ).toBe(1);
    await f.restart();
    expect(await f.proofs.pendingReference(locator)).toBe(row.pending_reference);
    expect(await f.proofs.provisioningEvidence(locator)).toEqual(witness);
  }
}, 120000);

test('creation approvals bind the generated native stage and current operator, including cached results', async () => {
  const owner = await f.person('ordinary-binding-owner');
  const other = await f.person('ordinary-binding-other');
  const key = 'ordinary-binding-bot';
  const operation = {
    kind: 'automated' as const,
    registrationId: '',
    operatorAccountId: owner.accountId,
    handle: 'ordinary_binding_bot',
    operationKey: key,
    authorization: 'approval-request',
  };
  const approval = await f
    .approval()
    .approve(owner.bearer, { operationKey: key, operation }, { pool, deadline: Date.now() + 10000 });
  const input = {
    key,
    handle: operation.handle,
    operatorAccountId: owner.accountId,
    authorization: approval.reference,
  };
  const result = await f.host.workflows.createAutomated(input);
  const stage = (
    await f.authPool.query('SELECT registration_id FROM auth_registration_stage WHERE account_id=$1', [
      result.accountId,
    ])
  ).rows[0];
  const current = { ...operation, registrationId: stage.registration_id, authorization: approval.reference };
  const noReader = createWorkflowApprovals({
    pool,
    access: f.access,
    actions: new Map([['account:manage', { anonymous: false }]]),
    referenceKeys: f.referenceKeys,
  });
  await expect(noReader.resolve(approval.reference, current, { pool, deadline: Date.now() + 10000 })).rejects.toThrow();
  expect(await f.approval().resolve(approval.reference, current, { pool, deadline: Date.now() + 10000 })).toBeDefined();
  for (const changed of [
    { ...current, handle: 'substituted_handle' },
    { ...current, operationKey: 'substituted-key' },
    { ...current, operatorAccountId: other.accountId },
    { ...current, registrationId: 'another-workflow' },
  ])
    await expect(
      f.approval().resolve(approval.reference, changed, { pool, deadline: Date.now() + 10000 }),
    ).rejects.toThrow();
  expect(await f.host.workflows.createAutomated(input)).toEqual(result);
  await f.bindings.internalLifecycle.raiseFence({ accountId: owner.accountId, key: 'binding-owner-native-fence' });
  await expect(f.host.workflows.createAutomated(input)).rejects.toThrow();
  await expect(
    f.host.workflows.revokeSessions({ accountId: other.accountId, key: 'unsupported-native-revoke' }),
  ).rejects.toThrow('Durable workflow approvals are unavailable');
});

test('native workflow history contains no registration credentials, cookies, bearer or private keys', async () => {
  const workflows = await f.authPool.query('SELECT inputs,output FROM auth_dbos.workflow_status');
  const steps = await f.authPool.query('SELECT output FROM auth_dbos.operation_outputs');
  const history = JSON.stringify([workflows.rows, steps.rows]);
  expect(history).not.toContain(password);
  expect(history).not.toContain('@ordinary.test');
  expect(history).not.toContain('access_token');
  expect(history).not.toContain('cookie');
  expect(history).not.toContain(f.privateKey.d!);
});

test('ordinary pending references retain provenance denials after a real operator relation commit', async () => {
  const operator = await f.person('pending-provenance-owner');
  const pending = await f.host.workflows.beginRegistration({ key: 'pending-provenance', handle: 'pending_provenance' });
  const row = (
    await f.authPool.query('SELECT reservation_id,pending_reference FROM auth_registration_stage WHERE account_id=$1', [
      pending.accountId,
    ])
  ).rows[0];
  const proof = createRegistrationProofBindings({ pool, referenceKeys: f.referenceKeys });
  expect(await proof.verifyNativePendingIdentity(row.pending_reference)).toMatchObject({
    automated: false,
    authnEpoch: 1,
    receipt: {
      registrationId: row.reservation_id,
      reservationId: row.reservation_id,
      authnEpoch: 1,
      expiresAt: pending.expiresAt,
    },
  });
  const held = await f.COMMANDS.operators.reserveResponsibility({
    operatorAccountId: operator.accountId,
    subjectAccountId: pending.accountId,
    key: 'provenance-operator',
  });
  const input = { ...held.value, expectedOperatorAccountId: null, expectedVersion: '0', key: 'provenance-relation' };
  const outcome = await f.COMMANDS.operators.recordOperatorRelation(input);
  expect(await proof.verifyProvisioningReceipt(row.pending_reference)).toBeNull();
  expect(await proof.verifyNativePendingIdentity(row.pending_reference)).toBeNull();
  await expect(f.bindings.trustedAccess.authorizeProvisioning(row.pending_reference)).rejects.toThrow();
  const chain = await proof.createAutomatedProvisioningReference({
    pendingReference: row.pending_reference,
    input,
    outcome,
  });
  expect(chain).toBeString();
  expect(await proof.verifyNativePendingIdentity(chain!)).toMatchObject({
    automated: true,
    operatorAccountId: operator.accountId,
  });
  await expect(f.bindings.trustedAccess.authorizeProvisioning(chain!)).rejects.toThrow();
  expect(
    await proof.createAutomatedProvisioningReference({
      pendingReference: row.pending_reference,
      input,
      outcome: { ...outcome, position: outcome.position + 1n },
    }),
  ).toBeNull();
});

test('automated provisioning rechecks approval after the relation commit and cannot activate under a fenced operator', async () => {
  const owner = await f.person('step-recheck-owner');
  const record = f.proofs.recordAutomatedPending;
  let subject: string | undefined;
  f.proofs.recordAutomatedPending = async (input) => {
    await record(input);
    subject = input.accountId;
    await f.COMMANDS.internalLifecycle.raiseFence({ accountId: owner.accountId, key: 'step-recheck-fence' });
  };
  try {
    await expect(f.automated('step-recheck-bot', owner)).rejects.toThrow();
  } finally {
    f.proofs.recordAutomatedPending = record;
  }
  expect(subject).toBeString();
  expect((await f.authPool.query('SELECT id FROM "user" WHERE id=$1', [subject])).rowCount).toBe(0);
  expect(await f.bindings.trustedAccess.readAccount(subject!)).toBeNull();
  expect((await f.bindings.workflowPorts.readAccount!(subject!))?.state).toBe('pending');
});
