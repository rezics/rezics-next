import { setFixtureAccountState, suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import {
  createAuthHost,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  createBarrierProofVerifier,
  type AccountOperation,
  type AuthService,
} from '@rezics/auth';
import { migrate } from '../../../auth/scripts/database.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWorkflowApprovals, workflowApprovalBinding } from '../../src/access/workflow-approvals.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { ACTIVE_ACCOUNTS } from '../../src/access/grant-subject.ts';
import { accessCheck } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { registerTestClient, testKernel, testRouteKey, testTokens } from '../support/test-kernel.ts';

/** Real Auth host, native registration and Auth-issued tokens verified via JWKS.
 * Shared with the growth test; only its entry file registers the functional suite. */
export async function organizationFixture() {
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const suffix = randomUUID().replaceAll('-', '');
  const authName = `organization_auth_${suffix}`;
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authName}`;
  await db.admin.query(`CREATE DATABASE "${authName}"`);
  migrate(authUrl.href, fileURLToPath(new URL('../../../auth/db/migrations', import.meta.url)));
  const authPool = new Pool({ connectionString: authUrl.href });
  const issuer = `https://organization-${suffix}.auth.test`;
  const audience = 'https://organization.api.test';
  const password = 'organization creation native password';
  const actions = new Map([
    ...LIFECYCLE_ACTIONS,
    ['access:grant', { anonymous: false }],
    ['account:manage', { anonymous: false }],
  ]);
  const scopes = [...actions.keys()];
  let service: AuthService;
  const referenceKeys = testTokens();
  const routeKey = testRouteKey();
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
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const bindings = createNativeAccountBindings({
    pool: db.pool,
    access,
    actions,
    routeKey,
    referenceKeys,
    auth: () => service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
      barriers: createBarrierProofVerifier({ database: authPool }),
    },
  });
  const approvals = createWorkflowApprovals({
    pool: db.pool,
    access,
    actions,
    referenceKeys,
    creationBinding: proofs.creationBinding,
  });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'organization-host',
  };
  const host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: randomBytes(48).toString('base64url'),
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    siteActions: actions,
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    stagingKey: randomBytes(32),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: `organization-${suffix}`,
  });
  service = host.service;
  await host.start();
  await registerTestClient(service, { clientId: 'organization-test', firstParty: true, actions, scopes });
  await registerTestClient(service, {
    clientId: 'organization-no-scope',
    firstParty: true,
    actions,
    scopes: ['account:read'],
  });
  const context = () => ({ pool: db.pool, deadline: Date.now() + 10000 });
  async function bearer(email: string, clientId = 'organization-test') {
    const response = await host.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          client_id: clientId,
          scope: clientId === 'organization-test' ? scopes : ['account:read'],
        }),
      }),
    );
    if (!response.ok) throw new Error(`Native sign-in: ${response.status}: ${await response.text()}`);
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const token = await host.handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { origin: issuer, cookie, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    if (!token.ok) throw new Error(`Native token: ${token.status}: ${await token.text()}`);
    return ((await token.json()) as { access_token: string }).access_token;
  }
  async function human() {
    const key = randomUUID();
    const email = `${key}@organization.test`;
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
      prefix,
    };
  }
  async function create(f: Awaited<ReturnType<typeof approve>>, key: string = randomUUID()) {
    if (f.input.kind !== 'organization') throw new Error('Expected organization');
    return host.workflows.createOrganization({ key, handle: f.input.handle, authorization: f.approval.reference });
  }
  async function allowed(token: string) {
    const boundary = context();
    const actor = await access.authenticate(token, boundary);
    return (await accessCheck(access, actor, 'organization:create', PLATFORM_RESOURCE, boundary))(db.pool);
  }
  async function close() {
    await host.stop();
    await db.admin.query(`DROP DATABASE "${authName}"`);
    await db.close();
  }
  return {
    db,
    authPool,
    host,
    access,
    approvals,
    bindings,
    context,
    human,
    bearer,
    governance,
    operation,
    approve,
    create,
    allowed,
    close,
    password,
  };
}

if (Bun.main === import.meta.path) {
  let h: Awaited<ReturnType<typeof organizationFixture>>;
  let governor: Awaited<ReturnType<typeof h.human>>;
  let creator: Awaited<ReturnType<typeof h.human>>;
  beforeAll(async () => {
    h = await organizationFixture();
    governor = await h.human();
    creator = await h.human();
    await h.governance(governor.accountId);
  }, 60000);
  afterAll(async () => h?.close());

  test('Global approval creates an organization, committing its human owner inverse before authority; logical replay preserves identity and receipts', async () => {
    await h.db.admin
      .query(`CREATE FUNCTION public.require_committed_owner_inverse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'organization' AND NOT EXISTS (
          SELECT 1 FROM access.membership_inverse WHERE group_id=NEW.account_id AND account_id='${creator.accountId}'
            AND transaction_id <> NEW.transaction_id
        ) THEN RAISE EXCEPTION 'owner inverse must commit first'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER organization_inverse_before_authority BEFORE INSERT ON access.account
      FOR EACH ROW EXECUTE FUNCTION public.require_committed_owner_inverse()`);
    const f = await h.approve(creator.token);
    try {
      expect(await h.create(f)).toEqual({ accountId: f.accountId });
    } finally {
      await h.db.admin.query(
        'DROP TRIGGER organization_inverse_before_authority ON access.account; DROP FUNCTION public.require_committed_owner_inverse()',
      );
    }
    const account = (
      await h.db.admin.query('SELECT kind,state,handle FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(f.accountId),
        f.accountId,
      ])
    ).rows[0];
    expect(account).toEqual({ kind: 'organization', state: 'active', handle: (f.input as { handle: string }).handle });
    // Organizations have no Auth credential owner and cannot select themselves
    // as an approval actor through the closed request descriptor.
    expect((await h.authPool.query('SELECT 1 FROM "user" WHERE id=$1', [f.accountId])).rows).toHaveLength(0);
    await expect(
      h.approve(creator.token, { ...h.operation(), actorAccountId: f.accountId } as unknown as AccountOperation),
    ).rejects.toThrow();
    const owner = (
      await h.db.admin.query('SELECT * FROM access.organization_member WHERE route=$1 AND organization_id=$2', [
        routeOf(f.accountId),
        f.accountId,
      ])
    ).rows;
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ member_account_id: creator.accountId, role: 'owner' });
    const receipts = async () =>
      (
        await h.db.admin.query(
          'SELECT * FROM core.receipt WHERE idempotency_key LIKE $1 ORDER BY partition_no,command_kind,idempotency_key',
          [`%${f.prefix}%`],
        )
      ).rows;
    const first = await receipts();
    expect(first.length).toBeGreaterThan(5);
    // Fresh DBOS attempt ids and a fresh approval keep the immutable native key.
    const refreshed = await h.approve(creator.token, f.input, f.operationKey);
    expect(await h.create(refreshed)).toEqual({ accountId: f.accountId });
    expect(await receipts()).toEqual(first);
    expect(await h.create(f, 'same-dbos-attempt')).toEqual({ accountId: f.accountId });
    expect(await h.create(f, 'same-dbos-attempt')).toEqual({ accountId: f.accountId });
  });

  test('standing grant covers existing and future active accounts and excludes inactive ones', async () => {
    const future = await h.human();
    for (const person of [creator, future]) expect(await h.allowed(person.token)).toBe(true);
    for (const state of ['pending', 'suspended', 'deleted']) {
      await setFixtureAccountState(h.db.admin, future.accountId, state);
      await expect(h.allowed(future.token)).rejects.toThrow();
    }
    await h.db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(future.accountId),
      future.accountId,
    ]);
    future.token = await h.bearer(future.email);
    expect(await h.allowed(future.token)).toBe(true);
  });

  for (const fact of ['suspended', 'fenced', 'epoch-stale', 'scope'] as const) {
    test(`${fact} actor cannot approve or execute creation and writes no rows`, async () => {
      const person = await h.human();
      const token = fact === 'scope' ? await h.bearer(person.email, 'organization-no-scope') : person.token;
      const f = await h.approve(person.token);
      if (fact === 'suspended') await suspendAccount(h.db.admin, person.accountId);
      if (fact === 'fenced')
        await h.bindings.internalLifecycle.raiseFence({ accountId: person.accountId, key: randomUUID() });
      if (fact === 'epoch-stale')
        await h.db.admin.query(
          'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE account_id=$1',
          [person.accountId],
        );
      const snapshot = async () =>
        (
          await h.db.admin.query(
            `SELECT (SELECT count(*) FROM access.account) accounts, (SELECT count(*) FROM access.workflow_approval) approvals, (SELECT count(*) FROM core.receipt) receipts, (SELECT count(*) FROM access.membership_inverse) inverses, (SELECT count(*) FROM access.organization_member) members, (SELECT count(*) FROM access.handle_claim) handles`,
          )
        ).rows;
      const before = await snapshot();
      await expect(
        h.approvals.approve(token, { operationKey: randomUUID(), operation: h.operation() }, h.context()),
      ).rejects.toThrow();
      if (fact !== 'scope') await expect(h.create(f)).rejects.toThrow();
      else
        await expect(h.approvals.resolveForCaller(token, f.approval.reference, f.input, h.context())).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    });
  }

  for (const boundary of ['owner inverse', 'organization', 'handle hold'] as const) {
    test(`a floor change after ${boundary} commits stops the next protected step`, async () => {
      const person = await h.human();
      const f = await h.approve(person.token);
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
            await h.db.admin.query(
              'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2',
              [routeOf(person.accountId), person.accountId],
            );
            return value;
          });
        }) as typeof client.query;
      };
      h.db.pool.on('acquire', intercept);
      try {
        await expect(h.create(f)).rejects.toThrow();
        expect(fired).toBe(true);
      } finally {
        h.db.pool.off('acquire', intercept);
        for (const [client, query] of originals) client.query = query;
      }
      const account = (
        await h.db.admin.query('SELECT handle FROM access.account WHERE route=$1 AND account_id=$2', [
          routeOf(f.accountId),
          f.accountId,
        ])
      ).rows;
      if (boundary === 'owner inverse') expect(account).toHaveLength(0);
      else expect(account).toEqual([{ handle: null }]);
      expect(
        (
          await h.db.admin.query(
            'SELECT 1 FROM access.membership_inverse WHERE route=$1 AND account_id=$2 AND group_id=$3',
            [routeOf(person.accountId), person.accountId, f.accountId],
          )
        ).rows,
      ).toHaveLength(1);
    });
  }

  test('automated actors and organizations cannot initiate creation or smuggle bootstrap inputs', async () => {
    const key = randomUUID();
    const handle = `bot_${key.replaceAll('-', '')}`;
    const operation: AccountOperation = {
      kind: 'automated',
      registrationId: '',
      operatorAccountId: creator.accountId,
      handle,
      operationKey: key,
      authorization: 'input',
    };
    const approval = await h.approvals.approve(creator.token, { operationKey: key, operation }, h.context());
    const email = `${key}@bot.test`;
    await h.host.workflows.createAutomated({
      key,
      handle,
      operatorAccountId: creator.accountId,
      authorization: approval.reference,
      credential: { email, password: h.password },
    });
    const bot = await h.bearer(email);
    expect(await h.allowed(bot)).toBe(true);
    await expect(h.approve(bot)).rejects.toThrow();
    for (const extra of [
      { ownerAccountId: creator.accountId },
      { createOrganization: {} },
      { organizationId: PLATFORM_RESOURCE.id },
      { kind: 'organization', accountId: PLATFORM_RESOURCE.id },
    ])
      await expect(h.approve(creator.token, { ...h.operation(), ...extra } as AccountOperation)).rejects.toThrow();
  });

  test('handle collision retains the published owner inverse and another account owns its handle', async () => {
    const f = await h.approve(creator.token, h.operation(creator.handle));
    await expect(h.create(f)).rejects.toThrow();
    const inverse = (
      await h.db.admin.query(
        'SELECT * FROM access.membership_inverse WHERE route=$1 AND account_id=$2 AND group_id=$3',
        [routeOf(creator.accountId), creator.accountId, f.accountId],
      )
    ).rows;
    expect(inverse).toHaveLength(1);
    await expect(
      h.bindings.internalLifecycle.releaseMembershipCoordination({
        organizationId: f.accountId,
        memberAccountId: creator.accountId,
        reservationId: inverse[0].reservation_id,
        key: randomUUID(),
      }),
    ).rejects.toThrow();
    expect(
      (await h.db.admin.query('SELECT handle FROM access.account WHERE account_id=$1', [creator.accountId])).rows[0]
        .handle,
    ).toBe(creator.handle);
    expect(
      (await h.db.admin.query('SELECT role FROM access.organization_member WHERE organization_id=$1', [f.accountId]))
        .rows[0].role,
    ).toBe('owner');
  });

  test('ordinary Global grant revocation remains effective after another bootstrap run', async () => {
    const context = { ...h.context(), actor: await h.access.authenticate(governor.token, h.context()) };
    const stored = (
      await h.db.admin.query(
        "SELECT valid::text FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND action='organization:create' AND subject_kind='active_accounts'",
        [PLATFORM_RESOURCE.id],
      )
    ).rows[0];
    await h.bindings.grants.revoke(context, {
      resource: PLATFORM_RESOURCE,
      subject: ACTIVE_ACCOUNTS,
      actions: ['organization:create'],
      valid: stored.valid,
      key: randomUUID(),
    });
    expect(await h.allowed(creator.token)).toBe(false);
    await h.governance(governor.accountId);
    expect(await h.allowed(creator.token)).toBe(false);
    await expect(h.approve(creator.token)).rejects.toThrow();
  });
}
