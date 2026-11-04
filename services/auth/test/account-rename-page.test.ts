import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { managementOperationProfile, type SessionProof } from '@rezics/auth-contract';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthHost, type AccountWorkflowPorts } from '../src/index.ts';
import type { AccountProfileAccess } from '../src/account-profile-read-transport.ts';
import type { AccountRenamePageAccess } from '../src/account-rename-page.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const issuer = 'https://rename-page.auth.test';
const accountId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const renameProfile = managementOperationProfile('rename');
const ordinary: SessionProof = {
  account_id: accountId,
  client_id: 'login',
  scope: [],
  authn_epoch: 1,
  auth_time: 1,
  amr: ['pwd'],
};
const exact: SessionProof = {
  ...ordinary,
  client_id: renameProfile.client_id,
  scope: [...renameProfile.scope],
};
const unused = async (): Promise<never> => {
  throw new Error('Unexpected workflow access');
};
const access: AccountWorkflowPorts = {
  registrationTarget: () => {
    throw new Error('Unexpected workflow access');
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
function request(path: string, body: unknown) {
  return new Request(`${issuer}${path}`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('the actual host returns safe rename readiness and never reads the private profile for an ordinary session', async () => {
  const database = testDatabase();
  const product = new Pool({ connectionString: database.url });
  const system = new Pool({ connectionString: database.url, max: 8 });
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  const reads = { profile: 0, page: 0 };
  let human = ordinary;
  let source: 'ready' | 'refused' | 'unavailable' = 'ready';
  try {
    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'rename-page-host',
      alg: 'ES256',
    };
    const trusted = trustedAccessPorts({
      readAccount: async () => null,
      authorizeProvisioning: async () => null,
      readRenameAccountProfile: (async () => {
        reads.profile++;
        return { profile: { id: accountId, kind: 'actor', handle: 'current' } };
      }) satisfies AccountProfileAccess['readRenameAccountProfile'],
      readRenameAccountPage: (async () => {
        reads.page++;
        if (source === 'refused') throw Object.assign(new Error('denied'), { status: 403 });
        if (source === 'unavailable') throw new Error('dependency lost');
        return {
          viewer: { accountId, kind: 'actor' },
          profile: { id: accountId, kind: 'actor', handle: null },
          authActions: {
            state: 'ready' as const,
            operations: [
              {
                operationId: 'auth.account.rename',
                action: 'account:update',
                resource: { route: 1, id: accountId },
              },
            ],
          },
        };
      }) satisfies AccountRenamePageAccess['readRenameAccountPage'],
    });
    host = await createAuthHost({
      database: product,
      systemDatabasePool: system,
      issuer,
      audience: 'https://api.rezics.test',
      secret: 'rename-page-test-secret-at-least-32-bytes',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: trusted,
      access,
      stagingKey: randomBytes(32),
      maintenanceSchedule: '0 0 0 1 1 *',
      executorId: 'rename-page-test',
    });
    const internal = host.service.internal as unknown as {
      withFreshHuman: (_input: unknown, work: (proof: SessionProof) => Promise<unknown>) => Promise<unknown>;
      accessTokenForProof: (proof: SessionProof) => Promise<string>;
    };
    internal.withFreshHuman = async (_input, work) => work(human);
    internal.accessTokenForProof = async () => 'native-access-token';

    const ordinaryPage = await host.handler(request('/account-management/rename-page', {}));
    expect(ordinaryPage.status).toBe(200);
    expect(await ordinaryPage.json()).toEqual({
      state: 'management-auth-required',
      continuation: { kind: 'management-operation-step-up', operation: 'rename' },
    });
    const deniedProfile = await host.handler(request('/account-management/profile', { accountId }));
    expect(deniedProfile.status).toBe(403);
    expect(reads).toEqual({ profile: 0, page: 0 });

    human = exact;
    const admittedPage = await host.handler(request('/account-management/rename-page', {}));
    expect(admittedPage.headers.get('cache-control')).toBe('private, no-store');
    expect(await admittedPage.json()).toMatchObject({
      state: 'ready',
      viewer: { accountId, kind: 'actor', authnEpoch: 1, amr: ['pwd'] },
      profile: { id: accountId, kind: 'actor', handle: null },
      authActions: { state: 'ready', operations: [{ operationId: 'auth.account.rename' }] },
    });
    source = 'refused';
    expect(await (await host.handler(request('/account-management/rename-page', {}))).json()).toEqual({ state: 'refused' });
    source = 'unavailable';
    expect(await (await host.handler(request('/account-management/rename-page', {}))).json()).toEqual({ state: 'unavailable' });
    human = { ...exact, account_id: otherId, scope: ['account:update', 'account:read'] };
    expect(await (await host.handler(request('/account-management/rename-page', {}))).json()).toMatchObject({
      state: 'management-auth-required',
    });
    expect(reads).toEqual({ profile: 0, page: 3 });
  } finally {
    if (host) await host.stop();
    else await Promise.all([product.end(), system.end()]);
    database.close();
  }
}, 60000);
