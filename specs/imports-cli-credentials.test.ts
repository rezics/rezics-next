import { expect, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  exit,
  loadCliCredentialsDriver,
  type AuthRequestObservation,
  type ImportCliCredentialsDriver,
  type ImportCliCredentialsExecution,
  type VirtualClock,
} from './imports-cli-credentials-driver.ts';

const apiOrigin = 'https://api.importer.test';
const authOrigin = 'https://auth.importer.test';
const tokenLifetimeSeconds = 300;
const refreshBeforeExpirySeconds = 60;
const renewalIntervalMs = (tokenLifetimeSeconds - refreshBeforeExpirySeconds) * 1000;
const importerScopes = [
  'subject:create',
  'subject:batch_write',
  'statement:propose',
  'source_fence:read',
  'media:import_from_url',
  'media:read_reservation',
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

type TestJwk = JsonWebKey & { kid: string; alg: 'ES256'; key_ops: string[] };
type KeyFixture = { privateJwk: TestJwk; publicJwk: TestJwk; serializedPrivateJwk: string };

async function makeKey(kid = 'importer-test-key'): Promise<KeyFixture> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = {
    ...pair.privateKey.export({ format: 'jwk' }),
    kid,
    alg: 'ES256',
    key_ops: ['sign'],
  } as TestJwk;
  const publicJwk = {
    ...pair.publicKey.export({ format: 'jwk' }),
    kid,
    alg: 'ES256',
    key_ops: ['verify'],
  } as TestJwk;
  return { privateJwk, publicJwk, serializedPrivateJwk: JSON.stringify(privateJwk) };
}

function virtualClock(): VirtualClock {
  let value = Date.now();
  return {
    now: () => value,
    sleep: async (ms) => {
      value += ms;
    },
    advance(ms) {
      value += ms;
    },
  };
}

async function* input(text: string, chunkBytes = 31) {
  const bytes = encoder.encode(text);
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) yield bytes.subarray(offset, offset + chunkBytes);
}

function wikidataRecord(id: number): string {
  return (
    JSON.stringify({
      type: 'item',
      id: `Q${id}`,
      lastrevid: 7,
      labels: { en: { language: 'en', value: `Importer fixture ${id}` } },
      claims: {
        P31: [
          {
            id: `Q${id}$00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
            type: 'statement',
            rank: 'normal',
            mainsnak: {
              snaktype: 'value',
              property: 'P31',
              datatype: 'wikibase-item',
              datavalue: {
                type: 'wikibase-entityid',
                value: { 'entity-type': 'item', 'numeric-id': 47461344, id: 'Q47461344' },
              },
            },
          },
        ],
      },
    }) + '\n'
  );
}

function dump(records = 1): string {
  return Array.from({ length: records }, (_, index) => wikidataRecord(index + 1)).join('');
}

class Harness {
  readonly accountId = '6b147e8d-1762-4717-9a65-aeb435cb843e';
  readonly clientId = 'importer-credentials-test';
  readonly state: string;
  readonly clock = virtualClock();

  constructor(
    readonly directory: string,
    readonly keyPath: string,
    readonly key: KeyFixture,
    readonly driver: ImportCliCredentialsDriver,
  ) {
    this.state = resolve(directory, 'state.sqlite');
  }

  argv(options: { keyPath?: string; auth?: string } = {}): string[] {
    return [
      '--source',
      'wikidata',
      '--dump',
      '-',
      '--state',
      this.state,
      '--api',
      apiOrigin,
      '--account-key',
      options.keyPath ?? this.keyPath,
      '--account',
      this.accountId,
      '--client',
      this.clientId,
      '--auth',
      options.auth ?? authOrigin,
    ];
  }

  invoke(argv = this.argv(), text = dump(), signal?: AbortSignal) {
    return this.driver.invoke(argv, { stdin: input(text), ...(signal ? { signal } : {}) });
  }
}

async function withDriver(body: (h: Harness) => Promise<void>) {
  const create = await loadCliCredentialsDriver();
  const directory = await mkdtemp(join(tmpdir(), 'import-cli-credentials-'));
  const key = await makeKey();
  const keyPath = resolve(directory, 'account.jwk');
  await writeFile(keyPath, key.serializedPrivateJwk, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const clock = virtualClock();
  let driver: ImportCliCredentialsDriver | undefined;
  try {
    driver = await create({
      directory,
      accountId: '6b147e8d-1762-4717-9a65-aeb435cb843e',
      clientId: 'importer-credentials-test',
      accountKeyPath: keyPath,
      registeredPublicJwk: key.publicJwk as JsonWebKey,
      apiOrigin,
      authOrigin,
      clock,
    });
    await body(new Harness(directory, keyPath, key, driver));
  } finally {
    try {
      await driver?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function authPath(request: AuthRequestObservation): string {
  return new URL(request.url).pathname;
}

async function assertAuthFlow(h: Harness, execution: ImportCliCredentialsExecution) {
  const signinRequests = execution.auth.requests.filter((request) => authPath(request) === '/signin/key');
  const tokenRequests = execution.auth.requests.filter((request) => authPath(request) === '/token');
  expect(signinRequests.length).toBeGreaterThan(0);
  expect(execution.auth.requests.length).toBe(signinRequests.length + tokenRequests.length);
  expect(tokenRequests.length).toBe(signinRequests.length);
  expect([...execution.auth.registeredScopes].sort()).toEqual([...importerScopes].sort());

  const publicKey = createPublicKey({ key: h.key.publicJwk, format: 'jwk' });
  const jtis: string[] = [];
  for (let index = 0; index < signinRequests.length; index++) {
    const signin = signinRequests[index]!;
    const token = tokenRequests[index]!;
    expect(authPath(signin)).toBe('/signin/key');
    expect(authPath(token)).toBe('/token');
    expect(signin.url.startsWith(`${authOrigin}/`)).toBe(true);
    expect(token.url.startsWith(`${authOrigin}/`)).toBe(true);
    expect(signin.method).toBe('POST');
    expect(token.method).toBe('POST');
    expect(signin.origin).toBe(authOrigin);
    expect(token.origin).toBe(authOrigin);
    expect(signin.contentType).toBe('application/json');
    expect(token.contentType).toBe('application/json');
    expect(signin.responseStatus).toBe(200);
    expect(token.responseStatus).toBe(200);

    const signinBody = object(signin.body, 'Auth signin body was not an object');
    expect(Object.keys(signinBody).sort()).toEqual(['account_id', 'assertion', 'client_id', 'scope']);
    expect(signinBody.account_id).toBe(h.accountId);
    expect(signinBody.client_id).toBe(h.clientId);
    expect(Array.isArray(signinBody.scope)).toBe(true);
    const requestedScopes = signinBody.scope as string[];
    expect([...requestedScopes].sort()).toEqual([...importerScopes].sort());
    expect(typeof signinBody.assertion).toBe('string');

    const assertion = signinBody.assertion as string;
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      const segments = assertion.split('.');
      if (segments.length !== 3) throw new Error();
      const [protectedSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
      const signatureValid = verifySignature(
        'sha256',
        Buffer.from(`${protectedSegment}.${payloadSegment}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signatureSegment, 'base64url'),
      );
      if (!signatureValid) throw new Error();
      header = object(
        JSON.parse(Buffer.from(protectedSegment, 'base64url').toString('utf8')),
        'Invalid assertion header',
      );
      claims = object(
        JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')),
        'Invalid assertion payload',
      );
    } catch {
      throw new Error('Account-key assertion was not signed by the registered ES256 key');
    }
    expect(Object.keys(header).sort()).toEqual(['alg', 'kid']);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toBe(h.key.privateJwk.kid);
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    expect(claims.iss).toBe(h.accountId);
    expect(claims.sub).toBe(h.accountId);
    expect(claims.aud).toBe(`${authOrigin}/token`);
    expect(Number.isSafeInteger(claims.iat)).toBe(true);
    expect(Number.isSafeInteger(claims.exp)).toBe(true);
    expect(claims.iat).toBe(Math.floor(signin.atMs / 1000));
    expect((claims.exp as number) > (claims.iat as number)).toBe(true);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(60);
    expect(typeof claims.jti).toBe('string');
    expect(uuidPattern.test(claims.jti as string)).toBe(true);
    jtis.push(claims.jti as string);

    const tokenBody = object(token.body, 'Auth token body was not an object');
    expect(Object.keys(tokenBody)).toEqual([]);
    expect(token.cookie === signin.responseCookie).toBe(true);
    const tokenResponse = object(token.responseBody, 'Auth token response was not an object');
    expect(Object.keys(tokenResponse).sort()).toEqual(['access_token', 'expires_in', 'token_type']);
    expect(typeof tokenResponse.access_token).toBe('string');
    expect(tokenResponse.token_type).toBe('Bearer');
    expect(tokenResponse.expires_in).toBe(tokenLifetimeSeconds);
    expect(token.responseBytes).toBeLessThanOrEqual(token.policy.responseLimitBytes);
    expect(signin.requestBytes).toBeLessThanOrEqual(signin.policy.requestLimitBytes);
    expect(token.requestBytes).toBeLessThanOrEqual(token.policy.requestLimitBytes);
  }
  expect(new Set(jtis).size).toBe(jtis.length);

  expect(execution.api.requests.length).toBeGreaterThan(0);
  for (const authRequest of execution.auth.requests) {
    expect(authRequest.policy.timeoutMs > 0).toBe(true);
    expect(authRequest.requestBytes <= authRequest.policy.requestLimitBytes).toBe(true);
    expect(authRequest.responseBytes <= authRequest.policy.responseLimitBytes).toBe(true);
    for (const apiRequest of execution.api.requests) {
      expect(apiRequest.requestBytes <= apiRequest.policy.requestLimitBytes).toBe(true);
      expect(apiRequest.responseBytes <= apiRequest.policy.responseLimitBytes).toBe(true);
      expect(authRequest.policy.timeoutMs === apiRequest.policy.timeoutMs).toBe(true);
      expect(authRequest.policy.requestLimitBytes === apiRequest.policy.requestLimitBytes).toBe(true);
      expect(authRequest.policy.responseLimitBytes === apiRequest.policy.responseLimitBytes).toBe(true);
    }
  }
}

function writes(execution: ImportCliCredentialsExecution) {
  return execution.api.requests.filter((request) => new URL(request.url).pathname === '/v1/subjects:batchWrite');
}

async function assertNoSecrets(h: Harness, execution: ImportCliCredentialsExecution, additionalSecrets: string[] = []) {
  const secrets = new Set<string>([
    h.key.serializedPrivateJwk,
    String(h.key.privateJwk.d ?? ''),
    ...additionalSecrets,
    ...execution.auth.accessTokens,
    ...execution.auth.sessionCookies,
    ...execution.api.requests.flatMap((request) => {
      const token = request.authorization?.match(/^Bearer (.+)$/)?.[1];
      return token ? [token] : [];
    }),
    ...execution.auth.requests.flatMap((request) => {
      const cookie = [request.cookie, request.responseCookie].filter((value): value is string => !!value);
      const response =
        authPath(request) === '/token' ? object(request.responseBody, 'Auth token response was not an object') : {};
      const token = typeof response.access_token === 'string' ? [response.access_token] : [];
      const signinAssertion =
        authPath(request) === '/signin/key'
          ? (() => {
              const body = object(request.body, 'Auth signin body was not an object');
              return typeof body.assertion === 'string' ? [body.assertion] : [];
            })()
          : [];
      if (signinAssertion.length) return [...cookie, ...token, ...signinAssertion];
      return [...cookie, ...token];
    }),
  ]);
  const output = execution.stdout + execution.stderr;
  for (const secret of secrets) if (secret) expect(output.includes(secret)).toBe(false);

  const databaseFiles = new Set([
    resolve(h.state),
    resolve(`${h.state}-wal`),
    resolve(`${h.state}-shm`),
    ...execution.databaseFiles.map((path) => resolve(path)),
  ]);
  for (const path of databaseFiles) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      continue;
    }
    for (const secret of secrets) if (secret) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  }
}

test('help names account-key credentials and touches neither Auth nor API', async () => {
  await withDriver(async (h) => {
    const execution = await h.invoke(['--help']);
    expect(execution.code).toBe(exit.success);
    for (const flag of ['--account-key', '--account', '--client', '--auth', '--api'])
      expect(execution.stdout.includes(flag)).toBe(true);
    expect(execution.auth.requests).toHaveLength(0);
    expect(execution.api.requests).toHaveLength(0);
    expect(execution.key.fileReadCount).toBe(0);
    expect(execution.openHandles).toBe(0);
  });
});

test('a long import renews before expiry within the sign-in bound and every batch write succeeds', async () => {
  await withDriver(async (h) => {
    await chmod(h.keyPath, 0o400);
    let writeNumber = 0;
    h.driver.api.afterResponse = async (request, _response, clock) => {
      if (new URL(request.url).pathname !== '/v1/subjects:batchWrite') return;
      const advances = [renewalIntervalMs - 1000, 1000, renewalIntervalMs, renewalIntervalMs, renewalIntervalMs, 0];
      clock.advance(advances[writeNumber] ?? 0);
      writeNumber++;
    };
    const execution = await h.invoke(h.argv(), dump(501));
    expect(execution.code).toBe(exit.success);
    expect(execution.openHandles).toBe(0);
    await assertAuthFlow(h, execution);

    const apiWrites = writes(execution);
    expect(apiWrites.length).toBeGreaterThanOrEqual(6);
    expect(apiWrites.every((request) => request.responseStatus === 200 && request.effectApplied)).toBe(true);
    const duration = execution.finishedAtMs - execution.startedAtMs;
    expect(duration).toBeGreaterThanOrEqual(3 * tokenLifetimeSeconds * 1000);
    const signinCount = execution.auth.requests.filter((request) => authPath(request) === '/signin/key').length;
    expect(signinCount).toBeLessThanOrEqual(Math.ceil(duration / renewalIntervalMs) + 1);
    expect(apiWrites[1]!.atMs - apiWrites[0]!.atMs).toBe(renewalIntervalMs - 1000);
    expect(apiWrites[0]!.authorization === apiWrites[1]!.authorization).toBe(true);
    expect(apiWrites[2]!.atMs - apiWrites[0]!.atMs).toBe(renewalIntervalMs);
    expect(apiWrites[1]!.authorization !== apiWrites[2]!.authorization).toBe(true);
    expect(execution.key.fileReadCount).toBe(1);
    expect(execution.key.regularFile).toBe(true);
    expect(execution.key.mode & 0o077).toBe(0);
    expect(execution.key.importedKeyIsExtractable).toBe(false);
    await assertNoSecrets(h, execution);
  });
});

test('a bearer expiring during a write is renewed once and replayed with the same command keys', async () => {
  await withDriver(async (h) => {
    let injected = false;
    h.driver.api.beforeRequest = async (request, clock) => {
      if (!injected && new URL(request.url).pathname === '/v1/subjects:batchWrite') {
        injected = true;
        clock.advance(tokenLifetimeSeconds * 1000);
        return new Response('denied', { status: 401 });
      }
      return undefined;
    };
    const execution = await h.invoke();
    expect(execution.code).toBe(exit.success);
    await assertAuthFlow(h, execution);
    const attempts = writes(execution);
    expect(attempts.length).toBe(2);
    expect(attempts[0]!.responseStatus).toBe(401);
    expect(attempts[0]!.effectApplied).toBe(false);
    expect(attempts[1]!.responseStatus).toBe(200);
    expect(attempts[1]!.effectApplied).toBe(true);
    expect(attempts[0]!.url === attempts[1]!.url).toBe(true);
    expect(attempts[0]!.method === attempts[1]!.method).toBe(true);
    expect(attempts[0]!.body === attempts[1]!.body).toBe(true);
    expect(attempts[0]!.idempotencyHeader === attempts[1]!.idempotencyHeader).toBe(true);
    const firstBody = object(JSON.parse(attempts[0]!.body ?? '{}'), 'First batch body was not an object');
    const replayBody = object(JSON.parse(attempts[1]!.body ?? '{}'), 'Replay batch body was not an object');
    const firstKeys = Array.isArray(firstBody.commands)
      ? firstBody.commands.map((command) => object(command, 'Batch command was not an object').key)
      : [];
    const replayKeys = Array.isArray(replayBody.commands)
      ? replayBody.commands.map((command) => object(command, 'Batch command was not an object').key)
      : [];
    expect(firstKeys.length > 0).toBe(true);
    expect(JSON.stringify(firstKeys) === JSON.stringify(replayKeys)).toBe(true);
    expect(attempts[0]!.authorization !== attempts[1]!.authorization).toBe(true);
    expect(execution.auth.requests.filter((request) => authPath(request) === '/signin/key')).toHaveLength(2);
    await assertNoSecrets(h, execution);
  });
});

test('a second 401 ends the import denied after exactly one renewal', async () => {
  await withDriver(async (h) => {
    h.driver.api.beforeRequest = async (request) =>
      new URL(request.url).pathname === '/v1/subjects:batchWrite' ? new Response('denied', { status: 401 }) : undefined;
    const execution = await h.invoke();
    expect(execution.code).toBe(exit.denied);
    const attempts = writes(execution);
    expect(attempts.length).toBe(2);
    expect(attempts.every((request) => request.responseStatus === 401 && !request.effectApplied)).toBe(true);
    expect(execution.auth.requests.filter((request) => authPath(request) === '/signin/key')).toHaveLength(2);
    await assertNoSecrets(h, execution);
  });
});

test('wrong and revoked account keys end denied without an API write', async () => {
  await withDriver(async (h) => {
    const wrongKey = await makeKey(h.key.privateJwk.kid as string);
    const wrongPath = resolve(h.directory, 'wrong-account-key.jwk');
    await writeFile(wrongPath, wrongKey.serializedPrivateJwk, { mode: 0o600 });
    await chmod(wrongPath, 0o600);
    const wrong = await h.invoke(h.argv({ keyPath: wrongPath }));
    expect(wrong.code).toBe(exit.denied);
    expect(writes(wrong)).toHaveLength(0);
    expect(wrong.auth.requests.filter((request) => authPath(request) === '/signin/key')).toHaveLength(1);
    expect(wrong.auth.requests.filter((request) => authPath(request) === '/token')).toHaveLength(0);
    await assertNoSecrets(h, wrong, [wrongKey.serializedPrivateJwk, String(wrongKey.privateJwk.d ?? '')]);

    h.driver.auth.revokeAccountKey();
    const revoked = await h.invoke();
    expect(revoked.code).toBe(exit.denied);
    expect(writes(revoked)).toHaveLength(0);
    expect(revoked.auth.requests.filter((request) => authPath(request) === '/signin/key')).toHaveLength(1);
    expect(revoked.auth.requests.filter((request) => authPath(request) === '/token')).toHaveLength(0);
    await assertNoSecrets(h, revoked);
  });
});

test('unsafe or non-regular key files are refused before any network request', async () => {
  await withDriver(async (h) => {
    const groupReadable = resolve(h.directory, 'group-readable.jwk');
    await writeFile(groupReadable, h.key.serializedPrivateJwk, { mode: 0o640 });
    await chmod(groupReadable, 0o640);
    const worldReadable = resolve(h.directory, 'world-readable.jwk');
    await writeFile(worldReadable, h.key.serializedPrivateJwk, { mode: 0o604 });
    await chmod(worldReadable, 0o604);
    const keyDirectory = resolve(h.directory, 'key-directory');
    await mkdir(keyDirectory, { mode: 0o700 });
    const keyLink = resolve(h.directory, 'key-link.jwk');
    await symlink(h.keyPath, keyLink);

    for (const keyPath of [groupReadable, worldReadable, keyDirectory, keyLink]) {
      const execution = await h.invoke(h.argv({ keyPath }));
      expect(execution.code).toBe(exit.input);
      expect(execution.auth.requests).toHaveLength(0);
      expect(execution.api.requests).toHaveLength(0);
      expect(execution.openHandles).toBe(0);
      await assertNoSecrets(h, execution);
    }
  });
});

test('non-HTTPS and non-origin auth URLs are refused before any network request', async () => {
  await withDriver(async (h) => {
    const invalidOrigins = [
      'http://auth.importer.test',
      'https://auth.importer.test/path',
      'https://auth.importer.test?query=1',
      'https://auth.importer.test#fragment',
      'https://user:AUTH_URL_SECRET_SENTINEL@auth.importer.test',
    ];
    for (const auth of invalidOrigins) {
      const execution = await h.invoke(h.argv({ auth }));
      expect(execution.code).toBe(exit.input);
      expect(execution.auth.requests).toHaveLength(0);
      expect(execution.api.requests).toHaveLength(0);
      expect(execution.openHandles).toBe(0);
      await assertNoSecrets(h, execution, ['AUTH_URL_SECRET_SENTINEL']);
    }
  });
});

test('account-key credentials, account, client and auth origin are required', async () => {
  await withDriver(async (h) => {
    const argv = h.argv();
    const invalid = ['--account-key', '--account', '--client', '--auth'].map((flag) =>
      argv.filter((_, index) => argv[index] !== flag && argv[index - 1] !== flag),
    );
    for (const args of invalid) {
      const execution = await h.invoke(args);
      expect(execution.code).toBe(exit.input);
      expect(execution.auth.requests).toHaveLength(0);
      expect(execution.api.requests).toHaveLength(0);
      expect(execution.openHandles).toBe(0);
    }
  });
});

test('tokens, assertions and private key material never appear in output or SQLite state', async () => {
  await withDriver(async (h) => {
    const execution = await h.invoke();
    expect(execution.code).toBe(exit.success);
    await assertAuthFlow(h, execution);
    await assertNoSecrets(h, execution);
  });
});
