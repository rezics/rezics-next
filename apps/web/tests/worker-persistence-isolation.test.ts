import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { chromium } from 'playwright';
import { startDevServer } from './support/dev-server.ts';
import { openAccountMenu } from './support/account-menu.ts';
import { waitForPersonalRead } from './session-token.ts';
import '../../../scripts/worker-persistence.test.ts';

const app = resolve(import.meta.dir, '..');
const sharedRootMarker = 'owned-by-the-test-caller';
const clientId = 'web-persistence-isolation';
const sessionCookieName = '__Host-rezics_session';
const loginCookieName = '__Host-rezics_login';

type DirectServer = {
  origin: string;
  output(): string;
  stop(): Promise<void>;
};
type DirectStart = { server: DirectServer } | { failure: { code: number | null; output: string } };

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function directVite(port: number, inspectorPort: number): Promise<DirectStart> {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKER_INSPECTOR_PORT: String(inspectorPort) },
  });
  let output = '';
  let ready = false;
  let readyListener: (() => void) | undefined;
  const readyLine = new Promise<void>((resolveReady) => {
    readyListener = resolveReady;
  });
  const keep = (chunk: Buffer) => {
    const combined = (output + chunk.toString()).slice(-16_000);
    output = combined;
    if (!ready && /\bVITE\s+v\S+\s+ready in\s+[\d.]+\s*(?:ms|s)\b/i.test(combined.replace(/\x1b\[[0-9;]*m/g, ''))) {
      ready = true;
      readyListener?.();
    }
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const closed = new Promise<void>((resolveClosed) =>
    child.once('close', (exitCode, exitSignal) => {
      code = exitCode;
      signal = exitSignal;
      resolveClosed();
    }),
  );
  const startup = await Promise.race([
    readyLine.then(() => 'ready' as const),
    closed.then(() => 'closed' as const),
    new Promise<'timeout'>((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 150_000)),
  ]);
  if (startup !== 'ready') {
    if (startup === 'timeout') {
      await stopDirect(child, closed);
      throw new Error(`Legacy direct Vite spawn exceeded its ready budget; output:\n${output}`);
    }
    return { failure: { code, output: `${output}\nprocess signal: ${signal ?? 'none'}` } };
  }

  try {
    const response = await fetch(`${origin}/en/no-such-page`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    await response.body?.cancel();
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    await stopDirect(child, closed);
    throw new Error(`Legacy direct Vite spawn did not serve ${origin}/en/no-such-page: ${String(error)}\n${output}`);
  }

  return {
    server: {
      origin,
      output: () => output,
      stop: () => stopDirect(child, closed),
    },
  };
}

async function stopDirect(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), 10_000);
      }),
    ]);
    clearTimeout(timer);
    if (!stopped && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  await closed;
}

function configuredPersistencePath(output: string, fallback: string): string {
  const line = output.match(/\[worker-persistence\]\s+app=web\s+effective=(\S+)/);
  return line?.[1] ?? fallback;
}

function ownedRuntimeRoot(effectivePath: string): string {
  return dirname(effectivePath);
}

function callerCookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));
  if (!value) throw new Error(`Expected ${name} in Set-Cookie; got ${response.status}`);
  return value.split(';', 1)[0]!;
}

async function createSession(origin: string, issuer: LocalIssuer): Promise<string> {
  const start = await fetch(`${origin}/auth/sign-in?return_to=%2Fen`, { redirect: 'manual' });
  if (start.status !== 302) throw new Error(`Web sign-in start returned ${start.status}: ${await start.text()}`);
  const authorization = new URL(start.headers.get('location')!);
  const state = authorization.searchParams.get('state');
  const nonce = authorization.searchParams.get('nonce');
  if (!state || !nonce) throw new Error(`Web sign-in did not create OIDC state and nonce: ${authorization.href}`);
  const code = `code-${crypto.randomUUID()}`;
  issuer.addCode(code, nonce);
  const callback = new URL('/auth/callback', origin);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', state);
  const completed = await fetch(callback, {
    headers: { cookie: callerCookie(start, loginCookieName) },
    redirect: 'manual',
  });
  if (completed.status !== 303)
    throw new Error(`Web OIDC callback returned ${completed.status}: ${await completed.text()}`);
  return callerCookie(completed, sessionCookieName);
}

async function sessionCsrfToken(origin: string, cookie: string): Promise<string | null> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const separator = cookie.indexOf('=');
    await context.addCookies([
      {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        domain: new URL(origin).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    await page.goto(`${origin}/en/no-such-page`, { waitUntil: 'networkidle' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    await waitForPersonalRead(page, ['session']);
    const menu = await openAccountMenu(page);
    const token = menu.locator('form[action="/auth/sign-out"] input[name="csrf_token"]');
    return (await token.count()) === 0 ? null : await token.inputValue();
  } finally {
    await browser.close();
  }
}

type LocalIssuer = {
  issuer: string;
  clientKey: string;
  addCode(code: string, nonce: string): void;
  stop(): void;
};

async function localIssuer(): Promise<LocalIssuer> {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'persistence-test-issuer', use: 'sig' };
  const client = await generateKeyPair('ES256', { extractable: true });
  const clientJwk = {
    ...(await exportJWK(client.privateKey)),
    alg: 'ES256',
    kid: 'persistence-test-client',
    use: 'sig',
  };
  const nonces = new Map<string, string>();
  let issuer = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/auth/.well-known/openid-configuration')
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/revoke`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['ES256'],
          token_endpoint_auth_methods_supported: ['private_key_jwt'],
          token_endpoint_auth_signing_alg_values_supported: ['ES256'],
        });
      if (url.pathname === '/auth/jwks') return Response.json({ keys: [jwk] });
      if (url.pathname === '/auth/revoke' && request.method === 'POST') return new Response(null, { status: 200 });
      if (url.pathname === '/auth/token' && request.method === 'POST') {
        const form = new URLSearchParams(await request.text());
        const code = form.get('code') ?? '';
        const nonce = nonces.get(code);
        nonces.delete(code);
        if (form.get('grant_type') !== 'authorization_code' || !nonce)
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const idToken = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
          .setIssuer(issuer)
          .setSubject('persistence-owner')
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(keys.privateKey);
        return Response.json({
          access_token: `access-${code}`,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `refresh-${code}`,
          id_token: idToken,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });
  issuer = `${server.url.origin}/auth`;
  return {
    issuer,
    clientKey: JSON.stringify({ ...clientJwk, d: (await exportJWK(client.privateKey)).d }),
    addCode(code, nonce) {
      nonces.set(code, nonce);
    },
    stop() {
      server.stop(true);
    },
  };
}

const persistenceEnvironment = (issuer: LocalIssuer) => ({
  AUTH_ISSUER: issuer.issuer,
  API_RESOURCE: 'https://api.rezics.test',
  WEBSITE_CLIENT_ID: clientId,
  WEBSITE_CLIENT_KEY: issuer.clientKey,
  WEBSITE_SCOPES: 'media:read',
  PUBLIC_ORIGIN: 'https://rezics.com',
});

function snapshotEnvironment(names: string[]): () => void {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test('isolates concurrent shared-helper and legacy Vite Worker state, sessions, and cleanup', async () => {
  const outerRoot = mkdtempSync(join(tmpdir(), 'rezics-web-shared-test-root-'));
  const callerMarker = join(outerRoot, 'caller-state.txt');
  writeFileSync(callerMarker, sharedRootMarker);
  const previous = snapshotEnvironment([
    'WEB_TEST_STATE_DIR',
    'WEB_TEST_STATE_INSTANCE_DIR',
    'AUTH_TEST_STATE_INSTANCE_DIR',
    'REZICS_TEST_RUNTIME',
    'REZICS_TEST_PERSISTENCE_DIAGNOSTICS',
    'AUTH_ISSUER',
    'API_RESOURCE',
    'WEBSITE_CLIENT_ID',
    'WEBSITE_CLIENT_KEY',
    'WEBSITE_SCOPES',
    'PUBLIC_ORIGIN',
    'WORKER_INSPECTOR_PORT',
  ]);
  const issuer = await localIssuer();
  let helper: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let aborted: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let legacy: DirectServer | undefined;
  let helperPath: string | undefined;
  let abortedPath: string | undefined;
  let legacyPath: string | undefined;
  try {
    delete process.env.WEB_TEST_STATE_INSTANCE_DIR;
    delete process.env.AUTH_TEST_STATE_INSTANCE_DIR;
    Object.assign(process.env, persistenceEnvironment(issuer), {
      WEB_TEST_STATE_DIR: outerRoot,
      REZICS_TEST_RUNTIME: '1',
      REZICS_TEST_PERSISTENCE_DIAGNOSTICS: '1',
    });
    const directPort = await freePort();
    const [helperStart, legacyStart] = await Promise.allSettled([
      startDevServer({
        firstPath: '/en/no-such-page',
        warmUpPaths: [],
        env: { WORKER_INSPECTOR_PORT: String(await freePort()) },
      }),
      directVite(directPort, await freePort()),
    ]);
    if (helperStart.status === 'fulfilled') helper = helperStart.value;
    else
      throw new Error(
        `Shared helper runtime failed with outer state root ${outerRoot}; prior effective path was ${resolve(outerRoot, 'v3')}: ${String(helperStart.reason)}`,
      );
    if (legacyStart.status === 'rejected') throw legacyStart.reason;
    if ('failure' in legacyStart.value)
      throw new Error(
        `Legacy direct Vite runtime failed with outer state root ${outerRoot}; prior effective path was ${resolve(outerRoot, 'v3')}:\n${legacyStart.value.failure.output}`,
      );
    legacy = legacyStart.value.server;

    const previousEffectivePath = resolve(outerRoot, 'v3');
    helperPath = configuredPersistencePath(helper.diagnostics(), previousEffectivePath);
    legacyPath = configuredPersistencePath(legacy.output(), previousEffectivePath);
    expect(
      helperPath,
      `shared-helper Vite runtime and legacy direct Vite runtime both resolved persistState to ${helperPath}`,
    ).not.toBe(legacyPath);
    for (const path of [helperPath, legacyPath]) {
      expect(path).toStartWith(resolve(tmpdir()) + '/');
      expect(basename(dirname(path))).toStartWith('rezics-web-worker-');
      expect(existsSync(path), `effective SQLite directory ${path}`).toBe(true);
    }
    expect(`${helper.diagnostics()}\n${legacy.output()}`).not.toMatch(/SQLITE_BUSY|ERR_RUNTIME_FAILURE/u);

    const abortController = new AbortController();
    aborted = await startDevServer({
      firstPath: '/en/no-such-page',
      warmUpPaths: [],
      signal: abortController.signal,
      env: { WORKER_INSPECTOR_PORT: String(await freePort()) },
    });
    abortedPath = configuredPersistencePath(aborted.diagnostics(), previousEffectivePath);
    expect([helperPath, legacyPath]).not.toContain(abortedPath);
    abortController.abort();
    await aborted.stop();
    aborted = undefined;
    expect(existsSync(dirname(abortedPath))).toBe(false);
    expect(existsSync(dirname(helperPath))).toBe(true);
    expect(existsSync(dirname(legacyPath))).toBe(true);

    const [helperCookie, legacyCookie] = await Promise.all([
      createSession(helper.origin, issuer),
      createSession(legacy.origin, issuer),
    ]);
    const [helperToken, legacyToken] = await Promise.all([
      sessionCsrfToken(helper.origin, helperCookie),
      sessionCsrfToken(legacy.origin, legacyCookie),
    ]);
    expect(helperToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(legacyToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await sessionCsrfToken(helper.origin, legacyCookie)).toBeNull();
    expect(await sessionCsrfToken(legacy.origin, helperCookie)).toBeNull();

    await legacy.stop();
    legacy = undefined;
    expect(existsSync(dirname(legacyPath))).toBe(false);
    expect(existsSync(dirname(helperPath))).toBe(true);
    expect(await sessionCsrfToken(helper.origin, helperCookie)).toBe(helperToken);
    expect(existsSync(callerMarker)).toBe(true);
    expect(await Bun.file(callerMarker).text()).toBe(sharedRootMarker);
  } finally {
    await aborted?.stop();
    await legacy?.stop();
    await helper?.stop();
    issuer.stop();
    previous();
    rmSync(outerRoot, { recursive: true, force: true });
  }
}, 300_000);

test('preserves caller-owned session state across a sequential Vite restart and cleans startup failures', async () => {
  const outerRoot = mkdtempSync(join(tmpdir(), 'rezics-web-restart-test-root-'));
  const explicitState = mkdtempSync(join(tmpdir(), 'rezics-web-retained-session-'));
  const callerMarker = join(explicitState, 'keep-this-file');
  writeFileSync(callerMarker, 'retained across one logical runtime restart');
  const previous = snapshotEnvironment([
    'WEB_TEST_STATE_DIR',
    'WEB_TEST_STATE_INSTANCE_DIR',
    'AUTH_TEST_STATE_INSTANCE_DIR',
    'REZICS_TEST_RUNTIME',
    'REZICS_TEST_PERSISTENCE_DIAGNOSTICS',
    'AUTH_ISSUER',
    'API_RESOURCE',
    'WEBSITE_CLIENT_ID',
    'WEBSITE_CLIENT_KEY',
    'WEBSITE_SCOPES',
    'PUBLIC_ORIGIN',
    'WORKER_INSPECTOR_PORT',
  ]);
  const issuer = await localIssuer();
  const serverOptions = {
    firstPath: '/en/no-such-page',
    warmUpPaths: [] as const,
    env: { ...persistenceEnvironment(issuer), WEB_TEST_STATE_DIR: explicitState },
  };
  let first: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let restarted: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    delete process.env.WEB_TEST_STATE_INSTANCE_DIR;
    delete process.env.AUTH_TEST_STATE_INSTANCE_DIR;
    Object.assign(process.env, {
      WEB_TEST_STATE_DIR: outerRoot,
      REZICS_TEST_RUNTIME: '1',
      REZICS_TEST_PERSISTENCE_DIAGNOSTICS: '1',
    });
    first = await startDevServer({
      ...serverOptions,
      env: { ...serverOptions.env, WORKER_INSPECTOR_PORT: String(await freePort()) },
    });
    const firstPath = configuredPersistencePath(first.diagnostics(), resolve(explicitState, 'v3'));
    expect(firstPath).toBe(resolve(explicitState, 'v3'));
    const cookie = await createSession(first.origin, issuer);
    const tokenBefore = await sessionCsrfToken(first.origin, cookie);
    expect(tokenBefore).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await first.stop();
    first = undefined;
    expect(existsSync(explicitState)).toBe(true);
    expect(await Bun.file(callerMarker).text()).toBe('retained across one logical runtime restart');

    restarted = await startDevServer({
      ...serverOptions,
      env: { ...serverOptions.env, WORKER_INSPECTOR_PORT: String(await freePort()) },
    });
    expect(configuredPersistencePath(restarted.diagnostics(), resolve(explicitState, 'v3'))).toBe(firstPath);
    expect(await sessionCsrfToken(restarted.origin, cookie)).toBe(tokenBefore);
    await restarted.stop();
    restarted = undefined;
    expect(existsSync(explicitState)).toBe(true);
    expect(await Bun.file(callerMarker).text()).toBe('retained across one logical runtime restart');

    const occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
    const failed = await directVite(occupied.port, await freePort());
    occupied.stop(true);
    if (!('failure' in failed)) {
      await failed.server.stop();
      throw new Error('Strict-port startup unexpectedly succeeded while the port was occupied');
    }
    const failedPath = configuredPersistencePath(failed.failure.output, resolve(outerRoot, 'v3'));
    const failedRoot = dirname(failedPath);
    expect(failedPath).not.toBe(resolve(outerRoot, 'v3'));
    expect(basename(failedRoot)).toStartWith('rezics-web-worker-');
    expect(existsSync(failedRoot), `startup-failed Worker state ${failedRoot}`).toBe(false);
    expect(existsSync(callerMarker)).toBe(true);
    expect(await Bun.file(callerMarker).text()).toBe('retained across one logical runtime restart');
  } finally {
    await restarted?.stop();
    await first?.stop();
    issuer.stop();
    previous();
    rmSync(explicitState, { recursive: true, force: true });
    rmSync(outerRoot, { recursive: true, force: true });
  }
}, 300_000);
