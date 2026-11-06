import { startDevServer } from './support/dev-server.ts';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { chromium, type Browser } from 'playwright';
import offer from '../src/kernel/recorded/offer.json';
import { cleanupAll, withCleanup } from './support/server-custody.ts';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];

const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

const codes = new Map<string, { nonce: string; sub: string }>();
const tokenRequests: string[] = [];
const accessTokens: string[] = [];
const kernelCalls: { path: string; authorization: string | null }[] = [];
let counter = 0;
// How Auth answers the next refresh grants; null issues new tokens.
let refusal: (() => Response) | null = null;
let offerOutcome: 'missing' | 'closed' | 'unavailable' | 'error' | 'ready' = 'missing';
let offerReads = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// An OpenID provider as Auth serves the website client. Access tokens live 30 seconds, inside the Worker's one-minute
// refresh window, so every use of the session's credential asks Auth for a refresh.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const issue = async (sub: string, nonce?: string) => {
      counter += 1;
      const access = `access-${counter}`;
      accessTokens.push(access);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 30,
        refresh_token: `refresh-${counter}`,
        scope: 'openid offline_access media:read',
      };
      if (nonce !== undefined)
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      return json(body);
    };

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
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
      tokenRequests.push(form.get('grant_type') ?? '');
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        if (!grant) return json({ error: 'invalid_grant' }, 400);
        codes.delete(form.get('code') ?? '');
        return issue(grant.sub, grant.nonce);
      }
      if (form.get('grant_type') === 'refresh_token') return refusal ? refusal() : issue('alice');
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === `/v1/offers/${offer.offer.id}`) {
      offerReads++;
      if (offerOutcome === 'ready') return json({ offer: { ...offer.offer, revision: 1 } });
      const status = { missing: 404, closed: 403, unavailable: 503, error: 500 }[offerOutcome];
      const code = offerOutcome === 'closed' ? 'platform_closed' : 'dependency_unavailable';
      return Response.json(
        { code, detail: 'private upstream cause' },
        {
          status,
          headers: { 'cache-control': 'private, no-store', 'retry-after': '7' },
        },
      );
    }
    if (url.pathname.startsWith('/v1/media/')) {
      kernelCalls.push({ path: url.pathname + url.search, authorization: request.headers.get('authorization') });
      return Response.json(
        {
          type: 'https://rezics.com/problems/not_found',
          title: 'Not Found',
          status: 404,
          code: 'not_found',
          retryable: false,
          effect_status: 'not_applicable',
          request_id: randomUUID(),
        },
        { status: 404, headers: { 'content-type': 'application/problem+json' } },
      );
    }
    return json({ error: 'not_found' }, 404);
  },
});


let browser: Browser | undefined;
let browserStarting: Promise<Browser> | undefined;
let browserClosing: Promise<void> | undefined;
let teardownStarted = false;

function closeBrowser(): Promise<void> {
  return (browserClosing ??= (async () => {
    if (browser) {
      await browser.close();
      return;
    }
    if (browserStarting) {
      try {
        await (await browserStarting).close();
      } catch {
        if (browser) throw new Error('Refresh browser launch failed after producing a browser');
      }
    }
  })());
}

function openBrowser(): Promise<Browser> {
  if (teardownStarted) throw new Error('Refresh browser acquisition began after suite teardown');
  browserStarting ??= chromium.launch().then((launched) => {
    browser = launched;
    if (teardownStarted) void closeBrowser().catch(() => {});
    return launched;
  });
  void browserStarting.catch(() => {});
  return browserStarting;
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

afterAll(async () => {
  teardownStarted = true;
  await cleanupAll([
    { label: 'Refresh-errors browser', run: closeBrowser, timeoutMs: 6000 },
    { label: 'Refresh-errors Vite server', run: () => server?.stop(), timeoutMs: 7000 },
    { label: 'Refresh-errors Auth and kernel fake', run: () => fake.stop(true), timeoutMs: 5000 },
  ]);
});

const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]!
    .slice(name.length + 1);

// Signs a person in through the Worker, answering at Auth as a signed-in person would, and returns the session id.
async function signIn(): Promise<string> {
  refusal = null;
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=%2Fja`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location')!).searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, { nonce: params.get('nonce')!, sub: 'alice' });
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: `${login}=${cookieValue(start, login)}` },
  });
  expect(answer.status).toBe(303);
  return cookieValue(answer, session)!;
}

// A media download with the session: the Worker resolves its credential, refreshing first, then asks the kernel.
async function download(value: string) {
  const id = randomUUID();
  const response = await fetch(`${await site()}/media/${id}/original`, {
    redirect: 'manual',
    headers: { cookie: `${session}=${value}` },
  });
  const call = kernelCalls.findLast((entry) => entry.path.startsWith(`/v1/media/${id}:`));
  return { response, call };
}

const refreshes = () => tokenRequests.filter((grant) => grant === 'refresh_token').length;

test(
  'a refresh that Auth refuses with invalid_grant ends the session',
  async () => {
    const value = await signIn();
    refusal = () => json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400);
    const before = refreshes();
    const first = await download(value);
    // The request continues signed out.
    expect(refreshes()).toBe(before + 1);
    expect(first.call).toBeDefined();
    expect(first.call!.authorization).toBeNull();
    // The session is gone: no further refresh is attempted for it.
    const second = await download(value);
    expect(refreshes()).toBe(before + 1);
    expect(second.call!.authorization).toBeNull();
  },
  timeout,
);

test(
  'a refresh that fails for any other reason keeps the session and answers unavailable',
  async () => {
    const failures: [string, () => Response][] = [
      ['invalid_client', () => json({ error: 'invalid_client' }, 401)],
      ['invalid_request', () => json({ error: 'invalid_request' }, 400)],
      ['temporarily_unavailable', () => json({ error: 'temporarily_unavailable' }, 503)],
      ['server error page', () => new Response('<h1>Internal Server Error</h1>', { status: 500 })],
    ];
    for (const [name, answer] of failures) {
      const value = await signIn();
      refusal = answer;
      const before = refreshes();
      const failed = await download(value);
      expect(refreshes(), name).toBe(before + 1);
      expect(failed.response.status, name).toBe(502);
      expect(failed.response.headers.get('content-type'), name).toStartWith('application/problem+json');
      expect(((await failed.response.json()) as { code: string }).code, name).toBe('dependency_unavailable');
      // No kernel call is made with a missing or stale credential.
      expect(failed.call, name).toBeUndefined();

      // Once Auth recovers, the same session refreshes and the kernel sees the person's new token.
      refusal = null;
      const recovered = await download(value);
      expect(refreshes(), name).toBe(before + 2);
      expect(recovered.call?.authorization, name).toBe(`Bearer ${accessTokens.at(-1)}`);
    }
  },
  timeout,
);

test(
  'generic route errors retain native failure status and noindex while exposing bounded real retry recovery in the sole shell main',
  async () => {
    const path = `/en/offers/${offer.offer.id}`;
    const origin = await site();
    for (const [outcome, status] of [
      ['missing', 404],
      ['closed', 403],
      ['unavailable', 503],
      ['error', 500],
    ] as const) {
      offerOutcome = outcome;
      const response = await fetch(`${origin}${path}`, { redirect: 'manual' });
      const html = await response.text();
      expect(response.status, outcome).toBe(status);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('cache-control')).toContain('private');
      expect(html).toMatch(/name="robots"[^>]*content="noindex/);
      expect((html.match(/<main\b/g) ?? []).length).toBe(1);
      expect(html).not.toContain('private upstream cause');
      expect(html).not.toContain(offer.offer.title);
      if (status >= 500) expect(response.headers.get('retry-after')).toBe('7');
    }

    offerOutcome = 'unavailable';
    const ownedBrowser = await openBrowser();
    await withCleanup(async () => {
      const page = await ownedBrowser.newPage();
      const response = await page.goto(`${origin}${path}`);
      expect(response?.status()).toBe(503);
      await page.locator('html[data-hydrated]').waitFor();
      const main = page.getByRole('main');
      expect(await main.count()).toBe(1);
      const retry = main.getByRole('button', { name: 'Try again', exact: true });
      await retry.waitFor();
      expect(await main.getByRole('link', { name: 'Home', exact: true }).getAttribute('href')).toBe('/en');
      expect(await main.getByRole('link', { name: 'Search', exact: true }).getAttribute('href')).toBe('/en/search');
      const before = offerReads;
      const failedRead = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.startsWith('/_serverFn/') && response.url().includes(offer.offer.id),
      );
      await retry.click();
      expect((await failedRead).status()).toBe(503);
      await page.waitForFunction(() => {
        const retry = Array.from(document.querySelectorAll<HTMLButtonElement>('main button')).find(
          (button) => button.textContent === 'Try again',
        );
        return retry && !retry.disabled;
      });
      // A failed explicit attempt keeps noindex and never discloses the target or signs the reader in.
      expect(offerReads).toBe(before + 1);
      expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
      expect(await main.innerText()).not.toContain(offer.offer.title);
      expect(page.url()).toBe(`${origin}${path}`);
      offerOutcome = 'ready';
      await retry.click();
      await main.getByRole('heading', { name: offer.offer.title, exact: true }).waitFor();
      expect(offerReads).toBe(before + 2);
      expect(await main.count()).toBe(1);
      expect(await retry.count()).toBe(0);
      expect(page.url()).toBe(`${origin}${path}`);
    }, [{ label: 'Refresh-errors browser page', run: closeBrowser, timeoutMs: 6000 }]);
  },
  timeout,
);
