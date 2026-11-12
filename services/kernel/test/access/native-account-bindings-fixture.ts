import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createProvisioningEvidenceVerifier,
  createNativeWorkflowProofPorts,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createAccess, INTERNAL_ACTIONS } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `native_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const drop = async () => {
    const admin = new URL(process.env.DATABASE_URL!);
    admin.pathname = '/postgres';
    const owner = new Client({ connectionString: admin.toString() });
    const failures: unknown[] = [];
    try {
      await owner.connect();
      await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (error) {
      failures.push(error);
    }
    try {
      await owner.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Native Auth database cleanup failed');
  };
  try {
    const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
    return { url, close: drop };
  } catch (error) {
    try {
      await drop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native Auth database construction and cleanup failed', {
        cause: error,
      });
    }
    throw error;
  }
}

export const issuer = 'https://ordinary.auth.test';
export const password = 'ordinary native registration password';
export const scopes = [
  'subject:create',
  'subject:batch_write',
  'source_fence:read',
  'media:import_from_url',
  'account:manage',
  'access:grant',
];

export function actionDeclarations(actions: readonly string[]) {
  return new Map(
    actions.map(
      (action) =>
        [action, INTERNAL_ACTIONS.get(action) ?? LIFECYCLE_ACTIONS.get(action) ?? { anonymous: false }] as const,
    ),
  );
}

export const cookies = (response: Response) =>
  new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  });

export async function nativeFixture(
  pool: Pool,
  openAuthPool?: () => Pool,
  existing?: {
    database: { url: string; container?: string; close(): void | Promise<void> };
    privateKey: JWK & { kid: string };
    actions?: ReadonlyMap<string, { anonymous: boolean }>;
  },
) {
  configureTestReceiptKeys(pool);
  const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
  const actions = new Map([
    ...LIFECYCLE_ACTIONS,
    ...INTERNAL_ACTIONS,
    ...actionDeclarations(scopes),
    ...(existing?.actions ?? []),
  ]);
  const database = existing?.database ?? (await cloneAuthDatabase());
  let privateKey: (JWK & { kid: string }) | undefined = existing?.privateKey;
  let service!: AuthService;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let bindings: ReturnType<typeof createNativeAccountBindings>;
  let proofs: ReturnType<typeof createNativeWorkflowProofPorts>;
  let authPool: Pool | undefined;
  let access!: ReturnType<typeof createAccess>;
  async function closeResources(closeDatabase: boolean): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (host) await attempt(() => host!.stop());
    if (authPool) await attempt(() => authPool!.end());
    if (closeDatabase) await attempt(() => database.close());
    if (failures.length) throw new AggregateError(failures, 'Native Auth fixture cleanup failed');
  }
  const build = async () => {
    const currentPool = openAuthPool?.() ?? new Pool({ connectionString: database.url });
    authPool = currentPool;
    // The growth harness instruments this pool before any connection is made.
    currentPool.options.connectionString = database.url;
    const end = currentPool.end.bind(currentPool);
    let ending: Promise<void> | undefined;
    currentPool.end = (() => (ending ??= end())) as Pool['end'];
    proofs = createNativeWorkflowProofPorts({ database: currentPool });
    bindings = createNativeAccountBindings({
      pool,
      access,
      actions,
      routeKey: new Uint8Array(32).fill(91),
      referenceKeys,
      auth: () => service,
      proofs: {
        workflow: proofs,
        provisioning: createProvisioningEvidenceVerifier({ database: currentPool }),
        barriers: createBarrierProofVerifier({ database: currentPool }),
      },
    });
    host = await createAuthHost({
      database: currentPool,
      systemDatabasePool: currentPool,
      issuer,
      audience: 'https://ordinary.api.test',
      secret: 'ordinary-native-persistent-auth-secret-32-bytes',
      signing: { activeKid: privateKey!.kid, privateKeys: [privateKey!] },
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      accountOperations: bindings.accountOperations,
      accountManagementReads: bindings.accountManagementReads,
      stagingKey: new Uint8Array(32).fill(93),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: 'ordinary-native-executor',
    });
    service = host.service;
    await service.internal.registerClient({ clientId: 'ordinary-test-client', firstParty: true, scopes });
    await host.start();
  };
  try {
    if (!privateKey) {
      const pair = await generateKeyPair('ES256', { extractable: true });
      privateKey = { ...(await exportJWK(pair.privateKey)), kid: 'ordinary-native' };
    }
    access = createAccess({
      actions,
      auth: {
        issuer,
        audience: 'https://ordinary.api.test',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
      },
    });
    await build();
  } catch (error) {
    try {
      await closeResources(true);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native Auth fixture construction and cleanup failed', {
        cause: error,
      });
    }
    throw error;
  }
  const running = () => {
    if (!host) throw new Error('Auth host failed to start');
    return host;
  };
  const request = (path: string, body?: unknown, headers = new Headers()) =>
    service.handler(
      new Request(`${issuer}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const approval = () =>
    createWorkflowApprovals({
      pool,
      access,
      actions,
      referenceKeys,
      creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
    });
  return {
    pool,
    access,
    database,
    privateKey: privateKey!,
    referenceKeys,
    get COMMANDS() {
      return {
        lifecycle: bindings.lifecycle,
        internalLifecycle: bindings.internalLifecycle,
        operators: bindings.operators,
        grants: bindings.grants,
        delegations: bindings.delegations,
      };
    },
    stop: () => closeResources(false),
    request,
    approval,
    get host() {
      return running();
    },
    get bindings() {
      return bindings;
    },
    get authPool() {
      return authPool;
    },
    get proofs() {
      return proofs;
    },
    async restart() {
      await closeResources(false);
      try {
        await build();
      } catch (error) {
        try {
          await closeResources(true);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Native Auth fixture restart and cleanup failed', {
            cause: error,
          });
        }
        throw error;
      }
    },
    async close() {
      await closeResources(true);
    },
    async person(key: string) {
      const result = await running().workflows.register({
        key,
        handle: key.replaceAll('-', '_'),
        email: `${key}@ordinary.test`,
        password,
      });
      const signed = await request('/signin', {
        email: `${key}@ordinary.test`,
        password,
        client_id: 'ordinary-test-client',
        scope: scopes,
      });
      if (signed.status !== 200) throw new Error(`Signin failed: ${signed.status}`);
      const headers = cookies(signed);
      const response = await request('/token', {}, headers);
      if (response.status !== 200) throw new Error(`Token failed: ${response.status}`);
      const { access_token: bearer } = (await response.json()) as { access_token: string };
      return { ...result, headers, bearer };
    },
    async automated(key: string, human: { accountId: string; bearer: string }) {
      const operation = {
        kind: 'automated' as const,
        registrationId: '',
        operatorAccountId: human.accountId,
        handle: key.replaceAll('-', '_'),
        operationKey: key,
        authorization: 'approval-request',
      };
      const approved = await approval().approve(
        human.bearer,
        { operationKey: key, operation },
        { pool, deadline: Date.now() + 10000 },
      );
      return running().workflows.createAutomated({
        key,
        handle: operation.handle,
        operatorAccountId: human.accountId,
        authorization: approved.reference,
      });
    },
  };
}
