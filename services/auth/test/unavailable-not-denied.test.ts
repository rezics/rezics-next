import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type AuthService } from '../src/index.ts';
import { createProvisioningEvidenceVerifier } from '../src/provisioning-evidence.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const issuer = 'https://unavailable.auth.test';
const password = 'correct horse battery staple';
const failure = new Error('connection terminated unexpectedly');
const account: AccessAccount = {
  accountId: 'unavailable-human',
  kind: 'actor',
  state: 'pending',
  authnEpoch: 1,
  automated: false,
};
let database: Pool;
let fixture: ReturnType<typeof testDatabase>;
let service: AuthService;
let rejectQuery: (sql: string) => boolean = () => false;
let accountReads = 0;
let rejectAccountRead = 0;
let actorKey: Awaited<ReturnType<typeof generateKeyPair>>;

// Native Better Auth transactions and Auth's held issuance connection must see
// the same failure as direct pool reads, without changing the shared dependency.
function failingDatabase(pool: Pool): Pool {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property);
        if (typeof value !== 'function') return value;
        if (property === 'query')
          return (...args: unknown[]) => {
            const query = args[0];
            const sql = typeof query === 'string' ? query : ((query as { text?: string })?.text ?? '');
            if (rejectQuery(sql)) return Promise.reject(failure);
            return value.apply(object, args);
          };
        if (property === 'connect') return async () => wrap(await value.call(object));
        return value.bind(object);
      },
    });
  return wrap(pool);
}
function request(body: unknown, path = '/signin', cookie = '') {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}
const signin = (identity: 'email' | 'account_id') => ({
  [identity]: identity === 'email' ? 'unavailable@example.test' : account.accountId,
  password,
  client_id: 'unavailable-web',
  scope: ['read'],
});
async function sessions() {
  return (await database.query('SELECT id FROM session WHERE "userId"=$1 ORDER BY id', [account.accountId])).rows;
}
async function assertUnavailable(response: Response, before: Awaited<ReturnType<typeof sessions>>) {
  expect(response.status).toBe(503);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await sessions()).toEqual(before);
}
async function assertion(key = actorKey.privateKey, kid = 'actor-key', jti = crypto.randomUUID()) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuer(account.accountId)
    .setSubject(account.accountId)
    .setAudience(`${issuer}/token`)
    .setIssuedAt()
    .setExpirationTime('30s')
    .setJti(jti)
    .sign(key);
}
function keySignin(value: string) {
  return request(
    { account_id: account.accountId, assertion: value, client_id: 'unavailable-web', scope: ['read'] },
    '/signin/key',
  );
}

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'k',
  };
  actorKey = await generateKeyPair('ES256', { extractable: true });
  service = await createAuthService({
    database: failingDatabase(database),
    issuer,
    audience: 'https://unavailable.api.test',
    secret: 'unavailability-test-secret-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        if (++accountReads === rejectAccountRead) throw failure;
        return id === account.accountId ? account : null;
      },
      authorizeProvisioning: async (accountId) => ({ accountId }),
    }),
  });
  await service.internal.registerClient({ clientId: 'unavailable-web', firstParty: true, scopes: ['read'] });
  await service.internal.provisionPassword({
    authorization: account.accountId,
    email: 'unavailable@example.test',
    password,
  });
  account.state = 'active';
  await database.query('INSERT INTO auth_public_key (account_id,kid,public_jwk) VALUES ($1,$2,$3)', [
    account.accountId,
    'actor-key',
    { ...(await exportJWK(actorKey.publicKey)), alg: 'ES256' },
  ]);
}, 60_000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

for (const identity of ['email', 'account_id'] as const) {
  for (const dependency of ['Access account', 'Auth consent', 'Auth client'] as const) {
    test(`${identity} sign-in preserves unavailability in the session hook for ${dependency}`, async () => {
      const before = await sessions();
      accountReads = 0;
      rejectAccountRead = dependency === 'Access account' ? (identity === 'email' ? 1 : 2) : 0;
      let clientReads = 0;
      rejectQuery = (sql) =>
        dependency === 'Auth consent'
          ? sql.startsWith('SELECT scopes,pending_scopes FROM auth_consent')
          : dependency === 'Auth client' &&
            sql.startsWith('SELECT client_id, display_name, first_party, scopes FROM auth_client') &&
            ++clientReads === (identity === 'email' ? 2 : 1);
      try {
        await assertUnavailable(await request(signin(identity)), before);
      } finally {
        rejectAccountRead = 0;
        rejectQuery = () => false;
      }
    });
  }
  test(`${identity} sign-in still denies a wrong password`, async () => {
    const before = await sessions();
    const response = await request({ ...signin(identity), password: 'incorrect password' });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await sessions()).toEqual(before);
  });
}

test('key sign-in propagates key reads and replay-store failures, but denies invalid assertions and replay', async () => {
  const before = await sessions();
  for (const sqlPrefix of ['SELECT public_jwk FROM auth_public_key', 'INSERT INTO auth_key_assertion']) {
    rejectQuery = (sql) => sql.startsWith(sqlPrefix);
    try {
      await assertUnavailable(await keySignin(await assertion()), before);
    } finally {
      rejectQuery = () => false;
    }
  }
  accountReads = 0;
  rejectAccountRead = 2; // The second account read is the native session hook.
  try {
    await assertUnavailable(await keySignin(await assertion()), before);
  } finally {
    rejectAccountRead = 0;
  }
  const otherKey = await generateKeyPair('ES256');
  for (const value of [
    'malformed',
    await assertion(otherKey.privateKey),
    await assertion(actorKey.privateKey, 'unknown'),
  ]) {
    const denied = await keySignin(value);
    expect(denied.status).toBe(401);
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect(await sessions()).toEqual(before);
  }
  const valid = await assertion();
  expect((await keySignin(valid)).status).toBe(200);
  const committed = await sessions();
  expect((await keySignin(valid)).status).toBe(401);
  expect(await sessions()).toEqual(committed);
});

test('a failed presented-session read aborts replacement without issuing or revoking a session', async () => {
  const signed = await request(signin('email'));
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const before = await sessions();
  let reads = 0;
  rejectQuery = (sql) => {
    if (!/from "session"/i.test(sql)) return false;
    reads++;
    return true;
  };
  try {
    await assertUnavailable(await request(signin('email'), '/signin', cookie), before);
    expect(reads).toBeGreaterThan(0);
  } finally {
    rejectQuery = () => false;
  }
});

test('provisioning evidence creation and resolution raise on a failed lookup', async () => {
  const verifier = createProvisioningEvidenceVerifier({ database: failingDatabase(database) });
  const locator = {
    receiptKey: 'missing',
    accountId: account.accountId,
    registrationId: 'registration',
    reservationId: 'reservation',
    authnEpoch: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  rejectQuery = () => true;
  try {
    await expect(verifier.createReference(locator)).rejects.toBe(failure);
    await expect(verifier.resolve({ version: 1, ...locator, credentialId: 'credential' })).rejects.toBe(failure);
    expect(await verifier.resolve({})).toBeNull();
  } finally {
    rejectQuery = () => false;
  }
  expect(await verifier.createReference(locator)).toBeNull();
  expect(await verifier.resolve({ version: 1, ...locator, credentialId: 'credential' })).toBeNull();
});
