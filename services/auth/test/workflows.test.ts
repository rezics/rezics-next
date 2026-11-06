import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthService, type AccessAccount } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';
import { encodeCursor } from '../../kernel/src/tokens/cursor.ts';

// Boundary evidence only: these journaled responses are not an Access policy
// implementation. workflow-handle.test.ts binds real Access handle commands.
const issuer = 'https://workflows.auth.test';
const password = `seeded-workflow-password-${randomBytes(18).toString('hex')}`;
const email = 'workflow-human@example.test';
const stagingKey = randomBytes(32);
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let system: Pool;
let auth: AuthService;
let workflows: ReturnType<typeof createAccountWorkflows>;
let options: Parameters<typeof createAccountWorkflows>[0];
let instant = Date.now();
let failRevoke = false;
let beforeRevoke: (() => Promise<void>) | undefined;
const accounts = new Map<string, AccessAccount>();
const calls: string[] = [];
const pageCalls: { operatorAccountId: string; limit?: number; cursor?: string }[] = [];
const continuationReads: { operationKey: string; accountId: string }[] = [];
const continuationAuthorizations: { reference: string; step: string; target: string }[] = [];
let suspensionCalls = 0;
const fanoutRows = Array.from({ length: 65 }, (_, i) => ({
  subjectAccountId: `workflow-fanout-${i}`,
  reservationId: `fixture-reservation-${i}`,
}));
const cursorKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const fanoutCursor = encodeCursor(
  cursorKeys,
  {
    operation: 'access.operator.responsibility.list',
    parameters: { operatorAccountId: 'workflow-fanout-operator', purpose: 'operator', sort: 'reservationId:asc' },
  },
  { epoch: 1, after: [fanoutRows[63]!.reservationId] },
);
const value = async <T>(kind: string, key: string, data: T) => {
  calls.push(kind);
  const result = await pool.query<{ value: T }>(
    'INSERT INTO test_workflow_command VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key RETURNING value',
    [key, kind, data],
  );
  return { value: result.rows[0]!.value, partition: 1, epoch: '1', position: '1', transactionId: key, replayed: false };
};
const ports: AccountWorkflowPorts = {
  async readAccount(id) {
    const account = accounts.get(id) ?? null;
    return (
      account && {
        accountId: account.accountId,
        handle: null,
        operatorAccountId: null,
        state: account.state,
        fenced: account.fenced ?? false,
      }
    );
  },
  async authorizeOperation(reference) {
    if (reference !== 'approved-fanout') throw new Error('Operation denied');
    return {
      actor: { accountId: 'approved-human' },
      async suspendOperator() {
        suspensionCalls++;
        return {
          accountId: 'workflow-fanout-operator',
          state: 'suspended' as const,
          receiptId: 'fixture-suspension-receipt',
          minimumAuthnEpoch: '2',
          continuationOperationKey: 'fixture-fanout-continuation',
        };
      },
    };
  },
  async readContinuation(operationKey, accountId) {
    continuationReads.push({ operationKey, accountId });
    if (operationKey !== 'fixture-fanout-continuation' || accountId !== 'workflow-fanout-operator') return null;
    return {
      reference: 'fixture-continuation-reference',
      operationKey,
      operationDigest: 'fixture-operation-digest',
      commandKeyPrefix: 'fixture-command',
      barrierReceiptId: 'fixture-suspension-receipt',
      expiresAt: new Date(instant + 1800000).toISOString(),
      allowlist: [
        {
          step: 'revoke-auth-sessions',
          target: accountId,
          key: 'fixture-revoke-sessions',
          digest: 'fixture-revoke-digest',
        },
      ],
    };
  },
  async authorizeContinuation(reference, entry) {
    continuationAuthorizations.push({ reference, step: entry.step, target: entry.target });
    return { receiptId: 'fixture-continuation-receipt' };
  },
  async responsibilityPage(input) {
    pageCalls.push(input);
    expect(input.limit).toBe(64);
    expect(input.operatorAccountId).toBe('workflow-fanout-operator');
    expect(Object.hasOwn(input, 'after')).toBe(false);
    if (input.cursor === undefined) return { operators: fanoutRows.slice(0, 64), next: fanoutCursor };
    expect(input.cursor).toBe(fanoutCursor);
    return { operators: fanoutRows.slice(64), next: null };
  },
  registrationTarget: (key) => `workflow-account-${key}`,
  async reserveHandle(input) {
    return value('reserve-handle', input.key, {
      handle: input.handle.toLowerCase(),
      accountId: input.accountId,
      reservationId: `reservation-${input.accountId}`,
      expiresAt: new Date(instant + 1800000).toISOString(),
    });
  },
  async createPending(input) {
    const result = await value('pending-account', input.key, {
      accountId: input.accountId,
      registrationId: input.reservationId,
      expiresAt: new Date(instant + 1800000).toISOString(),
    });
    if (!accounts.has(input.accountId))
      accounts.set(input.accountId, {
        accountId: input.accountId,
        kind: 'actor',
        state: 'pending',
        automated: false,
        authnEpoch: 1,
      });
    return result;
  },
  async claimHandle(input) {
    return value('claim-handle', input.key, { accountId: input.accountId, handle: input.handle });
  },
  async activate(input) {
    const result = await value('activate', input.key, { accountId: input.accountId });
    accounts.get(input.accountId)!.state = 'active';
    return result;
  },
  async expireRegistration(input) {
    accounts.get(input.accountId)!.state = 'deleted';
    accounts.get(input.accountId)!.fenced = true;
    return value('expire-registration', input.key, { accountId: input.accountId });
  },
  async releaseExpiredRegistrationHandle(input) {
    return value('release-expired-handle', input.key, { accountId: input.accountId, handle: input.handle });
  },
  async provisioningReference(input) {
    return input.accountId;
  },
  async provisioningEvidence(input) {
    return {
      accountId: input.accountId,
      registrationId: input.reservationId,
      authIdentityId: input.accountId,
      authnEpoch: 1,
    };
  },
  async raiseFence(input) {
    const account = accounts.get(input.accountId)!;
    const result = await value('fence', input.key, {
      accountId: input.accountId,
      receiptId: `${input.key}:receipt`,
      minimumAuthnEpoch: String(account.authnEpoch + 1),
      kind: 'fence',
      priorOperatorAccountId: null,
    });
    account.fenced = true;
    account.authnEpoch = Number(result.value.minimumAuthnEpoch);
    return result;
  },
};
function request(path: string, body: unknown) {
  return workflows.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: issuer },
      body: JSON.stringify(body),
    }),
  );
}
function signin(accountId: string, suppliedEmail = email) {
  return auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: issuer },
      body: JSON.stringify({
        account_id: accountId,
        password,
        client_id: 'workflow-web',
        scope: ['read'],
        ...(suppliedEmail === email ? {} : {}),
      }),
    }),
  );
}
async function restart() {
  await workflows.close();
  workflows = createAccountWorkflows(options);
  await workflows.start();
}
beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  await pool.query('CREATE DATABASE auth_workflow_system');
  const systemUrl = new URL(fixture.url);
  systemUrl.pathname = '/auth_workflow_system';
  system = new Pool({ connectionString: systemUrl.href });
  await pool.query(
    'CREATE TABLE test_workflow_command (key text PRIMARY KEY, kind text NOT NULL, value jsonb NOT NULL)',
  );
  const signing = await generateKeyPair('ES256', { extractable: true });
  auth = await createAuthService({
    database: pool,
    issuer,
    audience: 'https://workflows.api.test',
    secret: randomBytes(48).toString('hex'),
    signing: {
      activeKid: 'workflow-signer',
      privateKeys: [{ ...(await exportJWK(signing.privateKey)), kid: 'workflow-signer', alg: 'ES256' }],
    },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      readAccount: async (id) => accounts.get(id) ?? null,
      authorizeProvisioning: async (id) => ({ accountId: id }),
    }),
  });
  await auth.internal.registerClient({ clientId: 'workflow-web', firstParty: true, scopes: ['read'] });
  const effects = {
    ...auth.internal,
    async revokeSessions(id: string) {
      await beforeRevoke?.();
      if (failRevoke) throw new Error('Injected Auth outage');
      await auth.internal.revokeSessions(id);
    },
  };
  options = {
    database: pool,
    systemDatabaseUrl: systemUrl.href,
    stagingKey,
    turnstile: {
      secret: 'workflow-test-secret',
      fetch: (async () =>
        Response.json({
          success: true,
          action: 'signup',
          hostname: new URL(issuer).hostname,
        })) as unknown as typeof fetch,
    },
    auth: { ...auth, internal: effects },
    access: ports,
    clock: () => new Date(instant),
  };
  workflows = createAccountWorkflows(options);
  await workflows.start();
}, 60000);
afterAll(async () => {
  await workflows?.close();
  await system?.end();
  await pool?.end();
  fixture?.close();
});

test('registration persists DBOS pending history and resumes same identity after both executor interruptions', async () => {
  const pending = await workflows.beginRegistration({ key: 'recover-human', handle: 'Recover_Human' });
  expect(pending).toMatchObject({ accountId: 'workflow-account-recover-human' });
  expect((await signin(pending.accountId)).status).toBeGreaterThanOrEqual(400);
  const history = await system.query(
    'SELECT workflow_uuid, status, inputs FROM dbos.workflow_status WHERE workflow_uuid=$1',
    [pending.workflowId],
  );
  expect(history.rows).toHaveLength(1);
  expect(history.rows[0]!.status).toBe('PENDING');
  await restart();
  await workflows.installRegistrationCredential({ registrationId: pending.registrationId, email, password });
  expect((await pool.query('SELECT id FROM "user"')).rows).toEqual([{ id: pending.accountId }]);
  expect((await pool.query('SELECT "userId" FROM account')).rows).toEqual([{ userId: pending.accountId }]);
  expect((await signin(pending.accountId)).status).toBeGreaterThanOrEqual(400);
  await restart();
  const active = await workflows.activateRegistration(pending.registrationId);
  expect(active).toEqual({ accountId: pending.accountId });
  expect(await workflows.activateRegistration(pending.registrationId)).toEqual(active);
  expect((await signin(pending.accountId)).status).toBe(200);
  expect(
    (await system.query('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [pending.workflowId])).rows,
  ).toEqual([{ status: 'SUCCESS' }]);
  expect((await pool.query("SELECT kind FROM test_workflow_command WHERE kind='activate'")).rows).toHaveLength(1);
  await expect(workflows.beginRegistration({ key: 'recover-human', handle: 'different' })).rejects.toThrow();
}, 60000);

test('actual durable arguments, outputs, events, errors and logs never contain staged plaintext credentials', async () => {
  const tables = (await system.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='dbos'"))
    .rows;
  let serialized = '';
  for (const { tablename } of tables)
    serialized += JSON.stringify(
      (await system.query(`SELECT row_to_json(t) AS row FROM dbos."${tablename.replaceAll('"', '""')}" t`)).rows,
    );
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(email);
  expect(serialized).not.toContain(stagingKey.toString('hex'));
  const stages = JSON.stringify((await pool.query('SELECT * FROM auth_registration_stage')).rows);
  expect(stages).not.toContain(password);
  expect(stages).not.toContain(email);
  expect((await system.query('SELECT * FROM dbos.operation_outputs')).rows.length).toBeGreaterThan(0);
});

test('expired registration after credential and handle barrier releases failed claim and orphan credentials cannot signin', async () => {
  const pending = await workflows.beginRegistration({ key: 'expired-human', handle: 'expired-human' });
  await workflows.installRegistrationCredential({
    registrationId: pending.registrationId,
    email: 'expired-workflow@example.test',
    password,
  });
  expect(calls.indexOf('claim-handle')).toBeGreaterThan(calls.indexOf('pending-account'));
  instant += 1800001;
  await workflows.expireDueRegistrations();
  expect(accounts.get(pending.accountId)).toMatchObject({ state: 'deleted', fenced: true });
  expect((await signin(pending.accountId)).status).toBeGreaterThanOrEqual(400);
  await expect(workflows.activateRegistration(pending.registrationId)).rejects.toThrow();
  expect(calls.lastIndexOf('release-expired-handle')).toBeGreaterThan(calls.lastIndexOf('expire-registration'));
  expect((await pool.query('SELECT id FROM "user" WHERE id=$1', [pending.accountId])).rows).toEqual([]);
}, 30000);

test('revocation persists Access fence before first Auth side effect and outage recovery preserves exact receipt', async () => {
  const id = 'workflow-account-recover-human';
  const oldEpoch = accounts.get(id)!.authnEpoch;
  let observed = 0;
  beforeRevoke = async () => {
    observed++;
    expect(accounts.get(id)).toMatchObject({ fenced: true });
    expect(accounts.get(id)!.authnEpoch).toBeGreaterThan(oldEpoch);
    expect((await pool.query("SELECT value FROM test_workflow_command WHERE kind='fence'")).rows).toHaveLength(1);
  };
  failRevoke = true;
  await expect(workflows.revokeSessions({ accountId: id, key: 'revoke-human' })).rejects.toThrow();
  expect(observed).toBeGreaterThan(0);
  const fenced = { ...accounts.get(id)! };
  expect((await signin(id)).status).toBeGreaterThanOrEqual(400);
  failRevoke = false;
  await workflows.resumeOperation('revoke-human');
  expect(accounts.get(id)).toEqual(fenced);
  beforeRevoke = undefined;
}, 30000);

test('strict signup endpoint composes Auth while rejecting public account authority and raw Better Auth signup', async () => {
  expect(
    (
      await request('/signup', {
        key: 'unsafe',
        handle: 'unsafe',
        email,
        password,
        turnstile_token: 'workflow-test-token',
        account_id: 'chosen',
        kind: 'organization',
        authn_epoch: 100,
      })
    ).status,
  ).toBe(400);
  const signup = await request('/signup', {
    key: 'http-human',
    handle: 'http-human',
    email: 'http-workflow@example.test',
    password,
    turnstile_token: 'workflow-test-token',
  });
  expect(signup.status).toBe(201);
  expect(await signup.json()).toEqual({ accountId: 'workflow-account-http-human' });
  const raw = await request('/api/auth/sign-up/email', { name: 'raw', email, password });
  expect(raw.status).toBe(404);
}, 30000);

test('public signup binds credentials atomically and cannot take over a trusted staged request', async () => {
  const ref = await workflows.beginRegistration({ key: 'private-stage', handle: 'private-stage' });
  const takeover = await request('/signup', {
    key: 'private-stage',
    handle: 'private-stage',
    email: 'takeover@example.test',
    password,
    turnstile_token: 'workflow-test-token',
  });
  expect(takeover.status).toBeGreaterThanOrEqual(400);
  await workflows.installRegistrationCredential({
    registrationId: ref.registrationId,
    email: 'private-stage@example.test',
    password,
  });
  expect(await workflows.activateRegistration(ref.registrationId)).toEqual({ accountId: ref.accountId });

  const payload = {
    key: 'bound-signup',
    handle: 'bound-signup',
    email: 'bound-signup@example.test',
    password,
    turnstile_token: 'workflow-test-token',
  };
  const competing = { ...payload, password: `${password}-changed` };
  const responses = await Promise.all([request('/signup', payload), request('/signup', competing)]);
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status >= 400)).toHaveLength(1);
  const accepted = responses[0]!.status === 201 ? payload : competing;
  instant += 1800001;
  expect((await request('/signup', { ...accepted, turnstile_token: 'workflow-retry-token' })).status).toBe(201);
  expect((await pool.query('SELECT id FROM "user" WHERE id=$1', ['workflow-account-bound-signup'])).rows).toHaveLength(
    1,
  );
  let serialized = '';
  for (const { tablename } of (
    await system.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='dbos'")
  ).rows)
    serialized += JSON.stringify(
      (await system.query(`SELECT row_to_json(t) FROM dbos."${tablename.replaceAll('"', '""')}" t`)).rows,
    );
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(competing.password);
  expect(serialized).not.toContain(payload.email);
}, 30000);

test('operator fencing delegates fanout to a committed continuation and resumes Auth revocation once', async () => {
  const operator = 'workflow-fanout-operator';
  for (const id of [operator, ...fanoutRows.map((row) => row.subjectAccountId)]) {
    accounts.set(id, { accountId: id, kind: 'actor', state: 'active', automated: false, authnEpoch: 1 });
  }
  // A cursor is no operation authorization: denial happens before any page read.
  await expect(
    workflows.fenceOperator({ key: 'denied-fanout', accountId: operator, authorization: fanoutCursor }),
  ).rejects.toThrow();
  expect(pageCalls).toHaveLength(0);
  expect(suspensionCalls).toBe(0);
  let revokeAttempts = 0;
  beforeRevoke = async () => {
    revokeAttempts++;
  };
  failRevoke = true;
  await expect(
    workflows.fenceOperator({ key: 'cursor-fanout', accountId: operator, authorization: 'approved-fanout' }),
  ).rejects.toThrow();
  expect(suspensionCalls).toBe(1);
  expect(revokeAttempts).toBe(1);
  expect(pageCalls).toHaveLength(0);
  expect(continuationReads).toEqual([{ operationKey: 'fixture-fanout-continuation', accountId: operator }]);
  expect(continuationAuthorizations).toEqual([
    { reference: 'fixture-continuation-reference', step: 'revoke-auth-sessions', target: operator },
  ]);
  expect(fanoutRows.every((row) => accounts.get(row.subjectAccountId)!.fenced !== true)).toBe(true);
  failRevoke = false;
  await restart();
  expect(await workflows.resumeOperation('cursor-fanout')).toEqual({
    accountId: operator,
    state: 'suspended',
    receiptId: 'fixture-suspension-receipt',
    minimumAuthnEpoch: '2',
  });
  expect(suspensionCalls).toBe(1);
  expect(revokeAttempts).toBe(2);
  expect(pageCalls).toHaveLength(0);
  const completed = {
    suspensionCalls,
    revokeAttempts,
    continuationReads: continuationReads.length,
    continuationAuthorizations: continuationAuthorizations.length,
  };
  expect(await workflows.resumeOperation('cursor-fanout')).toEqual({
    accountId: operator,
    state: 'suspended',
    receiptId: 'fixture-suspension-receipt',
    minimumAuthnEpoch: '2',
  });
  expect({
    suspensionCalls,
    revokeAttempts,
    continuationReads: continuationReads.length,
    continuationAuthorizations: continuationAuthorizations.length,
  }).toEqual(completed);
  beforeRevoke = undefined;
}, 30000);

// The installed native host shares its database with copy custody. Exercise
// that lane as well as the historical separate-system-store restart above.
test('native copy registrations publish pending events across close/relaunch and concurrent callers', async () => {
  await workflows.close();
  for (let cycle = 0; cycle < 3; cycle++) {
    workflows = createAccountWorkflows({ ...options, systemDatabaseUrl: fixture.url });
    await Promise.all([workflows.start(), workflows.start()]);
    const opened = await Promise.all(
      [0, 1].map((index) =>
        workflows.beginRegistration({
          key: `native-relaunch-${cycle}-${index}`,
          handle: `Native_Relaunch_${cycle}_${index}`,
        }),
      ),
    );
    expect(new Set(opened.map((row) => row.accountId)).size).toBe(2);
    const rows = await pool.query('SELECT status FROM auth_dbos.workflow_status WHERE workflow_uuid=ANY($1::text[])', [
      opened.map((row) => row.workflowId),
    ]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.status === 'PENDING')).toBe(true);
    await workflows.close();
  }
}, 120_000);
