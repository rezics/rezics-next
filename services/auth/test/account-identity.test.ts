import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { readNativeAccountIdentity } from '../src/account-identity.ts';
import { createAuthService, type AccessAccount, type AuthService } from '../src/index.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const issuer = 'https://identity.auth.test';
const person = randomUUID();
const other = randomUUID();
const clientId = randomUUID();
const otherClientId = randomUUID();
const password = 'identity fixture correct horse battery staple';
const email = 'reader.native-login@example.test';
const accounts = new Map<string, AccessAccount>();
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let service: AuthService;
let afterIdentityRead: (() => Promise<void>) | undefined;
let unavailable = false;
let identityReads = 0;

function request(cookie = '', body: unknown = {}, headers: Record<string, string> = {}) {
  return service.handler(
    new Request(`${issuer}/account-identity`, {
      method: 'POST',
      headers: { origin: issuer, cookie, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}
async function signin(accountId = person) {
  const response = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, password, client_id: clientId, scope: ['read'] }),
    }),
  );
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url, max: 4 });
  // Pause the real native exact-self read's result before the service rechecks
  // authority. This instruments only this fixture's connections, never a dependency.
  database.on('connect', (connection) => {
    connection.query = new Proxy(connection.query, {
      apply(query, receiver, args) {
        const result = Reflect.apply(query, receiver, args);
        if (args[0] !== 'SELECT id,email FROM "user" WHERE id=$1') return result;
        identityReads++;
        const callback = afterIdentityRead;
        afterIdentityRead = undefined;
        return Promise.resolve(result).then(async (value) => {
          await callback?.();
          return value;
        });
      },
    });
  });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'identity',
  };
  service = await createAuthService({
    database,
    issuer,
    audience: 'https://identity.api.test',
    secret: 'identity-fixture-persistent-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        if (unavailable) throw new Error('Current authority unavailable');
        return accounts.get(id) ?? null;
      },
      async authorizeProvisioning(accountId) {
        return { accountId };
      },
    }),
  });
  await service.internal.registerClient({ clientId, firstParty: true, scopes: ['read'] });
  await service.internal.registerClient({ clientId: otherClientId, firstParty: true, scopes: ['read'] });
  for (const id of [person, other]) {
    const account: AccessAccount = { accountId: id, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
    accounts.set(id, account);
    await service.internal.provisionPassword({
      authorization: id,
      email: id === person ? email : 'other@example.test',
      password,
    });
    account.state = 'active';
  }
}, 60000);
afterEach(async () => {
  afterIdentityRead = undefined;
  unavailable = false;
  Object.assign(accounts.get(person)!, { state: 'active', authnEpoch: 1, automated: false, fenced: false });
  await database.query("UPDATE auth_client SET disabled=false,scopes=ARRAY['read'] WHERE client_id=$1", [clientId]);
  await database.query('UPDATE "user" SET email=$2,name=\'\',"emailVerified"=false WHERE id=$1', [person, email]);
  await database.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [person, clientId]);
});
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('native identity fails closed for historical non-UUID IDs before disclosure lookup', async () => {
  let queries = 0;
  const unavailableDatabase = {
    async query() {
      queries++;
      return { rows: [] };
    },
  } as unknown as Pool;
  await expect(readNativeAccountIdentity(unavailableDatabase, 'legacy-account')).rejects.toMatchObject({ status: 503 });
  expect(queries).toBe(0);
});

test('default Auth handler reads only the current native login email, without synthetic name or verification claims', async () => {
  const cookie = await signin();
  await database.query('UPDATE "user" SET name=\'Synthetic default\',"emailVerified"=false WHERE id=$1', [person]);
  const before = identityReads;
  const response = await request(cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ account_id: person, email });
  expect(identityReads - before).toBe(1);
  const foreign = await request(await signin(other));
  expect(await foreign.json()).toEqual({ account_id: other, email: 'other@example.test' });
  const session = await service.handler(new Request(`${issuer}/session`, { headers: { cookie } }));
  expect(Object.keys(await session.json()).sort()).toEqual([
    'account_id',
    'amr',
    'auth_time',
    'authn_epoch',
    'client_id',
    'scope',
  ]);
});

test('a native owner without email stays handleless even when its synthetic name looks recognizable', async () => {
  const cookie = await signin();
  await database.query('UPDATE "user" SET email=NULL,name=\'not-a-real-login@example.test\' WHERE id=$1', [person]);
  expect(await (await request(cookie)).json()).toEqual({ account_id: person, email: null });
});

test('the private projection rejects account selectors, public requests, bearer access and cross-origin requests before identity I/O', async () => {
  const cookie = await signin();
  for (const body of [
    { account_id: other },
    { accountId: other },
    { email: 'typed@example.test' },
    { cursor: 'next' },
  ]) {
    const before = identityReads;
    expect((await request(cookie, body)).status).toBe(400);
    expect(identityReads).toBe(before);
  }
  for (const headers of [
    { origin: 'https://foreign.test' },
    { 'sec-fetch-site': 'cross-site' },
    { authorization: 'Bearer unused' },
  ] as Record<string, string>[]) {
    const before = identityReads;
    const response = await request(cookie, {}, headers);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(identityReads).toBe(before);
  }
  expect((await request()).status).toBe(401);
  expect((await service.handler(new Request(`${issuer}/account-identity`, { headers: { cookie } }))).status).toBe(403);
  expect(
    (
      await service.handler(
        new Request(`${issuer}/account-identity?account_id=${other}`, {
          method: 'POST',
          headers: { origin: issuer, cookie, 'content-type': 'application/json' },
          body: '{}',
        }),
      )
    ).status,
  ).toBe(400);
});

test('current account, floor, native client and consent admission cannot be replaced by a cached identity allow', async () => {
  const cookie = await signin();
  for (const change of [
    { state: 'suspended' },
    { state: 'deleted' },
    { fenced: true },
    { automated: true },
    { authnEpoch: 2 },
  ]) {
    Object.assign(accounts.get(person)!, { state: 'active', fenced: false, automated: false, authnEpoch: 1 }, change);
    expect((await request(cookie)).status).toBe(401);
  }
  Object.assign(accounts.get(person)!, { state: 'active', fenced: false, automated: false, authnEpoch: 1 });
  await database.query('UPDATE auth_client SET disabled=true WHERE client_id=$1', [clientId]);
  expect((await request(cookie)).status).toBe(401);
  await database.query('UPDATE auth_client SET disabled=false WHERE client_id=$1', [clientId]);
  await database.query(
    "INSERT INTO auth_consent (account_id,client_id,scopes,pending_scopes) VALUES ($1,$2,ARRAY['read'],ARRAY[]::text[])",
    [person, clientId],
  );
  expect((await request(cookie)).status).toBe(401);
});

test('late native identity results are withheld after revocation, proof changes, floor changes, consent reduction or source failure', async () => {
  const cases: (() => Promise<void>)[] = [
    async () => {
      await database.query('DELETE FROM session WHERE "userId"=$1', [person]);
    },
    async () => {
      await database.query('UPDATE session SET "authTime"="authTime"-1 WHERE "userId"=$1', [person]);
    },
    async () => {
      await database.query('UPDATE session SET "grantedScope"=\'\' WHERE "userId"=$1', [person]);
    },
    async () => {
      await database.query('UPDATE session SET "authMethods"=\'pop\' WHERE "userId"=$1', [person]);
    },
    async () => {
      await database.query('UPDATE session SET "userId"=$2 WHERE "userId"=$1', [person, other]);
    },
    async () => {
      await database.query('UPDATE session SET "clientId"=$2 WHERE "userId"=$1', [person, otherClientId]);
    },
    async () => {
      await database.query('UPDATE session SET "expiresAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE "userId"=$1', [
        person,
      ]);
    },
    async () => {
      accounts.get(person)!.authnEpoch = 2;
    },
    async () => {
      await database.query('UPDATE auth_client SET disabled=true WHERE client_id=$1', [clientId]);
    },
    async () => {
      await database.query(
        "INSERT INTO auth_consent (account_id,client_id,scopes,pending_scopes) VALUES ($1,$2,ARRAY['read'],ARRAY[]::text[])",
        [person, clientId],
      );
    },
    async () => {
      unavailable = true;
    },
  ];
  for (const change of cases) {
    accounts.get(person)!.authnEpoch = 1;
    unavailable = false;
    await database.query('UPDATE auth_client SET disabled=false WHERE client_id=$1', [clientId]);
    await database.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [person, clientId]);
    const cookie = await signin();
    afterIdentityRead = change;
    const response = await request(cookie);
    expect([401, 503]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toContain(email);
    expect(body).not.toContain(person);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }
});
