import { chromium } from 'playwright';
import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
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
const scopes = ['library_entry:list', 'library_entry:read', 'library_entry:update', 'library_entry:delete'];
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
// Stored out of order: the home page relies on the kernel's most-recently-updated-first order, not its own.
function showcase(): Entry[] {
  return [
    entry(21, 'in_progress', 10, 'Middle read'),
    entry(22, 'planned', 50, 'Only planned'),
    entry(23, 'in_progress', 30, 'Newest read'),
    entry(24, 'completed', 40, 'Already finished'),
    entry(25, 'in_progress', 20, 'Older read'),
  ];
}
function crowded(): Entry[] {
  return Array.from({ length: 9 }, (_, index) => entry(100 + index, 'in_progress', index + 1, `Crowded ${index + 1}`));
}

let entries = showcase();
let failContinue = false;
let continueOperationExposed = true;
type Call = {
  method: string;
  path: string;
  view: string | null;
  limit: string | null;
  state: string | null;
  authorization: string | null;
};
const calls: Call[] = [];
const browserReads: { method: string; path: string }[] = [];
const headerReads: { method: string; path: string }[] = [];
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
  browserReads.length = 0;
  entries = next;
  failContinue = false;
  continueOperationExposed = true;
  headerReads.length = 0;
}

// OpenID provider copied from library-entries.test.ts; the home page sends the website's access token.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure')
      return json({
        admitted: [
          'personal_library',
          'reading_progress',
          ...(continueOperationExposed ? ['library_continue.list'] : []),
        ],
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
    if (request.method === 'POST' && url.pathname === '/v1/pages:read') {
      const input = (await request.clone().json()) as { reads?: Record<string, { kind: string; id: string }> };
      if (input.reads) {
        browserReads.push({ method: request.method, path: url.pathname });
        headerReads.push({ method: request.method, path: url.pathname });
        const reads = Object.fromEntries(
          Object.entries(input.reads).map(([key, descriptor]) => {
            const item = entries.find((candidate) => candidate.subjectId === descriptor.id);
            return [key, item ? { status: 200, body: { subject: item.subject } } : { status: 404 }];
          }),
        );
        return json({ reads });
      }
      browserReads.push({ method: request.method, path: url.pathname });
      return pageFake(request);
    }
    if (request.method === 'GET' && url.pathname === '/v1/progressSessions') {
      browserReads.push({ method: request.method, path: url.pathname });
      return json({ progressSessions: [], next: null });
    }
    if (request.method === 'GET' && url.pathname === '/v1/libraryEntries') {
      browserReads.push({ method: request.method, path: url.pathname });
      calls.push({
        method: request.method,
        path: url.pathname,
        view: url.searchParams.get('view'),
        limit: url.searchParams.get('limit'),
        state: url.searchParams.get('state'),
        authorization: request.headers.get('authorization'),
      });
      const listed = entries.filter((item) => item.state === 'in_progress').slice(0, 6);
      return json({ libraryEntries: listed, next: null });
    }
    if (url.pathname !== '/v1/libraryContinue' || request.method !== 'GET')
      return json(problem(404, 'not_found'), 404, true);
    browserReads.push({ method: request.method, path: url.pathname });
    calls.push({
      method: request.method,
      path: url.pathname,
      view: null,
      limit: url.searchParams.get('limit'),
      state: null,
      authorization: request.headers.get('authorization'),
    });
    if (!request.headers.get('authorization')?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (failContinue) return json(problem(503, 'service_unavailable'), 503, true);
    const rawLimit = Number(url.searchParams.get('limit') ?? 20);
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 20;
    const listed = entries
      .filter((item) => item.state === 'in_progress')
      .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
      .slice(0, limit);
    return json({
      subjects: listed.map((item) => ({
        subjectId: item.subjectId,
        state: item.state,
        lastActivityAt: item.updatedAt,
        activeProgressSession: null,
      })),
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

async function readPage(path: string, cookie?: string) {
  const origin = await site();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    if (cookie)
      await context.addCookies([
        { name: session, value: cookie, domain: new URL(origin).hostname, path: '/', secure: true, httpOnly: true },
      ]);
    const page = await context.newPage();
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    await page.locator('[data-session-slot]').waitFor();
    if (cookie) await waitForPersonalRead(page, ['home-continue', path.split('/')[1]!]);
    await page.waitForLoadState('networkidle');
    return { status: response!.status(), html: await page.content() };
  } finally {
    await browser.close();
  }
}

async function inspectHome(path: string, cookie: string, width: number, openMenu = false) {
  const origin = await site();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: false });
    await context.addCookies([
      { name: session, value: cookie, domain: new URL(origin).hostname, path: '/', secure: true, httpOnly: true },
    ]);
    const page = await context.newPage();
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    await waitForPersonalRead(page, ['home-continue', path.split('/')[1]!]);
    await page.waitForLoadState('networkidle');
    if (openMenu) {
      await page.locator('[data-slot="cover-card-actions"] button').first().click();
      await page.locator('[data-slot="drawer-content"]').waitFor();
    }
    return await page.evaluate(() => {
      const personal = document.querySelector<HTMLElement>('[data-slot="personal"]');
      const row = personal?.querySelector<HTMLElement>('[data-slot="cover-row"]');
      const cards = [...(personal?.querySelectorAll<HTMLElement>('[data-slot="cover-card"]') ?? [])];
      const next = personal?.nextElementSibling as HTMLElement | null;
      const bounds = (element: HTMLElement | null) => {
        const rect = element?.getBoundingClientRect();
        return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null;
      };
      const style = row ? getComputedStyle(row) : null;
      return {
        personalClass: personal?.className ?? '',
        personal: bounds(personal ?? null),
        next: bounds(next),
        row: row
          ? {
              clientWidth: row.clientWidth,
              scrollWidth: row.scrollWidth,
              snap: style?.scrollSnapType ?? '',
              bounds: bounds(row),
              cards: cards.map(bounds),
            }
          : null,
        cardCount: cards.length,
        titlesInCovers: cards.map((card) => card.querySelector('[data-slot="cover"]')?.textContent?.trim() ?? ''),
        captionCount: personal?.querySelectorAll('[data-slot="cover-caption"]').length ?? 0,
        progressCount: personal?.querySelectorAll('[data-slot="progress-row"]').length ?? 0,
        placeholderGlyphCount: [...(personal?.querySelectorAll('[data-slot="cover"]') ?? [])].filter((cover) =>
          cover.textContent?.includes('…'),
        ).length,
        drawerOpen: !!document.querySelector('[data-slot="drawer-content"]'),
        menuButtons: [...(personal?.querySelectorAll<HTMLButtonElement>('button[aria-label]') ?? [])].map((button) =>
          button.getAttribute('aria-label'),
        ),
        controlVisibility: Object.fromEntries(
          [
            ...(personal?.querySelectorAll<HTMLButtonElement>(
              'button[aria-label="Next Continue items"], button[aria-label="Previous Continue items"]',
            ) ?? []),
          ].map((button) => [button.getAttribute('aria-label'), getComputedStyle(button).display !== 'none']),
        ),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  } finally {
    await browser.close();
  }
}
function main(html: string) {
  return /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
}
function linksIn(html: string) {
  const found: { href: string; text: string }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = /href="([^"]*)"/.exec(match[1] ?? '')?.[1]?.replaceAll('&amp;', '&');
    if (href) found.push({ href, text: match[2]!.replace(/<[^>]+>/g, '').trim() });
  }
  return found;
}
function personal(html: string): string | undefined {
  return /<section\b[^>]*data-slot="personal"[^>]*>([\s\S]*?)<\/section>/.exec(main(html))?.[1];
}
async function messageOf(locale: string, key: string): Promise<string> {
  const file = new URL(`../messages/${locale}.json`, import.meta.url);
  return ((await Bun.file(file).json()) as Record<string, string>)[key]!;
}
function continueReads() {
  return calls.filter((call) => call.method === 'GET' && call.path === '/v1/libraryContinue');
}

function readsTo(path: string) {
  return browserReads.filter((call) => call.path === path);
}

afterAll(async () => {
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // The dev server has already exited.
    }
});

test(
  'a signed-in visitor with subjects in progress sees them on the home page, most recently updated first, each card linking to its progress',
  async () => {
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const page = await readPage(`/${locale}`, cookie);
      expect(page.status).toBe(200);
      const row = personal(page.html);
      expect(row, `${locale} Continue row`).toBeDefined();
      expect(row).toMatch(new RegExp(`<h2\\b[^>]*>\\s*${await messageOf(locale, 'home_continue_heading')}\\s*</h2>`));
      // The row sits after the search box, and holds only entries in progress, newest first.
      const body = main(page.html);
      expect(body.indexOf('name="q"')).toBeLessThan(body.indexOf('data-slot="personal"'));
      // Cards keep titles in CoverCard and expose their subject destination only through the menu.
      expect([...(row ?? '').matchAll(/data-slot="cover-card"/g)]).toHaveLength(6);
      const hrefs = linksIn(row ?? '').map((link) => link.href);
      expect(hrefs).toHaveLength(6);
      expect(new Set(hrefs).size).toBe(3);
      expect(hrefs.every((href) => href.includes('/library/progress'))).toBe(true);
      expect(row).toContain('Newest read');
      expect(row).not.toContain('Only planned');
      expect(row).not.toContain('Already finished');
      // One read of the personal library, for entries in progress, up to six, with their subjects embedded.
      const reads = continueReads();
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({
        limit: '6',
      });
      expect(reads[0]!.authorization).toStartWith('Bearer ');
    }
    reset(crowded());
    const crowd = personal((await readPage('/en', cookie)).html) ?? '';
    expect([...crowd.matchAll(/data-slot="cover-card"/g)]).toHaveLength(12);
    expect(crowd).toContain('Crowded 9');
    expect(crowd).not.toContain('Crowded 3<');
  },
  timeout,
);

test(
  'fine pointer carousel controls follow the scroll position and the tile menu opens as a phone sheet',
  async () => {
    const cookie = await alice();
    reset(crowded());
    const view = await inspectHome('/en', cookie, 390, true);
    expect(view.drawerOpen).toBe(true);
    expect(view.menuButtons).toContain('Next Continue items');
    expect(view.menuButtons).toContain('Previous Continue items');
    expect(view.controlVisibility).toEqual({
      'Previous Continue items': false,
      'Next Continue items': true,
    });
  },
  timeout,
);

test(
  'Continue cards use the shared cover and progress row without an oversized empty slot',
  async () => {
    const cookie = await alice();
    reset();
    const view = await inspectHome('/en', cookie, 1280);
    expect(view.cardCount).toBe(6); // three cards for each responsive layout
    expect(view.titlesInCovers.every((title) => title === '')).toBe(true);
    expect(view.captionCount).toBe(0);
    expect(view.progressCount).toBe(6);
    expect(view.placeholderGlyphCount).toBe(0);
    expect(view.personalClass).not.toMatch(/min-h-/);
    expect(view.personal && view.next && view.next.top - view.personal.bottom).toBeLessThan(40);
  },
  timeout,
);

test(
  'at phone width Continue is a snapping sideways row with a partial next card and no page overflow',
  async () => {
    const cookie = await alice();
    reset(crowded());
    const view = await inspectHome('/en', cookie, 390);
    expect(view.row?.scrollWidth).toBeGreaterThan(view.row?.clientWidth ?? 0);
    expect(view.row?.snap).toContain('x mandatory');
    expect(view.row?.cards.some((card) => card && view.row && card.right > view.row.bounds.right)).toBe(true);
    expect(view.scrollWidth).toBeLessThanOrEqual(390);
  },
  timeout,
);

test(
  'a signed-out visitor, or one with nothing in progress, sees no Continue row and the home page makes no library read',
  async () => {
    reset();
    const cookie = await alice();
    for (const locale of locales) {
      reset();
      const out = await readPage(`/${locale}`);
      expect(out.status).toBe(200);
      expect(personal(out.html)).toBeUndefined();
      expect(out.html).not.toContain(await messageOf(locale, 'home_continue_heading'));
      expect(out.html).toContain('name="q"');
      expect(continueReads()).toHaveLength(0);

      reset(showcase().filter((item) => item.state !== 'in_progress'));
      const idle = await readPage(`/${locale}`, cookie);
      expect(idle.status).toBe(200);
      expect(personal(idle.html)).toBeUndefined();
      expect(idle.html).toContain('name="q"');
      expect(continueReads()).toHaveLength(1);
    }
  },
  timeout,
);

test(
  'when the library read fails, the home page still renders without the row',
  async () => {
    const cookie = await alice();
    reset();
    failContinue = true;
    const page = await readPage('/en', cookie);
    expect(continueReads()).toHaveLength(1);
    expect(page.status).toBe(200);
    expect(page.html).toContain('name="q"');
    expect(personal(page.html)).toBeUndefined();
    expect(page.html).not.toContain('Newest read');
  },
  timeout,
);

test(
  'when exposure does not list library_continue.list, home shows no Continue row and makes no library reads',
  async () => {
    const cookie = await alice();
    reset();
    continueOperationExposed = false;
    const page = await readPage('/en', cookie);
    expect(page.status).toBe(200);
    expect(personal(page.html)).toBeUndefined();
    expect(page.html).toContain('name="q"');
    expect(continueReads()).toHaveLength(0);
    expect(readsTo('/v1/libraryEntries')).toHaveLength(0);
    expect(readsTo('/v1/progressSessions')).toHaveLength(0);
  },
  timeout,
);

test(
  'a browser home render reads its public page once, then bounds signed-in Continue reads',
  async () => {
    await site();
    reset();
    const signedOut = await readPage('/en');
    expect(signedOut.status).toBe(200);
    expect(browserReads).toEqual([{ method: 'POST', path: '/v1/pages:read' }]);

    const cookie = await alice();
    reset(crowded());
    const signedIn = await readPage('/en', cookie);
    expect(signedIn.status).toBe(200);
    expect(readsTo('/v1/pages:read')).toHaveLength(2);
    expect(continueReads()).toHaveLength(1);
    expect(continueReads()[0]).toMatchObject({ limit: '6' });
    expect(headerReads).toHaveLength(1);
    expect(browserReads).toHaveLength(3);
  },
  timeout,
);
