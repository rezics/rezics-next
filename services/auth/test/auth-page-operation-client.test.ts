import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthHost, type AccountWorkflowPorts } from '../src/index.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const unused = async (): Promise<never> => {
  throw new Error('Default client registration must not call Access');
};
const access: AccountWorkflowPorts = {
  registrationTarget: () => {
    throw new Error('Default client registration must not call Access');
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

test('default native host registers the exact narrow first-party operation client', async () => {
  const database = testDatabase();
  const product = new Pool({ connectionString: database.url });
  const system = new Pool({ connectionString: database.url, max: 8 });
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  try {
    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'auth-page-operation-host',
      alg: 'ES256',
    };
    host = await createAuthHost({
      database: product,
      systemDatabasePool: system,
      issuer: 'https://auth-page-operation.auth.test',
      audience: 'https://api.rezics.test',
      secret: 'auth-page-operation-host-secret-at-least-32-bytes',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: trustedAccessPorts({
        readAccount: unused,
        readFencedAccount: unused,
        authorizeProvisioning: unused,
      }),
      access,
      stagingKey: randomBytes(32),
      maintenanceSchedule: '0 0 0 1 1 *',
      executorId: 'auth-page-operation-host',
    });
    const client = () =>
      product.query<{ client_id: string; first_party: boolean; scopes: string[] }>(
        'SELECT client_id, first_party, scopes FROM auth_client WHERE client_id=$1',
        ['rezics-auth-account-operations'],
      );
    expect((await client()).rows).toEqual([]);
    await Promise.all([host.start(), host.start()]);
    expect((await client()).rows).toEqual([
      {
        client_id: 'rezics-auth-account-operations',
        first_party: true,
        scopes: ['account:delete', 'organization:create'],
      },
    ]);
    expect((await product.query('SELECT first_party, scopes FROM auth_client WHERE client_id=$1', ['login'])).rows)
      .toEqual([{ first_party: true, scopes: [] }]);
  } finally {
    if (host) await host.stop();
    else await Promise.all([product.end(), system.end()]);
    database.close();
  }
}, 60000);
