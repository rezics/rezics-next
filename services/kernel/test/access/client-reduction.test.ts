import { actionDeclarations } from './native-account-bindings-fixture.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createNativeWorkflowProofPorts,
  createProvisioningEvidenceVerifier,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWorkflowApprovals, WORKFLOW_APPROVAL_ACTIONS } from '../../src/access/workflow-approvals.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `client_reduction_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

const pool = createPool(process.env.DATABASE_URL!);
const issuer = 'https://client-management.auth.test';
const audience = 'https://client-management.api.test';
const scopes = ['account:manage', 'account:read', 'access:grant', ...WORKFLOW_APPROVAL_ACTIONS.keys()].sort();
const actions = new Map([...LIFECYCLE_ACTIONS, ...actionDeclarations(scopes)]);
const referenceKeys = { current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) };
let service: AuthService;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let database: Awaited<ReturnType<typeof cloneAuthDatabase>>;
const access = createAccess({
  actions,
  auth: {
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetch: (input, init) => service.handler(new Request(input, init)),
  },
});
const approvals = createWorkflowApprovals({ pool, access, actions, referenceKeys });
const password = 'native client management password';
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
async function request(path: string, body: unknown, cookie = '') {
  return host.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}
async function signed(accountId: string, clientId: string, selectedScopes = scopes) {
  const response = await request('/signin', {
    account_id: accountId,
    password,
    client_id: clientId,
    scope: selectedScopes,
  });
  expect(response.status).toBe(200);
  return cookies(response);
}
async function bearer(cookie: string) {
  const response = await request('/token', {}, cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function person() {
  const key = crypto.randomUUID();
  return host.workflows.register({
    key,
    handle: `client_${key.replaceAll('-', '')}`,
    email: `${key}@client.test`,
    password,
  });
}
let staff: Awaited<ReturnType<typeof person>>;
let ordinary: Awaited<ReturnType<typeof person>>;
const context = () => ({ pool, deadline: Date.now() + 10000 });
async function reduce(accountId: string, clientId: string, next: string[]) {
  const operation = {
    kind: 'client-reduction' as const,
    clientId,
    scopes: next,
    firstParty: false,
    authorization: 'request',
  };
  const key = crypto.randomUUID();
  const approval = await approvals.approve(
    await bearer(await signed(accountId, 'client-management')),
    { operationKey: key, operation },
    context(),
  );
  return host.workflows.reduceClientScopes({ ...operation, key, authorization: approval.reference });
}
async function client() {
  const clientId = crypto.randomUUID();
  await service.internal.registerClient({ clientId, firstParty: false, scopes: ['account:read', 'account:manage'] });
  return clientId;
}
beforeAll(async () => {
  database = await cloneAuthDatabase();
  const authPool = new Pool({ connectionString: database.url });
  const proofs = createNativeWorkflowProofPorts({ database: authPool });
  const bindings = createNativeAccountBindings({
    pool,
    access,
    actions,
    routeKey: crypto.getRandomValues(new Uint8Array(32)),
    referenceKeys,
    auth: () => service,
    proofs: {
      workflow: proofs,
      provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
      barriers: createBarrierProofVerifier({ database: authPool }),
    },
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...(await exportJWK(pair.privateKey)), kid: 'client-management' };
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: crypto.randomUUID() + crypto.randomUUID(),
    signing: { activeKid: key.kid, privateKeys: [key] },
    stagingKey: crypto.getRandomValues(new Uint8Array(32)),
    trustedAccess: bindings.trustedAccess,
    access: bindings.workflowPorts,
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'client-management',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'client-management', firstParty: true, scopes });
  await host.start();
  staff = await person();
  await bootstrapGovernance(pool, staff.accountId);
  ordinary = await person();
});
afterAll(async () => {
  try {
    await host?.stop();
  } finally {
    await database?.close();
    await pool.end();
  }
});

test('platform staff reduce client scopes through Auth and the removed scope is denied from T', async () => {
  const clientId = await client();
  const consenting = await signed(ordinary.accountId, 'client-management');
  expect(
    (await request('/consent', { client_id: clientId, scope: ['account:read', 'account:manage'] }, consenting)).status,
  ).toBe(200);
  const cookie = await signed(ordinary.accountId, clientId, ['account:read', 'account:manage']);
  await bearer(cookie);
  await reduce(staff.accountId, clientId, ['account:read']);
  expect((await request('/token', {}, cookie)).status).toBe(401);
  expect(
    (
      await request('/signin', {
        account_id: ordinary.accountId,
        password,
        client_id: clientId,
        scope: ['account:manage'],
      })
    ).status,
  ).toBe(401);
});

test('an account without client:manage is refused with 403', async () => {
  const unprivileged = await person();
  await expect(reduce(unprivileged.accountId, await client(), ['account:read'])).rejects.toHaveProperty('status', 403);
});

test('client scope expansion is refused with 403', async () => {
  await expect(
    reduce(staff.accountId, await client(), ['account:read', 'account:manage', 'client:manage']),
  ).rejects.toHaveProperty('status', 403);
});
