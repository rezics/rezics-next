import {
  createAuthHost,
  createBarrierProofVerifier,
  createProvisioningEvidenceVerifier,
  createNativeWorkflowProofPorts,
  type AuthService,
  type AccountOperationAccess,
} from '@rezics/auth';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { admitGroup, PlatformClosedError } from '../../src/access/gates/admission.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `native_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
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
  const database = existing?.database ?? (await cloneAuthDatabase());
  const pair = existing ? undefined : await generateKeyPair('ES256', { extractable: true });
  const privateKey = existing?.privateKey ?? { ...(await exportJWK(pair!.privateKey)), kid: 'ordinary-native' };
  let service: AuthService;
  let host: Awaited<ReturnType<typeof createAuthHost>>;
  let bindings: ReturnType<typeof createNativeAccountBindings>;
  let proofs: ReturnType<typeof createNativeWorkflowProofPorts>;
  let authPool: Pool;
  const actions = new Map([
    ...LIFECYCLE_ACTIONS,
    ...scopes.map((scope) => [scope, { anonymous: false }] as const),
    ...(existing?.actions ?? []),
  ]);
  const access = createAccess({
    actions,
    auth: {
      issuer,
      audience: 'https://ordinary.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
  const build = async () => {
    authPool = openAuthPool?.() ?? new Pool({ connectionString: database.url });
    // The growth harness instruments this pool before any connection is made.
    authPool.options.connectionString = database.url;
    if (openAuthPool) {
      const end = authPool.end.bind(authPool);
      let ending: Promise<void> | undefined;
      authPool.end = (() => (ending ??= end())) as Pool['end'];
    }
    proofs = createNativeWorkflowProofPorts({ database: authPool });
    bindings = createNativeAccountBindings({
      pool,
      access,
      actions,
      routeKey: new Uint8Array(32).fill(91),
      referenceKeys,
      auth: () => service,
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
      audience: 'https://ordinary.api.test',
      secret: 'ordinary-native-persistent-auth-secret-32-bytes',
      signing: { activeKid: privateKey.kid, privateKeys: [privateKey] },
      trustedAccess: bindings.trustedAccess,
      access: bindings.workflowPorts,
      accountOperations: (() => {
        const workflowApprovals = createWorkflowApprovals({
          pool,
          access,
          actions,
          referenceKeys,
          creationBinding: (input: { registrationId: string; operationKey: string }) => proofs.creationBinding(input),
        });
        const context = () => ({ pool, deadline: Date.now() + 10000 });
        const ports: AccountOperationAccess = {
          context,
          approve: (token, input, ctx) => workflowApprovals.approve(token, input as never, ctx as never),
          resolveForCaller: (token, reference, operation, ctx) =>
            workflowApprovals.resolveForCaller(token, reference, operation as never, ctx as never),
          async admitGroup(token, group, ctx) {
            const bounded = ctx as ReturnType<typeof context>;
            const actor = await access.authenticate(token, bounded);
            try {
              await admitGroup({
                pool,
                access: () => access,
                actor,
                group,
                clientAction: 'organization:create',
                deadline: bounded.deadline,
                clock: () => new Date(),
              });
              return true;
            } catch (error) {
              if (error instanceof PlatformClosedError) return false;
              throw error;
            }
          },
        };
        return ports;
      })(),
      stagingKey: new Uint8Array(32).fill(93),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: 'ordinary-native-executor',
    });
    service = host.service;
    await service.internal.registerClient({ clientId: 'ordinary-test-client', firstParty: true, scopes });
    await host.start();
  };
  await build();
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
    privateKey,
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
    stop: () => host.stop(),
    request,
    approval,
    get host() {
      return host;
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
      await host.stop();
      await build();
    },
    async close() {
      try {
        await host.stop();
      } finally {
        await database.close();
      }
    },
    async person(key: string) {
      const result = await host.workflows.register({
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
      return host.workflows.createAutomated({
        key,
        handle: operation.handle,
        operatorAccountId: human.accountId,
        authorization: approved.reference,
      });
    },
  };
}
