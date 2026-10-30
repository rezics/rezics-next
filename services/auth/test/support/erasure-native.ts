import { expect } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../../scripts/database.ts';
import { migrate as migrateKernel } from '../../../kernel/scripts/database.ts';
import { createAuthHost, type AccountOperationAccess } from '../../src/index.ts';
import { createNativeWorkflowProofPorts } from '../../src/native-workflow-proofs.ts';
import { createProvisioningEvidenceVerifier } from '../../src/provisioning-evidence.ts';
import { createBarrierProofVerifier } from '../../src/barrier-proofs.ts';

export const issuer = 'https://native-erasure.auth.test';
export const password = 'native erasure acceptance password';
export const scopes = ['account:read', 'account:update', 'account:delete', 'account:manage'];
export type Person = { accountId: string; cookie: string; email: string; bearer: string };

/** Real Access composition is test-only. Production Auth receives ports and an
 * Auth-only pool, never a kernel module, pool, key or credential. */
export async function nativeFixture() {
  const fixture = testDatabase();
  migrateKernel(fixture.url);
  const kernel = new Pool({ connectionString: fixture.url });
  const pool = new Pool({ connectionString: fixture.url });
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = fixture.url;
  let modules;
  try {
    await import(createRequire(new URL('../../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
    modules = {
      ...(await import('../../../kernel/src/access/index.ts')),
      ...(await import('../../../kernel/src/access/native-account-bindings.ts')),
      ...(await import('../../../kernel/src/access/workflow-approvals.ts')),
      ...(await import('../../../kernel/src/access/lifecycle.ts')),
      ...(await import('../../../kernel/src/route/route.ts')),
    };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
  const actions = new Map(modules.LIFECYCLE_ACTIONS);
  actions.set('account:manage', { anonymous: false });
  let host: Awaited<ReturnType<typeof createAuthHost>>;
  const access = modules.createAccess({
    actions,
    auth: {
      issuer,
      audience: 'https://native-erasure.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => host.service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const proofs = createNativeWorkflowProofPorts({ database: pool });
  const referenceKeys = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  const bindings = modules.createNativeAccountBindings({
    pool: kernel,
    access,
    actions,
    routeKey: randomBytes(32),
    referenceKeys,
    auth: () => host.service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: pool }),
      barriers: createBarrierProofVerifier({ database: pool }),
    },
  });
  const approvals = modules.createWorkflowApprovals({
    pool: kernel,
    access,
    actions,
    referenceKeys,
    creationBinding: proofs.creationBinding,
  });
  const context = () => ({ pool: kernel, deadline: Date.now() + 30_000 });
  const accountOperations: AccountOperationAccess = {
    context,
    async admitGroup() {
      throw new Error('This fixture does not exercise gated groups');
    },
    approve: (token, input, ctx) => approvals.approve(token, input as never, ctx as never),
    resolveForCaller: (token, reference, operation, ctx) =>
      approvals.resolveForCaller(token, reference, operation as never, ctx as never),
  };
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'native-erasure',
    alg: 'ES256',
  };
  host = await createAuthHost({
    database: pool,
    systemDatabasePool: pool,
    issuer,
    audience: 'https://native-erasure.api.test',
    secret: randomBytes(48).toString('hex'),
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    accountOperations,
    stagingKey: randomBytes(32),
    executorId: `erasure-${randomUUID()}`,
    maintenanceSchedule: '* * * * * *',
  });
  await host.start();
  await host.service.internal.registerClient({ clientId: 'erasure-web', firstParty: true, scopes });
  const call = (path: string, body: unknown, cookie = '') =>
    host.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  return {
    fixture,
    pool,
    kernel,
    host,
    key,
    bindings,
    approvals,
    context,
    call,
    routeOf: modules.routeOf,
    async person(name: string): Promise<Person> {
      const requestKey = `${name}-${randomUUID()}`;
      const email = `${requestKey}@native-erasure.test`;
      const { accountId } = await host.workflows.register({
        key: requestKey,
        handle: requestKey.replaceAll('-', '_'),
        email,
        password,
      });
      const response = await call('/signin', { email, password, client_id: 'erasure-web', scope: scopes });
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const token = await call('/token', {}, cookie);
      expect(token.status).toBe(200);
      return { accountId, email, cookie, bearer: ((await token.json()) as { access_token: string }).access_token };
    },
    async delete(person: Person, key = randomUUID()) {
      const operation = { kind: 'delete', accountId: person.accountId };
      const approval = await call('/account-operations/approve', { operationKey: key, operation }, person.cookie);
      expect(approval.status).toBe(200);
      const { reference } = (await approval.json()) as { reference: string };
      return call('/account-operations/execute', { operationKey: key, operation, reference }, person.cookie);
    },
    async close() {
      await host.stop();
      await kernel.end();
      fixture.close();
    },
  };
}
