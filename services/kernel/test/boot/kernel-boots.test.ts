import { expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { trustedAccessPorts } from '../../../auth/test/support/trusted-access.ts';
import { withThrowawayDatabase } from '../../scripts/derived.ts';
import { createAuthDatabase } from '../support/auth-database.ts';

setDefaultTimeout(120_000);

const key = () => randomBytes(32).toString('base64url');
const unused = async (): Promise<never> => {
  throw new Error('Unexpected account workflow access');
};

test('the Kernel API, worker and native Auth host entries start against a throwaway database', async () => {
  await withThrowawayDatabase(async (env) => {
    const databaseUrl = env.DATABASE_URL!;
    const keys = {
      DATABASE_URL: databaseUrl,
      KERNEL_ROUTE_KEY: key(),
      KERNEL_SESSION_KEYS: `1:${key()}`,
      KERNEL_RECEIPT_KEYS: `1:${key()}`,
      KERNEL_WRITE_RATE_SECRET: key(),
      KERNEL_RATING_COUNTER_SECRET: key(),
      KERNEL_PORT: '0',
      KERNEL_EXECUTOR_ID: `boot-${crypto.randomUUID()}`,
      AUTH_ISSUER: 'https://auth.boot.test',
      AUTH_AUDIENCE: 'https://api.boot.test',
      AUTH_JWKS_URL: 'https://auth.boot.test/.well-known/jwks.json',
    };
    const { readConfig, startServer } = await import('../../src/server.ts');
    const { readWorkerConfig, startWorker } = await import('../../src/worker.ts');
    const { createAuthHost } = await import('../../../auth/src/host.ts');
    const stops: Array<() => Promise<void>> = [];
    try {
      const server = await startServer(readConfig(keys));
      stops.push(() => server.stop());
      const worker = await startWorker(readWorkerConfig(keys), undefined, keys);
      stops.push(() => worker.stop());
      const database = new Pool({
        connectionString: await createAuthDatabase(databaseUrl, `auth_boot_${crypto.randomUUID().replaceAll('-', '')}`),
      });
      const pair = await generateKeyPair('ES256', { extractable: true });
      const signing = { ...(await exportJWK(pair.privateKey)), kid: 'boot', alg: 'ES256' };
      const host = await createAuthHost({
        database,
        issuer: keys.AUTH_ISSUER,
        audience: keys.AUTH_AUDIENCE,
        secret: 'kernel-boot-auth-host-secret-32bytes!!',
        signing: { activeKid: signing.kid, privateKeys: [signing] },
        stagingKey: randomBytes(32),
        trustedAccess: trustedAccessPorts({ readAccount: async () => null, authorizeProvisioning: unused }),
        access: {
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
        },
        maintenanceSchedule: '0 0 1 1 *',
        executorId: 'kernel-boot-auth',
      });
      stops.push(() => host.stop());
      await host.start();
      const health = await fetch(new URL('/health', server.url));
      expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
    } finally {
      for (const stop of stops.reverse()) await stop();
    }
  });
});
