import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { signInPage } from './security-page-fixture';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const retryAfter = 37;
const email = 'reader+recovery@example.test';
const newPassword = 'new secure password';
const accountId = 'acct+id/秘密';
const token = 'secret+/&?=#token';
const session = randomBytes(24).toString('hex');
const signingKey = randomBytes(32);
const authorizationQuery =
  'response_type=code&client_id=rezics-website' +
  '&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback' +
  '&scope=openid+offline_access&state=opaque%2Bstate%26next%3D%2Fevil' +
  '&nonce=nonce%2Fone&code_challenge=challenge&code_challenge_method=S256' +
  '&resource=https%3A%2F%2Fapi.rezics.test&resource=urn%3Asecond&empty=' +
  '&prompt=login&prompt=select_account&max_age=600';

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

// Copied from apps/auth/tests/login.test.ts's fake Auth and reduced to the browser HTTP contract.
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
    if (url.pathname === '/signin/page' && request.method === 'POST')
      return Response.json(signInPage(JSON.parse(call.body).query, url.origin, { kind: 'signed-out' }), { headers });
    if (url.pathname === '/recovery/page' && request.method === 'POST')
      return Response.json(
        recoveryPage(JSON.parse(call.body).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
        { headers },
      );

    if (url.pathname === '/authorize' && request.method === 'GET') {
      if ((call.headers.cookie ?? '').split(';').some((cookie) => cookie.trim() === `auth_session=${session}`))
        return new Response('Authorization resumed with the session', { headers });
      const exp = String(Math.floor(Date.now() / 1000) + 300);
      const query = `${url.search.slice(1)}&exp=${exp}`;
      const sig = createHmac('sha256', signingKey).update(query).digest('base64url');
      headers.set('location', `/login?${query}&sig=${sig}`);
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
          const response = await fetch(`${origin}/recovery`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          });
          if (response.status === 200) return origin;
        } catch {}
        if (Date.now() > deadline) throw new Error(`dev server did not serve /recovery in time:\n${output}`);
        await Bun.sleep(500);
      }
    }
    throw new Error('could not start the Auth dev server after retrying occupied ports');
  })();
  return started;
}

type StorageFailure = 'access' | 'setItem' | 'getItem' | 'removeItem';

async function open(path = '/recovery', options: BrowserContextOptions = {}, storageFailure?: StorageFailure) {
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
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  await page.addInitScript((storageFailure) => {
    try {
      const previousHash = window.sessionStorage.getItem('recovery-hash-at-request');
      if (previousHash !== null)
        (window as unknown as { recoveryHashAtRequest?: string }).recoveryHashAtRequest = previousHash;
    } catch {}
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/recovery\/(?:start|complete)$/.test(new URL(requestUrl, location.href).pathname)) {
        (window as unknown as { recoveryHashAtRequest?: string }).recoveryHashAtRequest = location.hash;
        try {
          window.sessionStorage.setItem('recovery-hash-at-request', location.hash);
        } catch {}
      }
      return nativeFetch.call(this, input, init);
    };
    if (storageFailure === 'access') {
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new DOMException('Storage denied', 'SecurityError');
        },
      });
    } else if (storageFailure) {
      const original = Storage.prototype[storageFailure];
      Object.defineProperty(Storage.prototype, storageFailure, {
        value(this: Storage, key: string, value?: string) {
          if (key === 'auth.recovery.complete') throw new DOMException('Storage denied', 'SecurityError');
          return Reflect.apply(original, this, value === undefined ? [key] : [key, value]);
        },
      });
    }
  }, storageFailure);
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

async function startForm(page: Page) {
  const address = page.getByLabel(/email/i);
  expect(await address.count(), 'recovery start has a labelled email field').toBe(1);
  return { address, submit: page.getByRole('button', { name: 'Send recovery link', exact: true }) };
}

async function completeForm(page: Page) {
  const password = page.getByLabel(/new password/i);
  expect(await password.count(), 'recovery completion has a labelled new password field').toBe(1);
  return { password, submit: page.getByRole('button', { name: 'Update password', exact: true }) };
}

async function sendStart(page: Page, address: string) {
  const controls = await startForm(page);
  await controls.address.fill(address);
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/recovery/start'),
    controls.submit.click(),
  ]);
  return controls;
}

async function sendComplete(page: Page, value = newPassword) {
  const controls = await completeForm(page);
  await controls.password.fill(value);
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/recovery/complete'),
    controls.submit.click(),
  ]);
  return controls;
}

function recoveryCalls(path: 'start' | 'complete') {
  return calls.filter((call) => new URL(call.url, fake.url).pathname === `/recovery/${path}`);
}

test(
  'Malformed recovery fragments show a safe new-link action before password entry and optional browser storage cannot strand confirmed completion',
  async () => {
    for (const fragment of [
      '#unrelated=value',
      `#account_id=${encodeURIComponent(accountId)}`,
      `#token=${encodeURIComponent(token)}`,
      `#account_id=&token=${encodeURIComponent(token)}`,
      `#account_id=${encodeURIComponent(accountId)}&token=`,
      '#account_id=&token=',
    ]) {
      calls.length = 0;
      const { page, origin, urls } = await open(`/recovery${fragment}`);
      try {
        expect(page.url()).toBe(`${origin}/recovery`);
        const alert = page.getByRole('alert');
        await alert.waitFor({ state: 'visible' });
        expect(await alert.innerText()).toMatch(/invalid|expired/i);
        expect(await alert.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await page.getByLabel(/new password/i).count()).toBe(0);
        expect(await page.getByRole('button', { name: 'Update password', exact: true }).count()).toBe(0);
        expect(recoveryCalls('start')).toHaveLength(0);
        expect(recoveryCalls('complete')).toHaveLength(0);
        const recoveryDocument = await page.locator('html').evaluate((element) => element.outerHTML);
        expect(recoveryDocument).not.toContain(token);
        expect(recoveryDocument).not.toContain(encodeURIComponent(token));
        for (const url of urls) {
          expect(url).not.toContain(token);
          expect(url).not.toContain(encodeURIComponent(token));
        }
        expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(token);

        const newLink = page.getByRole('link', { name: /new recovery link/i });
        expect(await newLink.getAttribute('href')).toBe('/recovery');
        await newLink.click();
        await page.getByLabel(/email/i).waitFor({ state: 'visible' });
        await startForm(page);
        expect(await page.getByRole('alert').count()).toBe(0);
        expect(recoveryCalls('start')).toHaveLength(0);
        expect(recoveryCalls('complete')).toHaveLength(0);
      } finally {
        await page.context().close();
      }
    }

    completeStatus = 200;
    for (const storageFailure of ['access', 'setItem', 'getItem', 'removeItem'] as const) {
      calls.length = 0;
      const { page, origin } = await open(
        `/recovery#account_id=${encodeURIComponent(accountId)}&token=${encodeURIComponent(token)}`,
        {},
        storageFailure,
      );
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await sendComplete(page);
        await page.waitForURL(`${origin}/login`);
        await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ state: 'visible' });
        expect(await page.getByLabel(/email/i).isEditable()).toBe(true);
        expect(await page.getByLabel(/^password$/i).isEditable()).toBe(true);
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ state: 'visible' });
        expect(page.url()).toBe(`${origin}/login`);
        expect(recoveryCalls('start')).toHaveLength(0);
        expect(recoveryCalls('complete')).toHaveLength(1);
        expect(JSON.parse(recoveryCalls('complete')[0]!.body)).toEqual({
          account_id: accountId,
          token,
          new_password: newPassword,
        });
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a person asks for a recovery link by email and always sees the same confirmation',
  async () => {
    startStatus = 200;
    calls.length = 0;
    const { page, origin } = await open();
    try {
      const confirmations: string[] = [];
      for (const address of [email, 'nobody@example.test']) {
        const { address: input } = await sendStart(page, address);
        const notice = page.getByRole('status');
        await notice.waitFor({ state: 'visible' });
        confirmations.push((await notice.innerText()).trim());
        expect(await input.inputValue()).toBe(address);
        expect(await input.isEditable()).toBe(true);
        expect(recoveryCalls('start').at(-1)?.method).toBe('POST');
        expect(recoveryCalls('start').at(-1)?.url).toBe('/recovery/start');
        expect(recoveryCalls('start').at(-1)?.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
        expect(recoveryCalls('start').at(-1)?.headers.origin).toBe(origin);
        expect(JSON.parse(recoveryCalls('start').at(-1)!.body)).toEqual({ email: address });
      }
      expect(confirmations[0]).toMatch(/recovery request was accepted/i);
      expect(confirmations[1]).toBe(confirmations[0]);
      expect(recoveryCalls('start')).toHaveLength(2);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  "a recovery link's fragment is removed before any request, and a new password completes recovery and leads to sign-in",
  async () => {
    completeStatus = 200;
    calls.length = 0;
    const fragment = `#account_id=${encodeURIComponent(accountId)}&token=${encodeURIComponent(token)}`;
    const { page, origin, urls, responseHeaders } = await open(`/recovery${fragment}`);
    try {
      expect(await page.evaluate(() => location.hash)).toBe('');
      expect(responseHeaders['cache-control']).toContain('no-store');
      expect(responseHeaders['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(responseHeaders['x-frame-options']).toBe('DENY');
      expect(responseHeaders['referrer-policy']).toBe('no-referrer');
      const recoveryDocument = await page.locator('html').evaluate((element) => element.outerHTML);
      expect(recoveryDocument).not.toContain(token);
      expect(recoveryDocument).not.toContain(encodeURIComponent(token));
      const form = await completeForm(page);
      await form.password.fill(newPassword);
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/recovery/complete'),
        form.submit.click(),
      ]);
      await page.waitForURL(`${origin}/login`);
      await page.getByRole('status').waitFor({ state: 'visible' });

      expect(
        await page.evaluate(() => (window as unknown as { recoveryHashAtRequest?: string }).recoveryHashAtRequest),
      ).toBe('');
      expect(page.url()).toBe(`${origin}/login`);
      await page.getByRole('status').filter({ hasText: /password (?:has been )?changed|reset/i }).waitFor();
      expect(await page.getByRole('status').innerText()).toMatch(/password (?:has been )?changed|reset/i);
      expect(recoveryCalls('complete')).toHaveLength(1);
      const completion = recoveryCalls('complete')[0]!;
      expect(completion.method).toBe('POST');
      expect(completion.url).toBe('/recovery/complete');
      expect(completion.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
      expect(completion.headers.origin).toBe(origin);
      expect(JSON.parse(completion.body)).toEqual({ account_id: accountId, token, new_password: newPassword });

      for (const url of [...urls, ...calls.map((call) => call.url), page.url()]) {
        expect(url).not.toContain(token);
        expect(decodeURIComponent(url.replace(/\+/g, ' '))).not.toContain(token);
      }
      for (const call of calls) {
        for (const value of Object.values(call.headers)) expect(value).not.toContain(token);
        if (call !== completion) expect(call.body).not.toContain(token);
      }
      const document = await page.locator('html').evaluate((element) => element.outerHTML);
      expect(document).not.toContain(token);
      expect(document).not.toContain(encodeURIComponent(token));
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'invalid, used or expired links and out-of-range passwords are refused with localized messages',
  async () => {
    completeStatus = 400;
    calls.length = 0;
    const { page } = await open(
      `/recovery#account_id=${encodeURIComponent(accountId)}&token=${encodeURIComponent(token)}`,
    );
    try {
      const controls = await completeForm(page);
      for (const value of ['short7', 'x'.repeat(129)]) {
        await controls.password.fill(value);
        await controls.submit.click();
        const alert = page.getByRole('alert');
        await alert.waitFor({ state: 'visible' });
        expect(await alert.innerText()).toMatch(/8|128/);
        expect(recoveryCalls('complete')).toHaveLength(0);
      }

      await sendComplete(page, newPassword);
      expect(await page.getByRole('alert').innerText()).toMatch(/8.{0,20}128|between 8 and 128/i);
      expect(recoveryCalls('complete')).toHaveLength(1);

      completeStatus = 401;
      await sendComplete(page, newPassword);
      expect(await page.getByRole('alert').innerText()).toMatch(/invalid|expired/i);
      expect(await page.getByRole('link', { name: /new recovery link/i }).count()).toBe(1);
      expect(recoveryCalls('complete')).toHaveLength(2);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'rate limits and outages say when to try again',
  async () => {
    calls.length = 0;
    const startPage = await open();
    try {
      for (const status of [429, 503] as const) {
        startStatus = status;
        await sendStart(startPage.page, email);
        const message = (await startPage.page.getByRole('alert').innerText()).trim();
        expect(message).toMatch(/try again|later|wait/i);
        if (status === 429) {
          expect(message).toContain(String(retryAfter));
          expect(message).toMatch(/seconds?/i);
        }
      }
    } finally {
      await startPage.page.context().close();
    }

    const completePage = await open(
      `/recovery#account_id=${encodeURIComponent(accountId)}&token=${encodeURIComponent(token)}`,
    );
    try {
      for (const status of [429, 503] as const) {
        completeStatus = status;
        await sendComplete(completePage.page);
        const message = (await completePage.page.getByRole('alert').innerText()).trim();
        expect(message).toMatch(/try again|later|wait/i);
        if (status === 429) {
          expect(message).toContain(String(retryAfter));
          expect(message).toMatch(/seconds?/i);
        }
      }
    } finally {
      await completePage.page.context().close();
    }
  },
  timeout,
);

test(
  'sign-in resumes authorization without sig, exp and prompt, keeping max_age',
  async () => {
    signInStatus = 200;
    calls.length = 0;
    const { page, origin } = await open(`/authorize?${authorizationQuery}`);
    try {
      const address = page.getByLabel(/email/i);
      const password = page.getByLabel(/^password$/i);
      await address.fill(email);
      await password.fill('correct horse battery staple');
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
        page.getByRole('button', { name: 'Sign in', exact: true }).click(),
      ]);
      const expected = new URLSearchParams(authorizationQuery);
      expected.delete('prompt');
      const resumedUrl = `/authorize?${expected.toString()}`;
      await page.waitForURL(`${origin}${resumedUrl}`);
      const authorizations = calls.filter((call) => new URL(call.url, fake.url).pathname === '/authorize');
      expect(authorizations.map((call) => call.url)).toEqual([`/authorize?${authorizationQuery}`, resumedUrl]);
      const resumed = new URLSearchParams(new URL(authorizations.at(-1)!.url, fake.url).search);
      expect(resumed.has('sig')).toBe(false);
      expect(resumed.has('exp')).toBe(false);
      expect(resumed.has('prompt')).toBe(false);
      expect(resumed.get('max_age')).toBe('600');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
