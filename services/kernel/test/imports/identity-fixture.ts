import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AccountWorkflowOptions,
  type AuthService,
} from '@rezics/auth';
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { createKernel, type KernelDependencies } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { createApp } from '../../src/http/app.ts';
import { accessRoutes } from '../../src/access/routes.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import type { GrantInput } from '../../src/access/grant-commands.ts';
import { authTemplateName, createAuthDatabase } from '../support/auth-database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  COMMON_ACTIONS,
  IMPORT_ACTIONS,
  BULK_ACTION,
  GLOBAL,
  type Stage,
} from '../../../../specs/imports-identity-driver.ts';

export const MISSING_IMPORT_IDENTITY = 'openImportIdentity is not implemented';
let mountedActions: ReturnType<typeof actionCatalogue> | undefined;

/** Route metadata is immutable; every fixture still owns its Access and credentials. */
export function importActionCatalogue(database: GrowthDatabase, routeKey: Uint8Array) {
  mountedActions ??= actionCatalogue(createKernel({ pool: database.pool, routeKey }));
  return new Map(mountedActions);
}

export interface ImportIdentityOptions {
  /** Borrowed application database, including its original capture pool. */
  readonly database: GrowthDatabase;
  readonly clock: NonNullable<AccountWorkflowOptions['clock']>;
  /** Optional migrated, credential-free Auth template owned by the composition. */
  readonly authTemplate?: string;
  /** Start independent deployment services once their native configuration exists. */
  readonly configured?: (
    identity: Pick<ImportIdentity, 'access' | 'accessConfig' | 'routeKey' | 'tokenKeys'>,
  ) => Promise<void>;
  /** Fault observation only, after each actual committed setup boundary. */
  readonly afterStage?: (stage: Stage) => Promise<void>;
}
export interface ImportCredential {
  readonly accountId: AccountActor['accountId'];
  readonly bearer: string;
}
export interface ImportIdentity {
  readonly database: GrowthDatabase;
  readonly access: Access;
  readonly accessConfig: AccessConfig;
  readonly routeKey: KernelDependencies['routeKey'];
  readonly tokenKeys: NonNullable<KernelDependencies['tokens']>;
  readonly auth: AuthService;
  readonly client: Parameters<AuthService['internal']['registerClient']>[0];
  readonly governance: ImportCredential;
  readonly bulk: ImportCredential;
  readonly ordinary: ImportCredential;
  /** Change only batch_write, preserving every issued credential. */
  setBulkPermission(enabled: boolean): Promise<void>;
  /** Releases owned Auth resources; application DB remains caller-owned. */
  close(): Promise<void>;
}

/** Populate the Global partition used by measured public grant commits. */
async function seedCommandHistory(f: ImportIdentity, clientId: string): Promise<void> {
  const count = 2_048;
  const transactionIds = Array.from({ length: count }, () => randomUUID());
  const value = {
    resource: GLOBAL,
    subject: { kind: 'account', id: f.bulk.accountId },
    actions: [BULK_ACTION],
    valid: '(,)',
  };
  const client = await f.database.admin.connect();
  try {
    await client.query('BEGIN');
    const partition = (
      await client.query<{ partition_no: number; epoch: number; position: string }>(
        'SELECT partition_no,epoch,position::text AS position FROM core.partition WHERE partition_no=$1 FOR UPDATE',
        [GLOBAL.route >>> 4],
      )
    ).rows[0];
    if (!partition) throw new Error('Identity growth fixture partition is missing');
    // Match fence.sql: one event, receipt and write basis per consecutive commit.
    await client.query(
      `INSERT INTO core.outbox (partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
      SELECT $1,$2::bigint+ordinality,0,1,$3,gen_random_uuid(),
        'com.rezics.access.grant.create.v1',$5,$6::jsonb
      FROM unnest($4::uuid[]) WITH ORDINALITY AS seeded(transaction_id,ordinality)`,
      [partition.partition_no, partition.position, partition.epoch, transactionIds, GLOBAL.id, value],
    );
    await client.query(
      `INSERT INTO core.receipt (
        partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,
        epoch,position,transaction_id,response
      )
      SELECT $1,'account',$5,'access.grant.create','0:growth-command-baseline-'||ordinality,
        decode(repeat('00',32),'hex'),$3,$2::bigint+ordinality,transaction_id,$6::jsonb
      FROM unnest($4::uuid[]) WITH ORDINALITY AS seeded(transaction_id,ordinality)`,
      [partition.partition_no, partition.position, partition.epoch, transactionIds, f.governance.accountId, value],
    );
    await client.query(
      `INSERT INTO editorial.write_basis (
        partition_no,transaction_id,epoch,position,principal_kind,principal_id,client_id,requested_by
      )
      SELECT $1,transaction_id,$3,$2::bigint+ordinality,'account',$5,$6,NULL
      FROM unnest($4::uuid[]) WITH ORDINALITY AS seeded(transaction_id,ordinality)`,
      [partition.partition_no, partition.position, partition.epoch, transactionIds, f.governance.accountId, clientId],
    );
    await client.query('UPDATE core.partition SET position=position+$2 WHERE partition_no=$1', [
      partition.partition_no,
      count,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Ownership inventory only. Entries contain handles, never authority or proof mappings. */
const owned = new Map<string, () => Promise<boolean>>();
export async function identityResources(): Promise<readonly string[]> {
  const observed = await Promise.all([...owned].map(async ([name, live]) => ((await live()) ? name : null)));
  return observed.filter((name): name is string => name !== null).sort();
}
export async function createIdentityNamespace(base: string, template?: string) {
  const name = `import_identity_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(base);
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.href, max: 1 });
  let created = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${name}"`);
          owned.delete(`database:${name}`);
        }
      } finally {
        await admin.end();
      }
    })());
  try {
    // Both names are deployment configuration; identifiers are escaped independently.
    const escaped = template?.replaceAll('"', '""');
    await admin.query(`CREATE DATABASE "${name}"${escaped ? ` TEMPLATE "${escaped}"` : ''}`);
    created = true;
    owned.set(
      `database:${name}`,
      async () => (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rowCount === 1,
    );
    url.pathname = `/${name}`;
    return { name, url: url.href, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function createAuthNamespace(base: string) {
  const name = `import_identity_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
  let created = false;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (created) {
          await dropTestDatabase(admin, name);
          owned.delete(`database:${name}`);
        }
      } finally {
        await admin.end();
      }
    })());
  try {
    const url = await createAuthDatabase(base, name);
    created = true;
    owned.set(
      `database:${name}`,
      async () => (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [name])).rowCount === 1,
    );
    return { name, url, close };
  } catch (error) {
    try {
      await dropTestDatabase(admin, name);
    } finally {
      await admin.end();
    }
    throw error;
  }
}
const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });
const password = 'private native identity fixture password';
const support = new WeakMap<ImportIdentity, IdentitySupport>();
export function identitySupport(f: ImportIdentity): IdentitySupport {
  const result = support.get(f);
  if (!result) throw new Error('Unknown identity fixture');
  return result;
}
export type IdentitySupport = {
  authDatabase: GrowthDatabase;
  bindings: ReturnType<typeof createNativeAccountBindings>;
  host: Awaited<ReturnType<typeof createAuthHost>>;
  grantLocators: GrantInput[];
  bootstrapPosition: string;
  credentialKid: string;
  counters: {
    authMigrationCalls: number;
    baselineWorkflowCalls: { registrations: number; keyInstalls: number };
  };
  issue(accountId: string, scopes: readonly string[]): Promise<ImportCredential>;
  request(path: string, body: unknown, headers?: Headers): Promise<Response>;
  managementHeaders: Headers;
  /** Current management bearer; call `renewManagement` first when the run may have outlasted 300 s. */
  readonly managementBearer: string;
  renewManagement(): Promise<void>;
  approveOpening(key: string): Promise<string>;
  seedBaseline(count: number): Promise<void>;
  grow(index: number): Promise<void>;
};

/** Native ordinary composition shared with later content fixtures. Account credentials
 * travel only through Auth; native pending locators/approvals stay in their owning stores.
 * The unrelated baseline history is seeded in set-based writes; measured outcomes remain native. */
export async function openImportIdentity(options: ImportIdentityOptions): Promise<ImportIdentity> {
  const { database, clock } = options;
  const counters = { authMigrationCalls: 0, baselineWorkflowCalls: { registrations: 0, keyInstalls: 0 } };
  let countingBaselineCalls = false;
  const importerScopes = [...COMMON_ACTIONS, ...IMPORT_ACTIONS];
  const managementScopes = [
    ...importerScopes,
    'access:grant',
    'source_fence:takedown',
    'account:manage',
    'account:set_rate_tier',
  ];
  let namespace: Awaited<ReturnType<typeof createIdentityNamespace>> | undefined;
  let authDatabase: GrowthDatabase | undefined;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let ending: Promise<void> | undefined;
  const close = () =>
    (ending ??= (async () => {
      try {
        await host?.stop();
      } finally {
        try {
          await authDatabase?.close();
        } finally {
          await namespace?.close();
          if (namespace) {
            owned.delete(`host:${namespace.name}`);
            owned.delete(`pool:${namespace.name}`);
          }
        }
      }
    })());
  try {
    if (options.authTemplate) {
      namespace = await createIdentityNamespace(database.url, options.authTemplate);
    } else {
      const template = authTemplateName();
      const existing = await database.admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [template]);
      if (existing.rowCount === 0) counters.authMigrationCalls += 1;
      namespace = await createAuthNamespace(database.url);
    }
    authDatabase = await openGrowthDatabase(namespace.url);
    owned.set(`pool:${namespace.name}`, async () => !(authDatabase!.pool as Pool & { ended: boolean }).ended);
    // Auth owns the library pool. Make its pool close idempotent since the capture
    // database also owns instrumentation and closes all its registered pools.
    const authPool = authDatabase.openPool();
    const end = authPool.end.bind(authPool);
    let ended: Promise<void> | undefined;
    authPool.end = (() => (ended ??= end())) as Pool['end'];
    const pair = await generateKeyPair('ES256', { extractable: true });
    const kid = randomUUID();
    const issuer = `https://${randomUUID()}.identity.test`;
    const audience = `${issuer}/kernel`;
    const routeKey = new Uint8Array(randomBytes(32));
    const tokenKeys = { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
    let auth: AuthService;
    const actions = new Map([...importActionCatalogue(database, routeKey), ...LIFECYCLE_ACTIONS]);
    // Mounted actions already carry resource-type declarations. Replacing them with a
    // bare scope drops those declarations and makes public media reservation throw.
    for (const scope of managementScopes) if (!actions.has(scope)) actions.set(scope, { anonymous: false });
    const roles = resolveResourceRoles(actions);
    const accessConfig: AccessConfig = {
      actions,
      resourceRoles: { roles: Object.fromEntries(roles.roles), types: {} },
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: (request) => auth.handler(new Request(request)),
      },
    };
    // Built-in role definitions already come from createAccess. Expose their exact
    // resolved data for observation, without attempting to redefine built-ins.
    const access = createAccess({ actions, auth: accessConfig.auth! });
    const proofs = createNativeWorkflowProofPorts({ database: authPool });
    const bindings = createNativeAccountBindings({
      pool: database.pool,
      access,
      actions,
      routeKey,
      referenceKeys: tokenKeys,
      clock,
      auth: () => auth,
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
        barriers: createBarrierProofVerifier({ database: authPool }),
      },
    });
    const authSecret = randomBytes(32).toString('hex');
    const registrationStagingKey = new Uint8Array(randomBytes(32));
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: authSecret,
      signing: { activeKid: kid, privateKeys: [{ ...(await exportJWK(pair.privateKey)), kid }] },
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      stagingKey: registrationStagingKey,
      executorId: `identity-${randomUUID()}`,
      maintenanceSchedule: '0 0 1 1 *',
    });
    auth = host.service;
    await options.configured?.({ access, accessConfig, routeKey, tokenKeys });
    owned.set(
      `host:${namespace.name}`,
      async () => (await auth.handler(new Request(auth.verifier.jwksUrl))).status === 200,
    );
    const client = {
      clientId: `importer-${randomUUID()}`,
      firstParty: true,
      scopes: [...COMMON_ACTIONS, ...IMPORT_ACTIONS, 'statement:propose', 'media:read_reservation'],
    };
    const managementClient = `governance-${randomUUID()}`;
    await auth.internal.registerClient(client);
    await auth.internal.registerClient({ clientId: managementClient, firstParty: true, scopes: managementScopes });
    await host.start();
    const request = (path: string, body: unknown, headers = new Headers()) =>
      auth.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
          body: JSON.stringify(body),
        }),
      );
    async function login(email: string, clientId: string, scopes: readonly string[]) {
      const response = await request('/signin', { email, password, client_id: clientId, scope: scopes });
      if (response.status !== 200) throw new Error(`Native password signin: HTTP ${response.status}`);
      return cookies(response);
    }
    async function token(accountId: string, headers: Headers): Promise<ImportCredential> {
      const response = await request('/token', {}, headers);
      if (response.status !== 200) throw new Error(`Native token issuance: HTTP ${response.status}`);
      const body = (await response.json()) as { access_token: string };
      return { accountId, bearer: body.access_token };
    }
    const person = async (name: string) => {
      const email = `${name}@identity.test`;
      if (countingBaselineCalls) counters.baselineWorkflowCalls.registrations += 1;
      const result = await host!.workflows.register({ key: name, handle: name, email, password });
      return { ...result, email };
    };
    const [human, comparison] = await Promise.all([person('governance'), person('ordinary')]);
    await options.afterStage?.('auth-registration');
    // The deployment CLI owns a fresh connection. No HTTP bootstrap or actor bypass.
    const beforeBootstrap = String(
      (await database.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [GLOBAL.route >>> 4]))
        .rows[0].position,
    );
    await runIdentityBootstrap(database.url, human.accountId, true);
    const afterBootstrap = String(
      (await database.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [GLOBAL.route >>> 4]))
        .rows[0].position,
    );
    const bootstrapEvents = await database.admin.query<{ position: string }>(
      `SELECT position FROM core.outbox
       WHERE partition_no=$1 AND position>$2 AND position<=$3
         AND type='com.rezics.access.governance.bootstrapped.v1'
       ORDER BY position,event_seq`,
      [GLOBAL.route >>> 4, beforeBootstrap, afterBootstrap],
    );
    if (bootstrapEvents.rows.length !== 1) throw new Error('Missing unique bootstrap event in committed range');
    const bootstrapPosition = String(bootstrapEvents.rows[0]!.position);
    await options.afterStage?.('bootstrap');
    const managementHeaders = await login(human.email, managementClient, managementScopes);
    // Access tokens live 300 s, so the bearer is replaced by `renewManagement` between steps.
    let management = await token(human.accountId, managementHeaders);
    const approval = createWorkflowApprovals({
      pool: database.pool,
      access,
      actions,
      referenceKeys: tokenKeys,
      creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
    });
    const operation = {
      kind: 'automated' as const,
      registrationId: '',
      operatorAccountId: human.accountId,
      handle: 'importer',
      operationKey: 'create-importer',
      authorization: 'approval-request',
    };
    const approved = await approval.approve(
      management.bearer,
      { operationKey: operation.operationKey, operation },
      { pool: database.pool, deadline: Date.now() + 10000 },
    );
    const robot = await host.workflows.createAutomated({
      key: operation.operationKey,
      handle: operation.handle,
      operatorAccountId: human.accountId,
      authorization: approved.reference,
    });
    const accountKey = await generateKeyPair('ES256', { extractable: true });
    const accountKid = randomUUID();
    const stage = await auth.internal.stageCredentialEffect({
      key: 'importer-key',
      subjectAccountId: robot.accountId,
      headers: managementHeaders,
      credential: {
        kind: 'key',
        kid: accountKid,
        publicJwk: { ...(await exportJWK(accountKey.publicKey)), kid: accountKid },
      },
    });
    const effect = {
      effectRef: stage.effectRef,
      key: stage.key,
      subjectAccountId: robot.accountId,
      headers: managementHeaders,
    };
    const authorization = await auth.internal.approveCredentialEffect(effect);
    await auth.internal.applyCredentialEffect({ ...effect, authorization: authorization.reference });
    async function issue(accountId: string, scopes: readonly string[]): Promise<ImportCredential> {
      if (accountId !== robot.accountId) {
        const email =
          accountId === human.accountId ? human.email : accountId === comparison.accountId ? comparison.email : null;
        if (!email) throw new Error('Unknown credential owner');
        return token(accountId, await login(email, client.clientId, scopes));
      }
      // Only the account-key assertion is signed here. Access tokens are always
      // issued by /token and verified by the unchanged native JWKS verifier.
      const at = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: accountKid })
        .setIssuer(accountId)
        .setSubject(accountId)
        .setAudience(`${issuer}/token`)
        .setIssuedAt(at)
        .setExpirationTime(at + 30)
        .setJti(randomUUID())
        .sign(accountKey.privateKey);
      const signed = await request('/signin/key', {
        account_id: accountId,
        assertion,
        client_id: client.clientId,
        scope: scopes,
      });
      if (signed.status !== 200) throw new Error(`Native account-key signin: HTTP ${signed.status}`);
      return token(accountId, cookies(signed));
    }
    const grantLocators: GrantInput[] = [];
    // Reuse this actual Access instance in the HTTP composition; it owns native
    // authenticated identities and durable approval bridges for this exact pool.
    // Setup needs only the production Access routes. Mount their real request
    // pipeline without compiling unrelated content routes in every identity.
    // API and media fixtures still own their separate complete kernel apps.
    const app = accessRoutes(
      createApp({
        // Match the shared test kernel's request deadline.
        requestDeadlineMs: 30_000,
        pool: database.pool,
        tokens: tokenKeys,
        clock,
        access,
        // A finite isolated deployment budget admits history seeding while retaining
        // the real request-stage identity, counter SQL and admission pipeline.
        writeRate: createWriteRateLimiter({
          secret: randomBytes(32).toString('hex'),
          overrides: '{"new-account":{"write":{"maximum":10000,"seconds":60}}}',
        }),
      }) as unknown as Parameters<typeof accessRoutes>[0],
      { pool: database.pool, access: () => access, clock, tokens: tokenKeys },
    );
    /** The ordinary /token call on the management session. Never run inside a measured operation. */
    async function renewManagement() {
      try {
        management = await token(human.accountId, managementHeaders);
      } catch (error) {
        throw new Error(
          'Management session no longer issues tokens; its lifetime (the Better Auth default, 7 days) ended during the run',
          { cause: error },
        );
      }
    }
    async function grant(path: string, accountId: string, actions: readonly string[]) {
      const key = randomUUID();
      const send = () =>
        app.handle(
          new Request(`https://kernel.identity.test${path}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${management.bearer}`,
              'content-type': 'application/json',
              'idempotency-key': JSON.stringify(key),
            },
            body: JSON.stringify({
              resource: GLOBAL,
              subject: { kind: 'account', id: accountId },
              actions,
              valid: '(,)',
            }),
          }),
        );
      let response = await send();
      for (let attempt = 1; response.status === 503 && attempt < 3; attempt++) {
        await response.body?.cancel();
        await Bun.sleep(1000);
        response = await send();
      }
      if (![200, 201].includes(response.status)) throw new Error(`Public ${path} ${actions}: HTTP ${response.status}`);
      const body = (await response.json()) as { grant: GrantInput };
      if (path === '/v1/grants') grantLocators.push(body.grant);
    }
    await grant('/v1/grants', robot.accountId, importerScopes);
    await grant('/v1/grants', comparison.accountId, COMMON_ACTIONS);
    await options.afterStage?.('grants');
    const [governance, ordinary, bulk] = await Promise.all([
      issue(human.accountId, importerScopes),
      issue(comparison.accountId, COMMON_ACTIONS),
      issue(robot.accountId, importerScopes),
    ]);
    let bulkEnabled = true;
    const result: ImportIdentity = {
      database,
      access,
      accessConfig,
      routeKey,
      tokenKeys,
      auth,
      client,
      governance,
      bulk,
      ordinary,
      close,
      async setBulkPermission(enabled) {
        if (enabled === bulkEnabled) return;
        await grant(enabled ? '/v1/grants' : '/v1/grants:revoke', robot.accountId, [BULK_ACTION]);
        bulkEnabled = enabled;
      },
    };
    async function installKey(kid: string) {
      if (countingBaselineCalls) counters.baselineWorkflowCalls.keyInstalls += 3;
      const pair = await generateKeyPair('ES256', { extractable: true });
      const staged = await auth.internal.stageCredentialEffect({
        key: kid,
        subjectAccountId: robot.accountId,
        headers: managementHeaders,
        credential: { kind: 'key', kid, publicJwk: { ...(await exportJWK(pair.publicKey)), kid } },
      });
      const effect = {
        effectRef: staged.effectRef,
        key: staged.key,
        subjectAccountId: robot.accountId,
        headers: managementHeaders,
      };
      const approval = await auth.internal.approveCredentialEffect(effect);
      await auth.internal.applyCredentialEffect({ ...effect, authorization: approval.reference });
    }
    async function seedBaselineRows(count: number) {
      const now = Date.now();
      const baseline = Array.from({ length: count }, (_, index) => {
        const accountId = Bun.randomUUIDv7();
        const handle = `baseline_${index}`;
        const email = `${handle}@identity.test`;
        const registrationId = randomBytes(24).toString('base64url');
        const reservationId = Bun.randomUUIDv7();
        const credentialId = randomUUID();
        const expiresAt = new Date(now + 30 * 60_000).toISOString();
        const requestDigest = createHash('sha256')
          .update(JSON.stringify([handle]))
          .digest('hex');
        const credentialDigestKey = Buffer.from(
          hkdfSync('sha256', registrationStagingKey, '', 'rezics.auth.registration-binding.v1', 32),
        );
        const credentialDigest = createHmac('sha256', credentialDigestKey)
          .update(JSON.stringify({ email, password }))
          .digest('hex');
        const provisioningDigest = createHmac('sha256', authSecret)
          .update(
            JSON.stringify([
              'auth-provisioning-v2',
              accountId,
              email,
              password,
              [registrationId, reservationId, 1, expiresAt],
            ]),
          )
          .digest('hex');
        return {
          account_id: accountId,
          handle,
          email,
          transaction_id: Bun.randomUUIDv7(),
          registration_id: registrationId,
          reservation_id: reservationId,
          credential_id: credentialId,
          expires_at: expiresAt,
          pending_reference: randomBytes(32).toString('base64url'),
          request_digest: requestDigest,
          credential_digest: credentialDigest,
          provisioning_digest: provisioningDigest,
        };
      });
      const serialized = JSON.stringify(baseline);

      // Seed only unrelated identities. Keep the account and default self-grant rows that
      // native registrations leave in Access so the growth planner sees the same tables.
      await database.admin.query(
        `INSERT INTO access.account (route, account_id, kind, handle, state, transaction_id)
         SELECT get_byte(uuid_send(row.account_id::uuid),10) * 256 + get_byte(uuid_send(row.account_id::uuid),11),
                row.account_id::uuid, 'actor', row.handle, 'active', row.transaction_id
         FROM jsonb_to_recordset($1::jsonb) AS row(account_id text, handle text, transaction_id uuid)`,
        [serialized],
      );
      await database.admin.query(
        `INSERT INTO access.handle_claim (route, normalized_handle, account_id, state, transaction_id)
         SELECT get_byte(sha256(convert_to(row.handle, 'UTF8')),0) * 256
                  + get_byte(sha256(convert_to(row.handle, 'UTF8')),1),
                row.handle, row.account_id::uuid, 'active', row.transaction_id
         FROM jsonb_to_recordset($1::jsonb) AS row(account_id text, handle text, transaction_id uuid)`,
        [serialized],
      );
      await database.admin.query(
        `INSERT INTO access.resource_grant
           (route, resource_id, subject_id, subject_role, action, valid, transaction_id)
         SELECT get_byte(uuid_send(row.account_id::uuid),10) * 256 + get_byte(uuid_send(row.account_id::uuid),11),
                row.account_id::uuid, row.account_id::uuid, '', action.action, '(,)'::tstzrange, row.transaction_id
         FROM jsonb_to_recordset($1::jsonb) AS row(account_id text, transaction_id uuid)
         CROSS JOIN unnest(ARRAY['account:update','account:delete','account:read','account:manage']::text[]) AS action(action)`,
        [serialized],
      );

      const passwordHash = (
        await authDatabase!.pool.query<{ password: string }>(
          `SELECT password FROM account WHERE "userId"=$1 AND "providerId"='credential'`,
          [human.accountId],
        )
      ).rows[0]?.password;
      if (!passwordHash) throw new Error('Missing native password hash for identity baseline');
      await authDatabase!.pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified",image)
         SELECT row.account_id, '', row.email, false, NULL
         FROM jsonb_to_recordset($1::jsonb) AS row(account_id text, email text)`,
        [serialized],
      );
      await authDatabase!.pool.query(
        `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt")
         SELECT row.credential_id, row.account_id, 'credential', row.account_id, $2, statement_timestamp()
         FROM jsonb_to_recordset($1::jsonb) AS row(account_id text, credential_id text)`,
        [serialized, passwordHash],
      );
      await authDatabase!.pool.query(
        `INSERT INTO auth_registration_stage
           (registration_id,request_key,handle,account_id,reservation_id,request_digest,credential_digest,
            expires_at,completed_at,pending_reference)
         SELECT row.registration_id, row.handle, row.handle, row.account_id, row.reservation_id,
                decode(row.request_digest,'hex'), decode(row.credential_digest,'hex'), row.expires_at,
                statement_timestamp(), row.pending_reference
         FROM jsonb_to_recordset($1::jsonb) AS row(
           registration_id text, handle text, account_id text, reservation_id text, request_digest text,
           credential_digest text, expires_at timestamptz, pending_reference text
         )`,
        [serialized],
      );
      await authDatabase!.pool.query(
        `INSERT INTO auth_provisioning_receipt
           (idempotency_key,account_id,digest,registration_id,reservation_id,authn_epoch,expires_at,
            owner_id,credential_id,provisioning_kind)
         SELECT 'registration:' || row.registration_id, row.account_id, decode(row.provisioning_digest,'hex'),
                row.registration_id, row.reservation_id, 1, row.expires_at, row.account_id,
                row.credential_id, 'password'
         FROM jsonb_to_recordset($1::jsonb) AS row(
           registration_id text, account_id text, provisioning_digest text, reservation_id text,
           expires_at timestamptz, credential_id text
         )`,
        [serialized],
      );

      const publicKey = await exportJWK(accountKey.publicKey);
      const bindingKey = Buffer.from(
        hkdfSync('sha256', authSecret, '', 'rezics.auth.credential-binding.add-key.v1', 32),
      );
      const stagingKey = Buffer.from(
        hkdfSync('sha256', authSecret, '', 'rezics.auth.credential-staging.add-key.v1', 32),
      );
      const keys = Array.from({ length: count }, (_, index) => {
        const kid = `baseline-${index}`;
        const effectReference = randomUUID();
        const receiptId = randomUUID();
        const credential = {
          kind: 'key',
          kid,
          publicJwk: { ...publicKey, kid, alg: 'ES256', use: 'sig' },
        };
        const effectDigest = createHmac('sha256', bindingKey)
          .update(
            JSON.stringify([
              1,
              effectReference,
              kid,
              robot.accountId,
              'add-key',
              credential,
              null,
              null,
              human.accountId,
              managementClient,
              managementScopes,
            ]),
          )
          .digest('hex');
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', stagingKey, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify([1, effectReference, kid, robot.accountId, 'add-key'])));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
        return {
          kid,
          public_jwk: credential.publicJwk,
          receipt_id: receiptId,
          effect_reference: effectReference,
          effect_digest: effectDigest,
          stage_ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('hex'),
          opening_receipt_id: randomUUID(),
          opening_reference: randomUUID(),
        };
      });
      await authDatabase!.pool.query(
        `INSERT INTO auth_public_key (account_id,kid,public_jwk)
         SELECT $2, row.kid, row.public_jwk
         FROM jsonb_to_recordset($1::jsonb) AS row(kid text, public_jwk jsonb)`,
        [JSON.stringify(keys.map(({ kid, public_jwk }) => ({ kid, public_jwk }))), robot.accountId],
      );
      await authDatabase!.pool.query(
        `INSERT INTO auth_effect_receipt
           (receipt_id,account_id,purpose,minimum_authn_epoch,operation_key,effect_reference,effect_digest,
            stage_version,credential_row_id,credential_row_version,acting_human_id,client_id,scopes,
            stage_ciphertext,opening_receipt_id,committed_result,opening_reference,committed_at)
         SELECT row.receipt_id, $2, 'add-key', 1, row.kid, row.effect_reference, row.effect_digest, 1,
                NULL, NULL, $3, $4, $5::text[], decode(row.stage_ciphertext,'hex'), row.opening_receipt_id,
                jsonb_build_object('receiptId',row.receipt_id,'replayed',false), row.opening_reference,
                statement_timestamp()
         FROM jsonb_to_recordset($1::jsonb) AS row(
           receipt_id text, kid text, effect_reference text, effect_digest text, stage_ciphertext text,
           opening_receipt_id text, opening_reference text
         )`,
        [JSON.stringify(keys), robot.accountId, human.accountId, managementClient, managementScopes],
      );

      const sessionRows = Array.from({ length: 64 }, (_, index) => {
        const createdAt = new Date(Date.now() + index + 1).toISOString();
        return {
          id: randomUUID(),
          token: randomUUID(),
          created_at: createdAt,
          updated_at: createdAt,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
          user_id: robot.accountId,
          client_id: client.clientId,
          granted_scope: COMMON_ACTIONS.join(' '),
          authn_epoch: 1,
          auth_time: Math.floor(now / 1000),
          auth_methods: 'private_key_jwt',
        };
      });
      await authDatabase!.pool.query(
        `INSERT INTO session
           (id,token,"createdAt","updatedAt","expiresAt","userId","clientId","grantedScope",
            "authnEpoch","authTime","authMethods")
         SELECT row.id, row.token, row.created_at, row.updated_at, row.expires_at, row.user_id,
                row.client_id, row.granted_scope, row.authn_epoch, row.auth_time, row.auth_methods
         FROM jsonb_to_recordset($1::jsonb) AS row(
           id text, token text, created_at timestamptz, updated_at timestamptz, expires_at timestamptz,
           user_id text, client_id text, granted_scope text, authn_epoch integer, auth_time integer,
           auth_methods text
         )`,
        [JSON.stringify(sessionRows)],
      );
      const assertions = Array.from({ length: 64 }, () => ({ jti: randomUUID() }));
      await authDatabase!.pool.query(
        `INSERT INTO auth_key_assertion (account_id,jti,expires_at)
         SELECT $2, row.jti, statement_timestamp() + interval '30 seconds'
         FROM jsonb_to_recordset($1::jsonb) AS row(jti text)`,
        [JSON.stringify(assertions), robot.accountId],
      );

      // Keep unrelated native-shaped history beyond PostgreSQL's small-table
      // crossover so the measured owners retain stable indexed plans.
      const fillerKey = (
        await authDatabase!.pool.query<{ public_jwk: unknown }>(
          'SELECT public_jwk FROM auth_public_key WHERE account_id=$1 LIMIT 1',
          [result.bulk.accountId],
        )
      ).rows[0]?.public_jwk;
      if (!fillerKey) throw new Error('Missing native key for identity growth fixture');
      const seededAccounts = 2_048;
      const accountId = `(md5('import-identity-growth-' || i)::uuid)::text`;
      await authDatabase!.pool.query(
        `INSERT INTO public."user" (id,name,email,"emailVerified",image)
         SELECT ${accountId},'',NULL,false,NULL FROM generate_series(1,$1::integer) AS i`,
        [seededAccounts],
      );
      await authDatabase!.pool.query(
        `INSERT INTO public.account (id,"accountId","providerId","userId",password,"updatedAt")
         SELECT 'growth-credential-'||i,${accountId},'credential',${accountId},'growth-fixture-unusable-hash',statement_timestamp()
         FROM generate_series(1,$1::integer) AS i`,
        [seededAccounts],
      );
      await authDatabase!.pool.query(
        `INSERT INTO public.session (id,token,"userId","expiresAt","updatedAt","clientId","grantedScope","authnEpoch","authTime","authMethods")
         SELECT 'growth-session-'||i,'growth-token-'||i,${accountId},statement_timestamp()+interval '1 day',
           statement_timestamp(),$2,array_to_string($3::text[],' '),1,1,'private_key_jwt'
         FROM generate_series(1,$1::integer) AS i`,
        [seededAccounts, client.clientId, client.scopes],
      );
      await authDatabase!.pool.query(
        `INSERT INTO public.auth_consent (account_id,client_id,scopes)
         SELECT ${accountId},$2,$3::text[] FROM generate_series(1,$1::integer) AS i`,
        [seededAccounts, client.clientId, client.scopes],
      );
      await authDatabase!.pool.query(
        `INSERT INTO public.auth_public_key (account_id,kid,public_jwk)
         SELECT ${accountId},'growth-key-'||i,jsonb_set($2::jsonb,'{kid}',to_jsonb('growth-key-'||i),true)
         FROM generate_series(1,$1::integer) AS i`,
        [seededAccounts, fillerKey],
      );
      await authDatabase!.pool.query(
        `INSERT INTO public.auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch)
         SELECT 'growth-receipt-'||i,${accountId},'session',1
         FROM generate_series(1,$1::integer) AS i`,
        [seededAccounts],
      );
      await database.admin.query(
        `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
         SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,'actor','active',
           md5('import-identity-growth-tx-'||i)::uuid
         FROM (SELECT ${accountId}::uuid AS id,i FROM generate_series(1,$1::integer) AS i) seeded`,
        [seededAccounts],
      );
      await database.admin.query(
        `INSERT INTO access.resource_grant (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
         SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,id,'','account:read','(,)',
           md5('import-identity-growth-tx-'||i)::uuid
         FROM (SELECT ${accountId}::uuid AS id,i FROM generate_series(1,$1::integer) AS i) seeded`,
        [seededAccounts],
      );
    }
    support.set(result, {
      authDatabase,
      bindings,
      host,
      grantLocators,
      bootstrapPosition,
      credentialKid: accountKid,
      counters,
      issue,
      request,
      managementHeaders,
      get managementBearer() {
        return management.bearer;
      },
      renewManagement,
      async approveOpening(key) {
        const operation = {
          kind: 'opening' as const,
          authorization: 'approval-request',
          operatorAccountId: human.accountId,
          subjectAccountId: robot.accountId,
        };
        const approved = await approval.approve(
          management.bearer,
          { operationKey: key, operation },
          { pool: database.pool, deadline: Date.now() + 10000 },
        );
        const bound = { ...operation, authorization: approved.reference };
        const context = await approval.resolve(approved.reference, bound, {
          pool: database.pool,
          deadline: Date.now() + 10000,
        });
        const opened = await bindings.workflowPorts.authorizeOpening!(context, {
          operatorAccountId: human.accountId,
          subjectAccountId: robot.accountId,
          purpose: 'session',
          key,
        });
        return opened.value.receiptId;
      },
      async seedBaseline(count) {
        countingBaselineCalls = true;
        try {
          await seedBaselineRows(count);
        } finally {
          countingBaselineCalls = false;
        }
        await seedCommandHistory(result, managementClient);
        await renewManagement();
      },
      async grow(index) {
        await renewManagement();
        await host!.workflows.start();
        await person(`history_${index}`);
        // Grow real Auth keys/effect history and native consumed openings on
        // the same subject/operator anchors, as well as unrelated accounts.
        await installKey(`history-${index}`);
        // Same Global + hot importer rows, using only normal public commands.
        await result.setBulkPermission(false);
        await result.setBulkPermission(true);
        await issue(robot.accountId, COMMON_ACTIONS);
      },
    });
    // DBOS is a process singleton. Quiesce its workflows after finite setup so
    // two live fixture services can coexist with their separate Auth pools.
    await host.workflows.close();
    return result;
  } catch (error) {
    await close();
    throw error;
  }
}

const BOOTSTRAP_DIAGNOSTIC_BYTES = 16_384; // Per pipe; draining continues after the cap.
type BootstrapChild = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
};
type BootstrapSpawn = (
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdout: 'pipe'; stderr: 'pipe' },
) => BootstrapChild;

async function drainBootstrapPipe(stream: ReadableStream<Uint8Array>) {
  const retained = new Uint8Array(BOOTSTRAP_DIAGNOSTIC_BYTES);
  let length = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const count = Math.min(value.byteLength, retained.length - length);
      retained.set(value.subarray(0, count), length);
      length += count;
      truncated ||= count < value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(retained.subarray(0, length)), truncated };
}

function bootstrapDiagnostic(output: { text: string; truncated: boolean }, url: string) {
  const locator = URL.canParse(url) ? new URL(url) : null;
  const secrets = new Set([url]);
  for (const value of [locator?.username, locator?.password]) {
    if (!value) continue;
    secrets.add(value);
    try {
      secrets.add(decodeURIComponent(value));
    } catch {
      // Malformed URL escapes must not hide the original child failure.
    }
  }
  let text = output.text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (!secret) continue;
    text = text.replaceAll(secret, '[redacted]');
    // A cap can split a locator or credential. Remove that trailing prefix too.
    if (output.truncated) {
      for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) {
        if (text.endsWith(secret.slice(0, length))) {
          text = `${text.slice(0, -length)}[redacted]`;
          break;
        }
      }
    }
  }
  // Redaction and replacement characters can expand the already bounded text.
  return new TextDecoder().decode(Buffer.from(text).subarray(0, BOOTSTRAP_DIAGNOSTIC_BYTES), { stream: true });
}

export async function runIdentityBootstrap(
  url: string,
  accountId: string,
  required = false,
  spawn: BootstrapSpawn = (command, options) => Bun.spawn(command, options),
): Promise<{ exitCode: number }> {
  const child = spawn([process.execPath, 'services/kernel/scripts/bootstrap-governance.ts', '--account', accountId], {
    cwd: new URL('../../../../', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    drainBootstrapPipe(child.stdout),
    drainBootstrapPipe(child.stderr),
  ]);
  if (required && exitCode !== 0)
    throw new Error(`Deployment governance bootstrap exited ${exitCode}`, {
      cause: {
        exitCode,
        stdout: bootstrapDiagnostic(stdout, url),
        stderr: bootstrapDiagnostic(stderr, url),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      },
    });
  return { exitCode };
}
