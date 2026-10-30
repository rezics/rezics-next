import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { subjectHref } from '../src/subject/subject-href.ts';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['library_entry:list', 'library_entry:read', 'library_entry:update', 'library_entry:delete'];
const locales = ['en', 'zh-Hans'] as const;

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
    subject: { id: id(n), label, type: 'schema:Book' },
  };
}
type Session = {
  id: string;
  subjectId: string;
  state: 'active' | 'completed';
  mode: 'scalar_amount' | 'cursor_position' | 'completed_units';
  unit: 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
  amount: string | null;
  total: string | null;
  completedUnitCount: number;
};
const sessionId = (n: number) => `session-${n}`;
function active(n: number, rest: Partial<Session>): Session {
  return {
    id: sessionId(n),
    subjectId: id(n),
    state: 'active',
    mode: 'scalar_amount',
    unit: 'page',
    amount: null,
    total: null,
    completedUnitCount: 0,
    ...rest,
  };
}
// Six subjects in progress, newest first: an episode count with a total, pages with no total, a percent, a reading
// position that has no amount, a count of completed chapters, and one more with a long title.
const labels: Record<number, string> = {
  31: 'Spring Anime',
  32: 'Unfinished Novel',
  33: 'Audio Course',
  34: 'Kokoro Position',
  35: 'Serial Chapters',
  36: 'A Very Long Title That Needs Two Lines On A Compact Card',
};
function phoneEntries(): Entry[] {
  return [31, 32, 33, 34, 35, 36].map((n) => entry(n, 'in_progress', 100 - n, labels[n]!));
}
function phoneSessions(): Session[] {
  return [
    active(31, { unit: 'episode', amount: '3', total: '12' }),
    active(32, { unit: 'page', amount: '118' }),
    active(33, { unit: 'percent', amount: '40' }),
    active(34, { mode: 'cursor_position', unit: 'chapter' }),
    active(35, { mode: 'completed_units', unit: 'chapter', completedUnitCount: 12 }),
    active(36, { unit: 'volume', amount: '2', total: '9' }),
  ];
}
let entries = phoneEntries();
let sessions = phoneSessions();
let failLibrary = false;
let progressReads = 0;
let oidcTokenRequests = 0;
let oidcClientRejection = 'none';
type Call = {
  method: string;
  path: string;
  view: string | null;
  limit: string | null;
  state: string | null;
  authorization: string | null;
};
const calls: Call[] = [];
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
function reset(next = phoneEntries()) {
  calls.length = 0;
  progressReads = 0;
  entries = next;
  sessions = phoneSessions();
  failLibrary = false;
}

// OpenID provider copied from library-entries.test.ts; the home page sends the website's access token.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const client = async (form: URLSearchParams) => {
      if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
        oidcClientRejection = 'client_assertion_type';
        return false;
      }
      try {
        // Auth's contract: the registered kid, iss = sub = the client, aud exactly the issuer, at most 120 seconds.
        const { payload, protectedHeader } = await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
        if (!jti) {
          oidcClientRejection = 'client_assertion_replay';
          return false;
        }
        if (protectedHeader.kid !== clientJwk.kid) oidcClientRejection = 'client_key_id';
        else if (payload.aud !== issuer) oidcClientRejection = 'client_assertion_audience';
        else if (assertions.has(jti)) oidcClientRejection = 'client_assertion_replay';
        else if (!payload.exp || !payload.iat || payload.exp - payload.iat > 120)
          oidcClientRejection = 'client_assertion_lifetime';
        else oidcClientRejection = 'none';
        if (oidcClientRejection !== 'none') return false;
        assertions.add(jti);
        return true;
      } catch (error) {
        oidcClientRejection = error instanceof Error ? error.name : typeof error;
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
      oidcTokenRequests += 1;
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
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') return pageFake(request);
    if (url.pathname === '/v1/progressSessions' && request.method === 'GET') {
      progressReads += 1;
      if (!request.headers.get('authorization')?.startsWith('Bearer '))
        return json(problem(401, 'authentication_required'), 401, true);
      const subjectId = url.searchParams.get('subjectId');
      return json({ progressSessions: sessions.filter((item) => item.subjectId === subjectId), next: null });
    }
    if (url.pathname !== '/v1/libraryEntries' || request.method !== 'GET')
      return json(problem(404, 'not_found'), 404, true);
    calls.push({
      method: request.method,
      path: url.pathname,
      view: url.searchParams.get('view'),
      limit: url.searchParams.get('limit'),
      state: url.searchParams.get('state'),
      authorization: request.headers.get('authorization'),
    });
    if (!request.headers.get('authorization')?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (failLibrary) return json(problem(500, 'internal_error'), 500, true);
    const rawLimit = Number(url.searchParams.get('limit') ?? 20);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
    const state = url.searchParams.get('state');
    const listed = entries
      .filter((item) => (state ? item.state === state : true))
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
      .slice(0, limit);
    const full = url.searchParams.get('view') === 'FULL';
    return json({
      libraryEntries: listed.map((item) => (full ? item : { ...item, subject: undefined })),
      next: null,
    });
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
let siteOutput = '';

// The documented command, pointed at the fake through the environment it reads in development.
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    const keep = (chunk: Buffer) => (siteOutput = (siteOutput + chunk.toString()).slice(-8000));
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
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${siteOutput}`);
      try {
        const response = await fetch(`${origin}/en`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status < 500) return origin;
      } catch {
        // The dev server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${siteOutput}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

const setCookie = (response: Response, name: string) =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const cookieValue = (response: Response, name: string) =>
  setCookie(response, name)
    ?.split(';')[0]
    ?.slice(name.length + 1);

// Starts a sign-in, answers it as Auth would after the person signs in there, and returns the session cookie.
async function signIn(returnTo = '/en', grant: Partial<Grant> = {}) {
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
    ...grant,
  });
  oidcTokenRequests = 0;
  oidcClientRejection = 'none';
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  const body = (await answer
    .clone()
    .json()
    .catch(() => undefined)) as { status?: unknown; code?: unknown; title?: unknown } | undefined;
  const safeProblem = body
    ? {
        status: typeof body.status === 'number' ? body.status : undefined,
        code: typeof body.code === 'string' ? body.code.slice(0, 64) : undefined,
        title: typeof body.title === 'string' ? body.title.slice(0, 64) : undefined,
      }
    : undefined;
  const oidcDiagnostic = siteOutput
    .split('\n')
    .filter((line) => line.includes('[web auth] OpenID authorization-code grant failed:'))
    .at(-1);
  expect(
    [302, 303],
    `OpenID callback setup; HTTP ${answer.status}; problem=${JSON.stringify(safeProblem)}; ${oidcDiagnostic ?? 'no named OIDC grant error logged'}; client_id=${params.get('client_id')}; fake_token_requests=${oidcTokenRequests}; fake_client_rejection=${oidcClientRejection}`,
  ).toContain(answer.status);
  const sessionCookie = cookieValue(answer, session);
  expect(sessionCookie, 'signed-in session setup').toBeTruthy();
  return sessionCookie!;
}

let aliceCookie: Promise<string> | undefined;
const alice = async () => {
  aliceCookie ??= signIn('/en', { sub: 'alice' });
  return aliceCookie;
};

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The dev server has already exited.
    }
});

let browser: Browser | undefined;
type Viewport = { width: number; height: number };

// A live page in a real browser: the layout tests need the stylesheet and the script that hydrates the page.
async function open(path: string, cookie: string | undefined, viewport: Viewport) {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport,
    reducedMotion: 'reduce',
  });
  if (cookie)
    await context.addCookies([
      { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

async function messageOf(locale: string, key: string, values: Record<string, string> = {}): Promise<string> {
  const file = new URL(`../messages/${locale}.json`, import.meta.url);
  const text = ((await Bun.file(file).json()) as Record<string, string>)[key]!;
  return Object.entries(values).reduce((result, [name, value]) => result.replaceAll(`{${name}}`, value), text);
}
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
type Page = Awaited<ReturnType<typeof open>>;
// The Continue row draws its cards twice, once for the phone row and once for the grid; only one is displayed.
const cardsOf = (page: Page) => page.locator('[data-slot="personal"] article:visible');

test(
  'each home Continue card has an edge-to-edge cover, title, and one progress row with the share or unit form',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const page = await open(`/${locale}`, cookie, { width: 1280, height: 860 });
      try {
        const cards = cardsOf(page);
        expect(await cards.count(), `${locale} cards`).toBe(6);
        for (const [index, n] of [31, 32, 33, 34, 35, 36].entries()) {
          const card = cards.nth(index);
          const box = (await card.boundingBox())!;
          // The cover is the card's top, edge to edge, in the card's own corners: no padding or frame around it.
          const cover = (await card.locator('[data-slot="cover"]').boundingBox())!;
          expect(Math.abs(cover.x - box.x), `${locale} ${n} cover left`).toBeLessThanOrEqual(1);
          expect(Math.abs(cover.y - box.y), `${locale} ${n} cover top`).toBeLessThanOrEqual(1);
          expect(Math.abs(cover.width - box.width), `${locale} ${n} cover width`).toBeLessThanOrEqual(1);
          // Below the cover: the title followed by the state row, with no secondary type line.
          const title = (await card.locator('a').boundingBox())!;
          expect(await card.locator('a').innerText()).toBe(labels[n]!);
          expect(title.y).toBeGreaterThanOrEqual(cover.y + cover.height - 1);
          expect(await card.locator('[data-slot="cover-card-secondary"]').count()).toBe(0);
        }
        const text = async (index: number) => squash(await cards.nth(index).innerText());
        const bar = (index: number) => cards.nth(index).getByRole('progressbar');
        // An amount with a total is the unit form and a bar with the share, on the one row.
        const episodes = await messageOf(locale, 'home_continue_episode_of', { amount: '3', total: '12' });
        expect(await text(0), `${locale} episodes`).toContain(episodes);
        expect(await bar(0).getAttribute('aria-valuenow')).toBe('25');
        const row = (await bar(0).boundingBox())!;
        const label = (await cards.nth(0).getByText(episodes, { exact: true }).last().boundingBox())!;
        expect(Math.abs(row.y + row.height / 2 - (label.y + label.height / 2))).toBeLessThanOrEqual(6);
        expect(await text(5)).toContain(
          await messageOf(locale, 'home_continue_volume_of', { amount: '2', total: '9' }),
        );
        expect(await bar(5).count()).toBe(1);
        // A percent is its own label and the bar.
        expect(await text(2), `${locale} percent`).toContain(
          await messageOf(locale, 'home_continue_percent', { amount: '40' }),
        );
        expect(await bar(2).getAttribute('aria-valuenow')).toBe('40');
        // Only an amount, or a reading position: the unit form or the state label and no bar.
        expect(await text(1), `${locale} pages`).toContain(
          await messageOf(locale, 'home_continue_page', { amount: '118' }),
        );
        expect(await bar(1).count()).toBe(0);
        expect(await text(4)).toContain(await messageOf(locale, 'home_continue_chapter', { amount: '12' }));
        expect(await bar(4).count()).toBe(0);
        expect(await text(3), `${locale} position`).toContain(await messageOf(locale, 'home_continue_in_progress'));
        expect(await bar(3).count()).toBe(0);
      } finally {
        await page.context().close();
      }
      // A subject whose session cannot be read shows its state label instead of an empty bar.
      reset();
      sessions = sessions.filter((item) => item.subjectId !== id(32));
      const unread = await open(`/${locale}`, cookie, { width: 1280, height: 860 });
      try {
        const card = cardsOf(unread).nth(1);
        expect(squash(await card.innerText())).toContain(await messageOf(locale, 'home_continue_in_progress'));
        expect(await card.getByRole('progressbar').count()).toBe(0);
        expect(await card.locator('a').getAttribute('href')).toBe(`/${locale}/library/progress?subjectId=${id(32)}`);
      } finally {
        await unread.context().close();
      }
    }
  },
  timeout,
);

test(
  'a Continue card is one link to its progress session named Continue <title>, with a menu holding Open subject page, and nothing else is interactive',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const page = await open(`/${locale}`, cookie, { width: 1280, height: 860 });
      try {
        const cards = cardsOf(page);
        expect(await cards.count()).toBe(6);
        for (const [index, n] of [31, 32, 33, 34, 35, 36].entries()) {
          const card = cards.nth(index);
          const name = await messageOf(locale, 'home_continue_label', { title: labels[n]! });
          expect(await card.locator('a').count()).toBe(1);
          expect(await card.locator('a').getAttribute('href')).toBe(`/${locale}/library/progress/${sessionId(n)}`);
          expect(await card.locator('a').getAttribute('aria-label')).toBe(name);
          expect(await page.getByRole('link', { name }).count()).toBe(1);
          // The one other control is the menu button.
          expect(await card.locator('button, [role="button"], input, select, textarea, [tabindex]').count()).toBe(1);
          expect(await card.getByRole('button').count()).toBe(1);
        }
        const card = cards.nth(0);
        await card.getByRole('button').click();
        const item = page.getByRole('menuitem', { name: await messageOf(locale, 'home_continue_open_subject') });
        await item.waitFor();
        expect(await page.getByRole('menuitem').count()).toBe(1);
        expect(await item.getAttribute('href')).toBe(subjectHref({ id: id(31), label: labels[31]! }, locale).href);
        await page.keyboard.press('Escape');
        await item.waitFor({ state: 'detached' });
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  "the home page's catalogue rows are CoverRows of CoverCards at every width, with one frame ratio per row",
  async () => {
    for (const width of [390, 700, 1280]) {
      const page = await open('/en', undefined, { width, height: 900 });
      try {
        const lists = page.locator('[data-slot="type-list"]');
        expect(await lists.count()).toBeGreaterThan(0);
        for (let index = 0; index < (await lists.count()); index += 1) {
          const list = lists.nth(index);
          const row = list.getByRole('region');
          expect(await row.count(), `${width} row ${index}`).toBe(1);
          expect(await list.locator('li').count()).toBe(0);
          const cards = row.locator('article');
          expect(await cards.count()).toBeGreaterThan(0);
          expect(await row.evaluate((node) => getComputedStyle(node).overflowX)).toBe('auto');
          // One frame ratio for the row, the cover edge to edge, a link per card, and no state row.
          const ratios = await list
            .locator('[data-slot="cover"]')
            .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute('data-ratio')))]);
          expect(ratios, `${width} row ${index} ratio`).toHaveLength(1);
          const tops = new Set<number>();
          for (let card = 0; card < (await cards.count()); card += 1) {
            const box = (await cards.nth(card).boundingBox())!;
            const cover = (await cards.nth(card).locator('[data-slot="cover"]').boundingBox())!;
            expect(Math.abs(cover.x - box.x)).toBeLessThanOrEqual(1);
            expect(Math.abs(cover.width - box.width)).toBeLessThanOrEqual(1);
            tops.add(Math.round(box.y));
            expect(await cards.nth(card).locator('a').count()).toBe(1);
            expect(await cards.nth(card).getByRole('progressbar').count()).toBe(0);
            expect(squash(await cards.nth(card).innerText()).length).toBeGreaterThan(0);
          }
          expect(tops.size, `${width} row ${index} is one line`).toBe(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'the Continue row is a CoverRow below sm and a CoverGrid from sm up, and keeps its request cost',
  async () => {
    const cookie = await alice();
    reset();
    const phone = await open('/en', cookie, { width: 390, height: 844 });
    try {
      const row = phone.locator('[data-slot="personal"] [role="region"]');
      expect(await row.isVisible()).toBe(true);
      expect(await row.locator('article').count()).toBe(6);
      expect(await row.evaluate((node) => getComputedStyle(node).overflowX)).toBe('auto');
      const measure = await row.evaluate((node) => ({ client: node.clientWidth, scroll: node.scrollWidth }));
      expect(measure.scroll).toBeGreaterThan(measure.client);
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      const tops = new Set<number>();
      for (let index = 0; index < 6; index += 1)
        tops.add(Math.round((await cardsOf(phone).nth(index).boundingBox())!.y));
      expect(tops.size).toBe(1);
      expect(await cardsOf(phone).count()).toBe(6);
      // The search box and the first catalogue row still start in the first viewport.
      const search = (await phone.locator('input[name="q"]').first().boundingBox())!;
      expect(search.y + search.height).toBeLessThanOrEqual(844);
      expect((await phone.locator('[data-slot="type-list"]').first().boundingBox())!.y).toBeLessThan(844);
    } finally {
      await phone.context().close();
    }
    for (const width of [640, 700, 1280]) {
      reset();
      const page = await open('/en', cookie, { width, height: 900 });
      try {
        expect(await page.locator('[data-slot="personal"] [role="region"]').isVisible()).toBe(false);
        expect(await cardsOf(page).count()).toBe(6);
        const grid = page.locator('[data-slot="personal"] .grid:visible');
        expect(await grid.count()).toBe(1);
        expect(await grid.evaluate((node) => getComputedStyle(node).display)).toBe('grid');
        expect(await grid.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        // The home view still reads the library once and each shown subject's progress once.
        expect(calls.filter((call) => call.path === '/v1/libraryEntries')).toHaveLength(1);
        expect(progressReads).toBe(6);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
