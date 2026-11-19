import { startDevServer } from './support/dev-server.ts';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read.ts';
import { sessionQueryKey } from '../src/reader/lifetime/contract.ts';
import { cleanupAll, withCleanup } from './support/server-custody.ts';
import { waitForPersonalRead } from './session-token';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['follow:list', 'library_entry:list', 'progress_session:list', 'subject:search'];
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
type ContinueItem = Extract<FeedItem, { source: 'continue' }>;
type Entry = Pick<ContinueItem['continue'], 'state' | 'lastActivityAt'> & {
  subject: ContinueItem['summary'];
};
const stampAt = (minute: number) => new Date(Date.UTC(2026, 3, 2, 0, minute)).toISOString();
function entry(n: number, state: Entry['state'], minute: number, label: string): Entry {
  return {
    state,
    lastActivityAt: stampAt(minute),
    subject: {
      id: id(n),
      type: 'book',
      types: ['book'],
      label: { value: label, language: 'en' },
      creativeWork: true,
      cover: null,
    },
  };
}

function showcase(): Entry[] {
  return [
    entry(21, 'in_progress', 10, 'Oldest read'),
    entry(22, 'planned', 50, 'Only planned'),
    entry(23, 'in_progress', 30, 'Newest read'),
    entry(24, 'completed', 40, 'Already finished'),
    entry(25, 'in_progress', 20, 'Middle read'),
  ];
}
function crowded(): Entry[] {
  return Array.from({ length: 9 }, (_, index) => entry(100 + index, 'in_progress', index + 1, `Crowded ${index + 1}`));
}

const discoverySubject = entry(10, null, 0, 'Public discovery').subject;
const discovery: FeedItem = {
  id: `semantic:${discoverySubject.id}`,
  source: 'discovery',
  key: { owner: 'semantic', kind: 'book', route: 402, id: discoverySubject.id },
  occurredAt: null,
  summary: discoverySubject,
  destination: { kind: 'subject', id: discoverySubject.id, title: 'Public discovery' },
};

function continueItem({ subject, state, lastActivityAt }: Entry): ContinueItem {
  const subjectId = subject.id;
  return {
    id: `continue:${subjectId}`,
    source: 'continue',
    key: { owner: 'semantic', kind: subject.type, route: 402, id: subjectId },
    occurredAt: lastActivityAt,
    summary: subject,
    destination: { kind: 'subject', id: subjectId, title: subject.label?.value ?? null },
    continue: {
      subjectId,
      state,
      lastActivityAt,
      subject,
      activeProgressSession:
        subjectId === id(23)
          ? {
              id: id(230),
              subjectId,
              versionSubjectId: null,
              mode: 'cursor_position',
              unit: 'page',
              total: null,
              amount: null,
              locator: 'Chapter 3',
              position: null,
              completedUnitCount: 0,
              state: 'active',
              revision: 1,
              startedAt: lastActivityAt,
              completedAt: null,
            }
          : null,
    },
  };
}

let entries = showcase();
let failContinue = false;
let continueAdmitted = true;
const kernelReads: { method: string; path: string; query: string; authorization: string | null }[] = [];
const continueSelections: string[][] = [];

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
  kernelReads.length = 0;
  continueSelections.length = 0;
  entries = next;
  failContinue = false;
  continueAdmitted = true;
}

// OpenID provider copied from library-entries.test.ts; the home page sends the website's access token.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure')
      return json({
        admitted: ['feed_item.list', ...(continueAdmitted ? ['personal_library', 'reading_progress'] : [])],
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
    const authorization = request.headers.get('authorization');
    kernelReads.push({ method: request.method, path: url.pathname, query: url.search, authorization });
    if (request.method !== 'GET' || url.pathname !== '/v1/feedItems') return json(problem(404, 'not_found'), 404, true);
    if (authorization && !accessTokens.some((token) => authorization === `Bearer ${token}`))
      return json(problem(401, 'invalid_credentials'), 401, true);
    const personal = authorization !== null;
    if (personal && !continueAdmitted) return json(problem(403, 'platform_closed'), 403, true);

    // Model the native Home response at the HTTP boundary, including its bounded Continue lane.
    const continued =
      personal && !failContinue
        ? entries
            .filter((item) => item.state === 'in_progress')
            .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
            .slice(0, 6)
            .map(continueItem)
        : [];
    if (personal) continueSelections.push(continued.map((item) => item.continue.subjectId));
    return json({
      feedItems: [...continued.slice(0, 1), discovery, ...continued.slice(1)],
      next: null,
      asOf: stampAt(60),
      sources: {
        discovery: 'ready',
        following: personal ? 'ready' : 'not_requested',
        continue: !personal ? 'not_requested' : failContinue ? 'unavailable' : 'ready',
      },
    } satisfies FeedPage);
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

let browser: Promise<Browser> | undefined;
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
let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    env: {
      KERNEL_ORIGIN: fake.url.origin,
      AUTH_ISSUER: `${fake.url.origin}/auth`,
      WEBSITE_CLIENT_ID: clientId,
      WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
      API_RESOURCE: resource,
      WEBSITE_SCOPES: scopes.join(' '),
    },
    warmUpPaths: [],
  }).then((running) => {
    server = running;
    return running.origin;
  });
  return started;
}

function launchBrowser(): Promise<Browser> {
  suiteLifetime.assertActive('Home Continue browser launch');
  browser ??= suiteLifetime.acquire(
    'Home Continue browser launch',
    () => chromium.launch(),
    (browser) => browsers.add(browser),
    closeBrowser,
  );
  return browser;
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

async function readHome(
  locale: string,
  options: { cookie?: string; width?: number; result?: 'ready' | 'closed'; continued?: 'ready' | 'unavailable' } = {},
) {
  let context: BrowserContext | undefined;
  return suiteLifetime.run('Home Continue page setup', async () =>
    withCleanup(async () => {
      const origin = await site();
      suiteLifetime.assertActive('Home Continue page browser launch');
      const sharedBrowser = await launchBrowser();
      const { cookie, width = 1280, result = 'ready', continued = 'ready' } = options;
      context = await createContext(
        sharedBrowser,
        { viewport: { width, height: 844 }, hasTouch: width < 768 },
        'Home Continue page context acquisition',
      );
      if (cookie) {
        await context.addCookies([
          { name: session, value: cookie, domain: new URL(origin).hostname, path: '/', secure: true, httpOnly: true },
        ]);
        suiteLifetime.assertActive('Home Continue page cookie setup');
      }
      const page = await context.newPage();
      suiteLifetime.assertActive('Home Continue page creation');
      const response = await page.goto(`${origin}/${locale}`, { waitUntil: 'domcontentloaded' });
      suiteLifetime.assertActive('Home Continue page navigation');
      await waitForPersonalRead(page, [...sessionQueryKey]);
      suiteLifetime.assertActive('Home Continue session readiness');
      const feed = page.locator(
        `[data-home-feed-mounted="true"][data-home-feed-state="${result}"][aria-busy="false"]` +
          (cookie && result === 'ready' ? `[data-feed-source-state~="continue:${continued}"]` : ''),
      );
      await feed.waitFor();
      await page.waitForLoadState('networkidle');
      suiteLifetime.assertActive('Home Continue feed readiness');
      const items = await feed.locator('[data-feed-source]').evaluateAll((items) =>
        items.map((item) => {
          const title = item.querySelector('[data-content-item-slot="title"]');
          const state = item.querySelector('[data-content-item-slot="state"]');
          const subject = item.querySelector('[data-slot="list-row-link"]');
          const resume = item.querySelector<HTMLAnchorElement>('a[href*="/library/progress"]');
          const bounds = item.getBoundingClientRect();
          const resumeBounds = resume?.getBoundingClientRect();
          return {
            source: item.getAttribute('data-feed-source'),
            title: title?.textContent?.trim(),
            subject: subject?.getAttribute('href'),
            state: state?.textContent?.trim(),
            resume: resume?.getAttribute('href'),
            resumeLabel: resume?.textContent?.trim(),
            resumeHeight: resumeBounds?.height,
            top: bounds.top,
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
          };
        }),
      );
      return {
        status: response!.status(),
        document: await response!.text(),
        items,
        scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
      };
    }, [
      {
        label: 'Home Continue page context',
        run: () => (context ? closeContext(context) : undefined),
        timeoutMs: 6000,
      },
    ]),
  );
}

function feedReads() {
  return kernelReads.filter((call) => call.path === '/v1/feedItems');
}

function expectNoLibraryFanout() {
  expect(
    kernelReads.filter((call) => /^\/v1\/(?:pages:read|library|progressSessions|subjects)/.test(call.path)),
  ).toEqual([]);
}

afterAll(() =>
  retireSuite(suiteLifetime, 'Home Continue', [
    {
      label: 'Home Continue browser and contexts',
      timeoutMs: 12000,
      run: () =>
        withCleanup(
          () =>
            cleanupAll(
              [...contexts].map((context) => ({
                label: 'Home Continue browser context',
                run: () => closeContext(context),
                timeoutMs: 5000,
              })),
            ),
          [...browsers].map((browser) => ({
            label: 'Home Continue browser',
            run: () => closeBrowser(browser),
            timeoutMs: 5000,
          })),
        ),
    },
    { label: 'Home Continue fake API and OIDC listener', run: () => fake.stop(true), timeoutMs: 5000 },
    { label: 'Home Continue Vite process group', run: () => server?.stop(), timeoutMs: 7000 },
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
  'signed-in Mixed Home preserves the Continue lane order and keeps private rows out of the document',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const home = await readHome(locale, { cookie });
      expect(home.status).toBe(200);
      expect(home.document).toContain('Public discovery');
      expect(home.document).not.toContain('Newest read');
      expect(home.document).not.toContain(id(230));
      expect(home.items.map(({ source, title }) => [source, title])).toEqual([
        ['continue', 'Newest read'],
        ['discovery', 'Public discovery'],
        ['continue', 'Middle read'],
        ['continue', 'Oldest read'],
      ]);
      expect(home.items.filter(({ source }) => source === 'continue').map(({ resume }) => resume)).toEqual([
        `/${locale}/library/progress/${id(230)}`,
        `/${locale}/library/progress?subjectId=${id(25)}`,
        `/${locale}/library/progress?subjectId=${id(21)}`,
      ]);
    }
  },
  timeout,
);

test(
  'phone Continue items expose separate subject and resume links',
  async () => {
    const cookie = await alice();
    reset();
    const home = await readHome('en', { cookie, width: 390 });
    const newest = home.items[0]!;
    expect(newest.title).toBe('Newest read');
    expect(newest.subject).toContain(id(23));
    expect(newest.resume).toBe(`/en/library/progress/${id(230)}`);
    expect(newest.resumeLabel).toContain('Newest read');
    expect(newest.resumeHeight).toBeGreaterThanOrEqual(24);
  },
  timeout,
);

test(
  'Continue items show recorded progress on their shared feed card',
  async () => {
    const cookie = await alice();
    reset();
    const home = await readHome('en', { cookie });
    expect(home.items.map(({ title, state }) => [title, state])).toEqual([
      ['Newest read', 'Chapter 3'],
      ['Public discovery', undefined],
      ['Middle read', undefined],
      ['Oldest read', undefined],
    ]);
  },
  timeout,
);

test(
  'at phone width the bounded Mixed Home list flows vertically without page overflow',
  async () => {
    const cookie = await alice();
    reset(crowded());
    const home = await readHome('en', { cookie, width: 390 });
    expect(home.items.map(({ title }) => title)).toEqual([
      'Crowded 9',
      'Public discovery',
      'Crowded 8',
      'Crowded 7',
      'Crowded 6',
      'Crowded 5',
      'Crowded 4',
    ]);
    for (const [index, item] of home.items.entries()) {
      expect(item.left).toBeGreaterThanOrEqual(0);
      expect(item.right).toBeLessThanOrEqual(390);
      if (index > 0) expect(item.top).toBeGreaterThanOrEqual(home.items[index - 1]!.bottom);
    }
    expect(home.scrollWidth).toBeLessThanOrEqual(390);
  },
  timeout,
);

test(
  'signed-out and idle visitors see only discovery, and signed-out Home never reads a private lane',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const out = await readHome(locale);
      expect(out.status).toBe(200);
      expect(out.items.map(({ source }) => source)).toEqual(['discovery']);
      expect(feedReads().map(({ authorization }) => authorization)).toEqual([null]);
      expect(continueSelections).toEqual([]);
      expectNoLibraryFanout();

      reset(showcase().filter((item) => item.state !== 'in_progress'));
      const idle = await readHome(locale, { cookie });
      expect(idle.status).toBe(200);
      expect(idle.items.map(({ source }) => source)).toEqual(['discovery']);
      expect(continueSelections).toEqual([[]]);
    }
  },
  timeout,
);

test(
  'when the Continue lane fails, the same Mixed Home feed still renders public discovery',
  async () => {
    const cookie = await alice();
    reset();
    failContinue = true;
    const home = await readHome('en', { cookie, continued: 'unavailable' });
    expect(home.status).toBe(200);
    expect(home.items.map(({ source }) => source)).toEqual(['discovery']);
    expect(continueSelections).toEqual([[]]);
    expect(feedReads()).toHaveLength(2);
    expectNoLibraryFanout();
  },
  timeout,
);

test(
  'when private feed admission is closed, Home surfaces the refusal without reading Continue',
  async () => {
    const cookie = await alice();
    reset();
    continueAdmitted = false;
    const home = await readHome('en', { cookie, result: 'closed' });
    expect(home.status).toBe(200);
    expect(home.document).toContain('Public discovery');
    expect(home.items).toEqual([]);
    expect(continueSelections).toEqual([]);
    expect(feedReads()).toHaveLength(2);
    expectNoLibraryFanout();
  },
  timeout,
);

test(
  'Home reads one public page and one session-bound mixed page without separate owner reads',
  async () => {
    const cookie = await alice();
    reset(crowded());
    const home = await readHome('en', { cookie });
    expect(home.status).toBe(200);
    expect(feedReads()).toEqual([
      { method: 'GET', path: '/v1/feedItems', query: '?stream=home&limit=20', authorization: null },
      {
        method: 'GET',
        path: '/v1/feedItems',
        query: '?stream=home&limit=20',
        authorization: `Bearer ${accessTokens[0]}`,
      },
    ]);
    expect(continueSelections).toEqual([[id(108), id(107), id(106), id(105), id(104), id(103)]]);
    expectNoLibraryFanout();
  },
  timeout,
);
