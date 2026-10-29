import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { browserSessionToken } from './session-token';
import { closeAccountMenu, openAccountMenu } from './support/account-menu';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const timeout = 300_000;
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
const resource = 'https://api.rezics.test';
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = id(1);
const threadId = id(2);
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
const post = {
  ...metadata,
  id: id(12),
  threadId,
  boardId,
  authorId: id(90),
  parentId: null,
  revisionId: id(112),
  sha256: 'a'.repeat(64),
  licence: 'CC-BY-4.0',
  subjectIds: [],
  mediaIds: [],
  availability: 'available',
  body: {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'paragraph' },
          content: [
            { type: 'text', text: 'A contribution with ' },
            {
              type: 'text',
              text: 'reading notes',
              marks: [{ type: 'link', attrs: { href: 'https://example.org/notes' } }],
            },
          ],
        },
      ],
    },
  },
};
const board = { board: { ...metadata, id: boardId, title: 'Reading room', availability: 'available' } };
const thread = {
  thread: {
    ...metadata,
    id: threadId,
    boardId,
    authorId: id(90),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title: 'Zebra reading',
    availability: 'available',
    firstPost: post,
  },
};
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];

type Messages = Record<string, string>;
async function messages(locale: string): Promise<Messages> {
  return (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Messages;
}

// The website client's key, which only the Worker holds, and the issuer's signing key.
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = { challenge: string; nonce: string; redirectUri: string };
const codes = new Map<string, Grant>();
let counter = 0;
const liveRefreshTokens = new Set<string>();

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Auth answers as a person who is already signed in, so the shell can read a real session from the request.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure') return json({ admitted: ['personal_library', 'collections'] });
    const issuer = `${url.origin}/auth`;
    const authenticated = async (form: URLSearchParams) => {
      try {
        await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        return true;
      } catch {
        return false;
      }
    };

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/authorize') {
      const params = url.searchParams;
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        challenge: params.get('code_challenge')!,
        nonce: params.get('nonce')!,
        redirectUri: params.get('redirect_uri')!,
      });
      const back = new URL(params.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state')!);
      return new Response(null, { status: 302, headers: { location: back.href } });
    }
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await authenticated(form))) return json({ error: 'invalid_client' }, 401);
      counter += 1;
      const tokens: Record<string, unknown> = {
        access_token: `access-${counter}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${counter}`,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        tokens.id_token = await new SignJWT({ nonce: grant.nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject('alice')
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      } else if (
        form.get('grant_type') !== 'refresh_token' ||
        !liveRefreshTokens.delete(form.get('refresh_token') ?? '')
      )
        return json({ error: 'invalid_grant' }, 400);
      liveRefreshTokens.add(tokens.refresh_token as string);
      return json(tokens);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') return new Response(null, { status: 200 });
    if (url.pathname === '/auth/logout')
      return new Response(null, {
        status: 302,
        headers: { location: url.searchParams.get('post_logout_redirect_uri') ?? issuer },
      });
    if (url.pathname === `/v1/boards/${boardId}`) return json(board);
    if (url.pathname === `/v1/boards/${boardId}/threads`) return json({ threads: [thread.thread], next: null });
    if (url.pathname === `/v1/threads/${threadId}`) return json(thread);
    if (url.pathname === `/v1/threads/${threadId}/posts`) return json({ posts: [post], next: null });
    return json({ error: 'not_found' }, 404);
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
let browser: Browser | undefined;

// The documented command, in its own process group so that Vite and workerd stop with it.
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
        if (response.status < 500) {
          for (const path of [`/en/boards/${boardId}`, `/en/threads/${threadId}`])
            await fetch(`${origin}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
          return origin;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(path: string, options: BrowserContextOptions = {}): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: 120_000 });
  if (options.javaScriptEnabled !== false)
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}

async function visit(page: Page, path: string, javaScriptEnabled = true): Promise<void> {
  const origin = await site();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle', timeout: 120_000 });
  if (javaScriptEnabled) await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

let signedIn: Promise<NonNullable<BrowserContextOptions['storageState']>> | undefined;
function signedInState(): Promise<NonNullable<BrowserContextOptions['storageState']>> {
  signedIn ??= (async () => {
    const origin = await site();
    const en = await messages('en');
    const page = await open('/en');
    await page.getByRole('button', { name: en.account_menu!, exact: true }).click();
    await Promise.all([
      page.waitForResponse((response) => response.url().startsWith(`${origin}/auth/callback`)),
      page.getByRole('link', { name: en.account_sign_in!, exact: true }).click(),
    ]);
    await page.waitForURL(`${origin}/en`);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === sessionCookie);
    expect(cookies).toHaveLength(1);
    await page.context().close();
    return { cookies, origins: [] };
  })();
  return signedIn;
}

// Reads one pixel of an 8-bit RGB or RGBA PNG, the format of a Playwright screenshot.
function decode(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? rows[y * stride + x - channels]! : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const corner = y > 0 && x >= channels ? rows[(y - 1) * stride + x - channels]! : 0;
      const guess = left + up - corner;
      const nearest = Math.min(Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - corner));
      const paeth = Math.abs(guess - left) === nearest ? left : Math.abs(guess - up) === nearest ? up : corner;
      const base = [0, left, up, (left + up) >> 1, paeth][filter]!;
      rows[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + base) & 255;
    }
  }
  return {
    height,
    pixel: (x: number, y: number) => [...rows.subarray(y * stride + x * channels, y * stride + x * channels + 3)],
  };
}

const board_ = (locale: string) => `/${locale}/boards/${boardId}`;
const thread_ = (locale: string) => `/${locale}/threads/${threadId}`;

// The word each locale uses for a person's own collection of books, anime, games and recipes, and the words that
// name something else (a database, a public library building, a bookshelf of one kind).
const libraryTerms: Record<(typeof locales)[number], { term: string; others: string[] }> = {
  en: { term: 'library', others: [] },
  'zh-Hans': { term: '书架', others: ['资料库', '书库', '图书馆'] },
  'zh-Hant': { term: '書架', others: ['資料庫', '書庫', '圖書館'] },
  ja: { term: 'ライブラリ', others: ['図書館', '本棚'] },
  ko: { term: '라이브러리', others: ['도서관', '서재'] },
  de: { term: 'bibliothek', others: [] },
  fr: { term: 'bibliothèque', others: [] },
  es: { term: 'biblioteca', others: [] },
};

test.serial(
  'the navigation column runs the full height of a long page and stays in view while it scrolls, on desktop',
  async () => {
    const own = await messages('en');
    for (const colorScheme of ['light', 'dark'] as const) {
      const page = await open(board_('en'), { colorScheme });
      await page.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.style.height = '3200px';
        document.querySelector('main')!.append(spacer);
      });
      // A full-page screenshot is how a long page is reviewed: its column must be painted down to the last pixel.
      const wanted = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--sidebar)';
        document.body.append(probe);
        const colour = getComputedStyle(probe).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number);
        probe.remove();
        return colour;
      });
      const header = await page.evaluate(() => document.querySelector('header')!.getBoundingClientRect().bottom);
      const image = decode(await page.screenshot({ fullPage: true }));
      expect(image.height, colorScheme).toBeGreaterThan(3200);
      for (const y of [header + 300, image.height / 2, image.height - 40])
        image
          .pixel(16, Math.round(y))
          .forEach((channel, index) =>
            expect(Math.abs(channel - wanted[index]!), `${colorScheme} ${y}`).toBeLessThanOrEqual(1),
          );
      // While the page scrolls the column stays in view, from under the header to the bottom of the window.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForFunction(() => window.scrollY > 1000);
      const state = await page.evaluate(() => {
        const rect = (element: Element) => element.getBoundingClientRect();
        const header = rect(document.querySelector('header')!);
        const column = document.querySelector('[data-sidebar="sidebar"]')!;
        const home = rect(document.querySelector('nav a')!);
        const covered = [0.05, 0.5, 0.95].map((fraction) => {
          const y = header.bottom + (window.innerHeight - header.bottom) * fraction;
          return document.elementFromPoint(16, y)?.closest('[data-sidebar="sidebar"]') === column;
        });
        return {
          top: rect(column).top,
          bottom: rect(column).bottom,
          header: header.bottom,
          inner: window.innerHeight,
          covered,
          home,
        };
      });
      expect(state.top, colorScheme).toBeLessThanOrEqual(state.header + 1);
      expect(state.bottom, colorScheme).toBeGreaterThanOrEqual(state.inner - 1);
      expect(state.covered, colorScheme).toEqual([true, true, true]);
      expect(state.home.top, colorScheme).toBeGreaterThanOrEqual(0);
      expect(state.home.bottom, colorScheme).toBeLessThanOrEqual(state.inner);
      const toggle = page
        .getByRole('banner')
        .getByRole('button', { name: own.shell_collapse_navigation!, exact: true });
      expect(await toggle.isVisible(), colorScheme).toBe(true);
      await page.context().close();
    }
  },
  timeout,
);

test.serial(
  'on phones the navigation opens as a sheet and the page keeps one main landmark and one named primary navigation',
  async () => {
    const session = await signedInState();
    for (const locale of ['en', 'ja'] as const) {
      const own = await messages(locale);
      for (const signed of [false, true]) {
        const where = `${locale} ${signed ? 'signed in' : 'signed out'}`;
        const page = await open(board_(locale), { viewport: phone, ...(signed ? { storageState: session } : {}) });
        const open_ = page.getByRole('banner').getByRole('button', { name: own.shell_open_navigation!, exact: true });
        expect(await open_.isVisible(), `${where} trigger`).toBe(true);
        expect(await page.getByRole('main').count(), `${where} closed main`).toBe(1);
        expect(await page.getByRole('dialog').count(), `${where} closed`).toBe(0);
        await open_.click();
        const sheet = page.getByRole('dialog', { name: own.shell_navigation!, exact: true });
        await sheet.waitFor({ state: 'visible' });
        expect(await page.locator('main').count(), `${where} open main`).toBe(1);
        const navigation = page.getByRole('navigation', { name: own.shell_navigation!, exact: true });
        expect(await navigation.count(), `${where} navigation`).toBe(1);
        expect(await sheet.getByRole('navigation').count(), `${where} inside`).toBe(1);
        const names = await navigation
          .locator('a')
          .evaluateAll((anchors) => anchors.map((a) => (a.textContent ?? '').trim()));
        expect(names, where).toEqual(
          signed ? [own.nav_home, own.nav_search, own.nav_library] : [own.nav_home, own.nav_search],
        );
        expect(await sheet.getByRole('button', { name: own.shell_close_navigation!, exact: true }).count(), where).toBe(
          1,
        );
        await page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'hidden' });
        expect(await open_.evaluate((button) => document.activeElement === button), `${where} focus`).toBe(true);
        await open_.click();
        await sheet.waitFor({ state: 'visible' });
        await navigation.getByRole('link', { name: own.nav_search!, exact: true }).click();
        await page.waitForURL(`**/${locale}/search`);
        await sheet.waitFor({ state: 'hidden' });
        expect(await page.getByRole('main').count(), `${where} after`).toBe(1);
        await page.context().close();
      }
    }
  },
  timeout,
);

test.serial(
  'on a phone without JavaScript the page still has one main landmark and one named primary navigation',
  async () => {
    const own = await messages('en');
    const page = await open(board_('en'), { viewport: phone, javaScriptEnabled: false });
    expect(await page.getByRole('main').count()).toBe(1);
    const navigation = page.getByRole('navigation', { name: own.shell_navigation!, exact: true });
    expect(await navigation.count()).toBe(1);
    expect(await navigation.getByRole('link', { name: own.nav_home!, exact: true }).isVisible()).toBe(true);
    expect(await navigation.getByRole('link', { name: own.nav_search!, exact: true }).isVisible()).toBe(true);
    await page.context().close();
  },
  timeout,
);

test.serial(
  'interface links are underlined only on hover or focus, and links inside prose stay underlined',
  async () => {
    const decoration = (page: Page, selector: string) =>
      page.evaluate((s) => getComputedStyle(document.querySelector(s)!).textDecorationLine, selector);
    const outside = (page: Page) =>
      page.evaluate(() =>
        [...document.querySelectorAll('a')]
          .filter((a) => !a.closest('.rezics-document'))
          // The underline may sit on the link or on text inside it.
          .filter((a) =>
            [a, ...a.querySelectorAll('*')].some((e) => getComputedStyle(e).textDecorationLine.includes('underline')),
          )
          .map((a) => a.textContent?.trim() ?? ''),
      );
    for (const locale of ['en', 'ja'] as const) {
      const page = await open(board_(locale));
      const link = `main a[href*="/threads/${threadId}"]`;
      expect(await page.locator(link).count(), locale).toBe(1);
      expect(await outside(page), `${locale} at rest`).toEqual([]);
      await page.locator(link).hover();
      expect(await decoration(page, link), `${locale} hover`).toContain('underline');
      await page.mouse.move(0, 400);
      expect(await decoration(page, link), `${locale} after hover`).toBe('none');
      for (let tab = 0; tab < 60; tab += 1) {
        await page.keyboard.press('Tab');
        if (await page.evaluate((s) => document.activeElement === document.querySelector(s), link)) break;
      }
      expect(
        await page.evaluate((s) => document.activeElement === document.querySelector(s), link),
        `${locale} reached`,
      ).toBe(true);
      expect(await decoration(page, link), `${locale} focus`).toContain('underline');
      await page.context().close();
    }
    const page = await open(thread_('en'));
    const prose = '.rezics-document a[href="https://example.org/notes"]';
    expect(await page.locator(prose).count()).toBe(1);
    expect(await decoration(page, prose)).toContain('underline');
    expect(await outside(page), 'thread at rest').toEqual([]);
    await page.context().close();
  },
  timeout,
);

test.serial(
  'the personal library uses one term in navigation, buttons and headings in every locale',
  async () => {
    const english = await messages('en');
    const keys = Object.keys(english).filter((key) => /librar/i.test(english[key]!));
    expect(keys).toContain('nav_library');
    expect(keys).toContain('library_subject_add');
    expect(keys).toContain('library_heading');
    for (const locale of locales) {
      const own = await messages(locale);
      const { term, others } = libraryTerms[locale];
      for (const key of keys) expect(own[key]!.toLowerCase(), `${locale} ${key}`).toContain(term);
      for (const [key, value] of Object.entries(own))
        for (const other of others) expect(value, `${locale} ${key}`).not.toContain(other);
    }
    const session = await signedInState();
    for (const locale of ['zh-Hans', 'zh-Hant', 'de'] as const) {
      const own = await messages(locale);
      const { term } = libraryTerms[locale];
      const page = await open(board_(locale), { storageState: session });
      const navigation = page.getByRole('navigation', { name: own.shell_navigation!, exact: true });
      const link = (await navigation.getByRole('link', { name: own.nav_library!, exact: true }).textContent())!;
      expect(link.toLowerCase(), locale).toContain(term);
      await openAccountMenu(page);
      const account = await page.locator('#account-menu a[href$="/library"]').textContent();
      expect(account?.toLowerCase(), `${locale} account`).toContain(term);
      await closeAccountMenu(page);
      await page.context().close();
    }
  },
  timeout,
);

test.serial(
  'the personal library uses one term in the account menu at phone and desktop widths',
  async () => {
    const session = await signedInState();
    const own = await messages('en');
    for (const viewport of [phone, desktop]) {
      const page = await open(board_('en'), { storageState: session, viewport });
      try {
        expect(await page.locator('#account-menu').count()).toBe(0);
        const menu = await openAccountMenu(page);
        await openAccountMenu(page);
        expect(await menu.locator('a[href$="/library"]').textContent()).toBe(own.nav_library!);
        const token = await browserSessionToken(page);
        expect(await page.locator('#account-menu').count()).toBe(0);
        const reopened = await openAccountMenu(page);
        expect(await reopened.locator('input[name="csrf_token"]').inputValue()).toBe(token);
        await closeAccountMenu(page);
        expect(await page.locator('#account-menu').count()).toBe(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
