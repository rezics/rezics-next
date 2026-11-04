import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const retryAfter = 37;
const email = 'reader+step-up@example.test';
const password = 'private +/&?=#秘密';
const previousSession = 'stale-session';
const session = randomBytes(24).toString('hex');
const signingKey = randomBytes(32);
const exp = '1893456000';
const sig = 'opaque-signature';
const authorizationQuery =
  'response_type=code&client_id=rezics-website' +
  '&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback' +
  '&scope=openid+offline_access&state=opaque%2Bstate%26next%3D%2Fevil' +
  '&nonce=nonce%2Fone&code_challenge=challenge&code_challenge_method=S256' +
  '&resource=https%3A%2F%2Fapi.rezics.test&resource=urn%3Asecond&empty=' +
  '&prompt=login&prompt=select_account&max_age=600';
const stepUpQuery = `${authorizationQuery}&exp=${exp}&sig=${sig}`;

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};
const calls: Call[] = [];
let startStatus: 200 | 400 | 429 | 503 = 200;
let completeStatus: 200 | 400 | 401 | 429 | 503 = 200;
let signInStatus: 200 | 401 | 429 | 503 = 200;

// Copied from apps/auth/tests/recovery.test.ts's fake Auth and reduced to the browser HTTP contract.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const call: Call = {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      body: await request.text(),
    };
    calls.push(call);
    const headers = new Headers({ 'cache-control': 'no-store' });
    if (url.pathname === '/recovery/page' && request.method === 'POST')
      return Response.json(
        recoveryPage(JSON.parse(call.body).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
        { headers },
      );

    if (url.pathname === '/authorize' && request.method === 'GET') {
      if ((call.headers.cookie ?? '').split(';').some((cookie) => cookie.trim() === `auth_session=${session}`))
        return new Response('Authorization resumed with the session', { headers });
      const issuedExp = String(Math.floor(Date.now() / 1000) + 300);
      const query = `${url.search.slice(1)}&exp=${issuedExp}`;
      const issuedSig = createHmac('sha256', signingKey).update(query).digest('base64url');
      headers.set('location', `/login?${query}&sig=${issuedSig}`);
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/signin' && request.method === 'POST') {
      if (signInStatus === 200) {
        headers.append('set-cookie', `auth_session=${session}; Path=/; HttpOnly; SameSite=Lax`);
        return Response.json({ success: true }, { headers });
      }
      if (signInStatus === 429) headers.set('retry-after', String(retryAfter));
      return Response.json(
        {
          code: signInStatus === 401 ? 'authentication_denied' : signInStatus === 429 ? 'rate_limited' : 'unavailable',
        },
        { status: signInStatus, headers },
      );
    }

    if (url.pathname === '/recovery/start' && request.method === 'POST') {
      if (startStatus === 200) return Response.json({ success: true }, { headers });
      if (startStatus === 429) headers.set('retry-after', String(retryAfter));
      return Response.json(
        { code: startStatus === 400 ? 'invalid_request' : startStatus === 429 ? 'rate_limited' : 'unavailable' },
        { status: startStatus, headers },
      );
    }

    if (url.pathname === '/recovery/complete' && request.method === 'POST') {
      if (completeStatus === 200) return Response.json({ success: true }, { headers });
      if (completeStatus === 429) headers.set('retry-after', String(retryAfter));
      const code =
        completeStatus === 400
          ? 'invalid_password'
          : completeStatus === 401
            ? 'invalid_recovery'
            : completeStatus === 429
              ? 'rate_limited'
              : 'unavailable';
      return Response.json({ code }, { status: completeStatus, headers });
    }

    return new Response('Not Found', { status: 404, headers });
  },
});

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

// Copied from apps/auth/tests/recovery.test.ts's Auth origin and readiness page.
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
          const response = await fetch(`${origin}/step-up`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          });
          if (response.status === 200) return origin;
        } catch {}
        if (Date.now() > deadline) throw new Error(`dev server did not serve /step-up in time:\n${output}`);
        await Bun.sleep(500);
      }
    }
    throw new Error('could not start the Auth dev server after retrying occupied ports');
  })();
  return started;
}

async function open(path = '/step-up', options: BrowserContextOptions = {}) {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    ...options,
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.status(), 'the documented dev server serves the page').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin };
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

function signedIn(): BrowserContextOptions {
  return {
    storageState: {
      cookies: [
        {
          name: 'auth_session',
          value: previousSession,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    },
  };
}

const signIns = () => calls.filter((call) => new URL(call.url, fake.url).pathname === '/signin');
const authorizations = () => calls.filter((call) => new URL(call.url, fake.url).pathname === '/authorize');

async function confirm(page: Page) {
  const address = page.getByLabel(/^email$/i);
  const secret = page.getByLabel(/^password$/i);
  expect(await address.count(), 'step-up has a labelled email field').toBe(1);
  expect(await secret.count(), 'step-up has a labelled password field').toBe(1);
  expect(await address.getAttribute('type')).toBe('email');
  expect(await address.getAttribute('autocomplete')).toBe('username');
  expect(await secret.getAttribute('type')).toBe('password');
  expect(await secret.getAttribute('autocomplete')).toBe('current-password');
  expect(await page.locator('main').innerText()).toMatch(/not recent enough/i);
  await address.fill(email);
  await secret.fill(password);
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
    page.getByRole('button', { name: 'Verify your identity', exact: true }).click(),
  ]);
  return { address, secret };
}

function postedSignIn(call: Call | undefined, origin: string) {
  expect(call, 'Auth receives a confirmation').toBeDefined();
  expect(call!.method).toBe('POST');
  expect(call!.url).toBe('/signin');
  expect(call!.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
  expect(call!.headers.origin).toBe(origin);
  expect(JSON.parse(call!.body)).toEqual({ email, password, client_id: 'login', scope: [] });
}

test(
  'a signed-in person confirms their password and resumes the authorization without sig, exp and prompt',
  async () => {
    signInStatus = 200;
    calls.length = 0;
    const { page, origin } = await open(`/step-up?${stepUpQuery}`, signedIn());
    try {
      await confirm(page);
      const expected = new URLSearchParams(stepUpQuery);
      for (const name of ['sig', 'exp', 'prompt']) expected.delete(name);
      const resumedUrl = `/authorize?${expected.toString()}`;
      await page.waitForURL(`${origin}${resumedUrl}`);
      expect(signIns()).toHaveLength(1);
      postedSignIn(signIns()[0], origin);
      expect(signIns()[0]!.headers.cookie ?? '').toContain(`auth_session=${previousSession}`);
      expect(authorizations().map((call) => call.url)).toEqual([resumedUrl]);
      const resumed = new URLSearchParams(new URL(authorizations()[0]!.url, fake.url).search);
      expect(resumed.has('sig')).toBe(false);
      expect(resumed.has('exp')).toBe(false);
      expect(resumed.has('prompt')).toBe(false);
      expect(resumed.get('max_age')).toBe('600');
      expect(resumed.getAll('resource')).toEqual(['https://api.rezics.test', 'urn:second']);
      expect(resumed.get('empty')).toBe('');
      expect(authorizations()[0]!.headers.cookie ?? '').toContain(`auth_session=${session}`);
      expect(authorizations()[0]!.headers.cookie ?? '').not.toContain(previousSession);
      expect((await page.context().cookies()).find((cookie) => cookie.name === 'auth_session')?.value).toBe(session);
      expect(await page.locator('body').innerText()).toContain('Authorization resumed with the session');
      expect(page.url()).not.toContain(password);
      expect(decodeURIComponent(page.url())).not.toContain(password);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'without an authorization query, step-up returns to security settings',
  async () => {
    signInStatus = 200;
    for (const path of ['/step-up', `/step-up?sig=${sig}&exp=${exp}&prompt=login&prompt=select_account`]) {
      calls.length = 0;
      const { page, origin } = await open(path);
      try {
        await confirm(page);
        await page.waitForURL(`${origin}/security`);
        expect(page.url()).toBe(`${origin}/security`);
        expect(await page.getByRole('heading', { name: 'Account security', exact: true }).count()).toBe(1);
        expect(signIns()).toHaveLength(1);
        postedSignIn(signIns()[0], origin);
        expect(authorizations()).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a wrong password, rate limit or outage keeps the person on the page with a localized message',
  async () => {
    for (const status of [401, 429, 503] as const) {
      signInStatus = status;
      calls.length = 0;
      const { page, origin } = await open(`/step-up?${stepUpQuery}`);
      try {
        const here = page.url();
        const { address, secret } = await confirm(page);
        const alert = page.getByRole('alert');
        await alert.waitFor({ state: 'visible' });
        const message = (await alert.innerText()).trim();
        expect(page.url(), 'a refusal stays on step-up').toBe(here);
        expect(new URL(page.url()).pathname).toBe('/step-up');
        expect(await address.inputValue()).toBe(email);
        expect(await secret.inputValue()).toBe('');
        expect(signIns()).toHaveLength(1);
        postedSignIn(signIns()[0], origin);
        expect(authorizations()).toEqual([]);
        if (status === 401) {
          expect(message).toMatch(/email\s+or\s+password/i);
          expect(message).toMatch(/incorrect|wrong|invalid/i);
          expect(message).not.toMatch(
            /^(?:the |your )?(?:email|password)\s+(?:is\s+)?(?:incorrect|wrong|invalid|unknown|not found)/i,
          );
          expect(message).not.toMatch(/not registered|does not exist|unknown (?:email|account)/i);
        } else if (status === 429) {
          expect(message).toMatch(/wait|try again|too many/i);
          expect(message).toContain(String(retryAfter));
          expect(message).toMatch(/seconds?/i);
        } else {
          expect(message).toMatch(/unavailable|not available/i);
          expect(message).toMatch(/try again|later/i);
        }
        const html = await page.locator('html').evaluate((element) => element.outerHTML);
        expect(html).not.toContain(password);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
