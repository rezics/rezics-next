import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId } from '../../src/route/route.ts';
import { createPersonas } from '../support/personas.ts';
import { registerTestClient, testKernel, type TestKernel } from '../support/test-kernel.ts';
import { cookies, issuer, nativeFixture, password } from './native-account-bindings-fixture.ts';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest();
const encode = (data: Buffer | string) => Buffer.from(data).toString('base64url');

// Small CBOR encoder for a none attestation and a P-256 COSE public key.
function cbor(value: string | number | Buffer | Map<unknown, unknown>): Buffer {
  const header = (major: number, n: number) =>
    n < 24
      ? Buffer.from([major * 32 + n])
      : n < 256
        ? Buffer.from([major * 32 + 24, n])
        : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
  if (typeof value === 'number') return value >= 0 ? header(0, value) : header(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([header(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value]);
  return Buffer.concat([
    header(5, value.size),
    ...[...value].flatMap(([k, v]) => [cbor(k as never), cbor(v as never)]),
  ]);
}

/** Software resident authenticator: none attestation, real ES256 assertions. */
function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  let counter = 0;
  let userHandle: string;
  const clientData = (type: string, challenge: string, origin = issuer) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: encode(id),
    registration(options: { challenge: string; user: { id: string } }, uv = true, origin = issuer) {
      userHandle = options.user.id;
      const cose = cbor(
        new Map<unknown, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, 'base64url')],
          [-3, Buffer.from(jwk.y!, 'base64url')],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        hash('rezics.com'),
        Buffer.from([uv ? 0x45 : 0x41]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        length,
        id,
        cose,
      ]);
      return {
        id: encode(id),
        rawId: encode(id),
        type: 'public-key' as const,
        clientExtensionResults: { credProps: { rk: true } },
        response: {
          clientDataJSON: encode(clientData('webauthn.create', options.challenge, origin)),
          attestationObject: encode(
            cbor(
              new Map<unknown, unknown>([
                ['fmt', 'none'],
                ['attStmt', new Map()],
                ['authData', authData],
              ]),
            ),
          ),
          transports: ['internal'],
        },
      };
    },
    assertion(options: { challenge: string }, uv = true, origin = issuer) {
      const client = clientData('webauthn.get', options.challenge, origin);
      const count = Buffer.alloc(4);
      count.writeUInt32BE(++counter);
      const data = Buffer.concat([hash('rezics.com'), Buffer.from([uv ? 5 : 1]), count]);
      return {
        id: encode(id),
        rawId: encode(id),
        type: 'public-key' as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: encode(client),
          authenticatorData: encode(data),
          signature: encode(sign('sha256', Buffer.concat([data, hash(client)]), pair.privateKey)),
          userHandle,
        },
      };
    },
  };
}

const pool = createPool(process.env.DATABASE_URL!);
const clientId = 'suspended-signin-client';
const scope = ['account:manage', 'account:read', 'account:update', 'account:read_public_identity', 'account:delete'];
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let personas: Awaited<ReturnType<typeof createPersonas>>;
let emails: { active: string; suspended: string };
let devices: { active: ReturnType<typeof authenticator>; suspended: ReturnType<typeof authenticator> };
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let previousHeaders: Headers;

const key = () => `signin_${crypto.randomUUID().replaceAll('-', '')}`;
const sessionCount = async () =>
  (await auth.authPool.query('SELECT id FROM session WHERE "userId"=$1', [personas.suspended.accountId])).rowCount;

async function hostRequest(path: string, body: unknown, headers: Headers) {
  return auth.host.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: headers.get('cookie') ?? '' },
      body: JSON.stringify(body),
    }),
  );
}
async function command(bearer: string, path: string, body: unknown, method = 'POST') {
  return kernel.handle(
    new Request(`https://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key()),
      },
      body: JSON.stringify(body),
    }),
  );
}
async function checked(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response;
}
async function passwordSignIn(accountId: string, supplied = password) {
  return auth.request('/signin', { account_id: accountId, password: supplied, client_id: clientId, scope });
}
async function emailSignIn(email: string, supplied = password) {
  return auth.request('/signin', { email, password: supplied, client_id: clientId, scope });
}
async function passkeySignIn(device: ReturnType<typeof authenticator>, valid = true) {
  const challenge = await checked(await auth.request('/signin/passkey/options', {}));
  const response = device.assertion(await challenge.json());
  if (!valid) response.response.signature = randomBytes(64).toString('base64url');
  return auth.request('/signin/passkey', { response, client_id: clientId, scope }, cookies(challenge));
}
async function keySignIn(accountId: string, valid = true) {
  const pair = valid ? signing : await generateKeyPair('ES256');
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'human-key' })
    .setIssuer(accountId)
    .setSubject(accountId)
    .setAudience(`${issuer}/token`)
    .setIssuedAt()
    .setExpirationTime('30s')
    .setJti(crypto.randomUUID())
    .sign(pair.privateKey);
  return auth.request('/signin/key', { account_id: accountId, assertion, client_id: clientId, scope });
}
async function denial(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(response.headers.getSetCookie()).toEqual([]);
  const token = await auth.request('/token', {}, cookies(response));
  expect(token.status).toBe(401);
  expect(await token.json()).toEqual({ error: 'authentication_denied' });
}
async function registerDevice(headers: Headers) {
  const device = authenticator();
  const challenge = await checked(await auth.request('/passkeys/register/options', {}, headers));
  const ceremony = new Headers({ cookie: `${headers.get('cookie')}; ${cookies(challenge).get('cookie')}` });
  await checked(
    await auth.request('/passkeys/register', { response: device.registration(await challenge.json()) }, ceremony),
    201,
  );
  return device;
}

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'suspended-signin-native-rate-secret-32-bytes' }),
  });
  personas = await createPersonas(kernel, { version: 1, pool, auth });
  await registerTestClient(service, { clientId, firstParty: true, scopes: scope });
  // Locate the fixture's private credential addresses; all account changes use native commands/workflows.
  const email = async (id: string) =>
    (await auth.authPool.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [id])).rows[0]!.email;
  emails = { active: await email(personas.alice.accountId), suspended: await email(personas.suspended.accountId) };
  await checked(await command(personas.staff.bearer, `/v1/accounts/${personas.suspended.accountId}:reinstate`, {}));
  const suspended = cookies(await checked(await passwordSignIn(personas.suspended.accountId)));
  previousHeaders = suspended;
  const active = cookies(await checked(await passwordSignIn(personas.alice.accountId)));
  signing = await generateKeyPair('ES256', { extractable: true });
  for (const [accountId, headers] of [
    [personas.suspended.accountId, suspended],
    [personas.alice.accountId, active],
  ] as const) {
    const input = { key: key(), subjectId: accountId };
    const staged = await checked(
      await hostRequest(
        '/credential-effects/stage',
        {
          ...input,
          credential: {
            kind: 'key',
            kid: 'human-key',
            publicJwk: { ...(await exportJWK(signing.publicKey)), kid: 'human-key' },
          },
        },
        headers,
      ),
    );
    const { effectRef } = await staged.json();
    const approved = await checked(await hostRequest('/credential-effects/approve', { ...input, effectRef }, headers));
    const { reference } = await approved.json();
    await checked(await hostRequest('/credential-effects/apply', { ...input, effectRef, reference }, headers));
  }
  devices = { suspended: await registerDevice(suspended), active: await registerDevice(active) };
  // Prove the installed credentials work before using them as suspension witnesses.
  await checked(await keySignIn(personas.suspended.accountId));
  await checked(await passkeySignIn(devices.suspended));
  await checked(
    await command(personas.staff.bearer, `/v1/accounts/${personas.suspended.accountId}:suspend`, {
      reason: 'Private suspension reason that must never be returned',
    }),
  );
}, 360000);

afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await pool.end();
  }
});

for (const method of ['account ID password', 'email password', 'own key', 'passkey'] as const) {
  test(`${method} discloses suspension only after the credential verifies and creates no session or token`, async () => {
    const before = await sessionCount();
    const attempts = {
      'account ID password': () => passwordSignIn(personas.suspended.accountId),
      'email password': () => emailSignIn(emails.suspended),
      'own key': () => keySignIn(personas.suspended.accountId),
      passkey: () => passkeySignIn(devices.suspended),
    };
    await denial(await attempts[method](), 403, 'account_suspended');
    expect(await sessionCount()).toBe(before);
  });
}

test('invalid credentials have identical status and body for suspended, active and unknown people', async () => {
  for (const method of ['id', 'email', 'key', 'passkey']) {
    const attempts =
      method === 'id'
        ? [
            passwordSignIn(personas.alice.accountId, 'wrong password'),
            passwordSignIn(personas.suspended.accountId, 'wrong password'),
            passwordSignIn(newId(123), 'wrong password'),
          ]
        : method === 'email'
          ? [
              emailSignIn(emails.active, 'wrong password'),
              emailSignIn(emails.suspended, 'wrong password'),
              emailSignIn('unknown@ordinary.test', 'wrong password'),
            ]
          : method === 'key'
            ? [keySignIn(personas.alice.accountId, false), keySignIn(personas.suspended.accountId, false)]
            : [passkeySignIn(devices.active, false), passkeySignIn(devices.suspended, false)];
    let expected: { status: number; body: unknown } | undefined;
    for (const attempt of attempts) {
      const response = await attempt;
      const result = { status: response.status, body: await response.json() };
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(result.body).toEqual({ error: 'authentication_denied' });
      if (method !== 'passkey') expect(result.status).toBe(401);
      else expect(result.status).toBeGreaterThanOrEqual(400);
      expected ??= result;
      expect(result).toEqual(expected);
    }
  }
});

test('the bearer held before suspension is invalid on a kernel read and command', async () => {
  const { accountId, bearer } = personas.suspended;
  for (const response of [
    await kernel.handle(
      new Request(`https://kernel.test/v1/accounts?ids=${accountId}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    ),
    await command(bearer, `/v1/accounts/${accountId}/preferences`, { expectedVersion: 0 }, 'PATCH'),
  ]) {
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    expect(await response.json()).toHaveProperty('code', 'invalid_credentials');
  }
  for (const response of [
    await auth.request('/session', undefined, previousHeaders),
    await auth.request('/token', {}, previousHeaders),
  ])
    await denial(response, 401, 'authentication_denied');
});

test('pending and deleted accounts retain generic sign-in refusals', async () => {
  const registrationKey = key();
  const email = `${registrationKey}@ordinary.test`;
  const pending = await auth.host.workflows.beginRegistration({ key: registrationKey, handle: registrationKey });
  await auth.host.workflows.installRegistrationCredential({ registrationId: pending.registrationId, email, password });
  await denial(await passwordSignIn(pending.accountId), 401, 'authentication_denied');
  await denial(await emailSignIn(email), 401, 'authentication_denied');
  const deletedKey = key();
  const deleted = await auth.person(deletedKey);
  const signed = await checked(await passwordSignIn(deleted.accountId));
  const issued = await checked(await auth.request('/token', {}, cookies(signed)));
  const { access_token: bearer } = await issued.json();
  const operation = { kind: 'delete' as const, accountId: deleted.accountId, authorization: 'request' };
  const approval = await auth
    .approval()
    .approve(bearer, { operationKey: deletedKey, operation }, { pool, deadline: Date.now() + 10000 });
  await auth.host.workflows.deleteAccount({
    key: deletedKey,
    accountId: deleted.accountId,
    authorization: approval.reference,
  });
  await denial(await passwordSignIn(deleted.accountId), 401, 'authentication_denied');
  await denial(await emailSignIn(`${deletedKey}@ordinary.test`), 401, 'authentication_denied');
}, 60000);

test('reinstatement permits a fresh bearer to read its own profile without restoring the old bearer', async () => {
  const { accountId, bearer: oldBearer } = personas.suspended;
  await checked(await command(personas.staff.bearer, `/v1/accounts/${accountId}:reinstate`, {}));
  const signed = await checked(await passwordSignIn(accountId));
  const issued = await checked(await auth.request('/token', {}, cookies(signed)));
  const { access_token: bearer } = await issued.json();
  expect(decodeJwt(bearer).sub).toBe(accountId);
  const profile = await checked(
    await kernel.handle(
      new Request(`https://kernel.test/v1/accounts?ids=${accountId}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    ),
  );
  expect(await profile.json()).toMatchObject({ accounts: [{ id: accountId, state: 'active' }] });
  expect(
    (
      await kernel.handle(
        new Request(`https://kernel.test/v1/accounts?ids=${accountId}`, {
          headers: { authorization: `Bearer ${oldBearer}` },
        }),
      )
    ).status,
  ).toBe(401);
  await checked(await emailSignIn(emails.suspended));
  await checked(await keySignIn(accountId));
  await checked(await passkeySignIn(devices.suspended));
});
