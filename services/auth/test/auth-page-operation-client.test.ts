import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthHost, createAuthService, type AccessAccount, type AccountWorkflowPorts, type SessionProof } from '../src/index.ts';
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
    expect(
      (await product.query('SELECT first_party, scopes FROM auth_client WHERE client_id=$1', ['login'])).rows,
    ).toEqual([{ first_party: true, scopes: [] }]);
  } finally {
    if (host) await host.stop();
    else await Promise.all([product.end(), system.end()]);
    database.close();
  }
}, 60000);

const operationClient = {
  clientId: AUTH_PAGE_OPERATION_CLIENT_ID,
  firstParty: true,
  scopes: [...new Set(Object.values(AUTH_PAGE_OPERATION_SCOPES).flat())],
  mode: 'create-or-match' as const,
};
const issuer = 'https://operation-client.auth.test';
const audience = 'https://api.rezics.test';
const password = 'operation client real password';
const cookies = (response: Response) => response.headers.getSetCookie().map((s) => s.split(';')[0]).join('; ');

async function nativeHost() {
  const database = testDatabase();
  const pool = new Pool({ connectionString: database.url });
  const system = new Pool({ connectionString: database.url, max: 8 });
  const account: AccessAccount = {
    accountId: 'operation-human', kind: 'actor', state: 'pending', authnEpoch: 7, automated: false,
  };
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'operation-client-key' };
  const options = {
    database: pool, issuer, audience,
    secret: 'operation-client-real-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id: string) { return id === account.accountId ? account : null; },
      async authorizeProvisioning() { return { accountId: account.accountId }; },
    }),
    systemDatabasePool: system, stagingKey: randomBytes(32), access,
    maintenanceSchedule: '0 0 0 1 1 *', executorId: 'operation-client-test',
  };
  const host = await createAuthHost(options);
  return {
    database, pool, host, account, options,
    call(path: string, body?: unknown, cookie = '') {
      return host.handler(new Request(`${issuer}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    },
    async close() { await host.stop(); database.close(); },
  };
}

async function registry(pool: Pool) {
  const selected = [AUTH_PAGE_OPERATION_CLIENT_ID];
  return {
    client: (await pool.query('SELECT * FROM auth_client WHERE client_id=$1', selected)).rows,
    coverage: (await pool.query('SELECT * FROM auth_client_coverage WHERE client_id=$1', selected)).rows,
    consent: (await pool.query('SELECT * FROM auth_consent WHERE client_id=$1', selected)).rows,
    reduction: (await pool.query('SELECT * FROM auth_client_reduction WHERE client_id=$1', selected)).rows,
  };
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Observe the real pg calls; no API, lock, query or authentication result is replaced.
function observe(pool: Pool, before: (sql: string, values: unknown[]) => void, after?: (sql: string) => Promise<void>) {
  pool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<typeof query>) => {
      const input = args[0] as string | { text: string; values?: unknown[] };
      const sql = typeof input === 'string' ? input : input.text;
      before(sql, (typeof input === 'string' ? args[1] : input.values) as unknown[] ?? []);
      const result = query(...args);
      return after ? result.then(async (value) => { await after(sql); return value; }) : result;
    }) as typeof client.query;
  });
}

test('create-or-match preserves metadata and exact sets, rejects mismatches and keeps ordinary registration controls', async () => {
  const f = await nativeHost();
  try {
    const service = f.host.service;
    const clientId = operationClient.clientId;
    await service.internal.registerClient({ ...operationClient, scopes: [...operationClient.scopes].reverse(), displayName: 'Keep this metadata' });
    const original = await registry(f.pool);
    await Promise.all(Array.from({ length: 4 }, () => service.internal.registerClient({ ...operationClient, scopes: [...operationClient.scopes, ...operationClient.scopes] })));
    expect(await registry(f.pool)).toEqual(original);
    for (const input of [
      { ...operationClient, scopes: [] },
      { ...operationClient, scopes: ['account:delete'] },
      { ...operationClient, scopes: [...operationClient.scopes, 'account:manage'] },
      { ...operationClient, firstParty: false },
      { ...operationClient, mode: 'invalid' as 'create-or-match' },
    ]) {
      await expect(service.internal.registerClient(input)).rejects.toThrow();
      expect(await registry(f.pool)).toEqual(original);
    }
    // Omitted-mode callers retain the trusted growth/promotion and reduction rules.
    await service.internal.registerClient({ clientId: 'ordinary', firstParty: false, scopes: ['read'], displayName: 'Old' });
    await service.internal.registerClient({ clientId: 'ordinary', firstParty: true, scopes: ['read', 'write'] });
    expect((await f.pool.query('SELECT first_party, scopes, display_name FROM auth_client WHERE client_id=$1', ['ordinary'])).rows)
      .toEqual([{ first_party: true, scopes: ['read', 'write'], display_name: null }]);
    await expect(service.internal.registerClient({ clientId: 'ordinary', firstParty: true, scopes: ['read'] })).rejects.toThrow();
    await expect(service.internal.registerClient({ clientId: 'ordinary', firstParty: false, scopes: ['read', 'write'] })).rejects.toThrow();
    for (const input of [
      { ...operationClient, clientId: 'rezics-website' },
      { ...operationClient, scopes: ['media:complete'] },
      { ...operationClient, scopes: ['invalid scope'] },
    ]) await expect(service.internal.registerClient(input)).rejects.toThrow();
    await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['read'] });
    await Promise.all([f.host.start(), f.host.start()]);
    await f.host.start();
    expect(await registry(f.pool)).toEqual(original);
    expect((await f.pool.query('SELECT scopes FROM auth_client WHERE client_id=$1', ['login'])).rows).toEqual([{ scopes: ['read'] }]);
    await service.internal.beginClientReduction({ clientId, operationId: 'operation-client-reduction', firstParty: true, scopes: ['account:delete'] });
    const fenced = await registry(f.pool);
    await expect(service.internal.registerClient(operationClient)).rejects.toThrow();
    await expect(service.internal.registerClient({ ...operationClient, mode: undefined })).rejects.toThrow();
    expect(await registry(f.pool)).toEqual(fenced);
  } finally { await f.close(); }
}, 60000);

for (const incompatible of [
  { firstParty: true, scopes: [] },
  { firstParty: true, scopes: ['account:delete'] },
  { firstParty: true, scopes: [...operationClient.scopes, 'account:manage'] },
  { firstParty: false, scopes: operationClient.scopes },
]) test(`startup refuses incompatible party=${incompatible.firstParty} scopes=${incompatible.scopes.join(',')}`, async () => {
  const f = await nativeHost();
  const inspection = new Pool({ connectionString: f.database.url });
  try {
    await f.host.service.internal.registerClient({ ...incompatible, clientId: operationClient.clientId, displayName: 'Original' });
    const before = await registry(inspection);
    await expect(f.host.start()).rejects.toMatchObject({ name: 'AuthHostConfigurationError', code: 'operation-client', message: 'Invalid Auth host configuration: operation-client' });
    expect(await registry(inspection)).toEqual(before);
  } finally { await inspection.end(); await f.close(); }
}, 60000);

test('startup waits on the existing native registry lock and refuses the incompatible legitimate writer without mutation', async () => {
  const database = testDatabase();
  const product = new Pool({ connectionString: database.url });
  const writerPool = new Pool({ connectionString: database.url, max: 1 });
  const inspection = new Pool({ connectionString: database.url });
  const writerLocked = signal();
  const startupWaiting = signal();
  const releaseWriter = signal();
  let pause = false;
  observe(writerPool, () => {}, async (sql) => {
    if (pause && sql.startsWith('INSERT INTO auth_client_coverage')) {
      writerLocked.resolve();
      await releaseWriter.promise;
    }
  });
  observe(product, (sql, values) => {
    if (sql.includes('pg_advisory_xact_lock') && values[0] === `auth-client:${operationClient.clientId}`) startupWaiting.resolve();
  });
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let writing: Promise<void> | undefined;
  let starting: Promise<unknown> | undefined;
  try {
    const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'registry-race' };
    const options = { database: product, issuer, audience, secret: 'registry-race-secret-at-least-32-bytes', signing: { activeKid: key.kid, privateKeys: [key] }, trustedAccess: trustedAccessPorts({ readAccount: unused, authorizeProvisioning: unused }) };
    host = await createAuthHost({ ...options, access, stagingKey: randomBytes(32), maintenanceSchedule: '0 0 0 1 1 *' });
    const writer = await createAuthService({ ...options, database: writerPool });
    pause = true;
    writing = writer.internal.registerClient({ clientId: operationClient.clientId, firstParty: false, scopes: ['account:delete'], displayName: 'Concurrent original' });
    await writerLocked.promise;
    starting = host.start().catch((error: unknown) => error);
    await startupWaiting.promise;
    releaseWriter.resolve();
    await writing;
    const committed = await registry(inspection);
    expect(await starting).toMatchObject({ name: 'AuthHostConfigurationError', code: 'operation-client' });
    expect(await registry(inspection)).toEqual(committed);
    expect(committed.client).toMatchObject([{ first_party: false, scopes: ['account:delete'], display_name: 'Concurrent original' }]);
  } finally {
    releaseWriter.resolve();
    await writing?.catch(() => {});
    await starting;
    if (host) await host.stop(); else await product.end();
    await Promise.all([writerPool.end(), inspection.end()]);
    database.close();
  }
}, 60000);

test('password aliases issue each fixed operation profile with live proof and preserve current account and consent fences', async () => {
  const f = await nativeHost();
  try {
    expect(AUTH_PAGE_OPERATION_CLIENT_ID).toBe('rezics-auth-account-operations');
    expect(AUTH_PAGE_OPERATION_SCOPES).toEqual({ organization: ['organization:create'], delete: ['account:delete'] });
    const websiteKey = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)), kid: 'operation-website', alg: 'ES256', use: 'sig' as const };
    await f.host.service.internal.registerWebsiteClient({ publicJwks: { keys: [websiteKey] }, redirectUris: ['https://rezics.test/callback'], postLogoutRedirectUris: ['https://rezics.test/'], scopes: ['openid', 'offline_access', 'media:complete', ...operationClient.scopes] });
    const website = (await f.pool.query('SELECT * FROM auth_client WHERE client_id=$1', ['rezics-website'])).rows;
    await f.host.start();
    expect((await f.pool.query('SELECT * FROM auth_client WHERE client_id=$1', ['rezics-website'])).rows).toEqual(website);
    await f.host.service.internal.provisionPassword({ authorization: 'approved', email: 'operation@example.test', password });
    f.account.state = 'active';
    const signIn = (scope: string[], client_id = operationClient.clientId) => f.call('/signin', { email: 'operation@example.test', password, client_id, scope });
    for (const profile of Object.values(AUTH_PAGE_OPERATION_SCOPES)) {
      const signedIn = await signIn([...profile]);
      expect(signedIn.status).toBe(200);
      const proof = await signedIn.json() as SessionProof;
      const expected = { account_id: f.account.accountId, client_id: operationClient.clientId, scope: [...profile], authn_epoch: 7, amr: ['pwd'] };
      expect(proof).toMatchObject(expected);
      const headers = new Headers({ cookie: cookies(signedIn) });
      expect(await (await f.call('/session', undefined, cookies(signedIn))).json()).toMatchObject(expected);
      await expect(f.host.service.internal.accessTokenForProof(proof)).rejects.toThrow();
      const jwks = createLocalJWKSet(await (await f.call('/.well-known/jwks.json')).json());
      await f.host.service.internal.withFreshHuman({ headers }, async (live) => {
        expect(live).toMatchObject(expected);
        const token = await f.host.service.internal.accessTokenForProof(live);
        const verified = await jwtVerify(token, jwks, { issuer, audience, typ: 'at+jwt' });
        expect(verified.payload).toMatchObject({ sub: f.account.accountId, client_id: operationClient.clientId, scope: profile.join(' '), authn_epoch: 7, auth_time: live.auth_time, amr: ['pwd'] });
      });
      f.account.fenced = true;
      await expect(f.host.service.internal.withFreshHuman({ headers }, async () => {})).rejects.toThrow();
      f.account.fenced = false;
      f.account.authnEpoch++;
      await expect(f.host.service.internal.withFreshHuman({ headers }, async () => {})).rejects.toThrow();
      f.account.authnEpoch--;
      await f.pool.query('UPDATE session SET "authTime"=$1 WHERE "userId"=$2', [Math.floor(Date.now()/1000)-601, f.account.accountId]);
      await expect(f.host.service.internal.withFreshHuman({ headers }, async () => {})).rejects.toMatchObject({ code: 'step_up_required' });
    }
    const count = async () => (await f.pool.query('SELECT id FROM session WHERE "userId"=$1', [f.account.accountId])).rows;
    const before = await count();
    for (const scope of [['account:manage'], ['credential:manage'], ['media:complete'], ['openid'], ['organization:create', 'account:manage']]) {
      expect((await signIn(scope)).status).toBeGreaterThanOrEqual(400);
      expect(await count()).toEqual(before);
    }
    expect((await signIn(['account:delete'], 'rezics-website')).status).toBeGreaterThanOrEqual(400);
    expect(await count()).toEqual(before);
    await f.pool.query('INSERT INTO auth_consent(account_id,client_id,scopes,pending_scopes,pending_reference) VALUES ($1,$2,$3,$4,$5)', [f.account.accountId, operationClient.clientId, operationClient.scopes, [], 'pending-native-reduction']);
    expect((await signIn(['account:delete'])).status).toBeGreaterThanOrEqual(400);
    expect(await count()).toEqual(before);
  } finally { await f.close(); }
}, 60000);

test('host startup keeps fixed exact-key registry touches at 1/8/64 unrelated clients', async () => {
  const f = await nativeHost();
  try {
    await f.host.service.internal.registerClient({ ...operationClient, displayName: 'Selected fixed client' });
    const original = await registry(f.pool);
    let previous = 0;
    const counts: number[] = [];
    for (const scale of [1, 8, 64]) {
      for (let i = previous; i < scale; i++) await f.host.service.internal.registerClient({ clientId: `unrelated-${i}`, firstParty: false, scopes: ['unrelated:read'] });
      previous = scale;
      const pool = new Pool({ connectionString: f.database.url });
      const system = new Pool({ connectionString: f.database.url, max: 8 });
      let measuring = false;
      const touches: string[] = [];
      observe(pool, (sql, values) => {
        if (measuring && (values[0] === operationClient.clientId || values[0] === `auth-client:${operationClient.clientId}`)) touches.push(sql);
      });
      const host = await createAuthHost({ ...f.options, database: pool, systemDatabasePool: system });
      try {
        measuring = true;
        await Promise.all([host.start(), host.start(), host.start()]);
        measuring = false;
        expect(touches).toEqual([
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          'SELECT client_id FROM auth_client_reduction WHERE client_id=$1',
          'SELECT * FROM auth_client WHERE client_id=$1 FOR UPDATE',
        ]);
        counts.push(touches.length);
        expect(await registry(f.pool)).toEqual(original);
      } finally { await host.stop(); }
    }
    expect(counts).toEqual([3, 3, 3]);
  } finally { await f.close(); }
}, 60000);
