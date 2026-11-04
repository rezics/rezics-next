import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const session = randomBytes(24).toString('hex');
const clientId = 'reader+client';
const displayName = 'Reader <img src=x onerror=alert(1)>';
const registered = ['openid', 'offline_access', 'library:read', 'library:write'];
const granted = ['openid', 'library:write'];
const requested = ['openid', 'offline_access', 'library:read'];
type Call = { method: string; url: string; headers: Record<string, string>; body: string };
const calls: Call[] = [];
let readStatus = 200;
let writeStatus = 200;
let responseCode = 'unavailable';

// Copied from recovery.test.ts's fake Auth and reduced to the consent browser HTTP contract.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const call = {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      body: await request.text(),
    };
    calls.push(call);
    const headers = new Headers({ 'cache-control': 'no-store' });
    const signedIn = (call.headers.cookie ?? '')
      .split(';')
      .some((cookie) => cookie.trim() === `auth_session=${session}`);
    if (url.pathname.startsWith('/consent/') && request.method === 'GET') {
      if (!signedIn) return Response.json({ code: 'authentication_denied' }, { status: 401, headers });
      const id = decodeURIComponent(url.pathname.slice('/consent/'.length));
      if (id !== clientId && id !== 'unnamed') return Response.json({ code: 'not_found' }, { status: 404, headers });
      if (readStatus === 200)
        return Response.json(
          {
            client_id: id,
            display_name: id === 'unnamed' ? null : displayName,
            scopes: registered,
            requested: [...new Set((url.searchParams.get('scope') ?? '').split(' ').filter(Boolean))],
            granted,
            pending_reduction: false,
            acting_account: { account_id: 'person-1', email: 'person@example.test' },
            decisions: { allow: true, decline: true, switch_account: true },
          },
          { headers },
        );
      headers.set('retry-after', '37');
      return Response.json({ code: responseCode, message: 'HOSTILE AUTH BODY' }, { status: readStatus, headers });
    }
    if (url.pathname === '/consent' && request.method === 'POST') {
      if (!signedIn) return Response.json({ code: 'authentication_denied' }, { status: 401, headers });
      const body = JSON.parse(call.body);
      if (
        Object.keys(body).sort().join(',') !==
          'client_id,reviewed_account_id,reviewed_requested,reviewed_scopes,scope' ||
        !Array.isArray(body.scope) ||
        body.scope.some((scope: string) => !registered.includes(scope))
      )
        return Response.json({ code: 'invalid_request' }, { status: 400, headers });
      if (writeStatus === 200)
        return Response.json(
          {
            client_id: body.client_id,
            scope: body.scope,
            account_id: body.reviewed_account_id,
            requested: body.reviewed_requested,
          },
          { headers },
        );
      headers.set('retry-after', '37');
      return Response.json({ code: responseCode, message: 'HOSTILE AUTH BODY' }, { status: writeStatus, headers });
    }
    return new Response('Not Found', { status: 404, headers });
  },
});

function requestPath(id = clientId, scope = requested.join(' ')) {
  return `/consent?${new URLSearchParams({ client_id: id, scope, return_to: 'https://evil.example/' })}`;
}

// Copied from apps/web/tests/session.test.ts.
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

// Copied from apps/auth/tests/login.test.ts's Auth origin and readiness page.
function site(): Promise<string> {
  started ??= (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const port = await freePort();
      let output = '';
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
      };
      child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: app,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AUTH_ORIGIN: fake.url.origin },
      });
      let startError: Error | undefined;
      child.on('error', (error) => {
        startError = error;
      });
      child.stdout!.on('data', keep);
      child.stderr!.on('data', keep);
      const origin = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 150_000;
      for (;;) {
        if (startError) throw startError;
        if (child.exitCode !== null) {
          if (output.includes('Port ') && output.includes('already in use') && attempt < 3) break;
          throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
        }
        try {
          const response = await fetch(`${origin}/consent`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          });
          if (response.status === 200) return origin;
        } catch {}
        if (Date.now() > deadline) throw new Error(`dev server did not serve /consent in time:\n${output}`);
        await Bun.sleep(500);
      }
    }
    throw new Error('could not start the Auth dev server after retrying occupied ports');
  })();
  return started;
}

async function open(path = requestPath(), signedIn = true, options: BrowserContextOptions = {}) {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    ...options,
    javaScriptEnabled: true,
  });
  if (signedIn) await context.addCookies([{ name: 'auth_session', value: session, url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.status(), 'the documented dev server serves the page').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin, urls, responseHeaders: response?.headers() ?? {} };
  } catch (error) {
    await context.close();
    throw error;
  }
}

beforeAll(async () => {
  await site();
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function ready(page: Page) {
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
}

function reads() {
  return calls.filter((call) => call.method === 'GET' && call.url.startsWith('/consent/'));
}
function writes() {
  return calls.filter((call) => call.method === 'POST');
}

async function approve(page: Page) {
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'You can return to the client.' }).waitFor();
}

test(
  'a signed-in person sees the client and every requested scope, and approval sends the full approved set',
  async () => {
    calls.length = 0;
    const { page, origin, urls } = await open(requestPath(clientId, requested.concat('openid').join(' ')));
    try {
      await ready(page);
      expect(await page.getByText(displayName, { exact: true }).count()).toBe(1);
      expect(await page.getByText('You’re signed in as person@example.test.', { exact: true }).count()).toBe(1);
      expect(await page.locator('main img').count()).toBe(0);
      for (const scope of requested) {
        const row = page.getByRole('listitem').filter({ hasText: scope });
        expect(await row.count()).toBe(1);
        expect(await row.innerText()).toContain(scope === 'openid' ? 'Already granted' : 'New access');
      }
      expect(await page.getByText('Identify you', { exact: true }).count()).toBe(1);
      expect(await page.getByText('Keep access when you are away', { exact: true }).count()).toBe(1);
      expect(reads()).toHaveLength(1);
      expect(reads()[0]!.url).toBe(
        `/consent/${encodeURIComponent(clientId)}?${new URLSearchParams({
          scope: requested.concat('openid').join(' '),
        })}`,
      );
      expect(reads()[0]!.headers.cookie).toContain(`auth_session=${session}`);
      expect(urls.filter((url) => new URL(url).pathname.startsWith('/consent/'))).toHaveLength(1);
      await approve(page);
      expect(writes()).toHaveLength(1);
      const write = writes()[0]!;
      expect(JSON.parse(write.body)).toEqual({
        client_id: clientId,
        scope: [...new Set([...granted, ...requested])],
        reviewed_account_id: 'person-1',
        reviewed_scopes: granted,
        reviewed_requested: requested,
      });
      expect(write.headers['content-type']).toBe('application/json');
      expect(write.headers.origin).toBe(origin);
      expect(write.headers.cookie).toContain(`auth_session=${session}`);
      expect(new URL(page.url()).origin).toBe(origin);
      expect(new URL(page.url()).pathname).toBe('/consent');
      expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'requested scopes the client has not registered are not offered',
  async () => {
    calls.length = 0;
    const unavailable = 'admin:<script>alert(1)</script>';
    const { page } = await open(requestPath('unnamed', `offline_access ${unavailable}`));
    try {
      await ready(page);
      expect(await page.getByText('unnamed', { exact: true }).count()).toBe(1);
      const row = page.getByRole('listitem').filter({ hasText: unavailable });
      expect(await row.innerText()).toContain('Not available');
      expect(await row.getByRole('checkbox').count()).toBe(0);
      await approve(page);
      expect(JSON.parse(writes()[0]!.body)).toEqual({
        client_id: 'unnamed',
        scope: [...granted, 'offline_access'],
        reviewed_account_id: 'person-1',
        reviewed_scopes: granted,
        reviewed_requested: ['offline_access', unavailable],
      });
      expect(await page.locator('main script').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'declining writes nothing',
  async () => {
    calls.length = 0;
    const { page, origin } = await open();
    try {
      await ready(page);
      await page.getByRole('button', { name: 'Decline', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Review declined. This choice sends no approval.' }).waitFor();
      expect(writes()).toHaveLength(0);
      expect(reads()).toHaveLength(1);
      expect(new URL(page.url()).origin).toBe(origin);
      expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'signed out, the page offers sign-in; an unknown or first-party client shows not found',
  async () => {
    calls.length = 0;
    const { page } = await open(requestPath(), false);
    try {
      await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
      const login = new URL(
        await page.getByRole('link', { name: 'Sign in', exact: true }).getAttribute('href')!,
        'https://auth.test',
      );
      expect(login.pathname).toBe('/login');
      expect(login.searchParams.get('return_to')).toBe(requestPath().replace(/&return_to=.*$/, ''));
      expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
    for (const id of ['unknown', 'rezics-website']) {
      const { page } = await open(requestPath(id));
      try {
        await page.getByText('Client not found.', { exact: true }).waitFor();
        expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
      } finally {
        await page.context().close();
      }
    }
    expect(writes()).toHaveLength(0);
  },
  timeout,
);

test(
  'read and approval failures use localized status and code messages without exposing body text',
  async () => {
    for (const operation of ['read', 'write']) {
      calls.length = 0;
      readStatus = operation === 'read' ? 429 : 200;
      writeStatus = 429;
      responseCode = 'rate_limited';
      const { page } = await open();
      try {
        if (operation === 'write') {
          await ready(page);
          await page.getByRole('button', { name: 'Approve', exact: true }).click();
        }
        await page.getByRole('alert').filter({ hasText: 'Please try again in 37 seconds.' }).waitFor();
        expect(await page.getByText('HOSTILE AUTH BODY').count()).toBe(0);
        expect(reads()).toHaveLength(1);
        if (operation === 'write') {
          writeStatus = 200;
          await approve(page);
          expect(writes()).toHaveLength(2);
        }
      } finally {
        readStatus = writeStatus = 200;
        await page.context().close();
      }
    }
  },
  timeout,
);
