import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const narrow = { width: 320, height: 640 };
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
      content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: [{ type: 'text', text: 'A contribution' }] }],
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
        if (response.status < 500) return origin;
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
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  if (options.javaScriptEnabled !== false)
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}

async function visit(page: Page, path: string, javaScriptEnabled = true): Promise<void> {
  const origin = await site();
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
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
    const signInUrl = await page.locator('a[href^="/auth/sign-in"]').getAttribute('href');
    await Promise.all([
      page.waitForResponse((response) => response.url().startsWith(`${origin}/auth/callback`)),
      page.goto(new URL(signInUrl!, origin).href),
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

const pages = (locale: string) => [`/${locale}/boards/${boardId}`, `/${locale}/threads/${threadId}`];

async function visible(page: Page, name: string, exact = true): Promise<boolean> {
  const control = page.getByRole('banner').getByRole('button', { name, exact });
  return (await control.count()) > 0 && (await control.first().isVisible());
}

test.serial(
  'signed in or out, in English or Japanese, no page is wider than a 320 or 390 pixel phone screen',
  async () => {
    const session = await signedInState();
    for (const locale of ['en', 'ja'] as const)
      for (const viewport of [narrow, phone])
        for (const signed of [false, true]) {
          const page = await open(pages(locale)[0]!, { viewport, ...(signed ? { storageState: session } : {}) });
          for (const path of pages(locale)) {
            const where = `${locale} ${viewport.width}px ${signed ? 'signed in' : 'signed out'} ${path}`;
            await visit(page, path);
            const widths = await page.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              inner: window.innerWidth,
            }));
            expect(widths.scroll, where).toBeLessThanOrEqual(widths.inner);
          }
          await page.context().close();
        }
  },
  timeout,
);

test.serial(
  'on a phone the header holds the logo, language, theme and account controls, and the navigation sheet carries every destination',
  async () => {
    const session = await signedInState();
    for (const locale of ['en', 'ja'] as const) {
      const own = await messages(locale);
      for (const signed of [false, true]) {
        const where = `${locale} ${signed ? 'signed in' : 'signed out'}`;
        const page = await open(pages(locale)[0]!, { viewport: phone, ...(signed ? { storageState: session } : {}) });
        const header = page.getByRole('banner');
        expect(await header.getByRole('link', { name: 'REZICS', exact: true }).isVisible(), `${where} logo`).toBe(true);
        expect(await header.getByRole('button', { name: own.shell_language! }).isVisible(), `${where} language`).toBe(
          true,
        );
        expect(await visible(page, own.shell_theme!), `${where} theme`).toBe(true);
        if (signed) {
          expect(await visible(page, own.account_menu!), `${where} account`).toBe(true);
          const label = await header.getByText(own.account_menu!, { exact: true }).boundingBox();
          expect(label?.width ?? 0, `${where} label`).toBeLessThanOrEqual(1);
        } else {
          expect(await header.getByRole('button', { name: own.account_menu!, exact: true }).isVisible()).toBe(true);
        }
        await header.getByRole('button', { name: own.account_menu!, exact: true }).click();
        const account = page.getByRole('dialog', { name: own.account_menu!, exact: true });
        await account.waitFor();
        if (signed) await account.getByRole('link', { name: own.account_security_settings!, exact: true }).waitFor();
        else await account.getByRole('link', { name: own.account_sign_in!, exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await account.waitFor({ state: 'hidden' });
        expect(await visible(page, own.shell_open_navigation!), `${where} toggle`).toBe(true);
        expect(await visible(page, own.shell_collapse_navigation!), `${where} collapse`).toBe(false);
        expect(await header.locator(`input[aria-label="${own.search_label}"]`).isVisible(), `${where} search`).toBe(
          false,
        );
        await header.getByRole('button', { name: own.shell_open_navigation!, exact: true }).click();
        await page.getByRole('dialog').waitFor();
        const bar = page.getByRole('navigation', { name: own.shell_navigation!, exact: true }).locator('a');
        const names = await bar.evaluateAll((anchors) => anchors.map((a) => (a.textContent ?? '').trim()));
        expect(names, where).toEqual(
          signed ? [own.nav_home, own.nav_search, own.nav_library] : [own.nav_home, own.nav_search],
        );
        await page.context().close();
      }
    }
  },
  timeout,
);

test.serial(
  'on a desktop the header keeps the search field and the account button keeps its label',
  async () => {
    const session = await signedInState();
    for (const locale of ['en', 'ja'] as const) {
      const own = await messages(locale);
      const page = await open(pages(locale)[0]!, { storageState: session });
      const header = page.getByRole('banner');
      expect(await header.locator(`input[aria-label="${own.search_label}"]`).isVisible(), locale).toBe(true);
      expect(await header.getByText(own.account_menu!, { exact: true }).isVisible(), locale).toBe(true);
      expect(await visible(page, own.shell_collapse_navigation!), locale).toBe(true);
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(widths.scroll, locale).toBeLessThanOrEqual(widths.inner);
      await page.context().close();
    }
  },
  timeout,
);
