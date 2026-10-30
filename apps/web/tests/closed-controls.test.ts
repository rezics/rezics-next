import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createStoryRecordedKernelFetch, storyViewerId } from '../src/kernel/fake';
import subject from '../src/kernel/recorded/subject.json';
import offer from '../src/kernel/recorded/offer.json';
import collection from '../src/kernel/recorded/library-collection.json';
import progress from '../src/kernel/recorded/library-progress-session.json';

const app = join(import.meta.dir, '..');
const timeout = 1_200_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const loginCookie = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = [
  'thread:create',
  'post:create',
  'media:create',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
  'order:create',
  'order:read',
];
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
};
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
type KernelCall = { method: string; path: string; body: unknown; authorization: string | null };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const calls: KernelCall[] = [];
let admitted: string[] = [];
let exposureMode: 'ok' | 'failed' | 'slow' = 'ok';
let releaseExposure: (() => void) | undefined;
const recorded = createStoryRecordedKernelFetch();
const json = (body: unknown, status = 200) => Response.json(body, { status });
let accessCount = 0;
let sessionReads = 0;
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/session-read') {
      sessionReads += 1;
      return new Response(null, { status: 204 });
    }
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const verifyClient = async (form: URLSearchParams) => {
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
      accessCount += 1;
      const access = `access-${accessCount}`;
      const refresh = `refresh-${accessCount}`;
      family.current = refresh;
      families.set(refresh, family);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (nonce !== undefined)
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(family.sub)
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
      if (!(await verifyClient(form))) return json({ error: 'invalid_client' }, 401);
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        const verifier = form.get('code_verifier') ?? '';
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        return issue({ sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false }, grant.nonce);
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
      if (!(await verifyClient(form))) return json({ error: 'invalid_client' }, 401);
      const family = families.get(form.get('token') ?? '');
      if (family) family.revoked = true;
      return new Response(null, { status: 200 });
    }
    calls.push({
      method: request.method,
      path: url.pathname,
      body: null,
      authorization: request.headers.get('authorization'),
    });
    if (url.pathname === '/v1/platform/exposure') {
      if (exposureMode === 'failed') return json({ error: 'unavailable' }, 503);
      if (exposureMode === 'slow')
        await new Promise<void>((resolve) => {
          releaseExposure = resolve;
        });
      return json({ admitted });
    }
    if (url.pathname === `/v1/subjects/${subject.subject.id}/collections`) return json({ collections: [], next: null });
    return recorded(request);
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
function site(): Promise<string> {
  started ??= (async () => {
    const config = join(app, '.temp/closed-controls-vite.config.ts');
    await mkdir(join(app, '.temp'), { recursive: true });
    await Bun.write(
      config,
      `
      import config from ${JSON.stringify(pathToFileURL(join(app, 'vite.config.ts')).href)};
      export default { ...config, plugins: [...config.plugins, {
        name: 'count-exposure-session-rpcs', enforce: 'pre',
        transform(code, id) {
          if (!id.endsWith('/src/session/store.ts')) return;
          return code
            .replace('async signedIn(): Promise<{ signedIn: boolean; subject?: string; csrfToken: string | null }> {', '$& await fetch(${JSON.stringify(`${fake.url.origin}/session-read`)});')
            .replace('credential(): Promise<Credential> {', 'credential(): Promise<Credential> { return fetch(${JSON.stringify(`${fake.url.origin}/session-read`)}).then(() => this.countedCredential()); } private countedCredential(): Promise<Credential> {');
        }
      }] };
    `,
    );
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
    child = spawn(
      'bun',
      ['run', 'dev', '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
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
      },
    );
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
      if (Date.now() > deadline) throw new Error(`dev server did not start:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]!
    .slice(name.length + 1);

async function signIn(returnTo: string) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location')!).searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub: storyViewerId,
    expiresIn: 3600,
  });
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: `${loginCookie}=${cookieValue(start, loginCookie)}` },
  });
  expect(answer.status, 'OpenID fixture completes sign-in').toBe(303);
  const value = cookieValue(answer, sessionCookie);
  expect(value, 'OpenID fixture creates a session').toBeDefined();
  return value!;
}

let browser: Browser | undefined;
async function open(path: string, signedIn = true): Promise<Page> {
  const value = signedIn ? await signIn(path) : undefined;
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  if (value)
    await context.addCookies([
      { name: sessionCookie, value, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
  const page = await context.newPage();
  const pending = new Set<string>();
  page.on('request', (request) => pending.add(request.url()));
  page.on('requestfinished', (request) => pending.delete(request.url()));
  page.on('requestfailed', (request) => pending.delete(request.url()));
  try {
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: 120_000 });
  } catch (error) {
    throw new Error(`${error}\nPending: ${[...pending].join(', ')}\n${await page.locator('body').innerText()}`);
  }
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

const paths = {
  subject: `/en/subjects/${subject.subject.id}`,
  library: '/en/library',
  progress: `/en/library/progress?subjectId=${progress.progressSession.subjectId}`,
  session: `/en/library/progress/${progress.progressSession.id}`,
  collections: '/en/library/collections',
  collection: `/en/collections/${collection.collection.id}`,
  following: '/en/library/following',
  offer: `/en/offers/${offer.offer.id}`,
};
// Real controls, including menu triggers: hiding only menu contents leaves a misleading control.
const probes = [
  { path: paths.subject, group: 'personal_library', selector: '[data-library-entry]' },
  { path: paths.subject, group: 'collections', selector: '[data-add-to-collection]' },
  { path: paths.subject, group: 'collections', selector: '[data-public-collections]' },
  { path: paths.library, group: 'personal_library', selector: 'main button[aria-label^="Actions for"]' },
  { path: paths.progress, group: 'reading_progress', selector: 'main button[type="submit"]' },
  { path: paths.session, group: 'reading_progress', selector: 'main button[type="submit"]' },
  { path: paths.collections, group: 'collections', selector: 'main a[href$="/collections/new"]' },
  { path: paths.collection, group: 'collections', selector: 'main button[aria-label="More actions"]' },
  { path: paths.following, group: 'personal_library', selector: 'main button[data-slot="dropdown-menu-trigger"]' },
  { path: paths.offer, group: 'purchases', selector: 'main button' },
];

async function assertProbes(groups: string[], signedIn = true) {
  admitted = groups;
  for (const path of new Set(probes.map((probe) => probe.path))) {
    const page = await open(path, signedIn);
    try {
      for (const probe of probes.filter((probe) => probe.path === path)) {
        const expected =
          groups.includes(probe.group) &&
          (signedIn || probe.selector === '[data-public-collections]' || path === paths.offer);
        if (expected) await page.locator(probe.selector).first().waitFor();
        expect(
          await page.locator(probe.selector).count(),
          `${path} ${probe.selector}, admitted ${groups}`,
        ).toBeGreaterThanOrEqual(expected ? 1 : 0);
        if (!expected) expect(await page.locator(probe.selector).count(), `${path} ${probe.selector}`).toBe(0);
      }
      if (signedIn) {
        if (groups.includes('personal_library')) await page.locator('nav a[href="/en/library"]').first().waitFor();
        expect((await page.locator('nav a[href="/en/library"]').count()) > 0).toBe(groups.includes('personal_library'));
      }
    } catch (error) {
      throw new Error(
        `${error}\nPage: ${await page.locator('body').innerText()}\nExposure calls: ${JSON.stringify(calls.filter((call) => call.path === '/v1/platform/exposure').slice(-5))}`,
      );
    } finally {
      await page.context().close();
    }
  }
}

test(
  'no admitted group hides gated controls on subject, library, progress, collections, Following and offer, including Library navigation',
  async () => {
    await assertProbes([]);
  },
  timeout,
);

test(
  'each admitted group shows exactly its controls after hydration for signed-in and eligible anonymous viewers',
  async () => {
    for (const group of [
      'personal_library',
      'reading_progress',
      'collections',
      'purchases',
      'selling',
      'agent_verification',
    ]) {
      await assertProbes([group]);
    }
    for (const group of ['collections', 'purchases']) {
      admitted = [group];
      // Expire the previous anonymous isolate entry before changing its public opening.
      await Bun.sleep(60_050);
      for (const path of [paths.subject, paths.offer]) {
        const page = await open(path, false);
        try {
          if (path === paths.subject && group === 'collections')
            await page.locator('[data-public-collections]').waitFor();
          if (path === paths.offer && group === 'purchases')
            await page.getByRole('button', { name: 'Buy', exact: true }).waitFor();
          expect((await page.locator('[data-public-collections]').count()) > 0).toBe(
            path === paths.subject && group === 'collections',
          );
          if (path === paths.offer)
            expect(await page.getByRole('button', { name: 'Buy', exact: true }).count()).toBe(
              group === 'purchases' ? 1 : 0,
            );
        } finally {
          await page.context().close();
        }
      }
    }
  },
  timeout,
);

test(
  'absent groups and failed or pending exposure reads keep controls hidden',
  async () => {
    admitted = ['an-unrelated-group'];
    let page = await open(paths.offer);
    expect(await page.getByRole('button', { name: 'Buy', exact: true }).count()).toBe(0);
    await page.context().close();
    exposureMode = 'failed';
    page = await open(paths.offer);
    expect(await page.getByRole('button', { name: 'Buy', exact: true }).count()).toBe(0);
    await page.context().close();
    exposureMode = 'slow';
    releaseExposure = undefined;
    admitted = ['purchases'];
    // A pending server function must not block hydration or reveal the Buy control.
    const origin = await site();
    browser ??= await chromium.launch();
    const value = await signIn(paths.offer);
    const slowContext = await browser.newContext();
    await slowContext.addCookies([
      { name: sessionCookie, value, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
    page = await slowContext.newPage();
    try {
      await page.goto(`${origin}${paths.offer}`);
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      expect(await page.getByRole('button', { name: 'Buy', exact: true }).count()).toBe(0);
      const deadline = Date.now() + 10_000;
      while (!releaseExposure && Date.now() < deadline) await Bun.sleep(10);
      expect(releaseExposure, 'the viewer exposure read is pending').toBeDefined();
      releaseExposure!();
      await page.getByRole('button', { name: 'Buy', exact: true }).waitFor();
    } finally {
      exposureMode = 'ok';
      releaseExposure?.();
      await page.context().close();
    }
  },
  timeout,
);

// This explicit list excludes backend administration/selling and verification, which have no site surface.
const neverCalled = [
  'account.read_verification_request',
  'account.release_verification',
  'account.request_verification',
  'account.revoke_verification',
  'account.withdraw_verification',
  'verification_request.list_pending',
  'verification_request.approve',
  'verification_request.reject',
  'offer.create',
  'offer.delist',
  'offer.revise',
  'payout_statement.list',
  'payout_statement.get',
  'payout_statement.lines',
  'payout_statement.mark_paid',
  'entitlement.list',
  'rating.vote_delete',
  'rating.vote_get',
  'rating.vote_put',
  'rating.source_statistic_put',
];
test('operation-to-group map equals OpenAPI exposure and accounts for every gated operation', async () => {
  const source = await Bun.file(join(app, 'src/kernel/exposure.ts')).text();
  const literal = source.match(/export const operationGroups\s*=\s*({[\s\S]*?})\s*as const/);
  expect(literal, 'exposure exports a literal operationGroups map').not.toBeNull();
  const map = Function(`return (${literal![1]})`)() as Record<string, string>;
  const contract = await Bun.file(join(app, '../../contracts/openapi.json')).json();
  const gated: Record<string, string> = {};
  for (const methods of Object.values(contract.paths) as Record<
    string,
    { operationId?: string; 'x-exposure'?: string }
  >[]) {
    for (const op of Object.values(methods))
      if (op['x-exposure']?.startsWith('gate:')) gated[op.operationId!] = op['x-exposure'].slice(5);
  }
  for (const [operation, group] of Object.entries(map)) expect(group, operation).toBe(gated[operation]);
  expect(Object.keys(gated).sort()).toEqual([...Object.keys(map), ...neverCalled].sort());
});

test(
  'ten public server renders share one anonymous exposure read with and without cookies; signed-in load and three client navigations share one viewer read',
  async () => {
    const origin = await site();
    const value = await signIn('/en');
    await Bun.sleep(60_050);
    const before = calls.filter((call) => call.path === '/v1/platform/exposure' && call.authorization === null).length;
    sessionReads = 0;
    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const response = await fetch(`${origin}/en`, {
          headers: index % 2 ? { cookie: `${sessionCookie}=${value}` } : {},
        });
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain('rezics-platform-closed');
      }),
    );
    expect(Date.now() - startedAt, 'all ten public renders occur within the cache window').toBeLessThan(60_000);
    const reads =
      calls.filter((call) => call.path === '/v1/platform/exposure' && call.authorization === null).length - before;
    expect(reads).toBe(1);
    expect(sessionReads, 'public HTML does not read a session').toBe(0);
    admitted = ['personal_library', 'collections', 'reading_progress'];
    calls.length = 0;
    const page = await open('/en');
    try {
      await page.locator('nav a[href="/en/library"]').first().click();
      await page.waitForURL('**/en/library');
      const search = page.locator('header input[name="q"]:visible');
      expect(await search.count(), 'the centered shell search field remains available after navigation').toBe(1);
      await search.fill('The');
      await search.press('Enter');
      await page.waitForURL('**/en/search?q=The');
      await page.locator('nav a[href="/en"]').first().click();
      await page.waitForURL('**/en');
      expect(calls.filter((call) => call.path === '/v1/platform/exposure' && call.authorization !== null)).toHaveLength(
        1,
      );
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
