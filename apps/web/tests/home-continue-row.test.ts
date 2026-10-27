import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import { readProgress } from '../src/library/continue-read.ts';
import libraryEntriesRecording from '../src/kernel/recorded/library-entries.json';
import progressSessionsRecording from '../src/kernel/recorded/library-progress-sessions.json';
import fixtures from '../src/kernel/fixtures.json';

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
    subject: { id: id(n), label, type: 'book' },
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
    if (url.pathname === '/v1/progressSessions' && request.method === 'GET') {
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
async function open(path: string, cookie: string, viewport: Viewport) {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport,
    reducedMotion: 'reduce',
    extraHTTPHeaders: { cookie: `${session}=${cookie}` },
  });
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
const cardsOf = (page: Awaited<ReturnType<typeof open>>) =>
  page.locator('[data-slot="personal"] [data-slot="continue-card"]');

test(
  'each Continue card shows the progress the kernel returned, as its unit and total with the percent, or the amount alone without a total',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const page = await open(`/${locale}`, cookie, { width: 1280, height: 860 });
      try {
        const cards = cardsOf(page);
        expect(await cards.count(), `${locale} cards`).toBe(6);
        const percent = (share: number) =>
          new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(share);
        const text = async (index: number) => squash(await cards.nth(index).innerText());
        // An amount with a total names both and draws the bar with the share.
        expect(await text(0), `${locale} episodes`).toContain(
          await messageOf(locale, 'home_continue_episode_of', { amount: '3', total: '12' }),
        );
        expect(await text(0)).toContain(percent(0.25));
        expect(await cards.nth(0).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
        expect(await text(5)).toContain(
          await messageOf(locale, 'home_continue_volume_of', { amount: '2', total: '9' }),
        );
        // An amount without a total is the amount alone, and no bar.
        expect(await text(1), `${locale} pages`).toContain(
          await messageOf(locale, 'home_continue_page', { amount: '118' }),
        );
        expect(await cards.nth(1).getByRole('progressbar').count()).toBe(0);
        expect(await text(4)).toContain(await messageOf(locale, 'home_continue_chapter', { amount: '12' }));
        expect(await cards.nth(4).getByRole('progressbar').count()).toBe(0);
        // A percent is its own amount and the bar.
        expect(await text(2), `${locale} percent`).toContain(
          await messageOf(locale, 'home_continue_percent', { amount: '40' }),
        );
        expect(await cards.nth(2).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
        // A session with no amount says it is in progress.
        expect(await text(3), `${locale} position`).toContain(await messageOf(locale, 'home_continue_in_progress'));
        expect(await cards.nth(3).getByRole('progressbar').count()).toBe(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a Continue card is one link to continue and holds no separate button',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const page = await open(`/${locale}`, cookie, { width: 1280, height: 860 });
      try {
        const cards = cardsOf(page);
        expect(await cards.count()).toBe(6);
        const names = await messageOf(locale, 'home_continue_label', { title: '@' });
        const verb = squash(names.replace('@', ''));
        expect(verb.length).toBeGreaterThan(0);
        for (const [index, n] of [31, 32, 33, 34, 35, 36].entries()) {
          const card = cards.nth(index);
          expect(await card.locator('a').count()).toBe(1);
          expect(await card.locator('button, [role="button"]').count()).toBe(0);
          expect(await card.locator('a').getAttribute('href')).toBe(`/${locale}/library/progress/${sessionId(n)}`);
          // The link is named for what it does to this title, and the card shows no second caption for it.
          const label = await messageOf(locale, 'home_continue_label', { title: labels[n]! });
          expect(await card.locator('a').getAttribute('aria-label')).toBe(label);
          expect(await page.getByRole('link', { name: label }).count()).toBe(1);
          expect(squash(await card.innerText())).not.toContain(verb);
        }
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'on a phone Continue is one horizontally scrolling row of compact cards, and the search box and the first catalogue row start in the first viewport',
  async () => {
    const cookie = await alice();
    reset();
    const phone = await open('/en', cookie, { width: 390, height: 844 });
    try {
      const row = phone.locator('[data-slot="personal"] ul');
      const cards = cardsOf(phone);
      expect(await cards.count()).toBe(6);
      const measure = await row.evaluate((element) => ({
        overflowX: getComputedStyle(element).overflowX,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        page: document.documentElement.scrollWidth,
      }));
      expect(['auto', 'scroll']).toContain(measure.overflowX);
      expect(measure.scrollWidth).toBeGreaterThan(measure.clientWidth);
      expect(measure.page).toBeLessThanOrEqual(390);
      // One row of cards about 16rem wide, each with a thumbnail beside the title.
      const boxes = [];
      for (let index = 0; index < 6; index += 1) boxes.push((await cards.nth(index).boundingBox())!);
      expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(1);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThan(232);
        expect(box.width).toBeLessThan(280);
      }
      const cover = (await cards.nth(0).locator('[data-slot="cover"]').boundingBox())!;
      const title = (await cards.nth(0).getByText(labels[31]!).last().boundingBox())!;
      expect(cover.x + cover.width).toBeLessThanOrEqual(title.x + 1);
      // The search box is whole inside the first screen, and the first catalogue row starts inside it.
      const search = (await phone.locator('input[name="q"]').first().boundingBox())!;
      expect(search.y + search.height).toBeLessThanOrEqual(844);
      const catalogue = (await phone.locator('[data-slot="type-list"]').first().boundingBox())!;
      expect(catalogue.y).toBeLessThan(844);
    } finally {
      await phone.context().close();
    }
    // From the sm breakpoint up the cards keep the grid: no scrolling, three columns, then six.
    const tablet = await open('/en', cookie, { width: 700, height: 900 });
    try {
      const tops = new Set<number>();
      const cards = cardsOf(tablet);
      for (let index = 0; index < 6; index += 1) tops.add(Math.round((await cards.nth(index).boundingBox())!.y));
      expect(tops.size).toBe(2);
      const fits = await tablet
        .locator('[data-slot="personal"] ul')
        .evaluate((element) => element.scrollWidth <= element.clientWidth);
      expect(fits).toBe(true);
    } finally {
      await tablet.context().close();
    }
    const desktop = await open('/en', cookie, { width: 1280, height: 860 });
    try {
      const cards = cardsOf(desktop);
      const tops = new Set<number>();
      for (let index = 0; index < 6; index += 1) tops.add(Math.round((await cards.nth(index).boundingBox())!.y));
      expect(tops.size).toBe(1);
    } finally {
      await desktop.context().close();
    }
  },
  timeout,
);

test("the home story's Continue entries cover a total of episodes, pages without a total, a percent and a session without an amount", async () => {
  const recorded = progressSessionsRecording.progressSessions;
  // The first recorded session stays as it was: Kokoro's reading position.
  expect(recorded[0]).toMatchObject({
    id: '01a17a3b-70a2-712a-bae6-f4cc72cd9182',
    subjectId: '01a17a3b-6b89-748f-a486-33c354ef3c9a',
    mode: 'cursor_position',
    amount: null,
    locator: 'Part 2, chapter 14',
  });
  // The kernel answers a read for one subject with that subject's sessions; the recorded fake answers every read with
  // the whole recording, so the card must take the active session of its own subject.
  const client = {
    progressSessions: { get: async () => ({ data: { progressSessions: recorded, next: null } }) },
  } as never;
  const progress = [];
  for (const item of libraryEntriesRecording.libraryEntries) {
    const read = await readProgress(client, item.subjectId, 'Bearer story');
    if (read) progress.push(read);
  }
  // Every case has its own entry, and no two entries show the same session.
  expect(new Set(progress.map((item) => item.sessionId)).size).toBe(progress.length);
  expect(progress.length).toBeGreaterThanOrEqual(4);
  const total = (item: (typeof progress)[number]) => (item.total === null ? 0 : Number(item.total));
  expect(
    progress.some(
      (item) => item.mode === 'scalar_amount' && item.unit === 'episode' && item.amount !== null && total(item) > 0,
    ),
    'episodes with a total',
  ).toBe(true);
  expect(
    progress.some(
      (item) => item.mode === 'scalar_amount' && item.unit === 'page' && item.amount !== null && item.total === null,
    ),
    'pages without a total',
  ).toBe(true);
  expect(
    progress.some((item) => item.mode === 'scalar_amount' && item.unit === 'percent' && item.amount !== null),
    'a percent',
  ).toBe(true);
  expect(
    progress.some((item) => item.mode === 'cursor_position' && item.amount === null),
    'a session without an amount',
  ).toBe(true);
  // The first entry is Kokoro, which keeps its recorded reading position.
  expect(progress[0]?.sessionId).toBe(recorded[0]?.id);
});
