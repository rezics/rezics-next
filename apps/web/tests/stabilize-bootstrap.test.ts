import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createFakeKernelFetch, type FakeKernelCall } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { startDevServer } from './support/dev-server.ts';

const app = join(import.meta.dir, '..');
const root = join(app, '../..');
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const requestedScopes = 'openid offline_access';
const sessionCookieName = '__Host-rezics_session';
const loginCookieName = '__Host-rezics_login';

type AuthorizationCode = {
  challenge: string;
  nonce: string;
  redirectUri: string;
};

function cookieLine(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

function cookiePair(line: string): string {
  return line.split(';', 1)[0]!;
}

function safeProblem(response: Response): Promise<string> {
  return response
    .clone()
    .json()
    .then((value: unknown) => {
      if (!value || typeof value !== 'object') return 'none';
      const problem = value as { code?: unknown; status?: unknown };
      const code =
        typeof problem.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(problem.code) ? problem.code : 'none';
      const status = typeof problem.status === 'number' ? problem.status : response.status;
      return `${status}/${code}`;
    })
    .catch(() => 'none');
}

test('a cold isolated checkout completes the signed issuer flow through the production BFF and renders the requested signed-in page', async () => {
  await mkdir(join(root, '.temp'), { recursive: true });
  const ownedDirectory = await mkdtemp(join(root, '.temp/stabilize-bootstrap-'));
  const cacheDirectory = join(ownedDirectory, 'vite-cache');
  const viteConfig = join(ownedDirectory, 'vite.config.ts');

  const grants = new Map<string, AuthorizationCode>();
  const assertionIds = new Set<string>();
  const kernelCalls: FakeKernelCall[] = [];
  const pageCredentials: string[] = [];
  let siteOrigin = '';
  let issuer = '';
  let issuerFailure = 'none';
  let authorizationRequests = 0;
  let authorizationRequestValid = false;
  let tokenRequests = 0;
  let codeGrantRequests = 0;
  let clientAssertionsVerified = 0;
  let kernelServer: ReturnType<typeof Bun.serve> | undefined;
  let issuerServer: ReturnType<typeof Bun.serve> | undefined;
  let devServer: Awaited<ReturnType<typeof startDevServer>> | undefined;
  let browser: Browser | undefined;
  let stateDirectory: string | undefined;

  try {
    stateDirectory = await mkdtemp(join(tmpdir(), 'rezics-stabilize-bootstrap-state-'));
    const clientKeys = await generateKeyPair('ES256', { extractable: true });
    const clientPublicJwk = {
      ...(await exportJWK(clientKeys.publicKey)),
      alg: 'ES256',
      kid: 'stabilize-client-1',
      use: 'sig',
    };
    const clientPrivateJwk = {
      ...(await exportJWK(clientKeys.privateKey)),
      alg: 'ES256',
      kid: clientPublicJwk.kid,
      use: 'sig',
    };
    const issuerKeys = await generateKeyPair('ES256', { extractable: true });
    const issuerPublicJwk = {
      ...(await exportJWK(issuerKeys.publicKey)),
      alg: 'ES256',
      kid: 'stabilize-issuer-1',
      use: 'sig',
    };
    await Bun.write(
      viteConfig,
      `import config from ${JSON.stringify(pathToFileURL(join(app, 'vite.config.ts')).href)};\n` +
        `export default { ...config, cacheDir: ${JSON.stringify(cacheDirectory)} };\n`,
    );
    const kernelFetch = createFakeKernelFetch(fixtures as never, (call) => kernelCalls.push(call));
    kernelServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => kernelFetch(request),
    });
    issuerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const issuerOrigin = `${url.origin}/auth`;
        if (url.pathname === '/auth/.well-known/openid-configuration')
          return Response.json(
            {
              issuer: issuerOrigin,
              authorization_endpoint: `${issuerOrigin}/authorize`,
              token_endpoint: `${issuerOrigin}/token`,
              jwks_uri: `${issuerOrigin}/jwks`,
              response_types_supported: ['code'],
              grant_types_supported: ['authorization_code', 'refresh_token'],
              code_challenge_methods_supported: ['S256'],
              id_token_signing_alg_values_supported: ['ES256'],
              token_endpoint_auth_methods_supported: ['private_key_jwt'],
              token_endpoint_auth_signing_alg_values_supported: ['ES256'],
              scopes_supported: ['openid', 'offline_access'],
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        if (url.pathname === '/auth/jwks')
          return Response.json({ keys: [issuerPublicJwk] }, { headers: { 'cache-control': 'no-store' } });
        if (url.pathname === '/auth/authorize') {
          authorizationRequests += 1;
          const params = url.searchParams;
          const redirectUri = params.get('redirect_uri') ?? '';
          const challenge = params.get('code_challenge') ?? '';
          const nonce = params.get('nonce') ?? '';
          const state = params.get('state') ?? '';
          authorizationRequestValid =
            params.get('response_type') === 'code' &&
            params.get('client_id') === clientId &&
            redirectUri === `${siteOrigin}/auth/callback` &&
            params.get('resource') === resource &&
            params.get('scope') === requestedScopes &&
            params.get('code_challenge_method') === 'S256' &&
            challenge.length > 0 &&
            nonce.length > 0 &&
            state.length > 0;
          if (!authorizationRequestValid) {
            issuerFailure = 'authorization_request';
            return Response.json({ error: 'invalid_request' }, { status: 400 });
          }
          const code = randomUUID();
          grants.set(code, { challenge, nonce, redirectUri });
          const callback = new URL(redirectUri);
          callback.searchParams.set('code', code);
          callback.searchParams.set('state', state);
          return Response.redirect(callback, 302);
        }
        if (url.pathname === '/auth/token' && request.method === 'POST') {
          tokenRequests += 1;
          const form = new URLSearchParams(await request.text());
          if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
            issuerFailure = 'client_assertion_type';
            return Response.json({ error: 'invalid_client' }, { status: 401 });
          }
          try {
            const { payload, protectedHeader } = await jwtVerify(
              form.get('client_assertion') ?? '',
              clientKeys.publicKey,
              {
                issuer: clientId,
                subject: clientId,
                audience: issuer,
                algorithms: ['ES256'],
                maxTokenAge: '120s',
              },
            );
            const issuedAt = payload.iat;
            const expiresAt = payload.exp;
            const assertionId = payload.jti;
            if (
              protectedHeader.kid !== clientPublicJwk.kid ||
              payload.aud !== issuer ||
              typeof assertionId !== 'string' ||
              assertionIds.has(assertionId) ||
              typeof issuedAt !== 'number' ||
              typeof expiresAt !== 'number' ||
              expiresAt <= issuedAt ||
              expiresAt - issuedAt > 120
            ) {
              issuerFailure = 'client_assertion_validation';
              return Response.json({ error: 'invalid_client' }, { status: 401 });
            }
            assertionIds.add(assertionId);
            clientAssertionsVerified += 1;
            issuerFailure = 'none';
          } catch {
            issuerFailure = 'client_assertion_signature';
            return Response.json({ error: 'invalid_client' }, { status: 401 });
          }

          if (form.get('grant_type') !== 'authorization_code') {
            issuerFailure = 'unexpected_grant_type';
            return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
          }
          codeGrantRequests += 1;
          const code = form.get('code') ?? '';
          const grant = grants.get(code);
          grants.delete(code);
          const verifier = form.get('code_verifier') ?? '';
          const verifiedChallenge = createHash('sha256').update(verifier).digest('base64url');
          if (
            !grant ||
            form.get('redirect_uri') !== grant.redirectUri ||
            form.get('resource') !== resource ||
            verifiedChallenge !== grant.challenge
          ) {
            issuerFailure = 'authorization_code_validation';
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          }
          const accessToken = `access-${randomUUID()}`;
          const refreshToken = `refresh-${randomUUID()}`;
          const idToken = await new SignJWT({ nonce: grant.nonce })
            .setProtectedHeader({ alg: 'ES256', kid: issuerPublicJwk.kid })
            .setIssuer(issuer)
            .setSubject('signed-issuer-fixture-user')
            .setAudience(clientId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(issuerKeys.privateKey);
          pageCredentials.push(accessToken, refreshToken, idToken);
          issuerFailure = 'none';
          return Response.json(
            {
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: 600,
              refresh_token: refreshToken,
              id_token: idToken,
              scope: requestedScopes,
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        return new Response(null, { status: 404 });
      },
    });
    issuer = `${issuerServer.url.origin}/auth`;
    devServer = await startDevServer({
      cwd: app,
      warmUpPaths: [],
      budgets: { ready: 150_000, firstResponse: 60_000, warmUp: 60_000 },
      command: ({ port }) => [
        'bun',
        'run',
        'dev',
        '--config',
        viteConfig,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      env: {
        AUTH_ISSUER: issuer,
        API_RESOURCE: resource,
        WEBSITE_SCOPES: requestedScopes,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientPrivateJwk),
        PUBLIC_ORIGIN: 'https://rezics.com',
        SITE_ORIGINS: 'https://rezics.com',
        KERNEL_ORIGIN: kernelServer.url.origin,
        WEB_TEST_STATE_DIR: stateDirectory,
      },
    });
    siteOrigin = devServer.origin;

    const coldPage = await fetch(`${siteOrigin}/en`, { redirect: 'manual' });
    expect(coldPage.status, 'cold /en responds successfully after Vite announces ready').toBe(200);
    expect((await coldPage.text()).length, 'cold /en returns a rendered page').toBeGreaterThan(0);

    const signIn = await fetch(`${siteOrigin}/auth/sign-in?return_to=${encodeURIComponent('/en')}`, {
      redirect: 'manual',
    });
    expect(signIn.status, 'the real BFF starts the OIDC authorization request').toBe(302);
    const loginCookie = cookieLine(signIn, loginCookieName);
    expect(loginCookie, 'the BFF binds the login transaction to its protected cookie').toBeDefined();
    expect(loginCookie!, 'the login transaction cookie uses its host-only secure policy').toMatch(
      /;\s*HttpOnly\b.*;\s*Secure\b.*;\s*SameSite=Lax\b.*;\s*Path=\//i,
    );

    const authorizationUrl = new URL(signIn.headers.get('location') ?? '', siteOrigin);
    expect(authorizationUrl.origin, 'the BFF redirects to the configured issuer').toBe(issuerServer.url.origin);
    const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(authorization.status, 'the signed issuer fixture returns the real callback redirect').toBe(302);
    const callbackUrl = new URL(authorization.headers.get('location') ?? '', siteOrigin);
    expect(callbackUrl.origin, 'the issuer returns to the configured site callback').toBe(siteOrigin);
    expect(callbackUrl.pathname, 'the issuer returns to the BFF callback route').toBe('/auth/callback');

    const callback = await fetch(callbackUrl, {
      redirect: 'manual',
      headers: { cookie: cookiePair(loginCookie!) },
    });
    expect([302, 303], `BFF callback problem=${await safeProblem(callback)}; issuer=${issuerFailure}`).toContain(
      callback.status,
    );
    const sessionCookie = cookieLine(callback, sessionCookieName);
    expect(sessionCookie, 'the callback creates a real session cookie').toBeDefined();
    expect(sessionCookie!, 'the session cookie preserves the host-only secure policy').toMatch(
      /;\s*HttpOnly\b.*;\s*Secure\b.*;\s*SameSite=Lax\b.*;\s*Path=\//i,
    );
    expect(sessionCookie!, 'the session cookie does not set a Domain attribute').not.toMatch(/;\s*Domain=/i);
    const requestedPage = new URL(callback.headers.get('location') ?? '', siteOrigin);
    expect(requestedPage.origin, 'the callback redirects to the requested site origin').toBe(siteOrigin);
    expect(requestedPage.pathname, 'the callback returns to the requested signed-in page').toBe('/en');

    expect(authorizationRequests, 'the issuer fixture receives one authorization request').toBe(1);
    expect(authorizationRequestValid, 'the authorization request contains state, nonce, S256 PKCE and resource').toBe(
      true,
    );
    expect(tokenRequests, 'a public page read does not refresh or otherwise contact the issuer').toBe(1);
    expect(codeGrantRequests, 'the issuer receives one authorization-code grant').toBe(1);
    expect(clientAssertionsVerified, 'the issuer verifies the BFF private_key_jwt signature and claims').toBe(1);

    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    const sessionValue = cookiePair(sessionCookie!).slice(sessionCookieName.length + 1);
    await context.addCookies([
      {
        name: sessionCookieName,
        value: sessionValue,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.name));
    const pageResponse = await page.goto(`${siteOrigin}/en`, { waitUntil: 'domcontentloaded' });
    expect(pageResponse?.status(), 'the signed-in page returns a successful response').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await page.locator('#account-menu-button').waitFor({ state: 'visible' });
    expect(page.url(), 'the browser remains on the requested signed-in page').toBe(`${siteOrigin}/en`);
    expect(pageErrors, 'the signed-in page hydrates without module errors').toEqual([]);
    const renderedPage = await page.content();
    expect(
      pageCredentials.some((credential) => renderedPage.includes(credential)),
      'issuer credentials stay server-side',
    ).toBe(false);

    const publicPageReads = kernelCalls.filter((call) => call.method === 'POST' && call.path === '/v1/pages:read');
    expect(publicPageReads.length, 'the page uses the fake public kernel fixture').toBeGreaterThan(0);
    expect(
      publicPageReads.every((call) => call.authorization === null),
      'public page reads remain anonymous after sign-in',
    ).toBe(true);
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => browser?.close(),
      async () => devServer?.stop(),
      async () => issuerServer?.stop(true),
      async () => kernelServer?.stop(true),
      async () => rm(ownedDirectory, { recursive: true, force: true }),
      async () => {
        if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'bootstrap fixture cleanup failed');
  }
}, 300_000);
