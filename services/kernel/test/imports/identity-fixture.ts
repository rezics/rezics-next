import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AccountWorkflowOptions,
  type AuthService,
} from '@rezics/auth';
import { randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { migrate as migrateAuth } from '../../../auth/scripts/database.ts';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { createKernel, type KernelDependencies } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import type { GrantInput } from '../../src/access/grant-commands.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  COMMON_ACTIONS,
  IMPORT_ACTIONS,
  BULK_ACTION,
  GLOBAL,
  type Stage,
} from '../../../../specs/imports-identity-driver.ts';

export const MISSING_IMPORT_IDENTITY = 'openImportIdentity is not implemented';
export interface ImportIdentityOptions {
  /** Borrowed application database, including its original capture pool. */
  readonly database: GrowthDatabase;
  readonly clock: NonNullable<AccountWorkflowOptions['clock']>;
  /** Optional migrated, credential-free Auth template owned by the composition. */
  readonly authTemplate?: string;
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
 * No application outcomes are installed with SQL. */
export async function openImportIdentity(options: ImportIdentityOptions): Promise<ImportIdentity> {
  const { database, clock } = options;
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
    namespace = await createIdentityNamespace(database.url, options.authTemplate);
    if (!options.authTemplate) migrateAuth(namespace.url);
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
    const kernel = createKernel({
      pool: database.pool,
      routeKey,
      tokens: tokenKeys,
      clock,
    });
    const actions = new Map([...actionCatalogue(kernel), ...LIFECYCLE_ACTIONS]);
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
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: randomBytes(32).toString('hex'),
      signing: { activeKid: kid, privateKeys: [{ ...(await exportJWK(pair.privateKey)), kid }] },
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      stagingKey: new Uint8Array(randomBytes(32)),
      executorId: `identity-${randomUUID()}`,
      maintenanceSchedule: '0 0 1 1 *',
    });
    auth = host.service;
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
      const result = await host!.workflows.register({ key: name, handle: name, email, password });
      return { ...result, email };
    };
    const human = await person('governance');
    const comparison = await person('ordinary');
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
    const app = createKernel({
      pool: database.pool,
      routeKey,
      tokens: tokenKeys,
      clock,
      access,
      // A finite isolated deployment budget admits history seeding while retaining
      // the real request-stage identity, counter SQL and admission pipeline.
      writeRate: createWriteRateLimiter({
        secret: randomBytes(32).toString('hex'),
        overrides: '{"new-account":{"write":{"maximum":10000,"seconds":60}}}',
      }),
    });
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
      const response = await app.handle(
        new Request(`https://kernel.identity.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${management.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
          },
          body: JSON.stringify({
            resource: GLOBAL,
            subject: { kind: 'account', id: accountId },
            actions,
            valid: '(,)',
          }),
        }),
      );
      if (![200, 201].includes(response.status)) throw new Error(`Public ${path} ${actions}: HTTP ${response.status}`);
      const body = (await response.json()) as { grant: GrantInput };
      if (path === '/v1/grants') grantLocators.push(body.grant);
    }
    for (const action of importerScopes) await grant('/v1/grants', robot.accountId, [action]);
    for (const action of COMMON_ACTIONS) await grant('/v1/grants', comparison.accountId, [action]);
    await options.afterStage?.('grants');
    const governance = await issue(human.accountId, importerScopes);
    const ordinary = await issue(comparison.accountId, COMMON_ACTIONS);
    const bulk = await issue(robot.accountId, importerScopes);
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
    support.set(result, {
      authDatabase,
      bindings,
      host,
      grantLocators,
      bootstrapPosition,
      credentialKid: accountKid,
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
        await host!.workflows.start();
        // Independent real registrations can overlap. Native command admission,
        // deadlines and contention retries remain wholly owned by the kernel.
        for (let first = 0; first < count; first += 8)
          await Promise.all(
            Array.from({ length: Math.min(8, count - first) }, (_, offset) => person(`baseline_${first + offset}`)),
          );
        for (let index = 0; index < count; index++) await installKey(`baseline-${index}`);
        // Reach the native bounded session-history capacity before measurement,
        // so every measured issuance performs the same real eviction path.
        for (let index = 0; index < 64; index++) await issue(robot.accountId, COMMON_ACTIONS);
        await host!.workflows.close();
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

export async function runIdentityBootstrap(
  url: string,
  accountId: string,
  required = false,
): Promise<{ exitCode: number }> {
  const child = Bun.spawn(
    [process.execPath, 'services/kernel/scripts/bootstrap-governance.ts', '--account', accountId],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (required && exitCode !== 0) throw new Error(`Deployment governance bootstrap exited ${exitCode}`);
  return { exitCode };
}
