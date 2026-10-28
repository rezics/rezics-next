import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import fixtures from '../src/kernel/fixtures.json';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = ['openid'];
const subject = fixtures.subjects[0]!;
const subjectId = subject.id;
const stamp = '2026-04-02T15:04:05.000Z';
const shelfId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const fullShelfId = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
const publicShelfId = '0192f3a0-6c1e-7b2a-9d4e-000000000103';

const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = { challenge: string; nonce: string; redirectUri: string; scope: string; sub: string; expiresIn: number };
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
let counter = 0;
let libraryEntry: null | { subjectId: string; state: string; revision: number; createdAt: string; updatedAt: string } =
  null;
let members = new Set<string>();
let releaseWrite: (() => void) | undefined;
let writeGate: Promise<void> | undefined;
let refuseEntryWrite: 'closed' | undefined;
let calls: {
  method: string;
  path: string;
  query: string;
  body: unknown;
  key: string | null;
  authorization: string | null;
}[] = [];

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const problem = (status: number, code: string) => ({
  type: `https://rezics.com/problems/${code}`,
  title: code,
  status,
  code,
  retryable: false,
  effect_status: status === 409 ? 'not_applied' : 'not_applicable',
  request_id: randomUUID(),
});
function reset() {
  libraryEntry = null;
  members = new Set();
  calls = [];
  refuseEntryWrite = undefined;
  releaseWrite?.();
  releaseWrite = undefined;
  writeGate = undefined;
}
function holdEntryWrite() {
  writeGate = new Promise((resolve) => {
    releaseWrite = () => {
      releaseWrite = undefined;
      writeGate = undefined;
      resolve();
    };
  });
}

// The auth provider and the site dev-server setup follow posting.test.ts.
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
      query: url.search,
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    if (
      writeGate &&
      (request.method === 'PUT' || request.method === 'DELETE') &&
      url.pathname === `/v1/libraryEntries/${subjectId}`
    )
      await writeGate;
    const subjectRead = createFakeKernelFetch(fixtures as never);
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${subjectId}`) return subjectRead(request);
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') return subjectRead(request);
    if (url.pathname === `/v1/libraryEntries/${subjectId}`) {
      if (request.method === 'GET')
        return libraryEntry
          ? json({
              libraryEntry: {
                ...libraryEntry,
                subject: { id: subjectId, type: subject.type, label: subject.labels.en },
              },
            })
          : json(problem(404, 'not_found'), 404);
      if (request.method === 'PUT') {
        if (refuseEntryWrite === 'closed') {
          refuseEntryWrite = undefined;
          return json(problem(403, 'platform_closed'), 403);
        }
        const value = body as { state?: string; revision?: number } | null;
        if (libraryEntry && value?.revision !== libraryEntry.revision) return json(problem(409, 'conflict'), 409);
        libraryEntry = {
          subjectId,
          state: value?.state ?? 'planned',
          revision: (libraryEntry?.revision ?? 0) + 1,
          createdAt: libraryEntry?.createdAt ?? stamp,
          updatedAt: stamp,
        };
        return json(
          {
            libraryEntry: { ...libraryEntry, subject: { id: subjectId, type: subject.type, label: subject.labels.en } },
          },
          value?.revision === undefined ? 201 : 200,
        );
      }
      if (request.method === 'DELETE') {
        const revision = Number(url.searchParams.get('revision'));
        if (!libraryEntry || revision !== libraryEntry.revision) return json(problem(409, 'conflict'), 409);
        libraryEntry = null;
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === '/v1/collections' && request.method === 'GET') {
      return json({
        collections: [
          {
            id: shelfId,
            curatorAccountId: 'alice',
            title: 'My shelf',
            description: null,
            visibility: 'private',
            revision: 1,
            memberCount: members.has(shelfId) ? 1 : 0,
            createdAt: stamp,
            updatedAt: stamp,
            curator: { id: 'alice', handle: 'ada', displayName: 'Ada Lovelace' },
          },
          {
            id: fullShelfId,
            curatorAccountId: 'alice',
            title: 'Full shelf',
            description: null,
            visibility: 'private',
            revision: 1,
            memberCount: 5000,
            createdAt: stamp,
            updatedAt: stamp,
            curator: { id: 'alice', handle: 'ada', displayName: 'Ada Lovelace' },
          },
        ],
        next: null,
      });
    }
    const memberCollection = /^\/v1\/collections\/([^/]+)\/members$/.exec(url.pathname)?.[1];
    if (memberCollection && request.method === 'POST') {
      if (memberCollection === fullShelfId) return json(problem(409, 'collection_full'), 409);
      members.add(memberCollection);
      return json({ member: { id: randomUUID(), subjectId, note: null, addedAt: stamp } }, 201);
    }
    if (url.pathname === `/v1/subjects/${subjectId}/collections` && request.method === 'GET')
      return json({
        collections: [
          {
            id: publicShelfId,
            curatorAccountId: 'bob',
            title: 'Shared shelf',
            multiplicity: 3,
            curator: { id: 'bob', handle: 'grace', displayName: 'Grace Hopper' },
          },
        ],
        next: null,
      });
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
async function signIn(returnTo = `/en/subjects/${subjectId}`) {
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
  expect([302, 303]).toContain(answer.status);
  return cookieValue(answer, session)!;
}
let browser: Browser | undefined;
async function open(path: string, signedIn = true): Promise<{ page: Page; origin: string }> {
  const sessionCookie = signedIn ? await signIn(path) : undefined;
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: true,
  });
  if (sessionCookie)
    await context.addCookies([
      {
        name: session,
        value: sessionCookie,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('requestfailed', (request) =>
    browserErrors.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`),
  );
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(120_000);
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  try {
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    await page
      .locator(signedIn ? '#account-menu-button' : '[data-session-slot] a[href^="/auth/sign-in"]')
      .waitFor({ timeout: 120_000 });
  } catch (error) {
    throw new Error(
      `${String(error)}; page=${await page.locator('body').innerText()}; browser=${browserErrors.join(' | ')}`,
    );
  }
  return { page, origin };
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(50);
  expect(await check()).toBe(true);
}
function librarySlot(page: Page) {
  return page.locator('section[aria-label="Library"]');
}
function stateControl(slot: Locator) {
  return slot.getByRole('combobox', { name: 'Library state' });
}
async function pick(page: Page, select: Locator, name: string) {
  await select.click();
  await page.getByRole('option', { name, exact: true }).click();
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

test(
  'a signed-in person without an entry adds the subject to their library by choosing a state, which saves at once',
  async () => {
    reset();
    const { page } = await open(`/en/subjects/${subjectId}`);
    try {
      const slot = librarySlot(page);
      const select = stateControl(slot);
      expect(await select.innerText()).toContain('Add to library');
      expect(await select.innerText()).not.toContain('Planned');
      expect(await slot.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
      expect(await slot.getByRole('button', { name: 'Clear', exact: true }).count()).toBe(0);
      await select.click();
      const options = page.getByRole('listbox').getByRole('option');
      expect(
        await options.evaluateAll((nodes) =>
          nodes.some(
            (node) => node.getAttribute('aria-selected') === 'true' || node.getAttribute('data-state') === 'checked',
          ),
        ),
      ).toBe(false);
      expect(await page.getByRole('option', { name: 'Remove from library', exact: true }).count()).toBe(0);
      holdEntryWrite();
      await page.getByRole('option', { name: 'In progress', exact: true }).click();
      // The control can show busy before the kernel records the write, so wait for both.
      await eventually(async () => {
        const recorded =
          calls.filter((call) => call.method === 'PUT' && call.path === `/v1/libraryEntries/${subjectId}`).length === 1;
        return recorded && (await select.getAttribute('aria-busy')) === 'true' && (await select.isDisabled());
      });
      releaseWrite?.();
      await eventually(
        async () =>
          libraryEntry?.state === 'in_progress' &&
          libraryEntry.revision === 1 &&
          (await select.innerText()).includes('In progress') &&
          (await select.getAttribute('aria-busy')) !== 'true' &&
          !(await select.isDisabled()),
      );
      const put = calls.find((call) => call.method === 'PUT' && call.path === `/v1/libraryEntries/${subjectId}`)!;
      expect(put.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(put.body).toEqual({ state: 'in_progress' });
      expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    } finally {
      releaseWrite?.();
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a signed-in person changes or removes their library state from the same control, and a refused change goes back and says why',
  async () => {
    reset();
    libraryEntry = { subjectId, state: 'planned', revision: 1, createdAt: stamp, updatedAt: stamp };
    const { page } = await open(`/en/subjects/${subjectId}`);
    try {
      const slot = librarySlot(page);
      const select = stateControl(slot);
      expect(await select.innerText()).toContain('Planned');
      expect(await select.innerText()).not.toContain('Add to library');
      expect(await slot.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
      expect(await slot.getByRole('button', { name: 'Clear', exact: true }).count()).toBe(0);

      refuseEntryWrite = 'closed';
      await pick(page, select, 'Dropped');
      await eventually(
        async () =>
          (await slot.getByRole('alert').count()) > 0 &&
          (await slot.getByRole('alert').innerText()) === 'This part of REZICS is not open yet.',
      );
      expect(libraryEntry).toMatchObject({ state: 'planned', revision: 1 });
      expect(await select.innerText()).toContain('Planned');
      expect(await select.innerText()).not.toContain('Dropped');
      const refused = calls.find((call) => call.method === 'PUT' && call.path === `/v1/libraryEntries/${subjectId}`)!;
      expect(refused.body).toEqual({ state: 'dropped', revision: 1 });
      expect(refused.key).toMatch(/^[0-9a-f-]{36}$/i);

      calls.length = 0;
      await pick(page, select, 'In progress');
      await eventually(
        async () =>
          libraryEntry?.state === 'in_progress' &&
          libraryEntry.revision === 2 &&
          (await select.innerText()).includes('In progress'),
      );
      const put = calls.find((call) => call.method === 'PUT' && call.path === `/v1/libraryEntries/${subjectId}`)!;
      expect(put.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(put.body).toEqual({ state: 'in_progress', revision: 1 });

      await select.click();
      const list = page.getByRole('listbox');
      const names = await list.getByRole('option').allInnerTexts();
      expect(names.at(-1)).toBe('Remove from library');
      expect(await list.locator('[data-slot=select-separator]').count()).toBe(1);
      await page.keyboard.press('Escape');

      libraryEntry = { ...libraryEntry!, state: 'completed', revision: 8, updatedAt: stamp };
      calls.length = 0;
      await pick(page, select, 'Paused');
      await eventually(async () => (await select.innerText()).includes('Completed'));
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        `PUT /v1/libraryEntries/${subjectId}`,
        `GET /v1/libraryEntries/${subjectId}`,
      ]);
      expect(calls[0]?.body).toEqual({ state: 'paused', revision: 2 });
      expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(new URLSearchParams(calls[1]?.query).get('view')).toBe('FULL');
      expect(calls[1]?.authorization).toMatch(/^Bearer /);
      expect(libraryEntry).toMatchObject({ state: 'completed', revision: 8 });
      expect(await slot.getByRole('alert').innerText()).toBe('This entry changed elsewhere.');
      expect(await select.innerText()).not.toContain('Paused');

      calls.length = 0;
      await pick(page, select, 'Remove from library');
      await eventually(async () => libraryEntry === null && (await select.innerText()).includes('Add to library'));
      const remove = calls.find((call) => call.method === 'DELETE' && call.path === `/v1/libraryEntries/${subjectId}`)!;
      expect(remove.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(remove.query).toContain('revision=8');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a person adds the subject to one of their collections, and a full collection is explained',
  async () => {
    reset();
    const { page } = await open(`/en/subjects/${subjectId}`);
    try {
      const popover = page.locator('details[data-add-to-collection]');
      await popover.locator('summary').click();
      await popover.getByRole('button', { name: /load collections/i }).click();
      await popover.getByRole('button', { name: /my shelf/i }).click();
      await eventually(() => members.has(shelfId));
      const write = calls.find(
        (call) => call.method === 'POST' && call.path.endsWith(`/collections/${shelfId}/members`),
      )!;
      expect(write.key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(write.body).toEqual({ subjectId });
      await popover.getByRole('button', { name: /full shelf/i }).click();
      await eventually(async () => /5,?000/.test(await page.getByRole('alert').innerText()));
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the subject page lists the public collections that include it, with how many times',
  async () => {
    reset();
    const { page } = await open(`/en/subjects/${subjectId}`, false);
    try {
      const popover = page.locator('details[data-public-collections]');
      expect(await popover.locator('summary').innerText()).toContain('1');
      await popover.locator('summary').click();
      expect(await popover.innerText()).toContain('Shared shelf');
      expect(await popover.innerText()).toContain('Grace Hopper');
      expect(await popover.innerText()).toContain('3');
      const read = calls.find(
        (call) => call.method === 'GET' && call.path === `/v1/subjects/${subjectId}/collections`,
      )!;
      expect(new URLSearchParams(read.query).get('view')).toBe('FULL');
      expect(new URLSearchParams(read.query).get('limit')).toBe('100');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a person starts progress or sees their copies of the subject from its page',
  async () => {
    reset();
    const { page, origin } = await open(`/en/subjects/${subjectId}`);
    try {
      await page.locator('details[data-add-to-collection] summary').click();
      const links = page.locator('[data-library-subject-links]');
      expect(await links.getByRole('link', { name: /start progress/i }).getAttribute('href')).toBe(
        `/library/progress?subjectId=${subjectId}`,
      );
      expect(await links.getByRole('link', { name: /your copies/i }).getAttribute('href')).toBe(
        `/library/copies?subjectId=${subjectId}`,
      );
      expect(new URL(page.url()).origin).toBe(origin);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'signed out, the slot shows the public collections and offers sign-in for the rest',
  async () => {
    reset();
    const { page } = await open(`/en/subjects/${subjectId}`, false);
    try {
      expect(await page.locator('details[data-public-collections] summary').innerText()).toContain('1');
      const signInLink = page.locator('[data-library-sign-in]');
      expect(await signInLink.getAttribute('href')).toMatch(/\/auth\/sign-in\?return_to=/);
      expect(await page.locator('[data-library-entry]').count()).toBe(0);
      const publicRead = calls.find((call) => call.path === `/v1/subjects/${subjectId}/collections`)!;
      expect(publicRead.authorization).toBeNull();
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
