import { browserSessionToken } from './session-token';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { slug } from '@rezics/definitions/slug';
import { chromium, type Browser, type Page, type Request as BrowserRequest } from 'playwright';
import fixtures from '../src/kernel/fixtures.json';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = ['reaction:set'];
const subjectId = fixtures.subjects[0]!.id;
const subjectPath = `/en/subjects/${subjectId}/${slug(fixtures.subjects[0]!.labels.en!)}`;

const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = { challenge: string; nonce: string; redirectUri: string; scope: string; sub: string; expiresIn: number };
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
type Kind = 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
type Call = { method: string; path: string; body: unknown; key: string | null; authorization: string | null };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const accessTokens: string[] = [];
let counter = 0;
let calls: Call[] = [];
let counts: Partial<Record<Kind, number>> = {};
let own: Kind | null = null;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const problem = (status: number, code: string) => ({
  type: `https://rezics.com/problems/${code}`,
  title: code,
  status,
  code,
  retryable: false,
  effect_status: 'not_applicable',
  request_id: randomUUID(),
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reset(next: Partial<Record<Kind, number>> = { like: 6, love: 3, laugh: 2, insightful: 4, sad: 1 }) {
  calls = [];
  counts = next;
  own = null;
}

// The auth provider and the site dev-server setup follow library-subject-slot.test.ts.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/turnstile.js')
      return new Response(
        `
        window.turnstile = {
          render(container, options) {
            const verify = document.createElement('button');
            verify.type = 'button'; verify.textContent = 'Verify test challenge';
            verify.onclick = () => options.callback('token-' + crypto.randomUUID());
            container.append(verify);
            return '1';
          },
          reset() {},
          remove(id) {}
        };
      `,
        { headers: { 'content-type': 'text/javascript' } },
      );
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
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        return issue({ sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false }, grant.nonce);
      }
      if (form.get('grant_type') === 'refresh_token') {
        const family = families.get(form.get('refresh_token') ?? '');
        if (!family || family.revoked || family.current !== form.get('refresh_token'))
          return json({ error: 'invalid_grant' }, 400);
        return issue(family);
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') return new Response(null, { status: 200 });
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body =
      request.method === 'GET' || request.method === 'DELETE'
        ? null
        : await request
            .clone()
            .json()
            .catch(() => null);
    calls.push({
      method: request.method,
      path: url.pathname,
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    const subjectRead = createFakeKernelFetch(fixtures as never);
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${subjectId}`) return subjectRead(request);
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') return subjectRead(request);
    if (url.pathname === `/v1/subjects/${subjectId}/reactions` && request.method === 'GET')
      return json({
        counts: Object.entries(counts).map(([kind, count]) => ({ kind, count })),
        watermark: null,
      });
    if (url.pathname === `/v1/subjects/${subjectId}/reaction`) {
      if (request.method === 'GET') {
        if (!request.headers.get('authorization')) return json(problem(401, 'unauthorized'), 401);
        return json({ kind: own });
      }
      if (request.method === 'PUT') {
        own = (body as { kind: Kind }).kind;
        return json({ kind: own });
      }
      if (request.method === 'DELETE') {
        own = null;
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === '/v1/reports' && request.method === 'POST')
      return json({ reportId: '0192f3a0-6c1e-7b2a-9d4e-0000000000aa' }, 201);
    return json(problem(404, 'not_found'), 404);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}
let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
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
        TURNSTILE_SITE_KEY: 'subject-test-key',
        TURNSTILE_SCRIPT_URL: `${fake.url.origin}/turnstile.js`,
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
        if (response.status < 500) {
          const page = await fetch(`${origin}${subjectPath}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(90_000),
          });
          if (page.status >= 500) throw new Error(`subject page did not compile:\n${output}`);
          return origin;
        }
      } catch {
        /* wait for Vite */
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}
const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1);
async function signIn(returnTo = subjectPath) {
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
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303]).toContain(answer.status);
  return { origin, session: cookieValue(answer, session)!, access: accessTokens.at(-1)! };
}
let browser: Browser | undefined;
async function open(
  path: string,
  options: { signedIn?: boolean; javaScript?: boolean; width?: number } = {},
): Promise<{ page: Page; access: string | undefined; origin: string }> {
  const { signedIn = true, javaScript = true, width = 1280 } = options;
  const auth = signedIn ? await signIn(path) : undefined;
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: javaScript,
  });
  if (auth)
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
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(120_000);
  await page.goto(`${origin}${path}`, { waitUntil: javaScript ? 'networkidle' : 'load' });
  if (javaScript) await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return { page, access: auth?.access, origin };
}
afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* dev server already exited */
    }
});

const cluster = (page: Page) => page.locator('main header').getByRole('group', { name: 'Reactions' });
const slotCalls = () => calls.filter((call) => call.method !== 'GET' && call.path.endsWith('/reaction'));
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(50);
  expect(await check()).toBe(true);
}
async function pressed(page: Page, name: string) {
  return cluster(page).getByRole('button', { name, exact: true }).getAttribute('aria-pressed', { timeout: 250 });
}
async function chipState(page: Page, name: string, value: string) {
  try {
    return (await pressed(page, name)) === value;
  } catch {
    return false;
  }
}

test(
  "the subject header's reaction cluster sits top right with like, love, laugh, insightful and sad and their counts, and no upvote or downvote",
  async () => {
    reset();
    for (const width of [1280, 390]) {
      const { page } = await open(subjectPath, { width });
      try {
        const group = cluster(page);
        // On a phone the row keeps the two most used kinds; the others wait in the picker.
        const row =
          width >= 640 ? ['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1'] : ['Like 6', 'Insightful 4'];
        for (const name of ['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1'])
          expect(await group.getByRole('button', { name, exact: true }).count()).toBe(row.includes(name) ? 1 : 0);
        expect(await group.getByRole('button', { name: /^(Upvote|Downvote)/ }).count()).toBe(0);
        await group.getByRole('button', { name: 'React', exact: true }).click();
        const choices = page.getByRole('dialog', { name: 'Choose a reaction' });
        const offered = await choices.getByRole('button').allInnerTexts();
        const names = offered.map((text) => text.replace(/\s+/g, ' ').trim());
        expect(names).toEqual(
          width >= 640
            ? ['Like', 'Love', 'Laugh', 'Insightful', 'Sad']
            : ['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1'],
        );
        expect(await page.getByText(/Upvote|Downvote/).count()).toBe(0);
        await page.keyboard.press('Escape');

        const box = (await group.boundingBox())!;
        const title = (await page.locator('main h1').boundingBox())!;
        const header = (await page.locator('main header').boundingBox())!;
        if (width >= 1024) {
          // Top right of the header: beside the title block, in its right half and level with its first line.
          expect(box.x).toBeGreaterThan(header.x + header.width / 2);
          expect(box.x + box.width).toBeLessThanOrEqual(header.x + header.width + 1);
          expect(box.y).toBeLessThan(title.y + title.height);
        }
        // Nothing overflows sideways on a phone.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a signed-in reader sets one reaction, a new kind replaces the old, and removing it clears it',
  async () => {
    reset();
    own = 'insightful';
    const { page, access, origin } = await open(subjectPath);
    const browserPosts: BrowserRequest[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).origin === origin) browserPosts.push(request);
    });
    try {
      const group = cluster(page);
      expect(await pressed(page, 'Insightful 4')).toBe('true');
      expect(await pressed(page, 'Like 6')).toBe('false');

      await group.getByRole('button', { name: 'React', exact: true }).click();
      const choices = page.getByRole('dialog', { name: 'Choose a reaction' });
      await choices.getByRole('button', { name: 'Like', exact: true }).click();
      await eventually(() => slotCalls().length === 1);
      await eventually(() => chipState(page, 'Like 7', 'true'));
      expect(await chipState(page, 'Insightful 3', 'false')).toBe(true);

      await choices.getByRole('button', { name: 'Love', exact: true }).click();
      await eventually(() => slotCalls().length === 2);
      await eventually(() => chipState(page, 'Love 4', 'true'));
      expect(await chipState(page, 'Like 6', 'false')).toBe(true);

      await group.getByRole('button', { name: 'Love 4', exact: true }).click();
      await eventually(() => slotCalls().length === 3);
      await eventually(() => chipState(page, 'Love 3', 'false'));
      expect(await group.locator('[aria-pressed="true"]').count()).toBe(0);

      const path = `/v1/subjects/${subjectId}/reaction`;
      expect(slotCalls().map((call) => `${call.method} ${call.path}`)).toEqual([
        `PUT ${path}`,
        `PUT ${path}`,
        `DELETE ${path}`,
      ]);
      expect(slotCalls().map((call) => call.body)).toEqual([{ kind: 'like' }, { kind: 'love' }, null]);
      for (const call of slotCalls()) {
        expect(call.authorization).toBe(`Bearer ${access}`);
        expect(call.key).toMatch(uuid);
      }
      expect(new Set(slotCalls().map((call) => call.key)).size).toBe(3);
      expect(own).toBeNull();

      expect(browserPosts).toHaveLength(3);
      const csrf = await browserSessionToken(page);
      expect(csrf).toBeTruthy();
      for (const request of browserPosts) expect(request.headers()['x-csrf-token']).toBe(csrf!);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'signed out, the counts show and reacting offers sign-in; without JavaScript the same public controls show',
  async () => {
    reset();
    const { page, origin } = await open(subjectPath, { signedIn: false });
    try {
      const group = cluster(page);
      expect(await group.getByRole('img', { name: 'Like 6', exact: true }).count()).toBe(1);
      expect(await group.getByRole('img').count()).toBe(5);
      expect(await group.getByRole('button').count()).toBe(0);
      const link = group.getByRole('link', { name: 'React', exact: true });
      const target = new URL((await link.getAttribute('href'))!, origin);
      expect(`${target.origin}${target.pathname}`).toBe(`${origin}/auth/sign-in`);
      expect(target.searchParams.get('return_to')).toBe(subjectPath);
      expect(calls.some((call) => call.path.endsWith('/reaction'))).toBe(false);
      expect(slotCalls()).toHaveLength(0);
    } finally {
      await page.context().close();
    }

    // Until the browser reads the session, even a signed-in reader sees the public controls.
    const bare = await open(subjectPath, { javaScript: false });
    try {
      const buttons = cluster(bare.page).getByRole('button');
      expect(await buttons.count()).toBe(0);
      expect(await cluster(bare.page).getByRole('link', { name: 'React', exact: true }).count()).toBe(1);
      expect(await cluster(bare.page).getByRole('img', { name: 'Like 6', exact: true }).count()).toBe(1);
    } finally {
      await bare.page.context().close();
    }
  },
  timeout,
);

test(
  "reporting the subject lives in the header's overflow menu",
  async () => {
    reset();
    const { page } = await open(subjectPath, { signedIn: false });
    try {
      // No visible report button; the menu sits beside the cluster in the header.
      expect(await page.getByRole('button', { name: 'Report', exact: true }).count()).toBe(0);
      const menu = page.locator('main header').getByRole('button', { name: 'More actions', exact: true });
      expect(await menu.count()).toBe(1);
      const group = (await cluster(page).boundingBox())!;
      const trigger = (await menu.boundingBox())!;
      expect(Math.abs(trigger.y + trigger.height / 2 - (group.y + group.height / 2))).toBeLessThan(group.height);

      await menu.click();
      await page.getByRole('menuitem', { name: 'Copy link', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: 'Report', exact: true }).click();
      await page.getByRole('dialog', { name: 'Report this content', exact: true }).waitFor();
      await page.getByRole('radio', { name: 'Spam', exact: true }).check();
      await page.getByRole('button', { name: 'Verify test challenge', exact: true }).click();
      await page.getByRole('button', { name: 'Submit report', exact: true }).click();
      await page.getByRole('status', { name: 'Thank you for your report.', exact: true }).waitFor();
      const reports = calls.filter((call) => call.method === 'POST' && call.path === '/v1/reports');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.body).toEqual({
        target: { kind: 'subject', id: subjectId },
        reason: 'spam',
        botToken: expect.stringMatching(/^token-/),
      });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// The counts are one kernel read and the reader's own reaction one more, whatever the number of reactions.
test(
  'reading a subject costs one counts read, plus one own-reaction read when signed in, at 1, 10 and 100 reactions',
  async () => {
    const auth = await signIn();
    const reads: Record<string, number[]> = { out: [], in: [] };
    for (const total of [1, 10, 100]) {
      reset({ like: total });
      const signedOut = await fetch(`${auth.origin}${subjectPath}`);
      expect(signedOut.status).toBe(200);
      expect(await signedOut.text()).toContain(`Like ${total}`);
      const outCounts = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reactions`);
      const outOwn = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reaction`);
      expect(outCounts).toHaveLength(1);
      expect(outOwn).toHaveLength(0);
      reads.out!.push(outCounts.length + outOwn.length);

      reset({ like: total });
      own = 'like';
      const signedIn = await fetch(`${auth.origin}${subjectPath}`, {
        headers: { cookie: `${session}=${auth.session}` },
      });
      expect(signedIn.status).toBe(200);
      expect(await signedIn.text()).toContain(`Like ${total}`);
      const inCounts = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reactions`);
      const inOwn = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reaction`);
      expect(inCounts).toHaveLength(1);
      expect(inOwn).toHaveLength(1);
      expect(inOwn[0]!.authorization).toBe(`Bearer ${auth.access}`);
      expect(calls.filter((call) => call.path.includes('/reaction') && call.method !== 'GET')).toHaveLength(0);
      reads.in!.push(inCounts.length + inOwn.length);
    }
    expect(new Set(reads.out).size).toBe(1);
    expect(new Set(reads.in).size).toBe(1);
  },
  timeout,
);
