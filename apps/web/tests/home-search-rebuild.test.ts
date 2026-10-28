import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { localeChain } from '@rezics/composition';
import platform from '@rezics/composition/profiles/platform.json' with { type: 'json' };
import { chromium, type Browser, type Page } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { waitForPersonalRead } from './session-token';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = [
  'library_entry:list',
  'library_entry:read',
  'library_entry:update',
  'library_entry:delete',
  'progress_session:list',
];
const locales = ['en', 'zh-Hans', 'ja'] as const;

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
type CoverFixture = {
  media: string;
  width: number;
  height: number;
  placeholder: { thumbhash: string; color: string };
  variants: { format: 'avif' | 'webp'; width: number }[];
  focalPoint: null;
  credit: null;
};
const cover = (n: number): CoverFixture => ({
  media: `0192f3a0-6c1e-7b2a-9d4e-8${String(n).padStart(11, '0')}`,
  width: 640,
  height: 960,
  placeholder: { thumbhash: '', color: '#3b4a6b' },
  variants: [
    { format: 'avif', width: 320 },
    { format: 'webp', width: 320 },
  ],
  focalPoint: null,
  credit: null,
});
type Summary = {
  id: string;
  type: string;
  types: string[];
  creativeWork: boolean;
  label: { value: string; language: string };
  cover: CoverFixture | null;
};
const summary = (
  n: number,
  label: string,
  language: string,
  withCover: boolean,
  type = 'schema:Book',
  uuid = id(n),
): Summary => ({
  id: uuid,
  type,
  types: [type, 'schema:CreativeWork', 'schema:Thing'],
  creativeWork: true,
  label: { value: label, language },
  cover: withCover ? cover(n) : null,
});
type Entry = {
  subjectId: string;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  subject: Summary;
};
type Session = {
  id: string;
  subjectId: string;
  state: 'active' | 'completed';
  mode: 'scalar_amount' | 'completed_units';
  unit: 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
  amount: string | null;
  total: string | null;
  completedUnitCount: number;
};
const stampAt = (minute: number) => new Date(Date.UTC(2026, 3, 2, 0, minute)).toISOString();
function entry(n: number, state: EntryState, minute: number, label: string, language = 'en', withCover = true): Entry {
  const updatedAt = stampAt(minute);
  return {
    subjectId: id(n),
    state,
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
    subject: summary(n, label, language, withCover),
  };
}
// Stored out of order: the home page relies on the kernel's most-recently-updated-first order, not its own.
function showcase(): Entry[] {
  return [
    entry(21, 'in_progress', 10, 'Middle read'),
    entry(22, 'planned', 50, 'Only planned'),
    entry(23, 'in_progress', 30, 'Newest read'),
    entry(24, 'completed', 40, 'Already finished'),
    // A title the kernel could only give in Traditional Chinese, and a subject with no image.
    entry(25, 'in_progress', 20, '舊讀物', 'zh-Hant', false),
  ];
}
const sessionId = (n: number) => `session-${n}`;
// The newest read is at episode 3 of 12, the middle one at volume 5 of 8; the older one counts twelve chapters done
// with no total. Each subject also has a finished session that the home page must not use.
function sessions(): Session[] {
  const finished = (n: number): Session => ({
    id: `finished-${n}`,
    subjectId: id(n),
    state: 'completed',
    mode: 'scalar_amount',
    unit: 'page',
    amount: '999',
    total: '999',
    completedUnitCount: 0,
  });
  return [
    finished(21),
    finished(23),
    finished(25),
    {
      id: sessionId(23),
      subjectId: id(23),
      state: 'active',
      mode: 'scalar_amount',
      unit: 'episode',
      amount: '3',
      total: '12',
      completedUnitCount: 0,
    },
    {
      id: sessionId(21),
      subjectId: id(21),
      state: 'active',
      mode: 'scalar_amount',
      unit: 'volume',
      amount: '5',
      total: '8',
      completedUnitCount: 0,
    },
    {
      id: sessionId(25),
      subjectId: id(25),
      state: 'active',
      mode: 'completed_units',
      unit: 'chapter',
      amount: null,
      total: null,
      completedUnitCount: 12,
    },
  ];
}

let entries = showcase();
let failLibrary = false;
type Call = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: Record<string, unknown> | null;
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
function reset(next = showcase()) {
  calls.length = 0;
  entries = next;
  failLibrary = false;
}

// The search side: a definitions release, and a kernel that answers search, suggestions and facets.
const digest = 'release-home-search-digest';
const published = 'schema:datePublished';
const release = {
  types: {
    'schema:Book': { labels: { en: 'book', 'zh-Hans': '书籍' }, bases: [], facets: [published] },
    'schema:Recipe': { labels: { en: 'recipe', 'zh-Hans': '食谱' }, bases: [], facets: [published] },
    // Two distinct type terms that the zh-Hans labels name the same (a label defect for the definitions).
    'bf:Instance': { labels: { en: 'edition', 'zh-Hans': '版本' }, bases: [], facets: [published] },
    'wd:Q20631656': { labels: { en: 'release', 'zh-Hans': '版本' }, bases: [], facets: [published] },
  },
  properties: { [published]: { labels: { en: 'publication date', 'zh-Hans': '出版日期' }, datatype: 'time' } },
};
const displayTypeLabels: Record<string, Record<'en' | 'zh-Hans', string>> = {
  'schema:Book': { en: 'Book', 'zh-Hans': '书籍' },
  'schema:Recipe': { en: 'Recipe', 'zh-Hans': '食谱' },
  'bf:Instance': { en: 'Edition', 'zh-Hans': '版本' },
  'wd:Q20631656': { en: 'Release', 'zh-Hans': '版本' },
};
const typeCounts: Record<string, number> = {
  'schema:Book': 1,
  'schema:Recipe': 7,
  'bf:Instance': 3,
  'wd:Q20631656': 3,
};
type Hit = {
  n: number;
  type: string;
  labels: Record<string, string>;
  year: number;
  cover: boolean;
};
const hits: Hit[] = [
  { n: 31, type: 'schema:Book', labels: { en: 'Kokoro', 'zh-Hans': '心' }, year: 1914, cover: true },
  { n: 32, type: 'schema:Recipe', labels: { en: 'Kokoro curry', 'zh-Hans': '心咖喱' }, year: 1982, cover: false },
  { n: 33, type: 'schema:Book', labels: { en: 'Kokoro and after', 'zh-Hans': '心之后' }, year: 1925, cover: true },
];
const hitSummary = (hit: Hit): Summary => summary(hit.n, hit.labels.en!, 'en', hit.cover, hit.type);
function hitBody(hit: Hit, withFacts: boolean) {
  return {
    id: id(hit.n),
    type: hit.type,
    labels: hit.labels,
    summary: hitSummary(hit),
    ...(withFacts ? { facts: { [published]: [{ kind: 'time', year: hit.year }] } } : {}),
  };
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
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') return pageFake(request);
    const body =
      request.method === 'POST' ? ((await request.json().catch(() => null)) as Record<string, unknown> | null) : null;
    const search = url.searchParams;
    calls.push({
      method: request.method,
      path: url.pathname,
      search,
      body,
      authorization: request.headers.get('authorization'),
    });
    if (url.pathname === '/v1/definitions/active' && request.method === 'GET') return json({ digest });
    if (url.pathname === `/v1/definitions/releases/${digest}` && request.method === 'GET')
      return json({ digest, release });
    if (url.pathname === '/v1/subjects:search' && request.method === 'POST') {
      if (body?.text === 'boom') return json(problem(503, 'index_not_ready'), 503, true);
      if (body?.text === 'nothing')
        return json({ subjects: [], total: { value: 0, relation: 'exact' }, next: null, as_of: stampAt(0) });
      const properties = body?.properties as string[] | undefined;
      return json({
        subjects: hits.map((hit) => hitBody(hit, !!properties?.includes(published))),
        total: { value: hits.length, relation: 'exact' },
        next: null,
        as_of: stampAt(0),
      });
    }
    if (url.pathname === '/v1/subjects:suggest' && request.method === 'GET')
      return json({ subjects: [hits[0]!, hits[1]!].map((hit) => hitBody(hit, true)), as_of: stampAt(0) });
    if (url.pathname === '/v1/subjects:facets' && request.method === 'POST') {
      const facets = body?.facets as { property: string }[] | undefined;
      if (facets?.[0]?.property === 'type')
        return json({
          facets: [
            {
              property: 'type',
              relation: 'exact',
              values: Object.entries(typeCounts).map(([value, count]) => ({ value, count, labels: {} })),
            },
          ],
          total: { value: 14, relation: 'exact' },
          as_of: stampAt(0),
        });
      return json({ facets: [], total: { value: 3, relation: 'exact' }, as_of: stampAt(0) });
    }
    if (url.pathname === '/v1/progressSessions' && request.method === 'GET') {
      if (!request.headers.get('authorization')?.startsWith('Bearer '))
        return json(problem(401, 'authentication_required'), 401, true);
      const subjectId = search.get('subjectId');
      return json({ progressSessions: sessions().filter((item) => item.subjectId === subjectId), next: null });
    }
    if (url.pathname !== '/v1/libraryEntries' || request.method !== 'GET')
      return json(problem(404, 'not_found'), 404, true);
    if (!request.headers.get('authorization')?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (failLibrary) return json(problem(500, 'internal_error'), 500, true);
    const rawLimit = Number(search.get('limit') ?? 20);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
    const state = search.get('state');
    const listed = entries
      .filter((item) => (state ? item.state === state : true))
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
      .slice(0, limit);
    const full = search.get('view') === 'FULL';
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
        const response = await fetch(`${origin}/en`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(60_000),
        });
        if (response.status < 500) return origin;
      } catch {
        // The dev server is still starting.
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
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
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303], 'OpenID callback setup').toContain(answer.status);
  const sessionCookie = cookieValue(answer, session);
  expect(sessionCookie, 'signed-in session setup').toBeTruthy();
  return sessionCookie!;
}

let aliceCookie: Promise<string> | undefined;
const alice = async () => {
  aliceCookie ??= signIn('/en', { sub: 'alice' });
  return aliceCookie;
};

// Public home content works without script; personal Continue cards load after hydration.
async function render(path: string, cookie?: string): Promise<Page> {
  const response = await fetch(`${await site()}${path}`, {
    headers: cookie ? { cookie: `${session}=${cookie}` } : {},
  });
  expect(response.status).toBe(200);
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    javaScriptEnabled: Boolean(cookie),
  });
  if (cookie)
    await context.addCookies([
      { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    ]);
  // This fixture supplies cover metadata; live browser rendering also needs a successful image response.
  await context.route(
    (url) => url.pathname.startsWith('/media/'),
    (route) =>
      route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
          'base64',
        ),
      }),
  );
  const page = await context.newPage();
  if (cookie) {
    await page.goto(`${await site()}${path}`, { waitUntil: 'networkidle' });
    await waitForPersonalRead(page, ['home-continue', path.split('/')[1]!]);
    await page.locator('[data-slot="personal"] article').first().waitFor({ state: 'attached' });
    // Keep this markup proof unstyled, as the script-free snapshots below are.
    await page.evaluate(() => {
      for (const stylesheet of document.querySelectorAll('style, link[rel="stylesheet"]')) stylesheet.remove();
    });
  } else await page.setContent(await response.text());
  return page;
}

async function openLive(path: string): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  return page;
}

let browser: Browser | undefined;

async function messageOf(locale: string, key: string, values: Record<string, string> = {}): Promise<string> {
  const file = new URL(`../messages/${locale}.json`, import.meta.url);
  const text = ((await Bun.file(file).json()) as Record<string, string>)[key]!;
  return Object.entries(values).reduce((result, [name, value]) => result.replaceAll(`{${name}}`, value), text);
}
const calledPaths = (path: string) => calls.filter((call) => call.path === path);
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

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

test(
  "home's Continue cards show each subject's cover, progress and next action",
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const page = await render(`/${locale}`, cookie);
      try {
        // Without a stylesheet both drawings of the cards show: the phone row first, then the grid.
        const cards = page.locator('[data-slot="personal"] article');
        expect(await cards.count(), `${locale} cards`).toBe(6);
        const newest = cards.nth(0);
        const older = cards.nth(1);
        const middle = cards.nth(2);
        // Each card is one link, named for continuing its title, with cover and title inside it and no further link.
        for (const [card, title] of [
          [newest, 'Newest read'],
          [older, '舊讀物'],
          [middle, 'Middle read'],
        ] as const) {
          expect(await card.locator('a').count()).toBe(1);
          expect(await card.locator('[data-slot="cover"]').count()).toBe(1);
          expect(await card.locator('a').getAttribute('aria-label')).toBe(
            await messageOf(locale, 'home_continue_label', { title }),
          );
        }
        expect(await newest.locator('a').getAttribute('href')).toBe(`/${locale}/library/progress/${sessionId(23)}`);
        expect(await middle.locator('a').getAttribute('href')).toBe(`/${locale}/library/progress/${sessionId(21)}`);
        // The cover is the subject's own image, or the typographic placeholder when it has none.
        expect(await newest.locator('img').first().getAttribute('src')).toContain(`/media/${cover(23).media}/`);
        expect(await older.locator('img').count()).toBe(0);
        expect(await older.locator('[data-slot="cover"]').getAttribute('data-state')).toBe('placeholder');
        // The progress is the unit and total the progress read returned, localized, on one row with the bar.
        const episode = await messageOf(locale, 'home_continue_episode_of', { amount: '3', total: '12' });
        const volume = await messageOf(locale, 'home_continue_volume_of', { amount: '5', total: '8' });
        const chapters = await messageOf(locale, 'home_continue_chapter', { amount: '12' });
        expect(await newest.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
        expect(squash(await newest.innerText())).toContain(episode);
        expect(await middle.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62.5');
        expect(squash(await middle.innerText())).toContain(volume);
        // A count of completed units with no total names the count and draws no bar.
        expect(await older.getByRole('progressbar').count()).toBe(0);
        expect(squash(await older.innerText())).toContain(chapters);
        expect(await page.getByText('999').count()).toBe(0);
        // A title in another language than the page's carries that language.
        expect(await older.locator('[lang="zh-Hant"]').allInnerTexts()).toEqual(['舊讀物']);
        expect(await newest.locator(`[lang="${locale === 'en' ? 'none' : 'en'}"]`).count()).toBe(
          locale === 'en' ? 0 : 1,
        );
        expect(await newest.locator('[lang]').count()).toBe(locale === 'en' ? 0 : 1);
        // One library read, then one progress read per card shown.
        expect(calledPaths('/v1/libraryEntries')).toHaveLength(1);
        expect(calledPaths('/v1/progressSessions').map((call) => call.search.get('subjectId'))).toEqual(
          expect.arrayContaining([id(21), id(23), id(25)]),
        );
        expect(calledPaths('/v1/progressSessions')).toHaveLength(3);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

type Section = { id: string; types: string[]; title: Record<string, string> };
const home = (platform.routes.find((entry) => entry.route === '/')?.document.content ?? []) as {
  type: string;
  props: Record<string, unknown>;
}[];
const sections: Section[] = home
  .filter((node) => node.type === 'TypeList')
  .map((node) => ({
    id: String(node.props.id),
    types: node.props.types as string[],
    title: node.props.title as Record<string, string>,
  }));
const fixtureSubjects = (fixtures as { subjects: { id: string; type: string; cover?: unknown }[] }).subjects;

test(
  'each vertical section on home is a cover row with a count and a See all link to its search',
  async () => {
    expect(sections.map((section) => section.id)).toEqual(['books', 'anime', 'visual-novels', 'recipes']);
    for (const locale of locales) {
      const page = await render(`/${locale}`);
      try {
        const lists = page.locator('[data-slot="type-list"]');
        expect(await lists.count(), `${locale} sections`).toBe(sections.length);
        for (const [index, section] of sections.entries()) {
          const list = lists.nth(index);
          const subjects = fixtureSubjects.filter((subject) => section.types.includes(subject.type));
          expect(subjects.length).toBeGreaterThan(0);
          expect(squash(await list.locator('h2').innerText())).toBe(section.title[locale]);
          // The count is the read's total, in the reader's language.
          const count = await messageOf(locale, 'home_section_count', {
            count: new Intl.NumberFormat(locale).format(subjects.length),
          });
          expect(squash(await list.locator('[data-slot="type-count"]').innerText())).toBe(count);
          // A row of covers: one frame per subject, one ratio for the whole row, an image only where there is one.
          const items = list.locator('article');
          expect(await items.count()).toBe(Math.min(subjects.length, 12));
          expect(await list.locator('[data-slot="cover"]').count()).toBe(await items.count());
          const ratios = await list
            .locator('[data-slot="cover"]')
            .evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute('data-ratio')))]);
          expect(ratios, `${section.id} ratio`).toHaveLength(1);
          expect(await list.locator('img').count()).toBeGreaterThan(0);
          expect(await list.locator('article:has(img)').count()).toBe(
            subjects.filter((subject) => subject.cover).length,
          );
          expect(await list.locator('[data-state="placeholder"]').count()).toBe(
            subjects.filter((subject) => !subject.cover).length,
          );
          // See all goes to the section's search.
          const seeAll = list.locator('a[data-slot="see-all"]');
          expect(await seeAll.count()).toBe(1);
          expect(await seeAll.getAttribute('href')).toBe(
            `/${locale}/search?type=${encodeURIComponent(section.types[0]!)}`,
          );
          expect(squash(await seeAll.innerText())).toBe(await messageOf(locale, 'home_see_all'));
        }
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'home has no category links that repeat the section headings below them',
  async () => {
    // The template carries no grid of category links, and the page shows none.
    expect(JSON.stringify(home)).not.toContain('LinkGrid');
    for (const locale of locales) {
      const page = await render(`/${locale}`);
      try {
        const body = page.getByRole('main');
        const titles = sections.map((section) => section.title[locale]!);
        const links = await body.locator('a').evaluateAll((nodes) =>
          nodes.map((node) => ({
            href: node.getAttribute('href') ?? '',
            text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
          })),
        );
        // The only links to a type's search are the sections' own See all links, and none is named like a heading.
        const toSearch = links.filter((link) => link.href.includes('/search?type='));
        expect(toSearch).toHaveLength(sections.length);
        expect(await body.locator('a[data-slot="see-all"]').count()).toBe(sections.length);
        for (const title of titles) expect(links.filter((link) => link.text === title)).toEqual([]);
        // Each heading appears once, as the section's own.
        const headings = await body.locator('h2').allInnerTexts();
        for (const title of titles) expect(headings.filter((heading) => squash(heading) === title)).toHaveLength(1);
        expect(await body.locator('[role="search"] input[name="q"]').count()).toBe(1);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'every search result and typeahead suggestion shows its subject’s cover frame, title, type and year',
  async () => {
    for (const locale of ['en', 'zh-Hans'] as const) {
      reset();
      const page = await openLive(`/${locale}/search?q=Kokoro`);
      try {
        const rows = page.getByRole('main').locator('[data-slot="item"]');
        expect(await rows.count()).toBe(hits.length);
        for (const [index, hit] of hits.entries()) {
          const row = rows.nth(index);
          const cover = row.locator('[data-slot="cover"]');
          expect(await cover.count()).toBe(1);
          expect(await cover.getAttribute('data-size')).toBe('sm');
          // One frame ratio for the list, so a recipe among books does not break the alignment.
          expect(await cover.getAttribute('data-ratio')).toBe('5:7');
          const title = row.getByRole('link', { name: hit.labels[locale]!, exact: true });
          expect(await title.count()).toBe(1);
          const typeName = displayTypeLabels[hit.type]![locale];
          expect(await row.getByText(typeName, { exact: true }).count()).toBe(1);
          expect(await row.locator('[data-slot="year"]').innerText()).toBe(String(hit.year));
        }
        // The reader's language chain goes with every search read.
        const chain = localeChain(locale);
        expect(calledPaths('/v1/subjects:search')[0]!.body).toMatchObject({ languages: chain });
        expect(
          calledPaths('/v1/subjects:facets').every(
            (call) => (call.body as { languages?: string[] }).languages?.join() === chain.join(),
          ),
        ).toBe(true);

        // The types are one entry per term, most matches first and then by name; equal names are never merged.
        const typesHeading = await messageOf(locale, 'search_types');
        const types = page.getByRole('main').locator('section', {
          has: page.getByRole('heading', { name: typesHeading, exact: true }),
        });
        const entries = types.locator('li');
        const expected =
          locale === 'en'
            ? ['Recipe (7)', 'Edition (3)', 'Release (3)', 'Book (1)']
            : ['食谱 (7)', '版本 (3)', '版本 (3)', '书籍 (1)'];
        expect((await entries.allInnerTexts()).map(squash)).toEqual(expected);
        const hrefs = await entries.locator('a').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
        expect(hrefs.map((href) => new URL(href!, 'http://x').searchParams.get('type'))).toEqual([
          'schema:Recipe',
          'bf:Instance',
          'wd:Q20631656',
          'schema:Book',
        ]);
      } finally {
        await page.context().close();
      }
      // Typeahead suggestions: the same frame, title, type and year in a smaller cover, in the shell on any other page.
      const other = await openLive(`/${locale}/library`);
      try {
        const chain = localeChain(locale);
        const input = other.getByRole('combobox').and(other.locator('input'));
        await input.fill('Kok');
        const options = other.getByRole('option');
        await options.nth(1).waitFor();
        expect(await options.count()).toBe(2);
        for (const [index, hit] of hits.slice(0, 2).entries()) {
          const option = options.nth(index);
          const frame = option.locator('[data-slot="cover"]');
          expect(await frame.count()).toBe(1);
          expect(await frame.getAttribute('data-size')).toBe('xs');
          const text = squash(await option.innerText());
          expect(text).toContain(hit.labels[locale]!);
          expect(text).toContain(displayTypeLabels[hit.type]![locale]);
          expect(await option.locator('[data-slot="year"]').innerText()).toBe(String(hit.year));
        }
        const suggest = calledPaths('/v1/subjects:suggest').at(-1)!;
        expect(suggest.search.getAll('languages')).toEqual(chain);
      } finally {
        await other.context().close();
      }
    }
    // An empty search and a failed one each say so in a sentence.
    const empty = await openLive('/en/search?q=nothing');
    try {
      expect(await empty.getByRole('main').innerText()).toContain(await messageOf('en', 'search_no_results'));
    } finally {
      await empty.context().close();
    }
    const failed = await openLive('/en/search?q=boom');
    try {
      expect(await failed.getByRole('main').innerText()).toContain(await messageOf('en', 'search_failed'));
    } finally {
      await failed.context().close();
    }
  },
  timeout,
);
