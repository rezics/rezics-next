import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { Pool } from 'pg';
import { createRequire } from 'node:module';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';
import { migrate, POSTGRES_IMAGE, run } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { newId, routeOf } from '../../kernel/src/route/route.ts';
import { createAuthHost, createAuthService, type AccountWorkflowPorts, type AuthService, type CredentialAuthorizationInput, type SessionProof } from '../src/index.ts';
import { credentialEffectTransport } from '../src/host.ts';

export const issuer = 'https://auth.rezics.com';
export const password = 'correct horse battery staple';
export const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
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
export function authenticator() {
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

/** Each fixture owns exactly the container it starts; no stale-fixture cleanup. */
export function passkeyDatabase() {
  const container = run('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql:rw,size=2g',
    '-e',
    'POSTGRES_USER=rezics',
    '-e',
    'POSTGRES_PASSWORD=rezics',
    '-e',
    'POSTGRES_DB=rezics',
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
  ]);
  try {
    const port = run('docker', ['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)![1];
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    migrateKernel(url);
    migrate(url);
    return { url, close: () => run('docker', ['rm', '-f', container]) };
  } catch (error) {
    run('docker', ['rm', '-f', container]);
    throw error;
  }
}

export async function passkeyFixture(supplied?: { pool: Pool; kernelPool: Pool; url: string }) {
  const database = supplied ? undefined : passkeyDatabase();
  const pool = supplied?.pool ?? new Pool({ connectionString: database!.url });
  const kernelPool = supplied?.kernelPool ?? new Pool({ connectionString: database!.url });
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = supplied?.url ?? database!.url;
  let native;
  try {
    await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
    native = {
      ...(await import('../../kernel/src/access/index.ts')),
      ...(await import('../../kernel/src/access/auth-credential-capability.ts')),
      ...(await import('../../kernel/src/access/workflow-approvals.ts')),
      ...(await import('../../kernel/src/access/operator.ts')),
      ...(await import('../../kernel/src/access/auth-bindings.ts')),
    };
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
  const {
    createAccess,
    createCredentialCapability,
    createWorkflowApprovals,
    createOperatorCommands,
    createAuthBindings,
  } = native;
  let service: AuthService;
  const actions = new Map([['account:manage', { anonymous: false }]]);
  const access = createAccess({
    actions,
    auth: {
      issuer,
      audience: 'https://api.rezics.com',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  const referenceKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(27)]]) };
  const operators = createOperatorCommands({ pool: kernelPool, access, actions, managementAction: 'account:manage' });
  const capability = createCredentialCapability({
    pool: kernelPool,
    access,
    operators,
    workflowApprovals: createWorkflowApprovals({ pool: kernelPool, access, actions, referenceKeys }),
    referenceKeys,
    accessTokenForProof: (proof) => service.internal.accessTokenForProof(proof),
    verifyCredentialEffect: (reference, expected) => service.internal.verifyCredentialEffect(reference, expected),
  });
  const pair = await generateKeyPair('ES256', { extractable: true });
  const signing = { ...(await exportJWK(pair.privateKey)), kid: 'passkey-signer' };
  const options = {
    database: pool,
    issuer,
    audience: 'https://api.rezics.com',
    secret: 'passkey-fixture-persistent-secret-32-bytes',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: trustedAccessPorts({
      ...createAuthBindings({
        pool: kernelPool,
        consumeAuthAuthorization: (input) => capability.consumeAuthAuthorization(input as CredentialAuthorizationInput),
      }),
      // Provisioning is fixture setup; all credential approvals, consumption and
      // floor changes below use the installed kernel capability.
      async readProvisioningAccount(id: string) {
        const row = (
          await kernelPool.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [routeOf(id), id])
        ).rows[0];
        return row
          ? {
              accountId: id,
              kind: 'actor' as const,
              state: row.state,
              authnEpoch: 1,
              automated: false,
              registrationId: id,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            }
          : null;
      },
      authorizeProvisioning: async (accountId: string) => ({ accountId }),
      approveCredentialEffect: capability.approveCredentialEffect,
      revalidateCredentialEffect: capability.revalidateCredentialEffect,
      advanceCredentialFloor: capability.advanceCredentialFloor,
    }),
  };
  service = await createAuthService(options);
  const handle = credentialEffectTransport(service, (r) => service.handler(r), options);
  const request = (path: string, body?: unknown, cookie = '') =>
    handle(
      new Request(`${issuer}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['account:manage'] });
  async function person() {
    const id = newId(0x9130);
    await kernelPool.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$3)`,
      [routeOf(id), id, newId(routeOf(id)!)],
    );
    await service.internal.provisionPassword({ authorization: id, email: `${id}@passkey.test`, password });
    await kernelPool.query(`UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2`, [
      routeOf(id),
      id,
    ]);
    await operators.provisionManagementDefaults({ operatorAccountId: id, key: randomUUID() });
    return id;
  }
  async function login(id: string) {
    const response = await request('/signin', {
      account_id: id,
      password,
      client_id: 'login',
      scope: ['account:manage'],
    });
    expect(response.status).toBe(200);
    return cookies(response);
  }
  async function register(cookie: string, device = authenticator()) {
    const options = await request('/passkeys/register/options', {}, cookie);
    expect(options.status).toBe(200);
    const creation = await options.json();
    expect(creation).toMatchObject({
      rp: { id: 'rezics.com', name: 'REZICS' },
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const ceremonyCookie = `${cookie}; ${cookies(options)}`;
    const body = { response: device.registration(creation), name: 'My device' };
    const response = await request('/passkeys/register', body, ceremonyCookie);
    expect(response.status).toBe(201);
    return { device, passkey: await response.json(), body, cookie: ceremonyCookie };
  }
  return {
    pool,
    kernelPool,
    service,
    options,
    request,
    person,
    login,
    register,
    async close() {
      if (!supplied) {
        await Promise.all([pool.end(), kernelPool.end()]);
        database!.close();
      }
    },
  };
}

test('a person registers through real credential effects, replays a lost response, lists only their passkeys and signs in with pop', async () => {
  const f = await passkeyFixture();
  try {
    const person = await f.person();
    const previous = await f.login(person);
    const registered = await f.register(previous);
    const replay = await f.request('/passkeys/register', registered.body, registered.cookie);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(registered.passkey);
    expect((await f.pool.query('SELECT * FROM passkey')).rowCount).toBe(1);
    expect(
      (
        await f.pool.query(
          "SELECT purpose,committed_at,opening_receipt_id FROM auth_effect_receipt WHERE purpose='add-passkey'",
        )
      ).rows[0],
    ).toMatchObject({ purpose: 'add-passkey', committed_at: expect.any(Date), opening_receipt_id: expect.any(String) });
    const other = await f.person();
    await f.register(await f.login(other));
    const list = await f.request('/passkeys', undefined, previous);
    expect(await list.json()).toEqual({ passkeys: [{ ...registered.passkey, last_used_at: null }] });
    const challenge = await f.request('/signin/passkey/options', {}, previous);
    const options = await challenge.json();
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials ?? []).toEqual([]);
    const response = await f.request(
      '/signin/passkey',
      { response: registered.device.assertion(options), client_id: 'login', scope: ['account:manage'] },
      `${previous}; ${cookies(challenge)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: person, amr: ['pop'] });
    expect((await f.request('/session', undefined, previous)).status).toBe(401);
    const token = await f.request('/token', {}, cookies(response));
    expect(decodeJwt((await token.json()).access_token).amr).toEqual(['pop']);
    const used = (await (await f.request('/passkeys', undefined, cookies(response))).json()).passkeys[0];
    expect(used.last_used_at).toBeString();
    for (const path of [
      '/api/auth/passkey/generate-register-options',
      '/api/auth/passkey/verify-registration',
      '/api/auth/passkey/delete-passkey',
    ])
      expect((await f.request(path, {}, cookies(response))).status).toBe(404);
  } finally {
    await f.close();
  }
}, 60000);

test('removing passkeys consumes a credential effect and floor receipt, and refuses the last interactive credential', async () => {
  const f = await passkeyFixture();
  try {
    const person = await f.person();
    let cookie = await f.login(person);
    const first = await f.register(cookie);
    const second = await f.register(cookie);
    expect((await f.request('/passkeys/remove', { id: first.passkey.id }, cookie)).status).toBe(200);
    expect(
      (await f.kernelPool.query('SELECT purpose FROM access.credential_floor_receipt WHERE account_id=$1', [person]))
        .rows[0].purpose,
    ).toBe('remove-passkey');
    expect((await f.request('/session', undefined, cookie)).status).toBe(401);
    cookie = await f.login(person);
    const stage = await f.service.internal.stageCredentialEffect({
      key: randomUUID(),
      subjectAccountId: person,
      headers: new Headers({ cookie }),
      credential: { kind: 'password', password: null },
    });
    const input = { ...stage, subjectAccountId: person, headers: new Headers({ cookie }) };
    const approval = await f.service.internal.approveCredentialEffect(input);
    await f.service.internal.applyCredentialEffect({ ...input, authorization: approval.reference });
    const options = await f.request('/signin/passkey/options', {});
    const signin = await f.request(
      '/signin/passkey',
      { response: second.device.assertion(await options.json()), client_id: 'login', scope: ['account:manage'] },
      cookies(options),
    );
    expect(signin.status).toBe(200);
    const removed = await f.request('/passkeys/remove', { id: second.passkey.id }, cookies(signin));
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ effect_status: 'not_applied' });
    expect((await f.pool.query('SELECT id FROM passkey WHERE "userId"=$1', [person])).rows).toEqual([
      { id: second.passkey.id },
    ]);
  } finally {
    await f.close();
  }
}, 60000);

test('a passkey session is accepted by website authorization, ID tokens and refresh', async () => {
  const f = await passkeyFixture();
  try {
    const person = await f.person();
    const cookie = await f.login(person);
    const { device } = await f.register(cookie);
    const options = await f.request('/signin/passkey/options', {});
    const signin = await f.request(
      '/signin/passkey',
      { response: device.assertion(await options.json()), client_id: 'login', scope: ['account:manage'] },
      cookies(options),
    );
    expect(signin.status).toBe(200);
    const clientKey = await generateKeyPair('ES256', { extractable: true });
    const callback = 'https://rezics.com/callback';
    const clientPublicKey = await exportJWK(clientKey.publicKey);
    await f.service.internal.registerWebsiteClient({
      publicJwks: {
        keys: [
          {
            kty: 'EC',
            crv: 'P-256',
            x: clientPublicKey.x!,
            y: clientPublicKey.y!,
            alg: 'ES256',
            kid: 'web',
            use: 'sig',
          },
        ],
      },
      redirectUris: [callback],
      postLogoutRedirectUris: ['https://rezics.com/'],
      scopes: ['openid', 'offline_access', 'media:complete'],
    });
    const verifier = encode(randomBytes(48));
    const query = new URLSearchParams({
      client_id: 'rezics-website',
      redirect_uri: callback,
      response_type: 'code',
      scope: 'openid offline_access',
      state: 'passkey-state',
      code_challenge: encode(hash(verifier)),
      code_challenge_method: 'S256',
      resource: f.options.audience,
    });
    const authorize = await f.service.handler(
      new Request(`${issuer}/authorize?${query}`, { headers: { cookie: cookies(signin) } }),
    );
    expect(authorize.status).toBe(302);
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code');
    expect(code).toBeString();
    async function token(fields: Record<string, string>) {
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'web' })
        .setIssuer('rezics-website')
        .setSubject('rezics-website')
        .setAudience(issuer)
        .setIssuedAt()
        .setExpirationTime('60s')
        .setJti(randomUUID())
        .sign(clientKey.privateKey);
      return f.service.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: 'rezics-website',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: assertion,
            resource: f.options.audience,
            ...fields,
          }),
        }),
      );
    }
    const exchange = await token({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: callback,
    });
    expect(exchange.status).toBe(200);
    const tokens = await exchange.json();
    expect(decodeJwt(tokens.id_token).amr).toEqual(['pop']);
    expect(decodeJwt(tokens.access_token).amr).toEqual(['pop']);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    expect(decodeJwt((await refreshed.json()).id_token).amr).toEqual(['pop']);
  } finally {
    await f.close();
  }
}, 60000);

test('default host accepts each exact Auth-page operation profile after native passkey verification and preserves live proof tokens', async () => {
  const database = passkeyDatabase();
  const pool = new Pool({ connectionString: database.url });
  const kernelPool = new Pool({ connectionString: database.url });
  const systemPool = new Pool({ connectionString: database.url, max: 8 });
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  try {
    const f = await passkeyFixture({ pool, kernelPool, url: database.url });
    const person = await f.person();
    const registered = await f.register(await f.login(person));
    const unused = async (): Promise<never> => { throw new Error('Sign-in must not invoke account workflows'); };
    const access: AccountWorkflowPorts = {
      registrationTarget: () => { throw new Error('Sign-in must not invoke account workflows'); },
      reserveHandle: unused, createPending: unused, claimHandle: unused, activate: unused,
      expireRegistration: unused, releaseExpiredRegistrationHandle: unused,
      provisioningReference: unused, provisioningEvidence: unused, raiseFence: unused, readAccount: unused,
    };
    host = await createAuthHost({ ...f.options, systemDatabasePool: systemPool, access, stagingKey: randomBytes(32), maintenanceSchedule: '0 0 0 1 1 *', executorId: 'operation-passkey-test' });
    const auth = host;
    const call = (path: string, body?: unknown, cookie = '') => auth.handler(new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const websiteKey = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)), kid: 'operation-passkey-website', alg: 'ES256', use: 'sig' as const };
    await auth.service.internal.registerWebsiteClient({ publicJwks: { keys: [websiteKey] }, redirectUris: ['https://rezics.com/callback'], postLogoutRedirectUris: ['https://rezics.com/'], scopes: ['openid', 'offline_access', 'media:complete', 'organization:create', 'account:delete'] });
    await Promise.all([auth.start(), auth.start()]);
    expect((await pool.query('SELECT scopes FROM auth_client WHERE client_id=$1', ['login'])).rows).toEqual([{ scopes: ['account:manage'] }]);
    const jwks = createLocalJWKSet(await (await call('/.well-known/jwks.json')).json());
    async function signIn(scope: string[], client_id = AUTH_PAGE_OPERATION_CLIENT_ID, uv = true) {
      const challenge = await call('/signin/passkey/options', {});
      expect(challenge.status).toBe(200);
      const options = await challenge.json();
      expect(options.userVerification).toBe('required');
      return call('/signin/passkey', { response: registered.device.assertion(options, uv), client_id, scope }, cookies(challenge));
    }
    for (const profile of Object.values(AUTH_PAGE_OPERATION_SCOPES)) {
      const response = await signIn([...profile]);
      expect(response.status).toBe(200);
      const proof = await response.json() as SessionProof;
      const expected = { account_id: person, client_id: AUTH_PAGE_OPERATION_CLIENT_ID, scope: [...profile], amr: ['pop'] };
      expect(proof).toMatchObject(expected);
      expect(await (await call('/session', undefined, cookies(response))).json()).toMatchObject(expected);
      const token = await call('/token', {}, cookies(response));
      expect(token.status).toBe(200);
      expect(decodeJwt((await token.json()).access_token)).toMatchObject({ sub: person, client_id: AUTH_PAGE_OPERATION_CLIENT_ID, scope: profile.join(' '), amr: ['pop'] });
      await auth.service.internal.withFreshHuman({ headers: new Headers({ cookie: cookies(response) }) }, async (live) => {
        expect(live).toMatchObject(expected);
        const bearer = await auth.service.internal.accessTokenForProof(live);
        expect((await jwtVerify(bearer, jwks, { issuer, audience: f.options.audience, typ: 'at+jwt' })).payload).toMatchObject({ sub: person, client_id: AUTH_PAGE_OPERATION_CLIENT_ID, scope: profile.join(' '), amr: ['pop'], authn_epoch: live.authn_epoch, auth_time: live.auth_time });
      });
      await expect(auth.service.internal.accessTokenForProof(proof)).rejects.toThrow();
    }
    const sessions = () => pool.query('SELECT id FROM session WHERE "userId"=$1 ORDER BY id', [person]).then((result) => result.rows);
    const before = await sessions();
    for (const scope of [['account:manage'], ['media:complete'], ['openid'], ['account:delete', 'account:manage']]) {
      expect((await signIn(scope)).status).toBeGreaterThanOrEqual(400);
      expect(await sessions()).toEqual(before);
    }
    expect((await signIn(['account:delete'], 'rezics-website')).status).toBeGreaterThanOrEqual(400);
    expect((await signIn(['account:delete'], AUTH_PAGE_OPERATION_CLIENT_ID, false)).status).toBeGreaterThanOrEqual(400);
    expect(await sessions()).toEqual(before);
  } finally {
    if (host) await host.stop(); else await Promise.all([pool.end(), systemPool.end()]);
    await kernelPool.end();
    database.close();
  }
}, 60000);
