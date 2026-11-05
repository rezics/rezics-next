import { actionDeclarations } from './native-account-bindings-fixture.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import {
  COMMITTED_CONTINUATION_ACTIONS,
  COMMITTED_CONTINUATION_RESUME_BUDGET_MS,
  CONTINUATION_NAMESPACE,
  ContinuationDeniedError,
  deletionAllowlist,
} from '../../src/access/committed-continuations.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { WORKFLOW_APPROVAL_ACTIONS, WorkflowApprovalDeniedError } from '../../src/access/workflow-approvals.ts';
import { derivedId, newId, routeOf } from '../../src/route/route.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const password = 'continuation-password';
const scopes = [
  'account:manage',
  'account:read',
  'account:update',
  'account:delete',
  'account:renew_cleanup',
  'account:suspend',
  ...WORKFLOW_APPROVAL_ACTIONS.keys(),
].sort();
const source = new URL(process.env.DATABASE_URL ?? '');
if (!source.protocol) throw new Error('DATABASE_URL must name a migrated isolated kernel database');
const suffix = randomUUID().replaceAll('-', '');
const authName = `continuation_auth_${suffix}`;
const connection = (name: string) => {
  const url = new URL(source.href);
  url.pathname = `/${name}`;
  return url.href;
};
const kernelUrl = source.href;
const authUrl = connection(authName);
const issuer = `https://continuation-${suffix}.auth.test`;
const audience = 'https://continuation.api.test';
const loginClient = 'continuation-login';
const appClient = 'continuation-app';
const routeKey = randomBytes(32);
const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const stagingKey = randomBytes(32);
const secret = randomBytes(48).toString('base64url');
const actions = new Map([...LIFECYCLE_ACTIONS, ...COMMITTED_CONTINUATION_ACTIONS, ...actionDeclarations(scopes)]);
let frozen: Date | null = null;
let expiryGovernor: Awaited<ReturnType<typeof person>> | undefined;
const clock = () => frozen ?? new Date();
const admin = new Pool({ connectionString: connection('postgres') });
const kernel = createPool(kernelUrl);
const facts = new Pool({ connectionString: kernelUrl });
let authPool: Pool | undefined;
/** Proofs outlive host.stop(), which ends only the pool handed to the Auth host. */
let proofsPool: Pool | undefined;
let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
let service: AuthService | undefined;
let bindings: ReturnType<typeof createNativeAccountBindings> | undefined;
let approvals: ReturnType<typeof import('../../src/access/workflow-approvals.ts').createWorkflowApprovals> | undefined;
const executorId = `continuation-${suffix}`;
const callers = new Map<string, Headers>();

const required = <T>(value: T | null | undefined, description: string): T => {
  if (value == null) throw new Error(description);
  return value;
};
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; '),
  });
const workflows = () => required(host, 'Auth host is stopped').workflows;
const authService = () => required(service, 'Auth service is stopped');
const readyBindings = () => required(bindings, 'Account bindings are not ready');
const readyApprovals = () => required(approvals, 'Workflow approvals are not ready');
const continuationIdFor = (accountId: string, operationKey: string) =>
  derivedId(CONTINUATION_NAMESPACE, `${accountId}:${operationKey}`, required(routeOf(accountId), 'Account route'));
async function request(path: string, body: unknown, caller?: string) {
  const response = await required(host, 'Auth host is stopped').handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: {
        origin: issuer,
        'content-type': 'application/json',
        cookie: caller ? (callers.get(caller)?.get('cookie') ?? '') : '',
      },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response;
}
async function login(email: string, clientId = appClient) {
  const response = await request('/signin', { email, password, client_id: clientId, scope: scopes });
  const handle = randomUUID();
  callers.set(handle, cookies(response));
  return handle;
}
async function bearer(caller: string) {
  const response = await request('/token', {}, caller);
  return (await response.json()).access_token as string;
}
async function person() {
  const id = randomUUID().replaceAll('-', '');
  const email = `${id}@example.test`;
  const handle = `human_${id}`;
  const registered = await workflows().register({ key: id, handle, email, password });
  const session = await login(email, loginClient);
  await request('/consent', { client_id: appClient, scope: scopes }, session);
  const caller = await login(email);
  return { accountId: registered.accountId, email, handle, caller };
}
async function startHost() {
  authPool = new Pool({ connectionString: authUrl });
  proofsPool ??= new Pool({ connectionString: authUrl });
  if (!bindings) {
    const proofs = createNativeWorkflowProofPorts({ database: proofsPool });
    bindings = createNativeAccountBindings({
      pool: kernel,
      access,
      actions,
      routeKey,
      clock,
      referenceKeys,
      auth: () => authService(),
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: proofsPool }),
        barriers: createBarrierProofVerifier({ database: proofsPool }),
      },
    });
    approvals = (await import('../../src/access/workflow-approvals.ts')).createWorkflowApprovals({
      pool: kernel,
      access,
      actions,
      referenceKeys,
      creationBinding: (input: {
        registrationId: string;
        operationKey: string;
        accountId?: string;
        reservationId?: string;
      }) => proofs.creationBinding(input),
    });
  }
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret,
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    siteActions: actions,
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    stagingKey,
    maintenanceSchedule: '0 0 1 1 *',
    executorId,
  });
  service = host.service;
  await host.start();
}
const pair = await generateKeyPair('ES256', { extractable: true });
const signingKey = { ...(await exportJWK(pair.privateKey)), kid: 'continuation-host' };
const access = createAccess({
  actions,
  auth: {
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetch: async () => authService().handler(new Request(`${issuer}/.well-known/jwks.json`)),
  },
});
const kernelHttp = createKernel({
  pool: kernel,
  routeKey,
  tokens: referenceKeys,
  access: () => access,
  writeRate: createWriteRateLimiter({ secret }),
});

async function userResult(work: Promise<unknown>) {
  try {
    return await work;
  } catch (error) {
    if (
      error instanceof WorkflowApprovalDeniedError ||
      (error instanceof Error && 'status' in error && error.status === 403)
    )
      return { outcome: 'denied' as const };
    throw error;
  }
}
function handleRoute(handle: string) {
  return createHash('sha256').update(handle).digest().readUInt16BE(0);
}
async function continuationRow(accountId: string, operationKey: string) {
  const row = await facts.query<{
    barrier: string;
    fence: string;
    ttl: boolean;
    live: boolean;
    document: Record<string, unknown>;
  }>(
    `SELECT c.barrier_transaction_id::text AS barrier, f.transaction_id::text AS fence,
            c.committed_expires_at = LEAST(c.created_at + interval '300 seconds',
              (SELECT a.expires_at FROM access.workflow_approval a
               WHERE a.operation_key = c.operation_key AND a.digest = c.operation_digest
               ORDER BY a.created_at DESC LIMIT 1) - interval '10 seconds') AS ttl,
            c.expires_at = c.committed_expires_at AS live, row_to_json(c) AS document
     FROM access.committed_continuation c
     JOIN access.lifecycle_fence_receipt f
       ON f.route = c.route AND f.account_id = c.account_id AND f.receipt_id = c.barrier_receipt_id
     WHERE c.route = $1 AND c.operation_key = $2`,
    [routeOf(accountId), operationKey],
  );
  return row.rows[0];
}
async function authUser(accountId: string) {
  return (await authPool!.query('SELECT id FROM "user" WHERE id=$1', [accountId])).rowCount;
}
async function link(operatorId: string, subjectId: string) {
  const reserved = await readyBindings().operators.reserveResponsibility({
    operatorAccountId: operatorId,
    subjectAccountId: subjectId,
    key: randomUUID(),
  });
  await readyBindings().operators.recordOperatorRelation({
    ...reserved.value,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    key: randomUUID(),
  });
  return reserved.value;
}
async function approveDelete(
  caller: string,
  accountId: string,
  responsibility?: { operatorAccountId: string; subjectAccountId: string; reservationId: string },
) {
  const key = randomUUID();
  const operation = {
    kind: 'delete' as const,
    accountId,
    authorization: 'bound-input',
    ...(responsibility ? { responsibility } : {}),
  };
  const approval = await readyApprovals().approve(
    await bearer(caller),
    { operationKey: key, operation },
    { pool: kernel, deadline: Date.now() + 10_000 },
  );
  return { key, operation, approval };
}
async function crashBeforeCleanup(run: () => Promise<unknown>) {
  const ports = readyBindings().workflowPorts;
  const original = ports.authorizeContinuation;
  if (!original) throw new Error('Continuation authorization is not installed');
  let crashed = false;
  ports.authorizeContinuation = async () => {
    crashed = true;
    throw new Error('crash before cleanup');
  };
  try {
    await run();
    throw new Error('deletion finished before the crash');
  } catch (error) {
    if (!crashed) throw error;
  } finally {
    ports.authorizeContinuation = original;
  }
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${authName}"`);
  migrateAuth(authUrl, fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
  await startHost();
  await authService().internal.registerClient({ clientId: loginClient, firstParty: true, scopes });
  await authService().internal.registerClient({ clientId: appClient, firstParty: false, scopes });
  expect(typeof kernelHttp.fetch).toBe('function');
});
afterAll(async () => {
  frozen = null;
  await host?.stop().catch(() => {});
  await proofsPool?.end().catch(() => {});
  await authPool?.end().catch(() => {});
  await kernel.end();
  await facts.end();
  await dropTestDatabase(admin, authName).catch(() => {});
  await admin.end();
});

test('a plain deletion commits erase and redirect only, and the continuation port refuses anything else', async () => {
  const human = await person();
  const { key, approval } = await approveDelete(human.caller, human.accountId);
  const outcome = await userResult(
    workflows().deleteAccount({ key, authorization: approval.reference, accountId: human.accountId }),
  );
  // The deletion removes the caller's own standing: the workflow's outcome is the answer.
  expect(outcome).toEqual({ accountId: human.accountId });
  const view = required(await readyBindings().continuations.read(key, human.accountId), 'Missing continuation');
  expect(view).not.toHaveProperty('response');
  expect(view).not.toHaveProperty('value');
  expect(view.allowlist).toEqual(
    required(
      deletionAllowlist({
        accountId: human.accountId,
        commandKeyPrefix: view.commandKeyPrefix,
        handle: human.handle,
        operatorAccountId: null,
        reservationId: null,
      }),
      'Deletion allowlist',
    ),
  );
  expect(view.allowlist.map((entry) => entry.step)).toEqual(['erase-auth-owner', 'redirect-deleted-handle']);
  const entry = view.allowlist[0]!;
  await expect(
    readyBindings().continuations.authorizeStep(view.reference, {
      ...entry,
      target: newId(required(routeOf(human.accountId), 'Account route')),
    }),
  ).rejects.toThrow(ContinuationDeniedError);
  await expect(
    readyBindings().continuations.authorizeStep(view.reference, { ...entry, key: `${entry.key}-other` }),
  ).rejects.toThrow();
  await expect(
    readyBindings().continuations.authorizeStep(view.reference, { ...entry, digest: 'ab'.repeat(32) }),
  ).rejects.toThrow();
  await expect(readyBindings().continuations.authorizeStep(approval.reference, entry)).rejects.toThrow();
  const row = required(await continuationRow(human.accountId, key), 'Continuation was not committed with the fence');
  expect(row.barrier).toBe(row.fence);
  expect(row.ttl).toBe(true);
  expect(JSON.stringify(row.document)).not.toContain('response');
  expect(await authUser(human.accountId)).toBe(0);
});

test('cleanup finishes from the continuation after the caller loses authority and the process restarts', async () => {
  const operator = await person();
  const subject = await person();
  const responsibility = await link(operator.accountId, subject.accountId);
  const { key, approval } = await approveDelete(subject.caller, subject.accountId, responsibility);
  await crashBeforeCleanup(() =>
    workflows().deleteAccount({
      key,
      authorization: approval.reference,
      accountId: subject.accountId,
      responsibility,
    }),
  );
  const row = required(await continuationRow(subject.accountId, key), 'Tombstone did not commit its continuation');
  expect(row.barrier).toBe(row.fence);
  expect(row.ttl).toBe(true);
  expect(row.live).toBe(true);
  expect(await authUser(subject.accountId)).toBe(1);
  await facts.query(
    `DELETE FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$2 AND action='account:delete'`,
    [routeOf(subject.accountId), subject.accountId],
  );
  await host?.stop();
  await startHost();
  const outcome = await userResult(workflows().resumeOperation(key));
  expect(outcome).toEqual({ outcome: 'denied' });
  expect(await authUser(subject.accountId)).toBe(0);
  const account = await facts.query<{ state: string; fenced: boolean }>(
    'SELECT state, authn_fenced AS fenced FROM access.account WHERE route=$1 AND account_id=$2',
    [routeOf(subject.accountId), subject.accountId],
  );
  expect(account.rows[0]).toEqual({ state: 'deleted', fenced: true });
  const handle = await facts.query<{ state: string }>(
    'SELECT state FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2',
    [handleRoute(subject.handle), subject.handle],
  );
  expect(handle.rows[0]?.state).toBe('reserved');
  const slot = await facts.query<{ terminal: boolean }>(
    `SELECT terminal FROM access.operator_relation_slot
     WHERE route=$1 AND subject_account_id=$2 AND reservation_id=$3`,
    [routeOf(subject.accountId), subject.accountId, responsibility.reservationId],
  );
  expect(slot.rows[0]?.terminal).toBe(true);
  const hold = await facts.query(
    `SELECT reservation_id FROM access.lifecycle_coordination
     WHERE route=$1 AND account_id=$2 AND reservation_id=$3 AND purpose='operator'`,
    [routeOf(operator.accountId), operator.accountId, responsibility.reservationId],
  );
  expect(hold.rowCount).toBe(0);
  const finished = await continuationRow(subject.accountId, key);
  const again = await userResult(workflows().resumeOperation(key));
  expect(again).toEqual({ outcome: 'denied' });
  expect(await continuationRow(subject.accountId, key)).toEqual(finished);
});

test('approval expiry bounds cleanup with a protected step left and an exhausted budget refuses the barrier', async () => {
  const governor = await person();
  expiryGovernor = governor;
  const operator = await person();
  const subject = await person();
  const responsibility = await link(operator.accountId, subject.accountId);
  await bootstrapGovernance(kernel, governor.accountId);
  const operation = { kind: 'fence-operator' as const, accountId: operator.accountId, authorization: 'bound-input' };
  const operationKey = randomUUID();
  const approval = await readyApprovals().approve(
    await bearer(governor.caller),
    { operationKey, operation },
    { pool: kernel, deadline: Date.now() + 10_000 },
  );
  const resolved = await readyApprovals().resolve(approval.reference, operation, {
    pool: kernel,
    deadline: Date.now() + 10_000,
  });
  const suspendApproved = (request: typeof resolved) =>
    required(
      (request as typeof resolved & { suspendOperator?: () => Promise<unknown> }).suspendOperator,
      'Resolved fencing operation has no native suspension',
    )();
  await suspendApproved(resolved);
  const view = required(await readyBindings().continuations.read(operationKey, operator.accountId), 'Missing root');
  expect(Date.parse(view.expiresAt)).toBe(Date.parse(approval.expiresAt) - COMMITTED_CONTINUATION_RESUME_BUDGET_MS);
  expect((await continuationRow(operator.accountId, operationKey))?.ttl).toBe(true);
  frozen = new Date(view.expiresAt);
  try {
    await expect(readyBindings().continuations.continueCommitted(view.reference)).rejects.toThrow(
      ContinuationDeniedError,
    );
    const resumed = await readyApprovals().resolve(approval.reference, operation, {
      pool: kernel,
      deadline: Date.now() + 10_000,
    });
    expect(await suspendApproved(resumed)).toEqual(await suspendApproved(resolved));
    expect(
      (
        await facts.query('SELECT 1 FROM access.lifecycle_coordination WHERE reservation_id=$1', [
          responsibility.reservationId,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    frozen = null;
  }

  const untouched = await person();
  const lateOperation = { ...operation, accountId: untouched.accountId };
  const lateKey = randomUUID();
  const late = await readyApprovals().approve(
    await bearer(governor.caller),
    { operationKey: lateKey, operation: lateOperation },
    { pool: kernel, deadline: Date.now() + 10_000 },
  );
  frozen = new Date(Date.parse(late.expiresAt) - COMMITTED_CONTINUATION_RESUME_BUDGET_MS);
  try {
    const request = await readyApprovals().resolve(late.reference, lateOperation, {
      pool: kernel,
      deadline: Date.now() + 10_000,
    });
    await expect(suspendApproved(request)).rejects.toThrow();
    expect(await readyBindings().continuations.read(lateKey, untouched.accountId)).toBeNull();
    const account = await facts.query(
      'SELECT state, authn_fenced FROM access.account WHERE route=$1 AND account_id=$2',
      [routeOf(untouched.accountId), untouched.accountId],
    );
    expect(account.rows[0]).toEqual({ state: 'active', authn_fenced: false });
  } finally {
    frozen = null;
  }
});

test('an expired continuation stays until current governance renews the same unfinished steps', async () => {
  const operator = await person();
  const subject = await person();
  const governor = expiryGovernor ?? (await person());
  const responsibility = await link(operator.accountId, subject.accountId);
  const { key, approval } = await approveDelete(subject.caller, subject.accountId, responsibility);
  const outsider = await bearer(operator.caller);
  // Commit the barrier five minutes in the past so the continuation is already
  // expired at wall time. Permission evidence cannot cover a future command clock.
  frozen = new Date(Date.now() - 5 * 60 * 1000 - 2_000);
  try {
    await crashBeforeCleanup(() =>
      workflows().deleteAccount({
        key,
        authorization: approval.reference,
        accountId: subject.accountId,
        responsibility,
      }),
    );
    const before = required(await readyBindings().continuations.read(key, subject.accountId), 'Missing continuation');
    const continuationId = continuationIdFor(subject.accountId, key);
    frozen = new Date(before.expiresAt);
    await expect(readyBindings().continuations.authorizeStep(before.reference, before.allowlist[0]!)).rejects.toThrow();
    expect(await authUser(subject.accountId)).toBe(1);
    const held = await facts.query(
      `SELECT reservation_id FROM access.lifecycle_coordination
       WHERE route=$1 AND account_id=$2 AND reservation_id=$3 AND purpose='operator'`,
      [routeOf(operator.accountId), operator.accountId, responsibility.reservationId],
    );
    expect(held.rowCount).toBe(1);
    const fenced = await facts.query<{ state: string; fenced: boolean }>(
      'SELECT state, authn_fenced AS fenced FROM access.account WHERE route=$1 AND account_id=$2',
      [routeOf(subject.accountId), subject.accountId],
    );
    expect(fenced.rows[0]).toEqual({ state: 'deleted', fenced: true });
    expect((await continuationRow(subject.accountId, key))?.live).toBe(true);
    await expect(readyBindings().continuations.renew(outsider, continuationId)).rejects.toThrow();
    await bootstrapGovernance(kernel, governor.accountId);
    const renewed = await readyBindings().continuations.renew(await bearer(governor.caller), continuationId);
    expect(renewed.expiresAt > before.expiresAt).toBe(true);
    const after = required(
      await readyBindings().continuations.read(key, subject.accountId),
      'Renewal dropped the continuation',
    );
    expect(after.allowlist).toEqual(before.allowlist);
    expect(after.expiresAt).toBe(renewed.expiresAt);
    const step = after.allowlist[0]!;
    const first = await readyBindings().continuations.authorizeStep(after.reference, step);
    const replay = await readyBindings().continuations.authorizeStep(after.reference, step);
    expect(replay.receiptId).toBe(first.receiptId);
    expect(
      (
        await facts.query(
          `SELECT reservation_id FROM access.lifecycle_coordination
           WHERE route=$1 AND account_id=$2 AND reservation_id=$3 AND purpose='operator'`,
          [routeOf(operator.accountId), operator.accountId, responsibility.reservationId],
        )
      ).rowCount,
    ).toBe(1);
    expect(await authUser(subject.accountId)).toBe(1);
  } finally {
    frozen = null;
  }
});
