import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts, type WorkflowResponsibility } from '../src/workflows.ts';

// Boundary sequencing evidence only. Deterministic Access command values are
// journaled, with no policy evaluator. Native membership/handle enforcement is
// covered separately in the kernel PostgreSQL and DBOS suites.
let deployment: ReturnType<typeof testDatabase>;
let database: Pool;
let system: Pool;
let auth: Awaited<ReturnType<typeof createAuthService>>;
let workflows: ReturnType<typeof createAccountWorkflows>;
let options: Parameters<typeof createAccountWorkflows>[0];
const accounts = new Map<string, AccessAccount & { handle: string | null; operatorAccountId: string | null }>();
const calls: string[] = [];
const issuer = 'https://operations.auth.test';
const password = randomBytes(24).toString('base64url');
let failRelease = false;
let failErase = false;
let failRevoke: string | undefined;
let failAuthorizationAt: number | undefined;
let authorizationFailure: Error | undefined;
let authorizationCalls = 0;
const workflowId = (key: string) =>
  `accounts:${createHash('sha256')
    .update(JSON.stringify(`operation:${key}`))
    .digest('hex')}`;
async function result<T>(kind: string, key: string, value: T) {
  calls.push(kind);
  const row = (
    await database.query<{ value: T }>(
      'INSERT INTO test_operation_command VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET key=EXCLUDED.key RETURNING value',
      [key, kind, value],
    )
  ).rows[0]!;
  return { value: row.value };
}
const ports: AccountWorkflowPorts = {
  registrationTarget: (key) => `operation-account-${key}`,
  reserveHandle: async (input) =>
    result('reserve-handle', input.key, {
      ...input,
      reservationId: `claim:${input.accountId}`,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    }),
  async createPending(input) {
    const outcome = await result('pending', input.key, {
      accountId: input.accountId,
      registrationId: input.reservationId,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
    });
    if (!accounts.has(input.accountId))
      accounts.set(input.accountId, {
        accountId: input.accountId,
        handle: input.handle,
        state: 'pending',
        kind: 'actor',
        automated: false,
        authnEpoch: 1,
        operatorAccountId: null,
      });
    return outcome;
  },
  async activate(input) {
    const outcome = await result('activate', input.key, { accountId: input.accountId });
    accounts.get(input.accountId)!.state = 'active';
    return outcome;
  },
  claimHandle: async (input) => result('claim-handle', input.key, { accountId: input.accountId, handle: input.handle }),
  expireRegistration: async (input) => result('expire-registration', input.key, {}),
  releaseExpiredRegistrationHandle: async (input) => result('release-expired-handle', input.key, {}),
  provisioningReference: async ({ accountId }) => accountId,
  provisioningEvidence: async ({ accountId }) => accountId,
  async raiseFence(input) {
    const account = accounts.get(input.accountId)!;
    const outcome = await result('fence', input.key, {
      accountId: input.accountId,
      receiptId: `${input.key}:receipt`,
      minimumAuthnEpoch: String(account.authnEpoch + 1),
      kind: 'fence',
      priorOperatorAccountId: null,
    });
    account.fenced = true;
    account.authnEpoch = Number(outcome.value.minimumAuthnEpoch);
    return outcome;
  },
  async authorizeOperation(_reference, operation) {
    authorizationCalls += 1;
    if (failAuthorizationAt === authorizationCalls && authorizationFailure) throw authorizationFailure;
    return {
      actor: { accountId: 'boundary-approved-human' },
      async revokeSessions() {
        if (operation.kind !== 'revoke') throw new Error('Not a session revocation');
        const account = accounts.get(operation.accountId)!;
        const outcome = await result('revoke-fence', 'revocation-fence', {
          accountId: operation.accountId,
          receiptId: 'revocation-fence-receipt',
          minimumAuthnEpoch: String(account.authnEpoch + 1),
          kind: 'fence' as const,
          priorOperatorAccountId: null,
          continuationOperationKey: 'revocation',
        });
        Object.assign(account, { fenced: true, authnEpoch: Number(outcome.value.minimumAuthnEpoch) });
        return outcome.value;
      },
      async suspendOperator() {
        if (operation.kind !== 'fence-operator') throw new Error('Not an operator suspension');
        const outcome = await result('suspend-operator', 'fanout-suspension', {
          accountId: operation.accountId,
          state: 'suspended' as const,
          receiptId: 'fanout-suspension-receipt',
          minimumAuthnEpoch: '2',
          continuationOperationKey: 'fanout-continuation',
        });
        Object.assign(accounts.get(operation.accountId)!, { state: 'suspended', fenced: true, authnEpoch: 2 });
        return outcome.value;
      },
    };
  },
  async readContinuation(operationKey, accountId) {
    calls.push('continuation-read');
    const committed = await database.query<{ key: string }>(
      `SELECT key FROM test_operation_command WHERE key IN ('fanout-suspension','revocation-fence')
       AND value->>'continuationOperationKey'=$1 AND value->>'accountId'=$2`,
      [operationKey, accountId],
    );
    if (!committed.rowCount) return null;
    if (committed.rows[0]!.key === 'revocation-fence')
      return {
        reference: 'revocation-continuation-reference',
        operationKey,
        operationDigest: 'revocation-operation-digest',
        commandKeyPrefix: 'revocation-command',
        barrierReceiptId: 'revocation-fence-receipt',
        expiresAt: new Date(Date.now() + 1800000).toISOString(),
        allowlist: [{ step: 'revoke-auth-sessions', target: accountId, key: 'revocation-revoke', digest: 'digest' }],
      };
    return {
      reference: 'fanout-continuation-reference',
      operationKey,
      operationDigest: 'fanout-operation-digest',
      commandKeyPrefix: 'fanout-command',
      barrierReceiptId: 'fanout-suspension-receipt',
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      allowlist: [
        { step: 'revoke-auth-sessions', target: accountId, key: 'fanout-revoke', digest: 'fanout-revoke-digest' },
      ],
    };
  },
  async authorizeContinuation(reference, entry) {
    calls.push('continuation-authorize');
    if (reference === 'revocation-continuation-reference') return { receiptId: 'revocation-continuation-receipt' };
    expect(reference).toBe('fanout-continuation-reference');
    expect(entry).toEqual({
      step: 'revoke-auth-sessions',
      target: 'fanout-operator',
      key: 'fanout-revoke',
      digest: 'fanout-revoke-digest',
    });
    return { receiptId: 'fanout-continuation-receipt' };
  },
  readAccount: async (id) => {
    const account = accounts.get(id);
    return account ? { ...account, fenced: !!account.fenced } : null;
  },
  reserveResponsibility: async (input) =>
    result('reserve-operator', input.key, {
      operatorAccountId: input.operatorAccountId,
      subjectAccountId: input.subjectAccountId,
      reservationId: `operator:${input.key}`,
    }),
  async recordOperatorRelation(input) {
    const outcome = await result('record-relation', input.key, {
      operatorAccountId: input.operatorAccountId,
      subjectAccountId: input.subjectAccountId,
      reservationId: input.reservationId,
      version: String(Number(input.expectedVersion) + 1),
    });
    const account = accounts.get(input.subjectAccountId)!;
    account.automated = true;
    account.operatorAccountId = input.operatorAccountId;
    return outcome;
  },
  retireResponsibility: async (input) => result('retire-operator', input.key, input),
  async releaseResponsibility(input) {
    const outcome = await result('release-operator', input.key, input);
    if (failRelease) {
      failRelease = false;
      throw new Error('Lost release acknowledgement');
    }
    return outcome;
  },
  async tombstone(_context, input) {
    const account = accounts.get(input.accountId)!;
    const outcome = await result('tombstone', input.key, {
      accountId: input.accountId,
      receiptId: `${input.key}:receipt`,
      minimumAuthnEpoch: String(account.authnEpoch + 1),
      kind: 'tombstone',
      priorOperatorAccountId: account.operatorAccountId,
    });
    account.state = 'deleted';
    account.fenced = true;
    account.authnEpoch = Number(outcome.value.minimumAuthnEpoch);
    account.operatorAccountId = null;
    account.handle = null;
    return outcome;
  },
  redirectHandle: async (input) => result('redirect-deleted', input.key, input),
  responsibilityPage: async () => {
    calls.push('operator-page');
    throw new Error('The kernel continuation owns operated-account pages');
  },
};
async function restart() {
  await workflows.close();
  workflows = createAccountWorkflows(options);
  await workflows.start();
}
async function owner(id: string) {
  accounts.set(id, {
    accountId: id,
    handle: null,
    state: 'pending',
    kind: 'actor',
    automated: true,
    operatorAccountId: 'fixture-operator',
    authnEpoch: 1,
  });
  await auth.internal.provisionCredentialless({ authorization: id });
  accounts.get(id)!.state = 'active';
}
beforeAll(async () => {
  deployment = testDatabase();
  database = new Pool({ connectionString: deployment.url });
  await database.query('CREATE DATABASE operation_system');
  await database.query(
    'CREATE TABLE test_operation_command (key text PRIMARY KEY, kind text NOT NULL, value jsonb NOT NULL)',
  );
  const systemUrl = new URL(deployment.url);
  systemUrl.pathname = '/operation_system';
  system = new Pool({ connectionString: systemUrl.href });
  const signing = await generateKeyPair('ES256', { extractable: true });
  auth = await createAuthService({
    database,
    issuer,
    audience: 'https://operations.api.test',
    secret: randomBytes(48).toString('hex'),
    signing: {
      activeKid: 'operations',
      privateKeys: [{ ...(await exportJWK(signing.privateKey)), kid: 'operations', alg: 'ES256' }],
    },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
      },
      readAccount: async (id) => accounts.get(id) ?? null,
      readRecoveryAccount: async (id) => accounts.get(id) ?? null,
      authorizeProvisioning: async (accountId) => ({ accountId }),
    }),
  });
  await auth.internal.registerClient({ clientId: 'operation-web', firstParty: true, scopes: ['read'] });
  options = {
    database,
    systemDatabaseUrl: systemUrl.href,
    stagingKey: randomBytes(32),
    access: ports,
    auth: {
      ...auth,
      internal: {
        ...auth.internal,
        async provisionPassword(input) {
          const output = await auth.internal.provisionPassword(input);
          calls.push('auth-password');
          return output;
        },
        async provisionCredentialless(input) {
          const output = await auth.internal.provisionCredentialless(input);
          calls.push('auth-credentialless');
          return output;
        },
        async eraseAccount(id) {
          calls.push('auth-erase');
          expect(accounts.get(id)).toMatchObject({ state: 'deleted', fenced: true });
          if (failErase) throw new Error('Auth erasure unavailable');
          await auth.internal.eraseAccount(id);
        },
        async revokeSessions(id, cleanup) {
          calls.push('auth-revoke');
          if (failRevoke === id) throw new Error('Auth revocation unavailable');
          return auth.internal.revokeSessions(id, cleanup);
        },
      },
    },
  };
  workflows = createAccountWorkflows(options);
  await workflows.start();
}, 60000);
afterAll(async () => {
  await workflows?.close();
  await system?.end();
  await database?.end();
  deployment?.close();
});

test('automated actors reserve responsibility before linking and use real credentialless or password Auth owners', async () => {
  for (const credential of [undefined, { email: 'own-password@example.test', password }]) {
    calls.length = 0;
    const output = await workflows.createAutomated({
      key: credential ? 'password' : 'credentialless',
      authorization: 'approved-operator',
      operatorAccountId: 'fixture-operator',
      handle: credential ? 'password_actor' : 'credentialless_actor',
      ...(credential ? { credential } : {}),
    });
    expect(calls.indexOf('reserve-operator')).toBeLessThan(calls.indexOf('record-relation'));
    expect(calls.indexOf('record-relation')).toBeLessThan(
      calls.indexOf(credential ? 'auth-password' : 'auth-credentialless'),
    );
    expect(calls.indexOf('claim-handle')).toBeLessThan(calls.indexOf('activate'));
    expect(
      (
        await database.query('SELECT "userId", password IS NOT NULL AS has_password FROM account WHERE "userId"=$1', [
          output.accountId,
        ])
      ).rows,
    ).toEqual([{ userId: output.accountId, has_password: !!credential }]);
    expect(accounts.get(output.accountId)).toMatchObject({
      automated: true,
      operatorAccountId: 'fixture-operator',
      state: 'active',
    });
    const signin = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: output.accountId, password, client_id: 'operation-web', scope: ['read'] }),
      }),
    );
    if (!credential) expect(signin.status).toBeGreaterThanOrEqual(400);
    else expect(signin.status).toBe(200);
    expect(Object.keys(output)).toEqual(['accountId']);
  }
}, 30000);

test('operator transfer recovers native command keys and releases old responsibility only after relation and invalidation', async () => {
  const subject = [...accounts.values()].find((a) => a.automated && a.state === 'active')!.accountId;
  const previous: WorkflowResponsibility = {
    operatorAccountId: 'fixture-operator',
    subjectAccountId: subject,
    reservationId: 'previous-reservation',
  };
  calls.length = 0;
  failRelease = true;
  await expect(
    workflows.transferOperator({
      key: 'transfer',
      authorization: 'approved-transfer',
      previous,
      expectedVersion: '1',
      operatorAccountId: 'next-operator',
    }),
  ).rejects.toThrow();
  expect(calls.indexOf('reserve-operator')).toBeLessThan(calls.indexOf('record-relation'));
  expect(calls.indexOf('record-relation')).toBeLessThan(calls.indexOf('auth-revoke'));
  expect(calls.indexOf('auth-revoke')).toBeLessThan(calls.indexOf('release-operator'));
  await restart();
  await workflows.resumeOperation('transfer');
  expect(
    (await database.query("SELECT key FROM test_operation_command WHERE kind='release-operator'")).rows,
  ).toHaveLength(1);
  expect(accounts.get(subject)!.operatorAccountId).toBe('next-operator');
}, 30000);

test('deletion leaves Access tombstone fenced through Auth outage and releases responsibility only after erasure', async () => {
  const account = await workflows.createAutomated({
    key: 'delete',
    authorization: 'approved',
    operatorAccountId: 'fixture-operator',
    handle: 'delete_actor',
  });
  const command = (
    await database.query<{ value: WorkflowResponsibility }>(
      "SELECT value FROM test_operation_command WHERE kind='reserve-operator' AND value->>'subjectAccountId'=$1",
      [account.accountId],
    )
  ).rows[0]!.value;
  calls.length = 0;
  failErase = true;
  await expect(
    workflows.deleteAccount({
      key: 'deletion',
      authorization: 'approved',
      accountId: account.accountId,
      responsibility: command,
    }),
  ).rejects.toThrow();
  expect(accounts.get(account.accountId)).toMatchObject({ state: 'deleted', fenced: true });
  expect(calls).toEqual(['tombstone', 'auth-erase']);
  failErase = false;
  await restart();
  await workflows.resumeOperation('deletion');
  expect(calls.indexOf('retire-operator')).toBeGreaterThan(calls.indexOf('auth-erase'));
  expect(calls.indexOf('release-operator')).toBeGreaterThan(calls.indexOf('retire-operator'));
  expect((await database.query('SELECT id FROM "user" WHERE id=$1', [account.accountId])).rows).toEqual([]);
}, 30000);

test('operator suspension stays fenced until Auth revocation resumes through the committed continuation', async () => {
  await owner('fanout-operator');
  const items = Array.from({ length: 65 }, (_, i) => ({
    subjectAccountId: `fanout-${String(i).padStart(3, '0')}`,
    reservationId: `reservation-${i}`,
  }));
  for (const item of items) await owner(item.subjectAccountId);
  const sessionOwners = ['fanout-operator', items[0]!.subjectAccountId, items[64]!.subjectAccountId];
  await database.query(
    `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
     SELECT id,id,id,'operation-web',now()+interval '1 day',now(),'read',1,1,'pwd' FROM unnest($1::text[]) id`,
    [sessionOwners],
  );
  calls.length = 0;
  failRevoke = 'fanout-operator';
  await expect(
    workflows.fenceOperator({ key: 'fanout', authorization: 'approved-admin', accountId: 'fanout-operator' }),
  ).rejects.toThrow();
  expect(accounts.get('fanout-operator')).toMatchObject({ state: 'suspended', fenced: true, authnEpoch: 2 });
  expect(items.every((item) => accounts.get(item.subjectAccountId)!.fenced !== true)).toBe(true);
  expect(calls).toEqual(['suspend-operator', 'continuation-read', 'continuation-authorize', 'auth-revoke']);
  expect(
    (await database.query('SELECT id FROM session WHERE "userId"=ANY($1::text[])', [sessionOwners])).rowCount,
  ).toBe(3);
  expect(
    (await system.query("SELECT status FROM dbos.workflow_status WHERE name='accounts.operation' AND status='ERROR'"))
      .rows.length,
  ).toBeGreaterThan(0);
  failRevoke = undefined;
  await restart();
  const expected = {
    accountId: 'fanout-operator',
    state: 'suspended',
    receiptId: 'fanout-suspension-receipt',
    minimumAuthnEpoch: '2',
  };
  expect(await workflows.resumeOperation('fanout')).toEqual(expected);
  expect(accounts.get('fanout-operator')).toMatchObject({ state: 'suspended', fenced: true, authnEpoch: 2 });
  expect(items.every((item) => accounts.get(item.subjectAccountId)!.fenced !== true)).toBe(true);
  expect(calls).toEqual([
    'suspend-operator',
    'continuation-read',
    'continuation-authorize',
    'auth-revoke',
    'continuation-read',
    'continuation-authorize',
    'auth-revoke',
  ]);
  expect(
    (await database.query('SELECT id FROM session WHERE "userId"=ANY($1::text[]) ORDER BY id', [sessionOwners])).rows,
  ).toEqual([{ id: items[0]!.subjectAccountId }, { id: items[64]!.subjectAccountId }]);
  const completedCalls = [...calls];
  expect(await workflows.resumeOperation('fanout')).toEqual(expected);
  expect(calls).toEqual(completedCalls);
}, 30000);

test('a session revocation commits the Access fence before Auth is asked, answers revocation-failed and resumes under its continuation', async () => {
  await owner('revoked-person');
  await database.query(
    `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
     VALUES ('revoked-person','revoked-person','revoked-person','operation-web',now()+interval '1 day',now(),'read',1,1,'pwd')`,
  );
  calls.length = 0;
  failRevoke = 'revoked-person';
  await expect(
    workflows.revokeSessions({ key: 'revocation', accountId: 'revoked-person', authorization: 'approved-person' }),
  ).rejects.toMatchObject({ code: 'revocation-failed' });
  // The failure leaves the committed fence, and Auth kept the session.
  expect(accounts.get('revoked-person')).toMatchObject({ fenced: true, authnEpoch: 2 });
  expect(calls).toEqual(['revoke-fence', 'continuation-read', 'continuation-authorize', 'auth-revoke']);
  expect((await database.query(`SELECT id FROM session WHERE "userId"='revoked-person'`)).rowCount).toBe(1);
  failRevoke = undefined;
  await restart();
  expect(await workflows.resumeOperation('revocation')).toEqual({ accountId: 'revoked-person' });
  expect(calls.filter((call) => call === 'revoke-fence')).toHaveLength(1);
  expect(calls.filter((call) => call === 'auth-revoke')).toHaveLength(2);
  expect((await database.query(`SELECT id FROM session WHERE "userId"='revoked-person'`)).rowCount).toBe(0);
  expect(accounts.get('revoked-person')).toMatchObject({ fenced: true, authnEpoch: 2 });
}, 30000);

test('consent reduction commits native fence before actual Auth mutation and keeps old authority invalid', async () => {
  await owner('consent-owner');
  await auth.internal.registerClient({ clientId: 'consent-client', firstParty: false, scopes: ['read', 'write'] });
  await database.query('INSERT INTO auth_consent VALUES ($1,$2,$3)', [
    'consent-owner',
    'consent-client',
    ['read', 'write'],
  ]);
  calls.length = 0;
  await workflows.reduceConsent({
    key: 'consent',
    authorization: 'approved',
    accountId: 'consent-owner',
    clientId: 'consent-client',
    scopes: ['read'],
  });
  expect(calls[0]).toBe('fence');
  expect((await database.query('SELECT scopes FROM auth_consent WHERE account_id=$1', ['consent-owner'])).rows).toEqual(
    [{ scopes: ['read'] }],
  );
  expect(accounts.get('consent-owner')).toMatchObject({ fenced: true, authnEpoch: 2 });
}, 30000);

test('client scope reduction gates issuance and durably fences bounded owner pages before changing Auth configuration', async () => {
  await auth.internal.registerClient({ clientId: 'reduce-client', firstParty: true, scopes: ['read', 'write'] });
  // Reduction visits only this client's consent and issuance owners.
  await database.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes)
     SELECT id,'reduce-client',ARRAY['read','write'] FROM "user"`,
  );
  const ownerIds = (await database.query<{ id: string }>('SELECT id FROM "user" ORDER BY id')).rows.map((r) => r.id);
  const failure = ownerIds[1]!;
  failRevoke = failure;
  await expect(
    workflows.reduceClientScopes({
      key: 'client-reduction',
      authorization: 'approved-admin',
      clientId: 'reduce-client',
      firstParty: false,
      scopes: ['read'],
    }),
  ).rejects.toThrow();
  expect(
    (await database.query('SELECT scopes,first_party FROM auth_client WHERE client_id=$1', ['reduce-client'])).rows,
  ).toEqual([{ scopes: ['read', 'write'], first_party: true }]);
  expect((await database.query('SELECT client_id FROM auth_client_reduction')).rows).toEqual([
    { client_id: 'reduce-client' },
  ]);
  await expect(
    auth.internal.registerClient({ clientId: 'reduce-client', firstParty: true, scopes: ['read', 'write', 'extra'] }),
  ).rejects.toThrow();
  failRevoke = undefined;
  await restart();
  await workflows.resumeClientReduction('client-reduction');
  expect(
    (await database.query('SELECT scopes,first_party FROM auth_client WHERE client_id=$1', ['reduce-client'])).rows,
  ).toEqual([{ scopes: ['read'], first_party: false }]);
  expect((await database.query('SELECT client_id FROM auth_client_reduction')).rows).toEqual([]);
  expect(ownerIds.every((id) => accounts.get(id)!.fenced)).toBe(true);
  expect(
    (
      await system.query(
        "SELECT function_id FROM dbos.operation_outputs WHERE function_name='accounts.client-reduction-page'",
      )
    ).rows.length,
  ).toBeGreaterThan(1);
}, 30000);

test('a refusal is recognized by its status, whatever class the binding gives it', async () => {
  const reserveHandle = ports.reserveHandle;
  class BindingRefusal extends Error {
    readonly status = 403;
  }
  ports.reserveHandle = async () => {
    throw new BindingRefusal('Handle is held');
  };
  try {
    await expect(
      workflows.beginRegistration({ key: 'refused-handle', handle: 'refused_handle' }),
    ).rejects.toMatchObject({ code: 'handle_unavailable' });
  } finally {
    ports.reserveHandle = reserveHandle;
  }
}, 15000);

test('DBOS preserves only typed boundary status while sanitizing the original failure', async () => {
  class DifferentlyNamedBoundaryFailure extends Error {
    constructor(
      message: string,
      readonly status: number | undefined,
    ) {
      super(message);
    }
  }
  for (const status of [401, 403, 503, 500, undefined] as const) {
    const key = `boundary-status-${status}`;
    const secret = `private-boundary-${status}`;
    const failure = new DifferentlyNamedBoundaryFailure(secret, status);
    authorizationFailure = failure;
    authorizationCalls = 0;
    failAuthorizationAt = 2;
    try {
      const before = calls.length;
      const outcome = workflows.createOrganization({
        key,
        authorization: 'approved-organization',
        handle: `boundary-${status}`,
      });
      if (status === 401 || status === 403 || status === 503) await expect(outcome).rejects.toMatchObject({ status });
      else await expect(outcome).rejects.toThrow('Account workflow step failed: organization-key');
      expect(calls.length).toBe(before);
      const row = (
        await system.query<{ output: unknown; error: unknown }>(
          `SELECT output,error FROM dbos.operation_outputs WHERE workflow_uuid=$1 AND function_name='accounts.organization-key'`,
          [workflowId(key)],
        )
      ).rows[0];
      expect(row).toBeDefined();
      const persisted = String(row!.output ?? row!.error);
      if (status === 401 || status === 403 || status === 503) expect(persisted).toContain(`"status":${status}`);
      else expect(persisted).not.toContain('"status"');
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain('DifferentlyNamedBoundaryFailure');
      if (status === 401 || status === 403) {
        expect(row!.error).toBeNull();
        const saved = (await DBOS.listWorkflowSteps(workflowId(key)))!.find(
          (step) => step.name === 'accounts.organization-key',
        )!;
        expect(saved.output).toEqual({ authStepOutcome: 'refused-v1', status });
        // Restart and replay the durable result, with the failing source removed.
        // Replaying this refusal must not execute the source or a later effect.
        failAuthorizationAt = undefined;
        await restart();
        const authorizationCount = authorizationCalls;
        await expect(
          (await DBOS.rewindWorkflow(workflowId(key), { startStep: saved.functionID + 1 })).getResult(),
        ).rejects.toMatchObject({ status });
        expect(authorizationCalls).toBe(authorizationCount);
        expect(calls.length).toBe(before);
      } else expect(row!.output).toBeNull();
    } finally {
      failAuthorizationAt = undefined;
      authorizationFailure = undefined;
    }
  }
}, 30000);

test('an owner who leaves is released under the committed change and answered from the workflow outcome', async () => {
  const { authorizeOperation, setMembership, releaseMembershipCoordination, actorAccountId } = ports;
  let left = false;
  ports.authorizeOperation = async (reference, operation) => {
    // Once the owner has left they no longer hold the right they used.
    if (left) throw Object.assign(new Error('Approval denied'), { status: 403 });
    return authorizeOperation!(reference, operation);
  };
  ports.actorAccountId = () => 'leaving-owner';
  ports.setMembership = async () => {
    calls.push('set-membership');
    left = true;
    return { value: {} };
  };
  ports.releaseMembershipCoordination = async (input) => {
    calls.push(`release:${input.reservationId}`);
    return { value: {} };
  };
  try {
    calls.length = 0;
    expect(
      await workflows.setMembership({
        key: 'owner-leaves',
        authorization: 'approved',
        organizationId: 'leave-organization',
        memberAccountId: 'leaving-owner',
        role: null,
        reservationId: 'leaving-hold',
      }),
    ).toEqual({ accountId: 'leaving-owner' });
    expect(calls).toEqual(['set-membership', 'release:leaving-hold']);
  } finally {
    Object.assign(ports, { authorizeOperation, setMembership, releaseMembershipCoordination, actorAccountId });
  }
}, 15000);

test('a revocation by anyone else after an operation commits stops the result from being disclosed', async () => {
  const { authorizeOperation, setMembership, actorAccountId } = ports;
  let committed = false;
  ports.authorizeOperation = async (reference, operation) => {
    // The manager lost the right through someone else's act, not this operation's.
    if (committed) throw Object.assign(new Error('Approval denied'), { status: 403 });
    return authorizeOperation!(reference, operation);
  };
  ports.actorAccountId = () => 'managing-owner';
  ports.setMembership = async () => {
    calls.push('set-membership');
    committed = true;
    return { value: {} };
  };
  try {
    calls.length = 0;
    await expect(
      workflows.setMembership({
        key: 'manager-demotes',
        authorization: 'approved',
        organizationId: 'revoked-organization',
        memberAccountId: 'other-member',
        role: 'member',
        reservationId: 'demote-hold',
      }),
    ).rejects.toThrow();
    expect(calls).toContain('set-membership');
  } finally {
    Object.assign(ports, { authorizeOperation, setMembership, actorAccountId });
  }
}, 15000);

test('persisted operation history contains no staged credentials or Auth responses', async () => {
  let serialized = '';
  for (const { tablename } of (
    await system.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='dbos'")
  ).rows)
    serialized += JSON.stringify(
      (await system.query(`SELECT row_to_json(t) FROM dbos."${tablename.replaceAll('"', '""')}" t`)).rows,
    );
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain('own-password@example.test');
  expect(serialized).not.toContain('set-cookie');
});
