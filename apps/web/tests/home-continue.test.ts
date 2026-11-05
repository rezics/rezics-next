import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { cleanupAll, ownNodeProcess, withCleanup, type ProcessCustody } from './support/server-custody.ts';
import { waitForPersonalRead } from './session-token';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['library_entry:list', 'library_entry:read', 'library_entry:update', 'library_entry:delete'];
const locales = ['en', 'ja'] as const;

// The website client's key, which only the Worker holds, and the issuer's signing key.
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = {
  ...(await exportJWK(clientKeys.privateKey)),
  alg: 'ES256',
  kid: 'website-1',
};
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = {
  ...(await exportJWK(issuerKeys.publicKey)),
  alg: 'ES256',
  kid: 'issuer-1',
  use: 'sig',
};

type Grant = {
  challenge: string;
  nonce: string;
  redirectUri: string;
  scope: string;
  sub: string;
  expiresIn: number;
  idNonce?: string;
};
type Family = {
  sub: string;
  current: string;
  expiresIn: number;
  revoked: boolean;
};
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const accessTokens: string[] = [];
let counter = 0;

const json = (body: unknown, status = 200, problem = false) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(problem ? { 'content-type': 'application/problem+json' } : {}),
    },
  });

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
type EntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
type Entry = {
  subjectId: string;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  subject: { id: string; label: string; type: string };
};
const stampAt = (minute: number) => new Date(Date.UTC(2026, 3, 2, 0, minute)).toISOString();
function entry(n: number, state: EntryState, minute: number, label: string): Entry {
  const updatedAt = stampAt(minute);
  return {
    subjectId: id(n),
    state,
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
    subject: { id: id(n), label, type: 'book' },
  };
}
// Stored out of order: the home page relies on the kernel's most-recently-updated-first order, not its own.
function showcase(): Entry[] {
  return [
    entry(21, 'in_progress', 10, 'Middle read'),
    entry(22, 'planned', 50, 'Only planned'),
    entry(23, 'in_progress', 30, 'Newest read'),
    entry(24, 'completed', 40, 'Already finished'),
    entry(25, 'in_progress', 20, 'Older read'),
  ];
}
function crowded(): Entry[] {
  return Array.from({ length: 9 }, (_, index) => entry(100 + index, 'in_progress', index + 1, `Crowded ${index + 1}`));
}

let entries = showcase();
let failContinue = false;
let continueOperationExposed = true;
type Call = {
  method: string;
  path: string;
  view: string | null;
  limit: string | null;
  state: string | null;
  authorization: string | null;
};
const calls: Call[] = [];
const browserReads: { method: string; path: string }[] = [];
const headerReads: { method: string; path: string }[] = [];
const pageFake = createFakeKernelFetch(fixtures as never);

function problem(status: number, code: string) {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: 'not_applicable',
    request_id: randomUUID(),
  };
}
function reset(next = showcase()) {
  calls.length = 0;
  browserReads.length = 0;
  entries = next;
  failContinue = false;
  continueOperationExposed = true;
  headerReads.length = 0;
}

// OpenID provider copied from library-entries.test.ts; the home page sends the website's access token.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure')
      return json({
        admitted: [
          'personal_library',
          'reading_progress',
          ...(continueOperationExposed ? ['library_continue.list'] : []),
        ],
      });
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const client = async (form: URLSearchParams) => {
      if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return false;
      try {
        // Auth's contract: the registered kid, iss = sub = the client, aud exactly the issuer, at most 120 seconds.
        const { payload, protectedHeader } = await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        if (
          protectedHeader.kid !== clientJwk.kid ||
          payload.aud !== issuer ||
          !payload.jti ||
          assertions.has(payload.jti) ||
          !payload.exp ||
          !payload.iat ||
          payload.exp - payload.iat > 120
        )
          return false;
        assertions.add(payload.jti);
        return true;
      } catch {
        return false;
      }
    };
    const issue = async (family: Family, nonce?: string) => {
      counter += 1;
      const access = `access-${counter}`;
      const refresh = `refresh-${counter}`;
      family.current = refresh;
      families.set(refresh, family);
      accessTokens.push(access);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (nonce !== undefined) {
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(family.sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      }
      return json(body);
    };

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await client(form))) return json({ error: 'invalid_client' }, 401);
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        return issue(
          {
            sub: grant.sub,
            current: '',
            expiresIn: grant.expiresIn,
            revoked: false,
          },
          grant.idNonce ?? grant.nonce,
        );
      }
      if (form.get('grant_type') === 'refresh_token') {
        const family = families.get(form.get('refresh_token') ?? '');
        if (!family || family.revoked || family.current !== form.get('refresh_token')) {
          if (family) family.revoked = true;
          return json({ error: 'invalid_grant' }, 400);
        }
        return issue(family);
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await client(form))) return json({ error: 'invalid_client' }, 401);
      const family = families.get(form.get('token') ?? '');
      if (family) family.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') {
      const input = (await request.clone().json()) as { reads?: Record<string, { kind: string; id: string }> };
      if (input.reads) {
        browserReads.push({ method: request.method, path: url.pathname });
        headerReads.push({ method: request.method, path: url.pathname });
        const reads = Object.fromEntries(
          Object.entries(input.reads).map(([key, descriptor]) => {
            const item = entries.find((candidate) => candidate.subjectId === descriptor.id);
            return [key, item ? { status: 200, body: { subject: item.subject } } : { status: 404 }];
          }),
        );
        return json({ reads });
      }
      browserReads.push({ method: request.method, path: url.pathname });
      return pageFake(request);
    }
    if (request.method === 'GET' && url.pathname === '/v1/progressSessions') {
      browserReads.push({ method: request.method, path: url.pathname });
      return json({ progressSessions: [], next: null });
    }
    if (request.method === 'GET' && url.pathname === '/v1/libraryEntries') {
      browserReads.push({ method: request.method, path: url.pathname });
      calls.push({
        method: request.method,
        path: url.pathname,
        view: url.searchParams.get('view'),
        limit: url.searchParams.get('limit'),
        state: url.searchParams.get('state'),
        authorization: request.headers.get('authorization'),
      });
      const listed = entries.filter((item) => item.state === 'in_progress').slice(0, 6);
      return json({ libraryEntries: listed, next: null });
    }
    if (url.pathname !== '/v1/libraryContinue' || request.method !== 'GET')
      return json(problem(404, 'not_found'), 404, true);
    browserReads.push({ method: request.method, path: url.pathname });
    calls.push({
      method: request.method,
      path: url.pathname,
      view: null,
      limit: url.searchParams.get('limit'),
      state: null,
      authorization: request.headers.get('authorization'),
    });
    if (!request.headers.get('authorization')?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (failContinue) return json(problem(503, 'service_unavailable'), 503, true);
    const rawLimit = Number(url.searchParams.get('limit') ?? 20);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
    const listed = entries
      .filter((item) => item.state === 'in_progress')
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
      .slice(0, limit);
    return json({
      subjects: listed.map((item) => ({
        subjectId: item.subjectId,
        state: item.state,
        lastActivityAt: item.updatedAt,
        activeProgressSession: null,
      })),
      next: null,
    });
  },
});

class SuiteRetiredError extends Error {
  constructor(label: string) {
    super(`${label} stopped because Home Continue suite teardown started`);
    this.name = 'SuiteRetiredError';
  }
}

type PendingSuiteOperation = { label: string; settled: Promise<void> };
type LateSuiteResource = { label: string; close: () => Promise<void> };
type SuiteCleanupAction = Parameters<typeof cleanupAll>[0][number];

class SuiteLifetime {
  private retiring = false;
  private cleanupFinished = false;
  private readonly pending = new Set<PendingSuiteOperation>();
  private readonly lateResources = new Set<LateSuiteResource>();
  private readonly lateFailures: unknown[] = [];
  private readonly retainedCleanups = new Set<SuiteCleanupAction>();

  get retired() {
    return this.retiring;
  }

  retire() {
    this.retiring = true;
  }

  assertActive(label: string) {
    if (this.retiring) throw new SuiteRetiredError(label);
  }

  run<T>(label: string, operation: () => T | PromiseLike<T>): Promise<T> {
    return this.observe(label, operation);
  }

  acquire<T>(
    label: string,
    acquire: () => T | PromiseLike<T>,
    adopt: (resource: T) => void,
    close: (resource: T) => Promise<void>,
  ): Promise<T> {
    return this.observe(label, acquire, adopt, (resource) => this.closeLate(label, resource, close));
  }

  retainCleanup(label: string, close: () => Promise<void>, timeoutMs = 5000) {
    let action: SuiteCleanupAction;
    let closing: Promise<void> | undefined;
    action = {
      label,
      timeoutMs,
      run: () => {
        closing ??= Promise.resolve()
          .then(close)
          .then(() => {
            this.retainedCleanups.delete(action);
          });
        return closing;
      },
    };
    this.retainedCleanups.add(action);
    return () => this.retainedCleanups.delete(action);
  }

  cleanupActions(): SuiteCleanupAction[] {
    return [...this.retainedCleanups];
  }

  private observe<T>(
    label: string,
    start: () => T | PromiseLike<T>,
    adopt?: (resource: T) => void,
    closeLate?: (resource: T) => Promise<void>,
  ): Promise<T> {
    this.assertActive(label);
    const record: PendingSuiteOperation = { label, settled: Promise.resolve() };
    this.pending.add(record);
    const observed = Promise.resolve()
      .then(() => {
        this.assertActive(label);
        return start();
      })
      .then(async (resource) => {
        if (this.retiring) {
          if (closeLate) await closeLate(resource);
          throw new SuiteRetiredError(label);
        }
        adopt?.(resource);
        return resource;
      });
    record.settled = observed.then(
      () => {
        this.pending.delete(record);
      },
      (error) => {
        this.pending.delete(record);
        if (this.retiring && !(error instanceof SuiteRetiredError)) this.recordLateFailure(label, error);
      },
    );
    void observed.catch(() => {});
    return observed;
  }

  private async closeLate<T>(label: string, resource: T, close: (resource: T) => Promise<void>) {
    const retained: LateSuiteResource = { label, close: () => close(resource) };
    this.lateResources.add(retained);
    try {
      await cleanupAll([{ label: `Home Continue late ${label}`, run: retained.close, timeoutMs: 5000 }]);
      this.lateResources.delete(retained);
    } catch (error) {
      throw new Error(`Home Continue late ${label} cleanup failed`, { cause: error });
    }
  }

  async settlePending() {
    await Promise.all([...this.pending].map(({ settled }) => settled));
    if (this.lateFailures.length > 0)
      throw new AggregateError(this.lateFailures, 'Home Continue late setup or acquisition failed');
    if (this.lateResources.size > 0)
      throw new AggregateError(
        [...this.lateResources].map(({ label }) => new Error(`Home Continue still owns late ${label}`)),
        'Home Continue late resources remain unsettled',
      );
    if (this.retainedCleanups.size > 0)
      throw new AggregateError(
        [...this.retainedCleanups].map(({ label }) => new Error(`Home Continue still owns ${label}`)),
        'Home Continue retained cleanup remains unsettled',
      );
  }

  pendingDiagnostics() {
    return [
      ...[...this.pending].map(({ label }) => `pending ${label}`),
      ...[...this.lateResources].map(({ label }) => `late ${label}`),
      ...[...this.retainedCleanups].map(({ label }) => `retained ${label}`),
    ].join('; ');
  }

  finishCleanup() {
    this.cleanupFinished = true;
  }

  private recordLateFailure(label: string, error: unknown) {
    const failure = new Error(`Home Continue ${label} failed after teardown began`, { cause: error });
    this.lateFailures.push(failure);
    if (this.cleanupFinished) console.error(failure);
  }
}

const suiteLifetime = new SuiteLifetime();

function retireSuite(lifetime: SuiteLifetime, label: string, actions: Parameters<typeof cleanupAll>[0]) {
  lifetime.retire();
  return cleanupAll([
    ...lifetime.cleanupActions(),
    ...actions,
    { label: `${label} pending startup and setup`, run: () => lifetime.settlePending(), timeoutMs: 8000 },
  ])
    .catch((error) => {
      const pending = lifetime.pendingDiagnostics();
      if (!pending) throw error;
      throw new AggregateError(
        [error, new Error(`${label} retained resources remain: ${pending}`)],
        `${label} cleanup did not settle`,
      );
    })
    .finally(() => lifetime.finishCleanup());
}

function startWithPort<T>(
  lifetime: SuiteLifetime,
  label: string,
  getPort: () => Promise<number>,
  launch: (port: number) => T | PromiseLike<T>,
): Promise<T> {
  return lifetime.run(label, async () => {
    const port = await getPort();
    lifetime.assertActive(`${label} launch after port resolution`);
    return launch(port);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function freePort(lifetime: SuiteLifetime, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    let closePromise: Promise<void> | undefined;
    const closeListeningProbe = () =>
      new Promise<void>((complete, fail) => {
        probe.close((error) => (error ? fail(error) : complete()));
      });
    const closeProbe = () => {
      if (closePromise) return closePromise;
      if (probe.listening) {
        closePromise = closeListeningProbe();
        return closePromise;
      }
      closePromise = new Promise<void>((complete, fail) => {
        const onListening = () => {
          probe.off('error', onError);
          void closeListeningProbe().then(complete, fail);
        };
        const onError = () => {
          probe.off('listening', onListening);
          complete();
        };
        probe.once('listening', onListening);
        probe.once('error', onError);
      });
      return closePromise;
    };
    const release = lifetime.retainCleanup(`${label} port probe`, closeProbe);
    probe.once('error', (error) => {
      release();
      reject(error);
    });
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      void closeProbe().then(() => {
        release();
        resolve(port);
      }, reject);
    });
  });
}

let child: ChildProcess | undefined;
let serverCustody: ProcessCustody | undefined;
let started: Promise<string> | undefined;
const browsers = new Set<Browser>();
const contexts = new Set<BrowserContext>();
const browserClosures = new WeakMap<Browser, Promise<void>>();
const contextClosures = new WeakMap<BrowserContext, Promise<void>>();

function closeBrowser(browser: Browser): Promise<void> {
  const existing = browserClosures.get(browser);
  if (existing) return existing;
  const closing = cleanupAll([{ label: 'Home Continue browser', run: () => browser.close(), timeoutMs: 5000 }]).then(
    () => {
      browsers.delete(browser);
    },
  );
  browserClosures.set(browser, closing);
  return closing;
}

function closeContext(context: BrowserContext): Promise<void> {
  const existing = contextClosures.get(context);
  if (existing) return existing;
  const closing = cleanupAll([
    { label: 'Home Continue browser context', run: () => context.close(), timeoutMs: 5000 },
  ]).then(() => {
    contexts.delete(context);
  });
  contextClosures.set(context, closing);
  return closing;
}

// The documented command, pointed at the fake through the environment it reads in development.
function site(): Promise<string> {
  started ??= startWithPort(
    suiteLifetime,
    'Home Continue Vite startup',
    () => freePort(suiteLifetime, 'Home Continue Vite startup'),
    async (port) => {
      suiteLifetime.assertActive('Home Continue Vite spawn');
      child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: app,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          KERNEL_ORIGIN: fake.url.origin,
          AUTH_ISSUER: `${fake.url.origin}/auth`,
          WEBSITE_CLIENT_ID: clientId,
          WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
          API_RESOURCE: resource,
          WEBSITE_SCOPES: scopes.join(' '),
        },
      });
      const custody = (serverCustody = ownNodeProcess(child, {
        label: 'Home Continue Vite server',
        outputLimit: 8000,
      }));
      let spawnError: Error | undefined;
      child.once('error', (error) => {
        spawnError = error;
      });
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 150_000;
      try {
        for (;;) {
          suiteLifetime.assertActive('Home Continue Vite readiness');
          if (spawnError)
            throw new Error(
              `dev server failed to spawn: ${spawnError.message}\nCaptured output:\n${custody.diagnostics()}`,
              {
                cause: spawnError,
              },
            );
          const exit = child.exitCode ?? child.signalCode;
          if (exit !== null) throw new Error(`dev server exited with ${exit}:\n${custody.diagnostics()}`);
          try {
            const response = await fetch(`${origin}/en`, {
              redirect: 'manual',
              signal: AbortSignal.timeout(60_000),
            });
            suiteLifetime.assertActive('Home Continue Vite readiness after response');
            if (response.status < 500) return origin;
          } catch (error) {
            if (suiteLifetime.retired) throw error;
            // The dev server is still starting.
          }
          if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${custody.diagnostics()}`);
          await Bun.sleep(500);
          suiteLifetime.assertActive('Home Continue Vite readiness after delay');
        }
      } catch (error) {
        return await withCleanup(async () => {
          throw error;
        }, [{ label: 'Home Continue Vite startup', run: () => custody.close(), timeoutMs: 7000 }]);
      }
    },
  );
  return started;
}

function launchBrowser(): Promise<Browser> {
  suiteLifetime.assertActive('Home Continue browser launch');
  return suiteLifetime.acquire(
    'Home Continue browser launch',
    () => chromium.launch(),
    (browser) => browsers.add(browser),
    closeBrowser,
  );
}

function createContext(browser: Browser, options: Parameters<Browser['newContext']>[0], label: string) {
  return suiteLifetime.acquire(
    label,
    () => browser.newContext(options),
    (context) => contexts.add(context),
    closeContext,
  );
}

const setCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) =>
  setCookie(response, name)
    ?.split(';')[0]
    ?.slice(name.length + 1);

// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the session cookie.
async function signIn(returnTo = '/en', grant: Partial<Grant> = {}) {
  return suiteLifetime.run('Home Continue sign-in setup', async () => {
    const origin = await site();
    suiteLifetime.assertActive('Home Continue sign-in request');
    const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, {
      redirect: 'manual',
    });
    suiteLifetime.assertActive('Home Continue sign-in response');
    const location = new URL(start.headers.get('location')!);
    const params = location.searchParams;
    const code = `code-${randomUUID()}`;
    codes.set(code, {
      challenge: params.get('code_challenge')!,
      nonce: params.get('nonce')!,
      redirectUri: params.get('redirect_uri')!,
      scope: params.get('scope')!,
      sub: 'alice',
      expiresIn: 3600,
      ...grant,
    });
    const loginCookie = cookieValue(start, login);
    const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
      redirect: 'manual',
      headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
    });
    suiteLifetime.assertActive('Home Continue OpenID callback response');
    expect([302, 303], 'OpenID callback setup').toContain(answer.status);
    const sessionCookie = cookieValue(answer, session);
    expect(sessionCookie, 'signed-in session setup').toBeTruthy();
    return sessionCookie!;
  });
}

let aliceCookie: Promise<string> | undefined;
const alice = async () => {
  suiteLifetime.assertActive('Home Continue shared sign-in');
  aliceCookie ??= signIn('/en', { sub: 'alice' });
  return aliceCookie;
};

async function readPage(path: string, cookie?: string) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  return suiteLifetime.run('Home Continue page setup', async () =>
    withCleanup(async () => {
      const origin = await site();
      suiteLifetime.assertActive('Home Continue page browser launch');
      browser = await launchBrowser();
      suiteLifetime.assertActive('Home Continue page context setup');
      context = await createContext(browser, {}, 'Home Continue page context acquisition');
      suiteLifetime.assertActive('Home Continue page context acquisition completion');
      if (cookie) {
        await context.addCookies([
          { name: session, value: cookie, domain: new URL(origin).hostname, path: '/', secure: true, httpOnly: true },
        ]);
        suiteLifetime.assertActive('Home Continue page cookie setup');
      }
      const page = await context.newPage();
      suiteLifetime.assertActive('Home Continue page creation');
      const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      suiteLifetime.assertActive('Home Continue page navigation');
      await page.locator('[data-session-slot]').waitFor();
      suiteLifetime.assertActive('Home Continue session readiness');
      if (cookie) await waitForPersonalRead(page, ['home-continue', path.split('/')[1]!]);
      suiteLifetime.assertActive('Home Continue personal readiness');
      await page.waitForLoadState('networkidle');
      suiteLifetime.assertActive('Home Continue final network readiness');
      const html = await page.content();
      suiteLifetime.assertActive('Home Continue page snapshot');
      return { status: response!.status(), html };
    }, [
      {
        label: 'Home Continue page context',
        run: () => (context ? closeContext(context) : undefined),
        timeoutMs: 6000,
      },
      {
        label: 'Home Continue page browser',
        run: () => (browser ? closeBrowser(browser) : undefined),
        timeoutMs: 6000,
      },
    ]),
  );
}

async function inspectHome(path: string, cookie: string, width: number, openMenu = false) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  return suiteLifetime.run('Home Continue page inspection setup', async () =>
    withCleanup(async () => {
      const origin = await site();
      suiteLifetime.assertActive('Home Continue inspection browser launch');
      browser = await launchBrowser();
      suiteLifetime.assertActive('Home Continue inspection context setup');
      context = await createContext(
        browser,
        { viewport: { width, height: 844 }, hasTouch: false },
        'Home Continue inspection context acquisition',
      );
      suiteLifetime.assertActive('Home Continue inspection context acquisition completion');
      await context.addCookies([
        { name: session, value: cookie, domain: new URL(origin).hostname, path: '/', secure: true, httpOnly: true },
      ]);
      suiteLifetime.assertActive('Home Continue inspection cookie setup');
      const page = await context.newPage();
      suiteLifetime.assertActive('Home Continue inspection page creation');
      await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      suiteLifetime.assertActive('Home Continue inspection navigation');
      await waitForPersonalRead(page, ['home-continue', path.split('/')[1]!]);
      suiteLifetime.assertActive('Home Continue inspection personal readiness');
      await page.waitForLoadState('networkidle');
      suiteLifetime.assertActive('Home Continue inspection network readiness');
      if (openMenu) {
        await page.locator('[data-slot="cover-card-actions"] button').first().click();
        suiteLifetime.assertActive('Home Continue inspection menu action');
        await page.locator('[data-slot="drawer-content"]').waitFor();
        suiteLifetime.assertActive('Home Continue inspection drawer readiness');
      }
      const inspection = await page.evaluate(() => {
        const personal = document.querySelector<HTMLElement>('[data-slot="personal"]');
        const row = personal?.querySelector<HTMLElement>('[data-slot="cover-row"]');
        const cards = [...(personal?.querySelectorAll<HTMLElement>('[data-slot="cover-card"]') ?? [])];
        const next = personal?.nextElementSibling as HTMLElement | null;
        const bounds = (element: HTMLElement | null) => {
          const rect = element?.getBoundingClientRect();
          return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null;
        };
        const style = row ? getComputedStyle(row) : null;
        return {
          personalClass: personal?.className ?? '',
          personal: bounds(personal ?? null),
          next: bounds(next),
          row: row
            ? {
                clientWidth: row.clientWidth,
                scrollWidth: row.scrollWidth,
                snap: style?.scrollSnapType ?? '',
                bounds: bounds(row),
                cards: cards.map(bounds),
              }
            : null,
          cardCount: cards.length,
          titlesInCovers: cards.map((card) => card.querySelector('[data-slot="cover"]')?.textContent?.trim() ?? ''),
          captionCount: personal?.querySelectorAll('[data-slot="cover-caption"]').length ?? 0,
          progressCount: personal?.querySelectorAll('[data-slot="progress-row"]').length ?? 0,
          placeholderGlyphCount: [...(personal?.querySelectorAll('[data-slot="cover"]') ?? [])].filter((cover) =>
            cover.textContent?.includes('…'),
          ).length,
          drawerOpen: !!document.querySelector('[data-slot="drawer-content"]'),
          menuButtons: [...(personal?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])].map((button) =>
            button.getAttribute('aria-label'),
          ),
          controlVisibility: Object.fromEntries(
            [
              ...(personal?.querySelectorAll<HTMLButtonElement>(
                'button[aria-label="Next Continue items"], button[aria-label="Previous Continue items"]',
              ) ?? []),
            ].map((button) => [button.getAttribute('aria-label'), getComputedStyle(button).display !== 'none']),
          ),
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      suiteLifetime.assertActive('Home Continue inspection result');
      return inspection;
    }, [
      {
        label: 'Home Continue inspection context',
        run: () => (context ? closeContext(context) : undefined),
        timeoutMs: 6000,
      },
      {
        label: 'Home Continue inspection browser',
        run: () => (browser ? closeBrowser(browser) : undefined),
        timeoutMs: 6000,
      },
    ]),
  );
}
function main(html: string) {
  return /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
}
function linksIn(html: string) {
  const found: { href: string; text: string }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = /href="([^"]*)"/.exec(match[1] ?? '')?.[1]?.replaceAll('&amp;', '&');
    if (href) found.push({ href, text: match[2]!.replace(/<[^>]+>/g, '').trim() });
  }
  return found;
}
function personal(html: string): string | undefined {
  return /<section\b[^>]*data-slot="personal"[^>]*>([\s\S]*?)<\/section>/.exec(main(html))?.[1];
}
async function messageOf(locale: string, key: string): Promise<string> {
  const file = new URL(`../messages/${locale}.json`, import.meta.url);
  return ((await Bun.file(file).json()) as Record<string, string>)[key]!;
}
function continueReads() {
  return calls.filter((call) => call.method === 'GET' && call.path === '/v1/libraryContinue');
}

function readsTo(path: string) {
  return browserReads.filter((call) => call.path === path);
}

afterAll(() =>
  retireSuite(suiteLifetime, 'Home Continue', [
    ...[...contexts].map((context) => ({
      label: 'Home Continue browser context',
      run: () => closeContext(context),
      timeoutMs: 6000,
    })),
    ...[...browsers].map((browser) => ({
      label: 'Home Continue browser',
      run: () => closeBrowser(browser),
      timeoutMs: 6000,
    })),
    { label: 'Home Continue fake API and OIDC listener', run: () => fake.stop(true), timeoutMs: 5000 },
    { label: 'Home Continue Vite process group', run: () => serverCustody?.close(), timeoutMs: 7000 },
  ]),
);

test('Home Continue retirement fences late startup and closes late browser/context handles', async () => {
  const lifetime = new SuiteLifetime();
  const portStarted = deferred<void>();
  const pendingPort = deferred<number>();
  let viteLaunches = 0;
  const startup = startWithPort(
    lifetime,
    'fixture Vite startup',
    () => {
      portStarted.resolve();
      return pendingPort.promise;
    },
    async () => {
      viteLaunches += 1;
      return 'http://127.0.0.1:4173';
    },
  );
  await portStarted.promise;

  const browserStarted = deferred<void>();
  const pendingBrowser = deferred<{ name: string }>();
  let browserAdopted = false;
  let browserCloses = 0;
  const browser = lifetime.acquire(
    'fixture browser launch',
    () => {
      browserStarted.resolve();
      return pendingBrowser.promise;
    },
    () => {
      browserAdopted = true;
    },
    async () => {
      browserCloses += 1;
    },
  );
  await browserStarted.promise;

  const contextStarted = deferred<void>();
  const pendingContext = deferred<{ name: string }>();
  const resumeSetup = deferred<void>();
  const setupStarted = deferred<void>();
  let contextAdopted = 0;
  let contextClosed = 0;
  let setupContinued = false;
  const context = lifetime.acquire(
    'fixture page context acquisition',
    () => {
      contextStarted.resolve();
      return pendingContext.promise;
    },
    () => {
      contextAdopted += 1;
    },
    async () => {
      contextClosed += 1;
    },
  );
  const setup = lifetime.run('fixture page readiness', async () => {
    setupStarted.resolve();
    await resumeSetup.promise;
    lifetime.assertActive('fixture page navigation after retirement');
    setupContinued = true;
  });
  await Promise.all([contextStarted.promise, setupStarted.promise]);

  lifetime.retire();
  pendingPort.resolve(4173);
  pendingBrowser.resolve({ name: 'late browser' });
  pendingContext.resolve({ name: 'late context' });
  resumeSetup.resolve();
  await Promise.allSettled([startup, browser, context, setup]);
  await lifetime.settlePending();

  expect(viteLaunches).toBe(0);
  expect(browserAdopted).toBe(false);
  expect(browserCloses).toBe(1);
  expect(contextAdopted).toBe(0);
  expect(contextClosed).toBe(1);
  expect(setupContinued).toBe(false);
});

test(
  'a signed-in visitor with subjects in progress sees them on the home page, most recently updated first, each card linking to its progress',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const page = await readPage(`/${locale}`, cookie);
      expect(page.status).toBe(200);
      const row = personal(page.html);
      expect(row, `${locale} Continue row`).toBeDefined();
      expect(row).toMatch(new RegExp(`<h2\\b[^>]*>\\s*${await messageOf(locale, 'home_continue_heading')}\\s*</h2>`));
      // The row sits after the search box, and holds only entries in progress, newest first.
      const body = main(page.html);
      expect(body.indexOf('name="q"')).toBeLessThan(body.indexOf('data-slot="personal"'));
      // Cards keep titles in CoverCard and expose their subject destination only through the menu.
      expect([...(row ?? '').matchAll(/data-slot="cover-card"/g)]).toHaveLength(6);
      const hrefs = linksIn(row ?? '').map((link) => link.href);
      expect(hrefs).toHaveLength(6);
      expect(new Set(hrefs).size).toBe(3);
      expect(hrefs.every((href) => href.includes('/library/progress'))).toBe(true);
      expect(row).toContain('Newest read');
      expect(row).not.toContain('Only planned');
      expect(row).not.toContain('Already finished');
      // One read of the personal library, for entries in progress, up to six, with their subjects embedded.
      const reads = continueReads();
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({
        limit: '6',
      });
      expect(reads[0]!.authorization).toStartWith('Bearer ');
    }
    reset(crowded());
    const crowd = personal((await readPage('/en', cookie)).html) ?? '';
    expect([...crowd.matchAll(/data-slot="cover-card"/g)]).toHaveLength(12);
    expect(crowd).toContain('Crowded 9');
    expect(crowd).not.toContain('Crowded 3<');
  },
  timeout,
);

test(
  'fine pointer carousel controls follow the scroll position and the tile menu opens as a phone sheet',
  async () => {
    const cookie = await alice();
    reset(crowded());
    const view = await inspectHome('/en', cookie, 390, true);
    expect(view.drawerOpen).toBe(true);
    expect(view.menuButtons).toContain('Next Continue items');
    expect(view.menuButtons).toContain('Previous Continue items');
    expect(view.controlVisibility).toEqual({
      'Previous Continue items': false,
      'Next Continue items': true,
    });
  },
  timeout,
);

test(
  'Continue cards use the shared cover and progress row without an oversized empty slot',
  async () => {
    const cookie = await alice();
    reset();
    const view = await inspectHome('/en', cookie, 1280);
    expect(view.cardCount).toBe(6); // three cards for each responsive layout
    expect(view.titlesInCovers.every((title) => title === '')).toBe(true);
    expect(view.captionCount).toBe(0);
    expect(view.progressCount).toBe(6);
    expect(view.placeholderGlyphCount).toBe(0);
    expect(view.personalClass).not.toMatch(/min-h-/);
    expect(view.personal && view.next && view.next.top - view.personal.bottom).toBeLessThan(40);
  },
  timeout,
);

test(
  'at phone width Continue is a snapping sideways row with a partial next card and no page overflow',
  async () => {
    const cookie = await alice();
    reset(crowded());
    const view = await inspectHome('/en', cookie, 390);
    expect(view.row?.scrollWidth).toBeGreaterThan(view.row?.clientWidth ?? 0);
    expect(view.row?.snap).toContain('x mandatory');
    expect(view.row?.cards.some((card) => card && view.row && card.right > view.row.bounds.right)).toBe(true);
    expect(view.scrollWidth).toBeLessThanOrEqual(390);
  },
  timeout,
);

test(
  'a signed-out visitor, or one with nothing in progress, sees no Continue row and the home page makes no library read',
  async () => {
    reset();
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const out = await readPage(`/${locale}`);
      expect(out.status).toBe(200);
      expect(personal(out.html)).toBeUndefined();
      expect(out.html).not.toContain(await messageOf(locale, 'home_continue_heading'));
      expect(out.html).toContain('name="q"');
      expect(continueReads()).toHaveLength(0);

      reset(showcase().filter((item) => item.state !== 'in_progress'));
      const idle = await readPage(`/${locale}`, cookie);
      expect(idle.status).toBe(200);
      expect(personal(idle.html)).toBeUndefined();
      expect(idle.html).toContain('name="q"');
      expect(continueReads()).toHaveLength(1);
    }
  },
  timeout,
);

test(
  'when the library read fails, the home page still renders without the row',
  async () => {
    const cookie = await alice();
    reset();
    failContinue = true;
    const page = await readPage('/en', cookie);
    expect(continueReads()).toHaveLength(1);
    expect(page.status).toBe(200);
    expect(page.html).toContain('name="q"');
    expect(personal(page.html)).toBeUndefined();
    expect(page.html).not.toContain('Newest read');
  },
  timeout,
);

test(
  'when exposure does not list library_continue.list, home shows no Continue row and makes no library reads',
  async () => {
    const cookie = await alice();
    reset();
    continueOperationExposed = false;
    const page = await readPage('/en', cookie);
    expect(page.status).toBe(200);
    expect(personal(page.html)).toBeUndefined();
    expect(page.html).toContain('name="q"');
    expect(continueReads()).toHaveLength(0);
    expect(readsTo('/v1/libraryEntries')).toHaveLength(0);
    expect(readsTo('/v1/progressSessions')).toHaveLength(0);
  },
  timeout,
);

test(
  'a browser home render reads its public page once, then bounds signed-in Continue reads',
  async () => {
    await site();
    reset();
    const signedOut = await readPage('/en');
    expect(signedOut.status).toBe(200);
    expect(browserReads).toEqual([{ method: 'POST', path: '/v1/pages:read' }]);

    const cookie = await alice();
    reset(crowded());
    const signedIn = await readPage('/en', cookie);
    expect(signedIn.status).toBe(200);
    expect(readsTo('/v1/pages:read')).toHaveLength(2);
    expect(continueReads()).toHaveLength(1);
    expect(continueReads()[0]).toMatchObject({ limit: '6' });
    expect(headerReads).toHaveLength(1);
    expect(browserReads).toHaveLength(3);
  },
  timeout,
);
