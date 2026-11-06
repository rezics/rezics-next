import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createAuthHost, AuthHostConfigurationError } from '../src/host.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';
import type { AuthServiceOptions } from '../src/index.ts';
import type { AccountWorkflowPorts } from '../src/workflows.ts';

const unused = async (): Promise<never> => {
  throw new Error('Database identity must not call Access');
};
const access: AccountWorkflowPorts = {
  registrationTarget: () => {
    throw new Error('Database identity must not call Access');
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
const trustedAccess: AuthServiceOptions['trustedAccess'] = trustedAccessPorts({
  readAccount: unused,
  readFencedAccount: unused,
  authorizeProvisioning: unused,
});

async function rejected(options: Parameters<typeof createAuthHost>[0], code: AuthHostConfigurationError['code']) {
  try {
    await createAuthHost(options);
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(AuthHostConfigurationError);
    expect((error as AuthHostConfigurationError).code).toBe(code);
  }
}

test('host identity admits an absolute unix-socket host and refuses a TCP host override', async () => {
  const socket = 'postgres://user:secret@localhost/auth?host=/tmp/native-owned-pg&sslmode=disable';
  const pool = new Pool({ connectionString: socket });
  const other = new Pool({ connectionString: 'postgres://user:secret@localhost/auth?host=127.0.0.1' });
  const base = {
    issuer: 'https://auth.test',
    audience: 'https://api.test',
    secret: 'unused',
    signing: { activeKid: 'unused' as const, privateKeys: [] },
    trustedAccess,
    access,
    stagingKey: randomBytes(32),
  };
  try {
    await rejected({ ...base, database: pool, stagingKey: new Uint8Array(3) }, 'staging-key');
    await rejected(
      {
        ...base,
        database: pool,
        systemDatabaseUrl: 'postgres://user:secret@localhost/auth?host=/tmp/other-socket&sslmode=disable',
      },
      'database',
    );
    await rejected({ ...base, database: other }, 'database');
    await rejected(
      {
        ...base,
        database: pool,
        systemDatabaseUrl: 'postgres://user:secret@localhost/kernel?host=/tmp/native-owned-pg',
      },
      'database',
    );
  } finally {
    await Promise.all([pool.end(), other.end()]);
  }
});
