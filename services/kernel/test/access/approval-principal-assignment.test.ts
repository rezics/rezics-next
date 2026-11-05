import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AccountOperation,
  type AuthService,
} from '@rezics/auth';
import { migrate } from '../../../auth/scripts/database.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWorkflowApprovals, workflowApprovalBinding } from '../../src/access/workflow-approvals.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { registerTestClient, testKernel, testRouteKey, testTokens } from '../support/test-kernel.ts';

/** Real Auth host, native registration and Auth-issued tokens verified via JWKS.
 * The host can be rebuilt over the same databases, which is a process restart. */
async function fixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const suffix = randomUUID().replaceAll('-', '');
  const authName = `assignment_auth_${suffix}`;
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authName}`;
  await db.admin.query(`CREATE DATABASE "${authName}"`);
  migrate(authUrl.href, fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
  const proofsPool = new Pool({ connectionString: authUrl.href });
  const issuer = `https://assignment-${suffix}.auth.test`;
  const audience = 'https://assignment.api.test';
  const password = 'principal assignment native password';
  const actions = new Map([
    ...LIFECYCLE_ACTIONS,
    ['access:grant', { anonymous: false }],
    ['account:manage', { anonymous: false }],
  ]);
  const scopes = [...actions.keys()];
  const secret = randomBytes(48).toString('base64url');
  const stagingKey = randomBytes(32);
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'assignment-host',
  };
  let service: AuthService;
  let host: Awaited<ReturnType<typeof createAuthHost>>;
  const referenceKeys = testTokens();
  const kernel = testKernel({
    pool: db.pool,
    actions,
    tokens: referenceKeys,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const access = kernel.testAccess;
  const proofs = createNativeWorkflowProofPorts({ database: proofsPool });
  const bindings = createNativeAccountBindings({
    pool: db.pool,
    access,
    actions,
    routeKey: testRouteKey(),
    referenceKeys,
    auth: () => service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: proofsPool }),
      barriers: createBarrierProofVerifier({ database: proofsPool }),
    },
  });
  const approvals = createWorkflowApprovals({
    pool: db.pool,
    access,
    actions,
    referenceKeys,
    creationBinding: proofs.creationBinding,
  });
  async function build() {
    const authPool = new Pool({ connectionString: authUrl.href });
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
      executorId: `assignment-${suffix}`,
    });
    service = host.service;
    await host.start();
  }
  await build();
  await registerTestClient(service!, { clientId: 'assignment-test', firstParty: true, actions, scopes });
  const context = () => ({ pool: db.pool, deadline: Date.now() + 10000 });
  const post = (path: string, body: unknown, cookie?: string) =>
    host.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );
  /** Auth issues the token from a real session; a delegated one names the assignment. */
  async function bearer(email: string, requestedBy?: string) {
    const signin = await post('/signin', { email, password, client_id: 'assignment-test', scope: scopes });
    if (!signin.ok) throw new Error(`Native sign-in: ${signin.status}`);
    const cookie = signin.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const token = await post('/token', requestedBy === undefined ? {} : { requested_by: requestedBy }, cookie);
    if (!token.ok) throw new Error(`Native token: ${token.status}`);
    return ((await token.json()) as { access_token: string }).access_token;
  }
  async function human() {
    const key = randomUUID();
    const email = `${key}@assignment.test`;
    const handle = `human_${key.replaceAll('-', '')}`;
    const { accountId } = await host.workflows.register({ key, handle, email, password });
    return { accountId, email, handle, token: await bearer(email) };
  }
  async function governance(accountId: string) {
    const child = Bun.spawn(['bun', 'services/kernel/scripts/bootstrap-governance.ts', '--account', accountId], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: db.url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(child.stderr).text();
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: '' });
  }
  const operation = (handle = `org_${randomUUID().replaceAll('-', '')}`): AccountOperation => ({
    kind: 'organization',
    handle,
    authorization: 'input',
  });
  async function approve(token: string, input: AccountOperation = operation(), operationKey = randomUUID()) {
    const approval = await approvals.approve(token, { operationKey, operation: input }, context());
    const request = await approvals.resolve(approval.reference, input, context());
    const prefix = workflowApprovalBinding(request)!.commandKeyPrefix;
    return {
      approval,
      input,
      operationKey,
      accountId: bindings.internalLifecycle.registrationTarget(`${prefix}:organization-id`),
    };
  }
  async function create(f: Awaited<ReturnType<typeof approve>>, key: string = randomUUID()) {
    if (f.input.kind !== 'organization') throw new Error('Expected organization');
    return host.workflows.createOrganization({ key, handle: f.input.handle, authorization: f.approval.reference });
  }
  return {
    db,
    approvals,
    context,
    password,
    bearer,
    human,
    governance,
    approve,
    create,
    get host() {
      return host;
    },
    /** A process restart: the Auth host stops and starts again over the same databases. */
    async restart() {
      await host.stop();
      await build();
    },
    async close() {
      await host.stop();
      await proofsPool.end();
      await db.admin.query(`DROP DATABASE "${authName}"`);
      await db.close();
    },
  };
}

/** A person acting for a principal through a principal assignment, against real
 * Access approvals and the Auth workflow host. */
let h: Awaited<ReturnType<typeof fixture>>;
let governor: Awaited<ReturnType<typeof h.human>>;
beforeAll(async () => {
  h = await fixture();
  governor = await h.human();
  await h.governance(governor.accountId);
}, 60000);
afterAll(async () => h?.close());

type Person = Awaited<ReturnType<typeof h.human>>;
const reference = (principal: Person, requestId: string) => `urn:rezics:request:${principal.accountId}:${requestId}`;

async function assign(principal: Person, person: Person) {
  const requestId = newId(routeOf(principal.accountId)!);
  await h.db.admin.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,creator_principal_id,valid,transaction_id)
    VALUES ($1,$2,$3,$4,$2,'(,)',$3)`,
    [routeOf(principal.accountId), principal.accountId, requestId, person.accountId],
  );
  return requestId;
}
const revoke = (principal: Person, requestId: string) =>
  h.db.admin.query(
    `UPDATE access.principal_assignment SET revoked_at=transaction_timestamp(), valid=valid * tstzrange(NULL,transaction_timestamp(),'[)')
    WHERE route=$1 AND principal_id=$2 AND request_id=$3`,
    [routeOf(principal.accountId), principal.accountId, requestId],
  );
const delegated = (person: Person, requestedBy: string) => h.bearer(person.email, requestedBy);
async function actingFor() {
  const principal = await h.human();
  const person = await h.human();
  const requestId = await assign(principal, person);
  const requestedBy = reference(principal, requestId);
  return { principal, person, requestId, requestedBy, token: await delegated(person, requestedBy) };
}
const snapshot = async () =>
  (
    await h.db.admin.query(
      `SELECT (SELECT count(*) FROM access.account) accounts, (SELECT count(*) FROM core.receipt) receipts,
       (SELECT count(*) FROM access.membership_inverse) inverses, (SELECT count(*) FROM access.organization_member) members,
       (SELECT count(*) FROM access.handle_claim) handles`,
    )
  ).rows;

test('a person acting for a principal creates an approval bound to that principal and assignment', async () => {
  const f = await actingFor();
  const approved = await h.approve(f.token);
  const row = (
    await h.db.admin.query(
      'SELECT actor_id,requested_by FROM access.workflow_approval WHERE route=$1 AND actor_id=$2',
      [routeOf(f.person.accountId), f.person.accountId],
    )
  ).rows;
  expect(row).toEqual([{ actor_id: f.person.accountId, requested_by: f.requestedBy }]);
  const request = await h.approvals.resolve(approved.approval.reference, approved.input, h.context());
  expect(request.actor.requestedBy).toBe(f.requestedBy);
  await expect(h.create(approved)).resolves.toEqual({ accountId: approved.accountId });
  expect(
    (
      await h.db.admin.query('SELECT member_account_id,role FROM access.organization_member WHERE organization_id=$1', [
        approved.accountId,
      ])
    ).rows,
  ).toEqual([{ member_account_id: f.person.accountId, role: 'owner' }]);
});

test('an approval is bound to its caller and assignment', async () => {
  const f = await actingFor();
  const approved = await h.approve(f.token);
  const plain = await h.bearer(f.person.email);
  const other = await actingFor();
  for (const caller of [plain, other.token, f.principal.token])
    await expect(
      h.approvals.resolveForCaller(caller, approved.approval.reference, approved.input, h.context()),
    ).rejects.toThrow();
  await expect(
    h.approvals.resolveForCaller(f.token, approved.approval.reference, approved.input, h.context()),
  ).resolves.toBeDefined();
});

test('an assignment that is revoked, or never was, creates no approval', async () => {
  const f = await actingFor();
  await revoke(f.principal, f.requestId);
  const before = await snapshot();
  await expect(h.approve(f.token)).rejects.toThrow();
  await expect(delegated(f.person, f.requestedBy)).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

test('a revoked assignment denies the first protected step with unchanged state', async () => {
  const f = await actingFor();
  const approved = await h.approve(f.token);
  await revoke(f.principal, f.requestId);
  const before = await snapshot();
  await expect(h.create(approved)).rejects.toThrow();
  await expect(h.approvals.resolve(approved.approval.reference, approved.input, h.context())).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

for (const fact of ['principal suspended', 'principal fenced'] as const) {
  test(`a ${fact} denies the protected step`, async () => {
    const f = await actingFor();
    const approved = await h.approve(f.token);
    if (fact === 'principal suspended') await suspendAccount(h.db.admin, f.principal.accountId);
    else
      await h.db.admin.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
        routeOf(f.principal.accountId),
        f.principal.accountId,
      ]);
    const before = await snapshot();
    await expect(h.create(approved)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
}

for (const boundary of ['owner inverse', 'organization', 'handle hold'] as const) {
  test(`a revocation after the ${boundary} commits stops the next protected step`, async () => {
    const f = await actingFor();
    const approved = await h.approve(f.token);
    const originals = new Map<PoolClient, PoolClient['query']>();
    let fired = false;
    const match =
      boundary === 'owner inverse'
        ? /INSERT INTO access\.membership_inverse\b/
        : boundary === 'organization'
          ? /INSERT INTO access\.account\b/
          : /SET hold_operation_id/;
    const intercept = (client: PoolClient) => {
      if (originals.has(client)) return;
      const query = client.query.bind(client);
      originals.set(client, client.query);
      let targeted = false;
      client.query = ((...args: Parameters<typeof query>) => {
        const raw = args[0] as string | { text: string };
        const sql = typeof raw === 'string' ? raw : raw.text;
        if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') targeted = false;
        if (match.test(sql)) targeted = true;
        const result = query(...args);
        if (sql !== 'COMMIT' || !targeted || fired) return result;
        fired = true;
        return (result as unknown as Promise<unknown>).then(async (value) => {
          await revoke(f.principal, f.requestId);
          return value;
        });
      }) as typeof client.query;
    };
    h.db.pool.on('acquire', intercept);
    try {
      await expect(h.create(approved)).rejects.toThrow();
      expect(fired).toBe(true);
    } finally {
      h.db.pool.off('acquire', intercept);
      for (const [client, query] of originals) client.query = query;
    }
    const account = (
      await h.db.admin.query('SELECT handle FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(approved.accountId),
        approved.accountId,
      ])
    ).rows;
    if (boundary === 'owner inverse') expect(account).toHaveLength(0);
    else expect(account).toEqual([{ handle: null }]);
    await expect(h.create(approved)).rejects.toThrow();
  });
}

test('a completed private result is not disclosed after revocation, to another caller or after a restart', async () => {
  const f = await actingFor();
  const key = randomUUID();
  const approved = await h.approve(f.token);
  const first = await h.create(approved, key);
  expect(first).toEqual({ accountId: approved.accountId });
  // Same caller, same current assignment, after a restart of the workflow host.
  await h.restart();
  const again = await h.approve(f.token, approved.input, approved.operationKey);
  expect(await h.create(again, key)).toEqual(first);
  // Another caller with their own approval of the same operation and key.
  const other = await actingFor();
  const intruder = await h.approve(other.token, approved.input, approved.operationKey);
  await expect(h.create(intruder, key)).rejects.toThrow();
  const rival = await h.human();
  const own = await h.approve(rival.token, approved.input, approved.operationKey);
  await expect(h.create(own, key)).rejects.toThrow();
  // The assignment is revoked: neither a replay nor a restart discloses it.
  await revoke(f.principal, f.requestId);
  await expect(h.create(approved, key)).rejects.toThrow();
  await expect(h.create(again, key)).rejects.toThrow();
  await h.restart();
  await expect(h.create(approved, key)).rejects.toThrow();
  await expect(h.create(again, key)).rejects.toThrow();
});

test('an automated or operated caller still cannot create an approval', async () => {
  const operator = await h.human();
  const key = randomUUID();
  const handle = `bot_${key.replaceAll('-', '')}`;
  const operation: AccountOperation = {
    kind: 'automated',
    registrationId: '',
    operatorAccountId: operator.accountId,
    handle,
    operationKey: key,
    authorization: 'input',
  };
  const approval = await h.approvals.approve(operator.token, { operationKey: key, operation }, h.context());
  const email = `${key}@bot.test`;
  const created = await h.host.workflows.createAutomated({
    key,
    handle,
    operatorAccountId: operator.accountId,
    authorization: approval.reference,
    credential: { email, password: h.password },
  });
  const bot = { accountId: created.accountId, email, handle, token: await h.bearer(email) };
  await expect(h.approve(bot.token)).rejects.toThrow();
  // Acting for a principal does not make an operated account a person.
  const principal = await h.human();
  const requestedBy = reference(principal, await assign(principal, bot));
  await expect(h.approve(await delegated(bot, requestedBy))).rejects.toThrow();
});
