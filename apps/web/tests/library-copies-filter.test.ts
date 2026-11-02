import { afterAll, expect, test as bunTest } from 'bun:test';
import { cleanupAll, ownNodeProcess, withCleanup, type ProcessCustody } from './support/server-custody.ts';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';

const app = join(import.meta.dir, '..');

let serverCustody: ProcessCustody | undefined;
let started: Promise<string> | undefined;
let serverStartupAbort: AbortController | undefined;
const pendingServerStartups = new Set<Promise<string>>();
let browser: Browser | undefined;
let browserLaunch: Promise<Browser> | undefined;
let browserClosing: Promise<void> | undefined;
let teardownStarted = false;
let cleanupPromise: Promise<void> | undefined;
const ownedContexts = new Set<BrowserContext>();
const pendingContextSetups = new Set<Promise<unknown>>();
const contextClosures = new WeakMap<BrowserContext, Promise<void>>();
const failedContextSetups = new WeakSet<BrowserContext>();

function ensureSiteStartupActive(output = '', cause?: unknown): void {
  if (teardownStarted) {
    const message = `dev server startup retired after suite teardown began${output ? `:\n${output}` : ''}`;
    if (cause !== undefined) throw new Error(message, { cause });
    throw new Error(message);
  }
}

function siteStartupRequestSignal(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const parentSignal = serverStartupAbort?.signal;
  const abort = () => controller.abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

type LifetimeTestOperation = () => unknown | PromiseLike<unknown>;

function test(name: string, operation: LifetimeTestOperation, timeoutMs?: number) {
  return bunTest(
    name,
    async () => {
      const contextsBefore = new Set(ownedContexts);
      let primary: unknown;
      let failed = false;
      try {
        await operation();
      } catch (error) {
        primary = error;
        failed = true;
      }
      const contexts = [...ownedContexts].filter(
        (context) => !contextsBefore.has(context) && !failedContextSetups.has(context),
      );
      const results = await Promise.allSettled(contexts.map(closeContextAttempt));
      const cleanupErrors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (failed && cleanupErrors.length > 0)
        throw new AggregateError([primary, ...cleanupErrors], `${name} and browser context cleanup both failed`, {
          cause: primary,
        });
      if (failed) throw primary;
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${name} browser context cleanup failed`);
    },
    timeoutMs,
  );
}

function closeContextAttempt(context: BrowserContext): Promise<void> {
  let closing = contextClosures.get(context);
  if (!closing) {
    closing = cleanupAll([{ label: 'browser context', run: () => context.close(), timeoutMs: 5000 }]);
    contextClosures.set(context, closing);
    void closing.catch(() => {});
  }
  return closing;
}

async function closeContext(context: BrowserContext): Promise<void> {
  // The owning test wrapper reports this cached failure together with its primary assertion failure.
  await closeContextAttempt(context).catch(() => {});
}

function closeBrowserHandle(instance: Browser): Promise<void> {
  browserClosing ??= cleanupAll([{ label: 'Playwright browser', run: () => instance.close(), timeoutMs: 5000 }]);
  void browserClosing.catch(() => {});
  return browserClosing;
}

function launchBrowser(): Promise<Browser> {
  if (teardownStarted) return Promise.reject(new Error('Browser launch requested after suite teardown began'));
  browserLaunch ??= chromium.launch().then(async (instance) => {
    browser = instance;
    if (teardownStarted) {
      await closeBrowserHandle(instance);
      throw new Error('Browser launch completed after suite teardown began');
    }
    return instance;
  });
  void browserLaunch.catch(() => {});
  return browserLaunch;
}

async function withBrowserContext<T>(
  options: BrowserContextOptions,
  prepare: (context: BrowserContext) => Promise<T>,
): Promise<{ context: BrowserContext; value: T }> {
  let context: BrowserContext | undefined;
  let complete = false;
  const operation = withCleanup(async () => {
    const instance = await launchBrowser();
    context = await instance.newContext(options);
    ownedContexts.add(context);
    if (teardownStarted) throw new Error('Browser context opened after suite teardown began');
    const value = await prepare(context);
    if (teardownStarted) throw new Error('Browser context setup completed after suite teardown began');
    complete = true;
    return { context, value };
  }, [
    {
      label: 'partial browser context setup',
      run: () => (complete || !context ? undefined : closeContextAttempt(context)),
      timeoutMs: 6000,
    },
  ]);
  pendingContextSetups.add(operation);
  try {
    return await operation;
  } catch (error) {
    if (context) failedContextSetups.add(context);
    throw error;
  } finally {
    pendingContextSetups.delete(operation);
  }
}

async function closeBrowser(): Promise<void> {
  let instance = browser;
  if (!instance && browserLaunch) {
    try {
      instance = await browserLaunch;
    } catch {
      instance = browser;
    }
  }
  if (instance) await closeBrowserHandle(instance);
}

function cleanupSuite(): Promise<void> {
  return (cleanupPromise ??= (async () => {
    teardownStarted = true;
    serverStartupAbort?.abort();
    const viteCustody = serverCustody;
    const contextActions = [...ownedContexts].map((context, index) => ({
      label: `browser context ${index + 1}`,
      run: () => closeContextAttempt(context),
      timeoutMs: 6000,
    }));
    const setupActions = [...pendingContextSetups].map((setup, index) => ({
      label: `pending browser context setup ${index + 1}`,
      run: () => setup,
      timeoutMs: 7000,
    }));
    const startupActions = [...pendingServerStartups].map((startup, index) => ({
      label: `pending Vite startup ${index + 1}`,
      run: () => startup,
      timeoutMs: 15_000,
    }));
    await withCleanup(
      () => cleanupAll([...contextActions, ...setupActions, ...startupActions]),
      [
        { label: 'Playwright browser', run: closeBrowser, timeoutMs: 7000 },
        { label: 'fake API listener', run: () => fake.stop(true), timeoutMs: 7000 },
        { label: 'Vite process group', run: () => viteCustody?.close(), timeoutMs: 8000 },
      ],
    );
  })());
}

const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['openid'];
const pageLimit = '100';

const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = {
  challenge: string;
  nonce: string;
  redirectUri: string;
  scope: string;
  sub: string;
  expiresIn: number;
  idNonce?: string;
};
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const accessSubjects = new Map<string, string>();
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
const edition = id(11);
const hiddenSubjectId = 'unavailable-subject-should-not-appear';
const newSubject = id(21);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type CopyStatus = 'ordered' | 'owned' | 'lent' | 'disposed';
type Subject = { id: string; label: string; type: string } | null;
type StoredCopy = {
  id: string;
  accountId: string;
  subjectId: string;
  subject: Subject;
  status: CopyStatus;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
};
type Draft = {
  subjectId?: string;
  status?: CopyStatus;
  location?: string | null;
  source?: string | null;
  acquiredOn?: string | null;
  disposedOn?: string | null;
  note?: string | null;
  revision?: number;
};

const zebra: Subject = { id: edition, label: 'Zebra story', type: 'book' };
const copies: StoredCopy[] = [];
let serial = 100;
function make(input: Omit<StoredCopy, 'id' | 'revision'> & { revision?: number }): StoredCopy {
  serial += 1;
  return { id: id(serial), revision: input.revision ?? 1, ...input };
}
function seedDefault() {
  copies.length = 0;
  serial = 100;
  copies.push(
    make({
      accountId: 'alice',
      subjectId: edition,
      subject: zebra,
      status: 'owned',
      location: 'Study',
      source: 'Bookshop',
      acquiredOn: '2030-01-01',
      disposedOn: null,
      note: 'First copy',
    }),
    make({
      accountId: 'alice',
      subjectId: hiddenSubjectId,
      subject: null,
      status: 'ordered',
      location: null,
      source: null,
      acquiredOn: null,
      disposedOn: null,
      note: 'Waiting',
    }),
    make({
      accountId: 'blake',
      subjectId: id(12),
      subject: { id: id(12), label: 'Secret story', type: 'book' },
      status: 'owned',
      location: 'Vault',
      source: 'Private',
      acquiredOn: '2030-01-02',
      disposedOn: null,
      note: 'Secret other copy',
    }),
  );
}
seedDefault();

type Call = {
  method: string;
  path: string;
  search: string;
  view: string | null;
  limit: string | null;
  cursor: string | null;
  revision: string | null;
  body: unknown;
  key: string | null;
  authorization: string | null;
};
const calls: Call[] = [];

function problem(status: number, code: string) {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: status === 409 ? 'not_applied' : 'not_applicable',
    request_id: randomUUID(),
  };
}
function reset() {
  calls.length = 0;
  seedDefault();
}
function wire(copy: StoredCopy, full: boolean) {
  const { accountId: _accountId, subject, ...rest } = copy;
  return full ? { ...rest, subject } : rest;
}
// OpenID provider copied from posting.test.ts; copy routes are the viewer's own library.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure') return json({ admitted: ['personal_library'] });
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const client = async (form: URLSearchParams) => {
      if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return false;
      try {
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
      accessSubjects.set(access, family.sub);
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
          { sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false },
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

    const token = request.headers.get('authorization') ?? '';
    const accountId = token.startsWith('Bearer ') ? accessSubjects.get(token.slice('Bearer '.length)) : undefined;
    let body: unknown = null;
    if (request.method === 'POST' || request.method === 'PATCH') body = await request.json().catch(() => null);
    calls.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      view: url.searchParams.get('view'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      revision: url.searchParams.get('revision'),
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    // Home reads POST /v1/pages/$read with no session. Unknown routes answer 404, as posting.test.ts does,
    // so that read is a missing page rather than a 401 that fails the document.
    const copyRoute = url.pathname === '/v1/copies' || /^\/v1\/copies\/([^/]+)$/.test(url.pathname);
    if (!copyRoute) return json(problem(404, 'not_found'), 404, true);
    if (!accountId) return json(problem(401, 'unauthorized'), 401, true);
    const key = request.headers.get('idempotency-key');
    const writing = request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE';
    if (writing && (!key || key.length < 3)) return json(problem(400, 'invalid_request'), 400, true);

    if (request.method === 'GET' && url.pathname === '/v1/copies') {
      const subjectId = url.searchParams.get('subjectId');
      if (subjectId !== null && !uuid.test(subjectId)) return json(problem(400, 'invalid_request'), 400, true);
      const cursor = url.searchParams.get('cursor');
      const owned = copies.filter(
        (copy) => copy.accountId === accountId && (!subjectId || copy.subjectId === subjectId),
      );
      const binding = `${accountId}:${subjectId ?? 'all'}:`;
      let offset = 0;
      if (cursor) {
        if (!cursor.startsWith(binding)) return json(problem(400, 'invalid_cursor'), 400, true);
        offset = Number(cursor.slice(binding.length));
        if (!Number.isSafeInteger(offset) || offset < 1 || offset >= owned.length)
          return json(problem(400, 'invalid_cursor'), 400, true);
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 100);
      const page = owned.slice(offset, offset + limit);
      return json({
        copies: page.map((copy) => wire(copy, url.searchParams.get('view') === 'FULL')),
        next: offset + limit < owned.length ? `${binding}${offset + limit}` : null,
      });
    }
    return json(problem(404, 'not_found'), 404, true);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function site(): Promise<string> {
  if (teardownStarted) return Promise.reject(new Error('Site startup requested after suite teardown began'));
  if (!started) {
    serverStartupAbort = new AbortController();
    const startup = Promise.resolve().then(async () => {
      ensureSiteStartupActive();
      const port = await freePort();
      ensureSiteStartupActive();
      const origin = `http://127.0.0.1:${port}`;
      let output = '';
      const keep = (chunk: Uint8Array) => {
        output = (output + Buffer.from(chunk).toString()).slice(-8000);
      };
      const startupChild = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
      const custody = ownNodeProcess(startupChild, {
        label: 'Vite dev server',
        outputLimit: 8000,
        onOutput: keep,
      });
      serverCustody = custody;
      let spawnError: Error | undefined;
      startupChild.once('error', (error) => {
        spawnError = error;
      });
      const deadline = Date.now() + 150_000;
      try {
        for (;;) {
          ensureSiteStartupActive(output);
          if (spawnError)
            throw new Error(`dev server spawn failed: ${spawnError.message}\n${output}`, { cause: spawnError });
          if (startupChild.exitCode !== null)
            throw new Error(`dev server exited with ${startupChild.exitCode}:\n${output}`);
          let response: Response | undefined;
          const request = siteStartupRequestSignal();
          try {
            response = await fetch(`${origin}/en`, {
              redirect: 'manual',
              signal: request.signal,
            });
          } catch (error) {
            ensureSiteStartupActive(output, error);
            // The dev server is still starting.
          } finally {
            request.dispose();
          }
          ensureSiteStartupActive(output);
          if (response && response.status < 500) return origin;
          if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
          await Bun.sleep(500);
        }
      } catch (error) {
        return await withCleanup(() => {
          throw error;
        }, [{ label: 'Vite startup process group', run: () => custody.close(), timeoutMs: 8000 }]);
      }
    });
    started = startup;
    pendingServerStartups.add(startup);
    void startup.then(
      () => pendingServerStartups.delete(startup),
      () => pendingServerStartups.delete(startup),
    );
  }
  return started;
}

const setCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) =>
  setCookie(response, name)
    ?.split(';')[0]
    ?.slice(name.length + 1);

async function signIn(returnTo = '/en') {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
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
  });
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303], 'OpenID callback setup').toContain(answer.status);
  const sessionCookie = cookieValue(answer, session);
  expect(sessionCookie, 'signed-in session setup').toBeTruthy();
  const issued = [...accessSubjects.keys()].at(-1);
  expect(issued, 'access token setup').toBeTruthy();
  return { session: sessionCookie!, access: issued! };
}

async function open(path: string) {
  const auth = await signIn(path);
  const origin = await site();
  const { value } = await withBrowserContext(
    {
      viewport: { width: 1280, height: 860 },
      reducedMotion: 'reduce',
      javaScriptEnabled: true,
    },
    async (context) => {
      await context.addCookies([
        {
          name: session,
          value: auth.session,
          domain: '127.0.0.1',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      return { page, access: auth.access, origin, response };
    },
  );
  return value;
}
const lists = () => calls.filter((call) => call.method === 'GET' && call.path === '/v1/copies');

afterAll(async () => {
  await cleanupSuite();
});

function seedPaged() {
  reset();
  for (let index = 0; index < 101; index += 1) {
    copies.push({ ...copies[0]!, id: id(1000 + index), note: `Filtered copy ${index}` });
  }
}

test(
  "with a subject in the URL, the copies page lists only the person's copies of that subject, paged",
  async () => {
    seedPaged();
    const { page, access } = await open(`/en/library/copies?subjectId=${edition}`);
    try {
      const main = page.locator('main');
      expect(await main.locator('article').count()).toBe(100);
      expect(await main.innerText()).not.toContain('Waiting');
      expect(await main.innerText()).not.toContain('Secret other copy');
      expect(lists().at(-1)?.authorization).toBe(`Bearer ${access}`);
      expect(new URLSearchParams(lists().at(-1)?.search).get('subjectId')).toBe(edition);
      expect(lists().at(-1)?.limit).toBe(pageLimit);
      await main.getByRole('link', { name: 'More', exact: true }).click();
      await page.waitForURL(/cursor=/);
      await main.getByText('Filtered copy 100', { exact: true }).waitFor();
      expect(await main.locator('article').count()).toBe(2);
      expect(new URL(page.url()).searchParams.get('subjectId')).toBe(edition);
      expect(lists().at(-1)?.cursor).toBe(`alice:${edition}:100`);
      expect(await main.getByRole('link', { name: 'More', exact: true }).count()).toBe(0);
    } finally {
      await closeContext(page.context());
    }
  },
  timeout,
);

test(
  'the filtered list says which subject it shows and links back to all copies',
  async () => {
    reset();
    const { page, origin } = await open(`/en/library/copies?subjectId=${edition}`);
    try {
      const main = page.locator('main');
      expect(await main.innerText()).toContain('Your copies of Zebra story');
      expect(await main.getByRole('form', { name: 'Add a copy' }).getByLabel('Edition').inputValue()).toBe(edition);
      await main.getByRole('link', { name: 'All copies', exact: true }).click();
      await page.waitForURL(`${origin}/en/library/copies`);
      await main.getByText('Waiting', { exact: true }).waitFor();
      expect(new URLSearchParams(lists().at(-1)?.search).has('subjectId')).toBe(false);
      for (const subjectId of [newSubject, id(12)]) {
        await page.goto(`${origin}/en/library/copies?subjectId=${subjectId}`, { waitUntil: 'networkidle' });
        expect(await main.locator('article').count()).toBe(0);
        expect(await main.innerText()).toContain('Your copies of this edition');
        expect(await main.innerText()).toContain('You have no copies of this edition.');
        expect(await main.getByRole('form', { name: 'Add a copy' }).getByLabel('Edition').inputValue()).toBe(subjectId);
        expect(await main.getByRole('link', { name: 'All copies', exact: true }).count()).toBe(1);
      }
    } finally {
      await closeContext(page.context());
    }
  },
  timeout,
);

test(
  'a stale or foreign cursor restarts the filtered list from its first page',
  async () => {
    seedPaged();
    for (const cursor of [`alice:${edition}:9999`, 'alice:all:100', `alice:${id(12)}:100`]) {
      calls.length = 0;
      const { page } = await open(`/en/library/copies?subjectId=${edition}&cursor=${encodeURIComponent(cursor)}`);
      try {
        expect(await page.locator('main article').count()).toBe(100);
        expect(await page.locator('main').innerText()).toContain('First copy');
        const reads = lists();
        expect(reads.map((call) => call.cursor)).toEqual([cursor, null]);
        expect(reads.every((call) => new URLSearchParams(call.search).get('subjectId') === edition)).toBe(true);
      } finally {
        await closeContext(page.context());
      }
    }
  },
  timeout,
);

test(
  'suite teardown refuses a new Vite startup',
  async () => {
    await cleanupSuite();
    await expect(site()).rejects.toThrow('Site startup requested after suite teardown began');
  },
  timeout,
);
