import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { getCurrentAdapter, runWithTransaction } from '@better-auth/core/context';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createAuthService, WEBSITE_CLIENT_ID, type AccessAccount, type PublicJwks } from '../src/index.ts';
import { testDatabase } from './database.ts';
import { nativeProbeOptions } from './probe-native-worker.ts';

// Diagnostic only: expose the pinned native provider in its own disposable
// database. Never mount this fixture as an application or log its credentials.
const fixture = testDatabase();
const database = new Pool({ connectionString: fixture.url, max: 1 });
const observer = new Pool({ connectionString: fixture.url, max: 1 });
const audience = 'https://api.rezics.test';
const secret = 'native-provider-probe-only-secret-at-least-32-bytes';
const account: AccessAccount = {
  accountId: '00000000-0000-7000-8000-123400000099',
  kind: 'actor',
  state: 'pending',
  authnEpoch: 1,
  automated: false,
};
let handler: (request: Request) => Promise<Response>;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handler(request) });
const issuer = `http://127.0.0.1:${server.port}`;
const redirectUri = 'https://website.rezics.test/auth/callback';
const selectedScopes = ['openid', 'offline_access', 'media:read'];
let worker: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
process.once('exit', () => worker?.kill('SIGKILL'));

async function startWorker() {
  worker = Bun.spawn(['bun', new URL('./probe-native-worker.ts', import.meta.url).pathname], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  worker.stdin.write(JSON.stringify({ url: fixture.url, issuer, secret, audience, scopes: selectedScopes }));
  await worker.stdin.end();
  const reader = worker.stdout.getReader();
  const deadline = setTimeout(() => worker?.kill('SIGKILL'), 15000);
  let ready = '';
  try {
    const decoder = new TextDecoder();
    while (!ready.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Native probe worker exited before listening');
      ready += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const { port } = JSON.parse(ready);
  assert.ok(Number.isSafeInteger(port) && port > 0, 'worker has a real loopback socket');
  return `http://127.0.0.1:${port}`;
}

async function stopWorker() {
  if (!worker) return;
  worker.kill('SIGTERM');
  await worker.exited;
  worker = undefined;
}

try {
  let issuanceHooks = 0;
  const options = nativeProbeOptions(database, issuer, secret, audience, selectedScopes, () => issuanceHooks++);
  // Native migration generation is used only inside this disposable database.
  // No production migration is generated or committed by this diagnostic.
  await (await getMigrations(options)).runMigrations();
  const native = betterAuth(options);
  handler = native.handler;
  const context = await native.$context;
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'probe-issuer',
    alg: 'ES256',
  };
  const service = await createAuthService({
    database,
    issuer,
    audience,
    secret,
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: {
      confirmBarrier: async () => false,
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(id) {
        return id === account.accountId ? account : null;
      },
      async authorizeProvisioning() {
        return { accountId: account.accountId };
      },
    },
  });
  await service.internal.registerClient({ clientId: 'probe-login', firstParty: true, scopes: ['media:read'] });
  const password = randomBytes(32).toString('base64url');
  await service.internal.provisionPassword({ authorization: 'fixture', email: 'probe@example.test', password });
  account.state = 'active';
  const login = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'probe@example.test', password, client_id: 'probe-login', scope: ['media:read'] }),
    }),
  );
  assert.equal(login.status, 200, 'real Better Auth password login');
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const clientKey = await generateKeyPair('ES256', { extractable: true });
  // Register through the real bootstrap path; the native provider reads the
  // same single client registry that production composition uses.
  await service.internal.registerWebsiteClient({
    publicJwks: {
      keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'probe-client', alg: 'ES256', use: 'sig' }],
    } as PublicJwks,
    redirectUris: [redirectUri],
    postLogoutRedirectUris: ['https://website.rezics.test/'],
    scopes: [...selectedScopes, 'media:complete'],
  });
  const client = { client_id: WEBSITE_CLIENT_ID };
  async function token(fields: Record<string, string>, origin = issuer) {
    const now = Math.floor(Date.now() / 1000);
    // Native 1.7.12 uses the endpoint audience. The website's stricter issuer
    // audience adaptation is orthogonal to this storage/rotation diagnostic.
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'probe-client' })
      .setIssuer(client.client_id)
      .setSubject(client.client_id)
      .setAudience(`${issuer}/api/auth/oauth2/token`)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomBytes(24).toString('base64url'))
      .sign(clientKey.privateKey);
    return fetch(`${origin}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource: audience,
        ...fields,
      }),
      signal: AbortSignal.timeout(15000),
    });
  }
  const verifier = randomBytes(48).toString('base64url');
  const authorize = new URL(`${issuer}/api/auth/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: selectedScopes.join(' '),
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
  }).toString();
  const authorization = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
  assert.ok([302, 303].includes(authorization.status), 'native authorization redirects');
  const code = new URL(authorization.headers.get('location')!).searchParams.get('code');
  assert.ok(code, 'native authorization returns a code');
  const exchange = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  assert.equal(exchange.status, 200, 'native code exchange');
  const issued = await exchange.json();
  assert.equal(typeof issued.refresh_token, 'string');

  // The official transaction context exposes a transaction adapter, but native
  // OAuth operations call ctx.context.adapter directly. Prove the distinction
  // with reads only, so the timed-out operation cannot mutate authority later.
  const adapter = context.adapter;
  let pendingRead: Promise<unknown> | undefined;
  let directReadUsesTransaction = false;
  await runWithTransaction(adapter, async () => {
    const transaction = await getCurrentAdapter(adapter);
    assert.notEqual(transaction, adapter, 'PostgreSQL provides a distinct native transaction adapter');
    assert.ok(await transaction.findOne({ model: 'user', where: [{ field: 'id', value: account.accountId }] }));
    pendingRead = adapter.findOne({ model: 'user', where: [{ field: 'id', value: account.accountId }] });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      directReadUsesTransaction = await Promise.race([
        pendingRead.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  });
  await pendingRead;
  assert.equal(directReadUsesTransaction, false, 'a bare transaction context does not bind native direct calls');
  let workerOrigin = await startWorker();

  const reachedInsert = Promise.withResolvers<void>();
  const releaseInsert = Promise.withResolvers<void>();
  let pause = true;
  let guarded = false;
  let refreshRowsAfterReplay = -1;
  const pauseCreate =
    (originalCreate: typeof context.adapter.create): typeof context.adapter.create =>
    async (input) => {
      if (input.model === 'oauthRefreshToken' && pause) {
        pause = false;
        reachedInsert.resolve();
        await releaseInsert.promise;
      }
      return originalCreate(input);
    };
  context.adapter.create = pauseCreate(context.adapter.create.bind(context.adapter));
  const originalTransaction = context.adapter.transaction.bind(context.adapter);
  context.adapter.transaction = (action) =>
    originalTransaction(async (transaction) => {
      transaction.create = pauseCreate(transaction.create.bind(transaction));
      return action(transaction);
    });
  const rotation = token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reachedInsert.promise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Native rotation never reached insertion')), 10000);
      }),
    ]);
    // Rotation has atomically revoked the parent, but has not inserted the child.
    const hooksBeforeReplay = issuanceHooks;
    const replayRequest = token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token }, workerOrigin);
    // Synchronize on observable state, never elapsed time: either the replay
    // finishes while the rotation is paused (no durable family guard), or the
    // replay process waits on a real PostgreSQL lock held by the paused rotation.
    // The observer never participates in the one-connection native runtime pool.
    const settled = replayRequest.then(
      () => 'replied' as const,
      () => 'replied' as const,
    );
    const end = Date.now() + 10000;
    while (true) {
      if ((await Promise.race([settled, Bun.sleep(10).then(() => 'pending' as const)])) === 'replied') break;
      const waiting = await observer.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name='native-refresh-probe-worker'
        AND cardinality(pg_blocking_pids(pid))>0`);
      if (waiting.rowCount) {
        guarded = true;
        releaseInsert.resolve();
        break;
      }
      if (Date.now() > end) throw new Error('Replay neither completed nor waited for a family lock');
    }
    const replay = await replayRequest;
    assert.equal(replay.status, 400, 'native replay is detected');
    assert.equal(issuanceHooks, hooksBeforeReplay, 'replay cannot reach the other process issuance hooks');
    const workerHooks = await (await fetch(`${workerOrigin}/probe/hooks`)).json();
    assert.equal(workerHooks.issuanceHooks, 0, 'native replay skips both hooks in the replay process');
    const afterReplay = await database.query(
      'SELECT count(*)::int AS count FROM "oauthRefreshToken" WHERE "clientId"=$1',
      [client.client_id],
    );
    refreshRowsAfterReplay = afterReplay.rows[0].count;
    // Unguarded native cleanup deletes the whole client/user history; a family
    // guard instead retains the rows and revokes the family permanently.
    if (!guarded) assert.equal(refreshRowsAfterReplay, 0, 'native replay cleanup completed');
  } finally {
    clearTimeout(deadline);
    releaseInsert.resolve();
  }
  const rotated = await rotation;
  assert.equal(rotated.status, 200, 'native concurrent rotation returns a child after replay cleanup');
  const child = await rotated.json();
  await stopWorker();
  workerOrigin = await startWorker();
  const survived = await token({ grant_type: 'refresh_token', refresh_token: child.refresh_token }, workerOrigin);
  console.log(
    JSON.stringify({
      provider: `@better-auth/oauth-provider@${(await Bun.file(new URL('../package.json', import.meta.resolve('@better-auth/oauth-provider'))).json()).version}`,
      betterAuth: (await Bun.file(new URL('../package.json', import.meta.resolve('better-auth'))).json()).version,
      guarded,
      processes: 2,
      poolMaxPerProcess: 1,
      restartedReplayProcess: true,
      directReadUsesTransaction,
      replayStatus: 400,
      refreshRowsImmediatelyAfterReplay: refreshRowsAfterReplay,
      concurrentRotationStatus: rotated.status,
      childRefreshAfterReplayStatus: survived.status,
      issuanceHooksDuringReplay: 0,
    }),
  );
  // Required outcome, deliberately failing on the unadapted pinned provider.
  // Observation mode retains a runnable diagnostic without treating the race
  // as a successful security assertion.
  if (process.argv.includes('--observe-native')) assert.equal(survived.status, 200, 'native race reproduced');
  else assert.ok(survived.status >= 400, 'a replayed family must never regain a usable child, including after restart');
} finally {
  await stopWorker();
  await server.stop(true);
  await observer.end();
  await database.end();
  fixture.close();
}
