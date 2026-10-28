import { browserSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { KernelClient } from '@rezics/client';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { slug } from '@rezics/definitions/slug';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['order:create', 'order:read'];

// The website client's key, which only the Worker holds, and the issuer's signing key.
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
const accessTokens: string[] = [];
let counter = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

type Data<F extends (...args: never[]) => unknown> = NonNullable<
  Awaited<ReturnType<F>> extends { data: infer D } ? D : never
>;
type OfferRead = Data<ReturnType<KernelClient['offers']>['get']>;
type OrderRead = Data<ReturnType<KernelClient['orders']>['get']>;
type OrderStart = Data<KernelClient['orders']['post']>;
type Problem = NonNullable<Awaited<ReturnType<KernelClient['orders']['post']>>['error']>['value'];
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const offerPath = (n = 1) => `/en/offers/${id(n)}`;
const stripe = 'https://checkout.stripe.com/c/pay/cs_test_checkout';
const coverMedia = id(91);
const bookLabels: Record<string, string> = {
  en: 'A Field Guide to Stars',
  de: 'Ein Feldführer zu den Sternen',
  ja: '星の野外ガイド',
};
type Subject = NonNullable<OfferRead['offer']['subject']>;
// The kernel's subject summary for a book, labelled in the first asked language it has a label for.
function summaryOf(languages: string | null, cover: Subject['cover']): Subject {
  const language = languages && languages in bookLabels ? languages : 'en';
  return {
    id: id(90),
    type: 'schema:Book',
    types: ['schema:Book', 'schema:CreativeWork'],
    label: { value: bookLabels[language]!, language },
    creativeWork: true,
    cover,
  };
}
const bookCover: Subject['cover'] = {
  media: coverMedia,
  width: 1200,
  height: 1800,
  placeholder: { thumbhash: '', color: '#5a4632' },
  variants: [
    { format: 'avif', width: 320 },
    { format: 'webp', width: 320 },
    { format: 'avif', width: 640 },
    { format: 'webp', width: 640 },
  ],
  focalPoint: null,
  credit: {
    rightsHolder: 'Star Press',
    via: { name: 'Open Library', url: 'https://openlibrary.org/' },
    license: 'All rights reserved',
    obligations: [],
  },
};
// A solid 320-by-480 image in each format a cover variant comes in: wide enough that the smallest cover's slot still
// gets a non-empty picture.
const images = {
  avif: Buffer.from(
    'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAA1AAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAFAAAAB4AAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EBDAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAA9bWRhdAoLAAAADET/vm18gCAyJhAAmQAAALALIAHFfFMI5N03bRxVvBwb6N2BXR6fTWl50lwIG7AU',
    'base64',
  ),
  webp: Buffer.from(
    'UklGRnYBAABXRUJQVlA4IGoBAABQJACdASpAAeABPxGIwVosKSckIAgBgCIJaW7hd2EWgAnsSpRu+zDxJsdCCn7IXaVAsl2vFych77ZOQ99sxlp7ZOQ99snI/55OQ99snIe/AEA99snIe+2TkPfbJyHvtk5xEXJyHvtk5D6F9LteLk5D325l+ntk5D32yc4iLk5D32ych9C+l2vFych77cy/T2ych77ZOcRFych77ZOQ+hfS7Xi5OQ99uZfp7ZOQ99snOIi5OQ99snIfQvpdrxcnIe+3Mv09snIe+2TnERcnIe+2TkPoX0u14uTkPfbmX6e2TkPfbJziIuTkPfbJyH0L6Xa8XJyHvtzL9PbJyHvtk5xEXJyHvtk5D6F9LteLk5D325l+ntk5D32yc4iLk5D32ych9C+l2vFych70gAD+/5E3/PURYqGLkM2ubTzaebTzaebTzaebTzPYyhFBQAFu3QiLdBPf/eYEAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    'base64',
  ),
};
const offerWithoutSubject = id(6);
const offerWithoutCover = id(7);
const orderWithoutSubject = id(14);
const offer: OfferRead = {
  offer: {
    id: id(1),
    targetSubjectId: id(90),
    subject: summaryOf('en', bookCover),
    title: 'A field guide to stars',
    currency: 'usd',
    unitAmountMinor: 123456,
    state: 'active',
  },
};
function order(n: number, settlement: OrderRead['order']['settlement'] = 'pending', offerId = id(1)): OrderRead {
  return {
    order: {
      id: id(n),
      offerId,
      title: offer.offer.title,
      targetSubjectId: id(90),
      subject: summaryOf('en', bookCover),
      settlement,
      checkoutUrl: settlement === 'failed' ? null : stripe,
      checkoutExpiresAt: '2026-12-01T00:00:00.000Z',
      entitlementId: settlement === 'paid' ? id(80) : null,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  };
}
function problem(status: number, code: string): Response {
  const body: Problem = {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: status === 503,
    effect_status: 'not_applied',
    request_id: randomUUID(),
  };
  return Response.json(body, { status, headers: { 'content-type': 'application/problem+json' } });
}
type Call = {
  method: string;
  path: string;
  languages: string | null;
  authorization: string | null;
  key: string | null;
  body: unknown;
  at: number;
};
const calls: Call[] = [];
let settlePending = false;
async function kernel(request: Request, url: URL): Promise<Response> {
  // Unknown /v1 routes, including the anonymous home pages:read, answer 404. A bearer is required only for orders.
  const offerRead = request.method === 'GET' && /^\/v1\/offers\/[^/]+$/.test(url.pathname);
  const orderStart = request.method === 'POST' && url.pathname === '/v1/orders';
  const orderRead = request.method === 'GET' && /^\/v1\/orders\/[^/]+$/.test(url.pathname);
  if (!offerRead && !orderStart && !orderRead) {
    await request.body?.cancel().catch(() => {});
    return problem(404, 'not_found');
  }
  const body: unknown = request.method === 'POST' ? await request.json() : null;
  const call: Call = {
    method: request.method,
    path: url.pathname,
    languages: url.searchParams.get('languages'),
    authorization: request.headers.get('authorization'),
    key: request.headers.get('idempotency-key'),
    body,
    at: Date.now(),
  };
  calls.push(call);
  if (offerRead) {
    const offerId = url.pathname.split('/').at(-1)!;
    const languages = call.languages;
    const result: OfferRead = {
      offer: {
        ...offer.offer,
        id: offerId,
        subject:
          offerId === offerWithoutSubject
            ? null
            : summaryOf(languages, offerId === offerWithoutCover ? null : bookCover),
        state: url.pathname.endsWith(id(2)) ? 'delisted' : 'active',
      },
    };
    return json(result);
  }
  if (!call.authorization || !accessTokens.some((token) => call.authorization === `Bearer ${token}`))
    return problem(401, 'unauthorized');
  if (orderStart) {
    const offerId = (body as { offerId?: string }).offerId;
    if (offerId === id(2) || offerId === id(3)) return problem(409, 'offer_unavailable');
    const attempt = calls.filter((entry) => entry.method === 'POST' && entry.key === call.key).length;
    if (offerId === id(5) && attempt === 1) return problem(503, 'dependency_unavailable');
    const result: OrderStart = order(20, offerId === id(4) && attempt === 1 ? 'failed' : 'pending', offerId);
    return Response.json(result, {
      status: 201,
      headers: { location: `/v1/orders/${result.order.id}`, 'cache-control': 'no-store' },
    });
  }
  // The order read carries the subject summary in the asked language, as the offer read does.
  const read = (n: number, settlement: OrderRead['order']['settlement'], subject = true): Response => {
    const result = order(n, settlement);
    return json({
      order: { ...result.order, subject: subject ? summaryOf(call.languages, bookCover) : null },
    } satisfies OrderRead);
  };
  if (url.pathname === `/v1/orders/${id(10)}`) return read(10, 'paid');
  if (url.pathname === `/v1/orders/${id(11)}`) return read(11, settlePending ? 'paid' : 'pending');
  if (url.pathname === `/v1/orders/${id(12)}`) return read(12, 'pending');
  if (url.pathname === `/v1/orders/${orderWithoutSubject}`) return read(14, 'pending', false);
  if (url.pathname === `/v1/orders/${id(15)}`) return read(15, 'failed');
  if (url.pathname === `/v1/orders/${id(16)}`) return read(16, 'unknown');
  // An authenticated buyer cannot read another buyer's order.
  if (url.pathname === `/v1/orders/${id(13)}`) return problem(404, 'not_found');
  return problem(404, 'not_found');
}

// OpenID provider copied from session.test.ts, including PKCE and private_key_jwt validation.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
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
      const access = `access-${counter}`,
        refresh = `refresh-${counter}`;
      family.current = refresh;
      families.set(refresh, family);
      accessTokens.push(access);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: `openid offline_access ${scopes.join(' ')}`,
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
        // Reusing a rotated refresh token revokes its whole family.
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
    if (url.pathname.startsWith('/v1/')) return kernel(request, url);
    return new Response(null, { status: 404 });
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;

// The documented command, pointed at the fake through the environment it reads in development.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
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
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

// Sign-in and cookie helpers copied from session.test.ts.
const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]!
    .slice(name.length + 1);
async function signIn(returnTo = offerPath()) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location')!).searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub: 'alice',
    expiresIn: 3600,
  });
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: `${login}=${cookieValue(start, login)}` },
  });
  expect(answer.status, 'OpenID fixture completes sign-in').toBe(303);
  const value = cookieValue(answer, session);
  expect(value, 'OpenID fixture creates a session').toBeDefined();
  return { value: value!, access: accessTokens.at(-1)!, answer };
}

// Browser context and navigation steps copied from the browser tests; checkout needs scripts enabled.
let browser: Browser | undefined;
async function open(
  path: string,
  value?: string,
  look: { width: number; height: number; theme?: 'light' | 'dark' } = { width: 1280, height: 860 },
): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: look.width, height: look.height },
    reducedMotion: 'reduce',
  });
  if (look.theme)
    await context.addCookies([
      { name: 'rezics_theme', value: look.theme, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
    ]);
  // The fake kernel serves no media; every cover variant answers with a small image.
  await context.route(
    (url) => url.pathname.startsWith('/media/'),
    (route) => {
      const format = new URL(route.request().url()).pathname.split('/').at(-1)!.split('-')[0] as 'avif' | 'webp';
      return route.fulfill({ status: 200, body: images[format], contentType: `image/${format}` });
    },
  );
  if (value)
    await context.addCookies([
      { name: session, value, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
  // Keep every Stripe navigation local while retaining its real destination in the address bar.
  await context.route('https://checkout.stripe.com/**', (route) =>
    route.fulfill({ status: 200, body: '<h1>Stripe Checkout</h1>', contentType: 'text/html' }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}
afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});
const starts = () => calls.filter((call) => call.method === 'POST' && call.path === '/v1/orders');
const reads = (n: number) => calls.filter((call) => call.method === 'GET' && call.path === `/v1/orders/${id(n)}`);
const buy = (page: Page) => page.getByRole('button', { name: /^buy$/i });
const retry = (page: Page) => page.getByRole('button', { name: /retry|try again/i });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(50);
  expect(check()).toBe(true);
}

// Add anonymous offer loading and locale currency formatting to turn this into test(...).
test(
  "an offer page shows its title and price in the visitor's locale",
  async () => {
    for (const locale of ['en', 'de', 'ja']) {
      calls.length = 0;
      const page = await open(`/${locale}/offers/${id(1)}`);
      try {
        expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe(offer.offer.title);
        const price = new Intl.NumberFormat(locale, { style: 'currency', currency: offer.offer.currency }).format(
          offer.offer.unitAmountMinor / 100,
        );
        expect(await page.locator('main').innerText()).toContain(price);
        expect(calls).toContainEqual(
          expect.objectContaining({ method: 'GET', path: `/v1/offers/${id(1)}`, authorization: null }),
        );
        expect(starts()).toHaveLength(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Add the CSRF-protected order start route and Stripe redirect to turn this into test(...).
test(
  "a signed-in buyer starts checkout and is sent to Stripe's checkout URL",
  async () => {
    const auth = await signIn();
    calls.length = 0;
    const page = await open(offerPath(), auth.value);
    try {
      expect(await buy(page).count()).toBe(1);
      const html = await page.content();
      const csrf = await browserSessionToken(page);
      expect(csrf).toBeTruthy();
      const posts: { url: string; csrf: string | undefined }[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push({ url: request.url(), csrf: request.headers()['x-csrf-token'] });
      });
      await buy(page).click();
      await page.waitForURL(stripe);
      expect(starts()).toHaveLength(1);
      expect(starts()[0]).toMatchObject({ authorization: `Bearer ${auth.access}`, body: { offerId: id(1) } });
      expect(starts()[0]!.body).toEqual({ offerId: id(1) });
      expect(starts()[0]!.key).toMatch(uuid);
      expect(html).toContain(starts()[0]!.key!);
      expect(posts).toHaveLength(1);
      expect(new URL(posts[0]!.url).origin).toBe(await site());
      expect(posts[0]!.csrf).toBe(csrf!);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Send anonymous buyers through sign-in with an offer return_to to turn this into test(...).
test(
  'a signed-out visitor is sent to sign in and back to the offer',
  async () => {
    calls.length = 0;
    const path = offerPath();
    const page = await open(path);
    try {
      expect(await buy(page).count()).toBe(1);
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      await page
        .context()
        .route(`${fake.url.origin}/auth/authorize**`, (route) => route.fulfill({ status: 200, body: 'Sign in' }));
      await buy(page).click();
      await page.waitForURL(`${fake.url.origin}/auth/authorize**`);
      const start = requests.find((url) => new URL(url).pathname === '/auth/sign-in');
      expect(start).toBeDefined();
      expect(new URL(start!).searchParams.get('return_to')).toBe(path);
      expect(starts()).toHaveLength(0);
      const params = new URL(page.url()).searchParams;
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        challenge: params.get('code_challenge')!,
        nonce: params.get('nonce')!,
        redirectUri: params.get('redirect_uri')!,
        scope: params.get('scope')!,
        sub: 'alice',
        expiresIn: 3600,
      });
      await page.goto(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`);
      await page.locator('html[data-hydrated]').waitFor();
      expect(page.url()).toBe(`${await site()}${path}`);
      expect(await buy(page).count()).toBe(1);
      expect(starts()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Refuse delisted offers and handle a start-time 409 to turn this into test(...).
test(
  'a delisted offer says it is unavailable and starts nothing',
  async () => {
    const auth = await signIn();
    for (const n of [2, 3]) {
      calls.length = 0;
      const page = await open(offerPath(n), auth.value);
      try {
        if (n === 3) {
          expect(await buy(page).count()).toBe(1);
          await buy(page).click();
          await eventually(() => starts().length === 1);
          await page
            .getByText(/unavailable/i)
            .first()
            .waitFor();
        }
        expect(await page.locator('main').innerText()).toMatch(/unavailable/i);
        expect(
          await buy(page)
            .isEnabled()
            .catch(() => false),
        ).toBe(false);
        expect(await retry(page).count()).toBe(0);
        expect(starts()).toHaveLength(n === 2 ? 0 : 1);
        if (n === 3)
          expect(starts()[0]).toMatchObject({ body: { offerId: id(3) }, authorization: `Bearer ${auth.access}` });
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Preserve the rendered idempotency key across 503 and null-URL retries to turn this into test(...).
test(
  'an unavailable kernel lets the buyer retry with the same idempotency key',
  async () => {
    const auth = await signIn();
    for (const n of [5, 4]) {
      calls.length = 0;
      const page = await open(offerPath(n), auth.value);
      try {
        expect(await buy(page).count()).toBe(1);
        const html = await page.content();
        const csrf = await browserSessionToken(page);
        const tokens: (string | undefined)[] = [];
        page.on('request', (request) => {
          if (request.method() === 'POST') tokens.push(request.headers()['x-csrf-token']);
        });
        await buy(page).click();
        await retry(page).waitFor();
        expect(new URL(page.url()).origin).toBe(await site());
        expect(starts()).toHaveLength(1);
        const key = starts()[0]!.key;
        expect(key).toMatch(uuid);
        expect(html).toContain(key!);
        await retry(page).click();
        await eventually(() => starts().length === 2);
        expect(starts()).toHaveLength(2);
        for (const call of starts())
          expect(call).toMatchObject({ key, body: { offerId: id(n) }, authorization: `Bearer ${auth.access}` });
        expect(csrf).toBeTruthy();
        expect(tokens).toEqual([csrf!, csrf!]);
        await page.waitForURL(stripe);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

// Add locale-preserving order returns and poll pending settlement to turn this into test(...).
test(
  'the return page shows a paid order and rechecks a pending one until it settles',
  async () => {
    const auth = await signIn();
    const origin = await site();
    for (const headers of [{ cookie: 'rezics_locale=ja', 'accept-language': 'de' }, { 'accept-language': 'de' }]) {
      const root = await fetch(`${origin}/`, { headers, redirect: 'manual' });
      const locale = new URL(root.headers.get('location')!, origin).pathname.replaceAll('/', '');
      const response = await fetch(`${origin}/orders/${id(10)}?checkout=success&source=stripe`, {
        headers,
        redirect: 'manual',
      });
      expect([302, 303, 307, 308]).toContain(response.status);
      expect(new URL(response.headers.get('location')!, origin).pathname).toBe(`/${locale}/orders/${id(10)}`);
      expect(new URL(response.headers.get('location')!, origin).search).toBe('?checkout=success&source=stripe');
    }
    for (const n of [10, 11]) {
      calls.length = 0;
      settlePending = false;
      const page = await open(`/en/orders/${id(n)}?checkout=success`, auth.value);
      try {
        if (n === 11) {
          expect(await page.locator('main').innerText()).toMatch(/waiting|pending|processing/i);
          expect(await page.locator('main').innerText()).not.toMatch(/payment confirmed|payment received/i);
          settlePending = true;
          await eventually(() => reads(n).length >= 2);
          await page.waitForFunction(() =>
            /paid|confirmed|payment received/i.test(document.querySelector('main')?.textContent ?? ''),
          );
          expect(reads(n).at(-1)!.at - reads(n)[0]!.at).toBeGreaterThanOrEqual(100);
        }
        expect(await page.locator('main').innerText()).toMatch(/paid|confirmed|payment received/i);
        expect(reads(n).length).toBeGreaterThanOrEqual(n === 11 ? 2 : 1);
        for (const call of reads(n)) expect(call.authorization).toBe(`Bearer ${auth.access}`);
        expect(starts()).toHaveLength(0);
      } finally {
        settlePending = true;
        await page.context().close();
      }
    }
  },
  timeout,
);

// Add the canceled return note and link to its offer to turn this into test(...).
test(
  'a canceled checkout returns to the offer with a note',
  async () => {
    const auth = await signIn();
    calls.length = 0;
    const page = await open(`/en/orders/${id(12)}?checkout=canceled`, auth.value);
    try {
      expect(await page.locator('main').innerText()).toMatch(/cancel(?:ed|led)/i);
      const back = page.locator(`main a[href="${offerPath()}"]`);
      expect(await back.count()).toBe(1);
      expect(reads(12)).toHaveLength(1);
      expect(reads(12)[0]!.authorization).toBe(`Bearer ${auth.access}`);
      expect(starts()).toHaveLength(0);
      await back.click();
      expect(page.url()).toBe(`${await site()}${offerPath()}`);
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe(offer.offer.title);
      expect(starts()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Map the buyer-scoped kernel 404 to the site's not-found page to turn this into test(...).
test(
  "another person's order is not found",
  async () => {
    const auth = await signIn();
    calls.length = 0;
    const response = await fetch(`${await site()}/en/orders/${id(13)}?checkout=success`, {
      headers: { cookie: `${session}=${auth.value}` },
    });
    expect(response.status).toBe(404);
    expect(reads(13)).toHaveLength(1);
    expect(reads(13)[0]!.authorization).toBe(`Bearer ${auth.access}`);
    const page = await open(`/en/orders/${id(13)}?checkout=success`, auth.value);
    try {
      expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe('Page not found');
      expect(await page.locator('main').innerText()).toContain('The page you requested could not be found.');
      expect(await page.locator('main').innerText()).not.toMatch(/paid|confirmed|cs_test_checkout/i);
      expect(starts()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

const subjectPath = (locale: string) => `/${locale}/subjects/${id(90)}/${slug(bookLabels[locale] ?? bookLabels.en!)}`;

test(
  "an offer page draws the subject it sells through Cover with its title in the visitor's language and links to the subject's page",
  async () => {
    for (const locale of ['en', 'de', 'ja']) {
      calls.length = 0;
      const page = await open(`/${locale}/offers/${id(1)}`);
      try {
        expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe(offer.offer.title);
        const sources = page.locator('main picture source');
        expect(await sources.count()).toBe(2);
        expect(await sources.nth(0).getAttribute('type')).toBe('image/avif');
        expect(await sources.nth(1).getAttribute('type')).toBe('image/webp');
        const avif = (await sources.nth(0).getAttribute('srcset'))!;
        const webp = (await sources.nth(1).getAttribute('srcset'))!;
        expect(avif).toMatch(new RegExp(`/media/${coverMedia}/avif-\\d+ `));
        expect(webp).toMatch(new RegExp(`/media/${coverMedia}/webp-\\d+ `));
        expect(await page.locator('main picture img').count()).toBe(1);
        const link = page.getByRole('link', { name: bookLabels[locale]!, exact: true });
        expect(await link.count()).toBe(1);
        expect(await link.getAttribute('href')).toBe(subjectPath(locale));
        // The link's name is its label alone: the cover inside it is a decorative repeat.
        expect(await link.locator('img').getAttribute('alt')).toBe('');
        const reads = calls.filter((call) => call.method === 'GET' && call.path === `/v1/offers/${id(1)}`);
        expect(reads).toHaveLength(1);
        expect(reads[0]!.languages).toBe(locale);
        expect(reads[0]!.authorization).toBeNull();
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'an offer whose subject has no cover or no summary shows the typographic placeholder and still sells',
  async () => {
    const auth = await signIn();
    for (const [n, title, linked] of [
      [6, offer.offer.title, false],
      [7, bookLabels.en!, true],
    ] as const) {
      calls.length = 0;
      const page = await open(offerPath(n), auth.value);
      try {
        expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe(offer.offer.title);
        const cover = page.locator('main [data-slot="cover"]');
        expect(await cover.count()).toBe(1);
        expect(await cover.getAttribute('data-state')).toBe('placeholder');
        expect(await cover.textContent()).toContain(title);
        expect(await page.locator('main img').count()).toBe(0);
        expect(await page.locator('main a[href*="/subjects/"]').count()).toBe(linked ? 1 : 0);
        await buy(page).click();
        await page.waitForURL(stripe);
        expect(starts()).toHaveLength(1);
        expect(starts()[0]).toMatchObject({ body: { offerId: id(n) }, authorization: `Bearer ${auth.access}` });
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'the offer page with a cover has no accessibility violations in either theme at phone and desktop widths',
  async () => {
    const found: string[] = [];
    for (const theme of ['light', 'dark'] as const)
      for (const width of [390, 1280]) {
        const page = await open(offerPath(), undefined, { width, height: 844, theme });
        try {
          expect(await page.locator('main picture img').count()).toBe(1);
          const result = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
            .analyze();
          for (const violation of result.violations)
            found.push(
              `${theme} ${width}px: ${violation.id} ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
            );
        } finally {
          await page.context().close();
        }
      }
    expect(found).toEqual([]);
  },
  timeout,
);

test(
  "the return page shows the order's title and the subject's cover in every settlement state",
  async () => {
    const auth = await signIn();
    for (const [n, locale] of [
      [10, 'en'],
      [11, 'en'],
      [15, 'en'],
      [16, 'en'],
      [10, 'de'],
      [10, 'ja'],
    ] as const) {
      calls.length = 0;
      settlePending = false;
      const page = await open(`/${locale}/orders/${id(n)}?checkout=success`, auth.value);
      try {
        expect(await page.locator('main').innerText()).toContain(offer.offer.title);
        const sources = page.locator('main picture source');
        expect(await sources.count()).toBe(2);
        expect(await sources.nth(0).getAttribute('srcset')).toMatch(new RegExp(`/media/${coverMedia}/avif-\\d+ `));
        expect(await sources.nth(1).getAttribute('srcset')).toMatch(new RegExp(`/media/${coverMedia}/webp-\\d+ `));
        expect(await page.locator('main picture img').count()).toBe(1);
        const link = page.getByRole('link', { name: bookLabels[locale]!, exact: true });
        expect(await link.getAttribute('href')).toBe(subjectPath(locale));
        expect(reads(n)[0]!.languages).toBe(locale);
        expect(reads(n)[0]!.authorization).toBe(`Bearer ${auth.access}`);
        if (n === 11) {
          // A settlement change from a recheck keeps the cover it already drew.
          await page.locator('main picture img').evaluate((img) => ((img as HTMLElement).dataset.kept = 'yes'));
          settlePending = true;
          await page.waitForFunction(() =>
            /paid|confirmed|payment received/i.test(document.querySelector('main')?.textContent ?? ''),
          );
          expect(await page.locator('main picture img').getAttribute('data-kept')).toBe('yes');
          expect(await page.locator('main').innerText()).toContain(offer.offer.title);
        }
      } finally {
        settlePending = true;
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "an order whose subject has no summary shows the placeholder with the order's title",
  async () => {
    const auth = await signIn();
    calls.length = 0;
    const page = await open(`/en/orders/${orderWithoutSubject}?checkout=success`, auth.value);
    try {
      expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
      const cover = page.locator('main [data-slot="cover"]');
      expect(await cover.count()).toBe(1);
      expect(await cover.getAttribute('data-state')).toBe('placeholder');
      expect(await cover.textContent()).toContain(offer.offer.title);
      expect(await page.locator('main').innerText()).toContain(offer.offer.title);
      expect(await page.locator('main img').count()).toBe(0);
      expect(await page.locator('main a[href*="/subjects/"]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the order status recheck keeps its response shape',
  async () => {
    const auth = await signIn();
    for (const [n, settlement] of [
      [10, 'paid'],
      [12, 'pending'],
      [15, 'failed'],
    ] as const) {
      calls.length = 0;
      const response = await fetch(`${await site()}/orders/${id(n)}/status`, {
        headers: { accept: 'application/json', cookie: `${session}=${auth.value}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: id(n), offerId: id(1), settlement });
      expect(reads(n)).toHaveLength(1);
      expect(reads(n)[0]!.languages).toBeNull();
    }
  },
  timeout,
);
