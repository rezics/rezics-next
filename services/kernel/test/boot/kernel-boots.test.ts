import { expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withThrowawayDatabase } from '../../scripts/derived.ts';

setDefaultTimeout(600_000);

const key = () => randomBytes(32).toString('base64url');
const unused = async (): Promise<never> => {
  throw new Error('Unexpected account workflow access');
};
const access = {
  registrationTarget: () => {
    throw new Error('Unexpected registration target');
  },
  reserveHandle: unused,
  createPending: unused,
  claimHandle: unused,
  activate: unused,
  expireRegistration: unused,
  releaseExpiredRegistrationHandle: unused,
  provisioningReference: unused,
  provisioningEvidence: unused,
  raiseFence: unused,
  readAccount: unused,
};

function serverKeys(databaseUrl: string) {
  return {
    DATABASE_URL: databaseUrl,
    KERNEL_ROUTE_KEY: key(),
    KERNEL_SESSION_KEYS: `1:${key()}`,
    KERNEL_RECEIPT_KEYS: `1:${key()}`,
    KERNEL_WRITE_RATE_SECRET: key(),
    KERNEL_PORT: '0',
  };
}

async function startKernelApi(databaseUrl: string) {
  const { readConfig, startServer } = await import('../../src/server.ts');
  const server = await startServer(readConfig(serverKeys(databaseUrl)));
  try {
    const health = await fetch(new URL('/health', server.url));
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
  } finally {
    await server.stop();
  }
}

async function startAuthHost(databaseUrl: string) {
  const { createAuthHost } = await import('../../../auth/src/host.ts');
  const { trustedAccessPorts } = await import('../../../auth/test/support/trusted-access.ts');
  const { createAuthDatabase } = await import('../support/auth-database.ts');
  const { Pool } = await import('pg');
  const { exportJWK, generateKeyPair } = await import('jose');
  const authUrl = await createAuthDatabase(databaseUrl, `auth_boot_${crypto.randomUUID().replaceAll('-', '')}`);
  const database = new Pool({ connectionString: authUrl });
  const system = new Pool({ connectionString: authUrl, max: 8 });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const signing = { ...(await exportJWK(pair.privateKey)), kid: 'boot', alg: 'ES256' };
  const host = await createAuthHost({
    database,
    systemDatabasePool: system,
    issuer: 'https://auth.boot.test',
    audience: 'https://api.boot.test',
    secret: 'kernel-boot-auth-host-secret-32bytes!!',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    stagingKey: randomBytes(32),
    trustedAccess: trustedAccessPorts({ readAccount: async () => null, authorizeProvisioning: unused }),
    access,
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'kernel-boot-auth',
  });
  try {
    await host.start();
  } finally {
    await host.stop();
  }
}

async function startKernelWorker(databaseUrl: string) {
  const { readWorkerConfig, startWorker } = await import('../../src/worker.ts');
  const { workerTestEnv } = await import('../support/worker-env.ts');
  const workerKeys = {
    ...workerTestEnv(),
    ...serverKeys(databaseUrl),
    KERNEL_RATING_COUNTER_SECRET: key(),
    KERNEL_EXECUTOR_ID: `boot-${crypto.randomUUID()}`,
  };
  const worker = await startWorker(readWorkerConfig(workerKeys), undefined, workerKeys);
  await worker.stop();
}

const OPERATION_ID = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

/** Exercise the actual local Auth composition, including native bindings and client registration. */
async function startPersonaSeed(databaseUrl: string) {
  const { assemble, developmentKeys, provisionPersona } = await import('../../../auth/scripts/dev-stack.ts');
  const { createAuthDatabase } = await import('../support/auth-database.ts');
  const authDatabaseUrl = await createAuthDatabase(
    databaseUrl,
    `persona_boot_${crypto.randomUUID().replaceAll('-', '')}`,
  );
  const temporary = resolve(import.meta.dir, '../../../../.temp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(resolve(temporary, 'persona-boot-'));
  const composition = await assemble({
    env: serverKeys(databaseUrl),
    authDatabaseUrl,
    keys: await developmentKeys(directory),
  });
  try {
    const person = await provisionPersona(composition, directory);
    expect(person.accountId).toBeString();
    const history: string[] = [];
    for (const route of composition.kernel.routes) {
      const detail = route.hooks?.detail as Record<string, unknown> | undefined;
      if (!detail || detail.hide === true) continue;
      expect(detail.operationId).toMatch(OPERATION_ID);
      if (String(route.path).includes('/structure-history')) {
        history.push(String(detail.operationId));
      }
    }
    expect(history.sort()).toEqual(['collection.structure_history_compare', 'collection.structure_history_list']);
    return person.accountId;
  } finally {
    await composition.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

async function boot(env: NodeJS.ProcessEnv) {
  const databaseUrl = env.DATABASE_URL!;
  // The root acceptance command does not inherit the Kernel workspace's Reylo preload.
  // Match dev-stack's loader before any entry or SQL-loading support import.
  await import('reylo/register');
  // DBOS is process-global; production runs these entries in separate processes.
  const personaId = await startPersonaSeed(databaseUrl);
  await startKernelApi(databaseUrl);
  const { synchronizeAccountAgent } = await import('../../src/access/account-agent-effect.ts');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await synchronizeAccountAgent(pool, personaId);
  } finally {
    await pool.end();
  }
  await startAuthHost(databaseUrl);
  await startKernelWorker(databaseUrl);
}

test('Kernel API, worker, native Auth host and persona/seed entries start against a throwaway database', async () => {
  if (process.env.DATABASE_URL) await boot(process.env);
  else await withThrowawayDatabase(boot);
});
