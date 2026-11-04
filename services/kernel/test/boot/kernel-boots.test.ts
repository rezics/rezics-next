import { expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { trustedAccessPorts } from '../../../auth/test/support/trusted-access.ts';
import { withThrowawayDatabase } from '../../scripts/derived.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
import { workerTestEnv } from '../support/worker-env.ts';

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
  const workerKeys = {
    ...workerTestEnv(),
    ...serverKeys(databaseUrl),
    KERNEL_RATING_COUNTER_SECRET: key(),
    KERNEL_EXECUTOR_ID: `boot-${crypto.randomUUID()}`,
  };
  const worker = await startWorker(readWorkerConfig(workerKeys), undefined, workerKeys);
  await worker.stop();
}

async function boot(env: NodeJS.ProcessEnv) {
  const databaseUrl = env.DATABASE_URL!;
  // DBOS is process-global; production runs these entries in separate processes.
  await startKernelApi(databaseUrl);
  await startAuthHost(databaseUrl);
  await startKernelWorker(databaseUrl);
}

test('the Kernel API, worker and native Auth host entries start against a throwaway database', async () => {
  if (process.env.DATABASE_URL) await boot(process.env);
  else await withThrowawayDatabase(boot);
});
