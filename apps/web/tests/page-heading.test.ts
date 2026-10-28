import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = id(1);
const threadId = id(2);
const errorId = id(97);
const closedId = id(98);
const metadata = {
  route: 0,
  visibility: 'published',
  securityRevision: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
const body = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: [{ type: 'text', text: 'A contribution' }] }],
  },
};
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
  body,
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

function problem(status: number, code: string) {
  return {
    type: `https://rezics.com/problems/${code}`,
    title: code,
    status,
    code,
    retryable: false,
    effect_status: status === 403 ? 'not_applied' : 'not_applicable',
    request_id: randomUUID(),
  };
}
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(status >= 400 ? { 'content-type': 'application/problem+json' } : {}),
    },
  });

// Discovery and signing keys copied from threads-read.test.ts; these public reads need no token grant.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
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
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    if (url.pathname === `/v1/boards/${errorId}` || url.pathname === `/v1/boards/${errorId}/threads`)
      return json(problem(500, 'internal_error'), 500);
    if (url.pathname === `/v1/boards/${closedId}` || url.pathname === `/v1/boards/${closedId}/threads`)
      return json(problem(403, 'platform_closed'), 403);
    if (request.method !== 'GET') return json(problem(404, 'not_found'), 404);
    if (url.pathname === `/v1/boards/${boardId}`) return json(board);
    if (url.pathname === `/v1/boards/${boardId}/threads`) return json({ threads: [thread.thread], next: null });
    if (url.pathname === `/v1/threads/${threadId}`) return json(thread);
    if (url.pathname === `/v1/threads/${threadId}/posts`) return json({ posts: [post], next: null });
    return json(problem(404, 'not_found'), 404);
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
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

let browser: Browser | undefined;
async function open(path: string): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
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

async function headingStyle(path: string) {
  const page = await open(path);
  try {
    const heading = page.locator('main').getByRole('heading', { level: 1 });
    expect(await heading.count()).toBe(1);
    return await heading.evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight };
    });
  } finally {
    await page.context().close();
  }
}

test(
  'public pages share their main heading style, and a signed-out library request redirects to sign-in',
  async () => {
    const styles = [];
    const origin = await site();
    const library = await fetch(`${origin}/en/library`, { redirect: 'manual' });
    expect(library.status).toBe(302);
    const location = new URL(library.headers.get('location')!, origin);
    expect(location.pathname).toBe('/auth/sign-in');
    expect(location.searchParams.get('return_to')).toBe('/en/library');
    for (const path of [`/en/boards/${boardId}`, `/en/threads/${threadId}`, '/en/search', '/en/missing'])
      styles.push(await headingStyle(path));
    expect(styles.every((style) => style.family === styles[0]!.family)).toBe(true);
    expect(styles.every((style) => style.size === styles[0]!.size)).toBe(true);
    expect(styles.every((style) => style.weight === styles[0]!.weight)).toBe(true);
    expect(styles[0]!.weight).toBe('600');
    expect(styles[0]!.size).toBe('36px');
  },
  timeout,
);

test(
  'the not-found, error and not-open-yet pages say what happened and offer the home page and search',
  async () => {
    for (const { path, heading, message } of [
      {
        path: '/en/missing',
        heading: 'Page not found',
        message: 'The page you requested could not be found.',
      },
      {
        path: `/en/boards/${errorId}`,
        heading: 'Something went wrong',
        message: 'Please try again.',
      },
      {
        path: `/en/boards/${closedId}`,
        heading: 'Not open yet',
        message: 'This part of REZICS is not open yet.',
      },
    ]) {
      const page = await open(path);
      try {
        const main = page.locator('main');
        expect((await main.getByRole('heading', { level: 1 }).textContent())?.trim()).toBe(heading);
        expect(await main.innerText()).toContain(message);
        const hrefs = await main
          .getByRole('link')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
        const paths = hrefs.map((href) => (href ? new URL(href, page.url()).pathname.replace(/\/$/, '') : ''));
        expect(paths).toContain('/en');
        expect(paths).toContain('/en/search');
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
