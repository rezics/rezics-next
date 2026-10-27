import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['library_entry:list', 'library_entry:read', 'library_entry:update', 'library_entry:delete'];

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

const json = (body: unknown, status = 200, problem = false) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(problem ? { 'content-type': 'application/problem+json' } : {}),
    },
  });

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const day = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * day).toISOString();
const reloadedStamp = '2026-05-01T00:00:00.000Z';

type EntryState = 'planned' | 'in_progress' | 'completed' | 'paused' | 'dropped';
const statuses: EntryState[] = ['in_progress', 'planned', 'completed', 'paused', 'dropped'];
type Entry = {
  subjectId: string;
  state: EntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  subject: ReturnType<typeof summary>;
};
function summary(n: number, label: string) {
  return {
    id: id(n),
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: label, language: 'en' },
    creativeWork: true,
    cover: null,
  };
}
function entry(n: number, state: EntryState, label: string, ago: number, revision = 1): Entry {
  return {
    subjectId: id(n),
    state,
    revision,
    createdAt: daysAgo(ago),
    updatedAt: daysAgo(ago),
    subject: summary(n, label),
  };
}
// A library with `count` entries of one status, newest first, labelled `<prefix> 001`, `<prefix> 002`, …
function many(state: EntryState, prefix: string, count: number, first: number): Entry[] {
  return Array.from({ length: count }, (_, index) =>
    entry(first + index, state, `${prefix} ${String(index + 1).padStart(3, '0')}`, 3),
  );
}
const showcase = (): Entry[] => [
  entry(11, 'in_progress', 'Kokoro', 3),
  entry(12, 'planned', 'Apple story', 4),
  entry(13, 'planned', 'Zebra story', 5),
  entry(14, 'completed', 'Moon story', 6),
];
let entries: Entry[] = showcase();

type Call = {
  method: string;
  path: string;
  key: string | null;
  revision: string | null;
  state: string | null;
  limit: string | null;
  cursor: string | null;
  body: unknown;
};
const calls: Call[] = [];
const reads = () => calls.filter((call) => call.method === 'GET' && call.path === '/v1/libraryEntries');
function reset(next: Entry[] = showcase()) {
  calls.length = 0;
  entries = next;
}
function problem(status: number, code: string) {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: status === 409 ? 'not_applied' : 'not_applicable',
    request_id: randomUUID(),
  };
}

// OpenID provider copied from library-rebuild.test.ts; the kernel fake pages by state, limit and cursor.
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
          { sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false },
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

    if (url.pathname === '/v1/definitions/active') return json({ digest: 'shelf-1' });
    if (url.pathname === '/v1/definitions/releases/shelf-1')
      return json({
        digest: 'shelf-1',
        release: { types: { 'schema:Book': { labels: { en: 'Book', 'zh-Hans': '书籍' } } }, properties: {} },
      });
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body = request.method === 'PUT' ? await request.json().catch(() => null) : null;
    calls.push({
      method: request.method,
      path: url.pathname,
      key: request.headers.get('idempotency-key'),
      revision: url.searchParams.get('revision'),
      state: url.searchParams.get('state'),
      limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor'),
      body,
    });
    if (!/^\/v1\/libraryEntries(\/|$)/.test(url.pathname)) return json(problem(404, 'not_found'), 404, true);
    if (!request.headers.get('authorization')?.startsWith('Bearer '))
      return json(problem(401, 'authentication_required'), 401, true);
    if (url.pathname === '/v1/libraryEntries' && request.method === 'GET') {
      const state = url.searchParams.get('state');
      const rows = entries.filter((item) => !state || item.state === state);
      const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));
      const offset = Number(url.searchParams.get('cursor')?.replace(/^c/, '') ?? 0);
      const next = offset + limit < rows.length ? `c${offset + limit}` : null;
      return json({ libraryEntries: rows.slice(offset, offset + limit), next });
    }
    const subjectId = /^\/v1\/libraryEntries\/([^/]+)$/.exec(url.pathname)?.[1];
    const current = entries.find((item) => item.subjectId === decodeURIComponent(subjectId ?? ''));
    if (!current) return json(problem(404, 'not_found'), 404, true);
    if (request.method === 'GET') return json({ libraryEntry: current });
    if (request.method === 'PUT') {
      const draft = body as { state?: EntryState; revision?: number };
      if (draft.revision !== current.revision || !draft.state) return json(problem(409, 'conflict'), 409, true);
      current.state = draft.state;
      current.revision += 1;
      current.updatedAt = reloadedStamp;
      const { subject: _subject, ...saved } = current;
      return json({ libraryEntry: saved });
    }
    if (request.method === 'DELETE') {
      if (Number(url.searchParams.get('revision')) !== current.revision)
        return json(problem(409, 'conflict'), 409, true);
      entries = entries.filter((item) => item.subjectId !== current.subjectId);
      return new Response(null, { status: 204 });
    }
    return json(problem(404, 'not_found'), 404, true);
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
let aliceAccess = '';
const alice = async () => {
  if (!aliceCookie) {
    const pending = signIn('/en', { sub: 'alice' });
    aliceCookie = pending;
    await pending;
    aliceAccess = accessTokens.at(-1) ?? '';
  }
  return aliceCookie;
};

let browser: Browser | undefined;

async function readPage(path: string, cookie?: string) {
  const response = await fetch(`${await site()}${path}`, {
    headers: cookie ? { cookie: `${session}=${cookie}` } : {},
  });
  return { status: response.status, html: await response.text() };
}
function main(html: string) {
  return /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? html;
}
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const count = (markup: string, pattern: RegExp) => [...markup.matchAll(pattern)].length;
/** The shelf sections of the All tab: the heading text, the markup and the links they carry. */
function sections(html: string) {
  return [...main(html).matchAll(/<section\b[\s\S]*?<\/section>/g)].map((match) => ({
    markup: match[0],
    title: text(/<h2\b[\s\S]*?<\/h2>/.exec(match[0])?.[0] ?? ''),
    links: linksIn(match[0]),
  }));
}
function linksIn(html: string) {
  const found: { href: string; text: string; current: boolean }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = /href="([^"]*)"/.exec(match[1] ?? '')?.[1]?.replaceAll('&amp;', '&');
    if (!href) continue;
    found.push({ href, text: text(match[2]!), current: /aria-current="page"/.test(match[1] ?? '') });
  }
  return found;
}
const links = (html: string) => linksIn(main(html));
const params = (href: string) => new URL(href, 'http://site.test').searchParams;

async function open(path: string, cookie: string): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.addCookies([
    { name: session, value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(50);
  expect(await check()).toBe(true);
}
// Escape closes one level of menu at a time: the status submenu first, then the menu.
async function closeMenus(page: Page) {
  for (let level = 0; level < 3 && (await page.getByRole('menu').count()) > 0; level++) {
    await page.keyboard.press('Escape');
    await Bun.sleep(150);
  }
  await page.getByRole('menu').first().waitFor({ state: 'detached' });
}
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
  'the All tab shows one section per status that has entries, In progress first titled Continue, each section linking to its tab, and no section for an empty status',
  async () => {
    reset([...showcase(), ...many('planned', 'Queued', 15, 100)]);
    const cookie = await alice();
    const page = await readPage('/en/library', cookie);
    expect(page.status).toBe(200);
    const shown = sections(page.html);
    // In progress comes first and is titled Continue; Paused and Dropped hold nothing, so they have no section.
    expect(shown.map((section) => section.title)).toEqual(['Continue', 'Planned', 'Completed']);
    const target = (section: (typeof shown)[number]) =>
      section.links.find((link) => link.text.startsWith('View all'))?.href;
    expect(shown.map((section) => params(target(section)!).get('state'))).toEqual([
      'in_progress',
      'planned',
      'completed',
    ]);
    expect(target(shown[0]!)!.startsWith('/en/library?')).toBe(true);
    // Each section shows its first 12 entries as cards, newest first.
    expect(count(shown[0]!.markup, /<article\b/g)).toBe(1);
    expect(text(shown[0]!.markup)).toContain('Kokoro');
    expect(count(shown[1]!.markup, /<article\b/g)).toBe(12);
    expect(text(shown[1]!.markup)).toContain('Apple story');
    expect(text(shown[1]!.markup)).not.toContain('Queued 011');
    expect(text(shown[2]!.markup)).toContain('Moon story');
    // The relative last update is the card's secondary line.
    expect(text(shown[0]!.markup)).toContain('Updated 3 days ago');
    // Five reads, one per status, 12 entries each, in parallel.
    const done = reads();
    expect(done).toHaveLength(5);
    expect(done.map((call) => call.state).sort()).toEqual([...statuses].sort());
    for (const call of done) expect(call.limit).toBe('12');

    // The layout and size carry into the sections and their links.
    const listed = await readPage('/en/library?layout=list&size=l', cookie);
    const listSections = sections(listed.html);
    expect(listSections.map((section) => section.title)).toEqual(['Continue', 'Planned', 'Completed']);
    expect(count(listSections[1]!.markup, /<li\b/g)).toBe(12);
    expect(count(listSections[1]!.markup, /<article\b/g)).toBe(0);
    const viewAll = params(target(listSections[1]!)!);
    expect([viewAll.get('state'), viewAll.get('layout'), viewAll.get('size')]).toEqual(['planned', 'list', 'l']);
    expect(links(listed.html).find((link) => link.text === 'Paused')?.current).toBe(false);
  },
  timeout,
);

test(
  "a status tab shows that status's entries as a CoverGrid of CoverCards by default, and layout=list and layout=table show the shelf list and the shelf table; layout, grid size and status survive paging, and an unknown value falls back to the default",
  async () => {
    reset([...showcase(), ...many('planned', 'Queued', 58, 100)]);
    const cookie = await alice();
    // 60 planned entries: Apple, Zebra and 58 queued.
    const grid = await readPage('/en/library?state=planned', cookie);
    const gridMain = main(grid.html);
    expect(count(gridMain, /<article\b/g)).toBe(48);
    expect(count(gridMain, /<table\b/g)).toBe(0);
    expect(count(gridMain, /<li\b/g)).toBe(0);
    expect(gridMain).toContain('grid-cols-3');
    expect(reads()).toHaveLength(1);
    expect(reads()[0]).toMatchObject({ state: 'planned', limit: '48', cursor: null });
    const more = links(grid.html).find((link) => link.text === 'More')!;
    expect(params(more.href).get('state')).toBe('planned');
    expect(params(more.href).get('cursor')).toBeTruthy();
    expect(params(more.href).has('layout')).toBe(false);

    // List and table, with a size, survive paging and a change of tab.
    const listed = await readPage('/en/library?state=planned&layout=list&size=l', cookie);
    const listMain = main(listed.html);
    expect(count(listMain, /<li\b/g)).toBe(48);
    expect(count(listMain, /<article\b/g)).toBe(0);
    expect(count(listMain, /<table\b/g)).toBe(0);
    const next = links(listed.html).find((link) => link.text === 'More')!;
    const kept = params(next.href);
    expect([kept.get('state'), kept.get('layout'), kept.get('size')]).toEqual(['planned', 'list', 'l']);
    const completedTab = links(listed.html).find((link) => link.text === 'Completed')!;
    const tabParams = params(completedTab.href);
    expect([tabParams.get('state'), tabParams.get('layout'), tabParams.get('size')]).toEqual([
      'completed',
      'list',
      'l',
    ]);
    expect(tabParams.has('cursor')).toBe(false);
    const second = await readPage(next.href, cookie);
    expect(count(main(second.html), /<li\b/g)).toBe(12);
    expect(links(second.html).some((link) => link.text === 'More')).toBe(false);

    const table = await readPage('/en/library?state=planned&layout=table', cookie);
    const tableMain = main(table.html);
    expect(count(tableMain, /<table\b/g)).toBe(1);
    expect(count(tableMain, /<article\b/g)).toBe(0);
    expect(count(/<tbody[\s\S]*<\/tbody>/.exec(tableMain)?.[0] ?? '', /<tr\b/g)).toBe(48);

    // The grid sizes are four, three and two columns on a phone.
    expect(main((await readPage('/en/library?state=planned&size=s', cookie)).html)).toContain('grid-cols-4');
    expect(main((await readPage('/en/library?state=planned&size=l', cookie)).html)).toContain('grid-cols-2');

    // Unknown values fall back to the defaults: All, a grid of medium size.
    const unknown = await readPage('/en/library?state=bogus&layout=bogus&size=huge', cookie);
    expect(unknown.status).toBe(200);
    const unknownMain = main(unknown.html);
    expect(sections(unknown.html).length).toBeGreaterThan(0);
    expect(count(unknownMain, /<article\b/g)).toBeGreaterThan(0);
    expect(count(unknownMain, /<table\b/g)).toBe(0);
    expect(unknownMain).toContain('grid-cols-3');
    expect(links(unknown.html).find((link) => link.text === 'All')?.current).toBe(true);
    // The Collections tab is a link to the person's collections; the tabs hold no counts.
    expect(links(unknown.html).find((link) => link.text === 'Collections')?.href).toBe('/en/library/collections');
    expect(text(unknownMain)).not.toMatch(/\bAll\s+\d/);
  },
  timeout,
);

test(
  "each item's menu changes its status and removes it after a confirmation saying that progress history, copies, follows and Collection memberships stay, and a conflicting change shows the current entry",
  async () => {
    reset();
    const page = await open('/en/library?state=planned', await alice());
    try {
      const apple = page.locator('main article').filter({ hasText: 'Apple story' });
      expect(await apple.count()).toBe(1);
      // The menu offers the status change, the subject page and removal.
      const menu = page.getByRole('menu');
      const actions = page.getByRole('button', { name: 'Actions for Apple story' });
      await actions.click();
      await menu.getByRole('menuitem', { name: 'Change status' }).click();
      const paused = menu.getByRole('menuitemradio', { name: 'Paused' });
      await paused.waitFor({ state: 'visible' });
      expect(await paused.count()).toBe(1);
      await closeMenus(page);
      await actions.click();
      await menu.getByRole('menuitem', { name: 'Open subject page' }).waitFor({ state: 'visible' });
      expect(await menu.getByRole('menuitem', { name: 'Open subject page' }).count()).toBe(1);
      expect(await menu.getByRole('menuitem', { name: 'Remove from library' }).count()).toBe(1);
      await closeMenus(page);

      // Choosing a status sends one revisioned write; the card says where the entry went.
      calls.length = 0;
      await actions.click();
      await menu.getByRole('menuitem', { name: 'Change status' }).click();
      await page.getByRole('menuitemradio', { name: 'Paused' }).click();
      await eventually(() => calls.some((call) => call.method === 'PUT'));
      expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
      expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: `/v1/libraryEntries/${id(12)}`,
        body: { state: 'paused', revision: 1 },
      });
      expect(calls.find((call) => call.method === 'PUT')!.key).toMatch(/^[0-9a-f-]{36}$/);
      await eventually(async () => (await apple.innerText()).includes('Paused'));

      // A conflicting change reloads the entry and shows what it is now.
      entries.find((item) => item.subjectId === id(13))!.state = 'dropped';
      entries.find((item) => item.subjectId === id(13))!.revision = 9;
      const zebra = page.locator('main article').filter({ hasText: 'Zebra story' });
      calls.length = 0;
      await page.getByRole('button', { name: 'Actions for Zebra story' }).click();
      await menu.getByRole('menuitem', { name: 'Change status' }).click();
      await page.getByRole('menuitemradio', { name: 'Completed' }).click();
      await eventually(() =>
        calls.some((call) => call.method === 'GET' && call.path === `/v1/libraryEntries/${id(13)}`),
      );
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        `PUT /v1/libraryEntries/${id(13)}`,
        `GET /v1/libraryEntries/${id(13)}`,
      ]);
      await eventually(async () => (await zebra.innerText()).includes('Dropped'));
      expect(await zebra.getByRole('status').innerText()).toBe('This entry changed elsewhere.');

      // Removal asks first, says what stays, and sends the revision the entry holds.
      calls.length = 0;
      await page.getByRole('button', { name: 'Actions for Apple story' }).click();
      await menu.getByRole('menuitem', { name: 'Remove from library' }).click();
      const dialog = page.getByRole('alertdialog');
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
      expect(text(await dialog.innerText())).toContain(
        'progress history, copies, follows and Collection memberships stay',
      );
      await dialog.getByRole('button', { name: 'Confirm removal', exact: true }).click();
      await eventually(() => calls.some((call) => call.method === 'DELETE'));
      expect(calls.find((call) => call.method === 'DELETE')).toMatchObject({
        path: `/v1/libraryEntries/${id(12)}`,
        revision: '2',
      });
      await eventually(async () => (await apple.count()) === 0);
      expect(entries.some((item) => item.subjectId === id(12))).toBe(false);
    } finally {
      await page.context().close();
    }

    // In the list, the status chip opens the status menu.
    reset();
    const listed = await open('/en/library?state=completed&layout=list', await alice());
    try {
      calls.length = 0;
      const row = listed.locator('main li').filter({ hasText: 'Moon story' });
      await row.getByRole('button', { name: 'Completed' }).click();
      await listed.getByRole('menuitemradio', { name: 'Planned' }).click();
      await eventually(() => calls.some((call) => call.method === 'PUT'));
      expect(calls.find((call) => call.method === 'PUT')).toMatchObject({
        path: `/v1/libraryEntries/${id(14)}`,
        body: { state: 'planned', revision: 1 },
      });
      await eventually(async () => (await row.innerText()).includes('Planned'));
    } finally {
      await listed.context().close();
    }
  },
  timeout,
);

test(
  'an empty library shows Nothing here yet with a link to browse, and an empty status tab says that status has nothing yet',
  async () => {
    reset([]);
    const cookie = await alice();
    const empty = await readPage('/en/library', cookie);
    expect(empty.status).toBe(200);
    expect(text(main(empty.html))).toContain('Nothing here yet');
    expect(links(empty.html).find((link) => link.text === 'Browse')?.href).toBe('/en/search');
    expect(sections(empty.html)).toHaveLength(0);
    // There are no filters yet, so there is no "nothing matches" state and no unfinished controls.
    expect(text(main(empty.html))).not.toMatch(/Select|Sort|Filter|nothing matches/i);

    reset(showcase());
    const tab = await readPage('/en/library?state=paused', cookie);
    expect(tab.status).toBe(200);
    expect(text(main(tab.html))).toContain('Nothing in Paused yet');
    expect(text(main(tab.html))).not.toContain('Nothing here yet');
    expect(count(main(tab.html), /<article\b/g)).toBe(0);
    expect(links(tab.html).find((link) => link.text === 'Paused')?.current).toBe(true);
    // The Chinese page says it in its own words.
    const own = (await Bun.file(join(app, 'messages', 'zh-Hans.json')).json()) as Record<string, string>;
    const chinese = await readPage('/zh-Hans/library', cookie);
    expect(text(main(chinese.html))).toContain(own.library_continue!);
  },
  timeout,
);

test(
  'the page renders without JavaScript and makes five entry reads for All and one for a status tab, with libraries of 10, 1,000 and 10,000 entries',
  async () => {
    const cookie = await alice();
    for (const size of [10, 1000, 10_000]) {
      reset(
        Array.from({ length: size }, (_, index) =>
          entry(1000 + index, statuses[index % statuses.length]!, `Book ${index}`, 3 + (index % 5)),
        ),
      );
      const all = await readPage('/en/library', cookie);
      expect(all.status).toBe(200);
      // Plain HTML, no script needed: the cards and the sections are in the document.
      const cards = count(main(all.html), /<article\b/g);
      expect(cards).toBe(Math.min(size, 60));
      expect(sections(all.html)).toHaveLength(5);
      expect(reads(), `All at ${size}`).toHaveLength(5);
      expect(calls.filter((call) => call.path !== '/v1/libraryEntries')).toHaveLength(0);

      calls.length = 0;
      const tab = await readPage('/en/library?state=planned', cookie);
      expect(tab.status).toBe(200);
      expect(count(main(tab.html), /<article\b/g)).toBe(Math.min(size / 5, 48));
      expect(reads(), `tab at ${size}`).toHaveLength(1);
      expect(calls).toHaveLength(1);
      calls.length = 0;
    }
  },
  timeout,
);
