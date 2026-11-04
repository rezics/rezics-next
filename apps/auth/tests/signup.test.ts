import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const retryAfter = 37;
const email = 'reader+signup@example.test';
const password = 'private +/&?=#秘密';
const handle = 'Reader_1';
const accountId = 'acct+id/秘密';
const siteKey = '0x-signup-site-key';
const leaked = 'An account with this email already exists';
const misleadingRetry = 'try again in 1 second';
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
let signupStatus: 201 | 400 | 409 | 429 | 503 = 201;
let signupError = 'registration_denied';
let signInStatus: 200 | 401 | 429 | 503 = 200;

const turnstileScript = `(() => {
  const widgets = new Map();
  let serial = 0;
  let tokenSerial = 0;
  window.__turnstileRenders = [];
  window.__turnstileResets = 0;
  window.__issueTurnstileToken = () => {
    const widget = window.__armedTurnstile;
    if (!widget) return false;
    window.__armedTurnstile = null;
    widget.options.callback('turnstile-' + (++tokenSerial));
    return true;
  };
  function issue(widget) {
    widget.options.callback('turnstile-' + (++tokenSerial));
  }
  window.turnstile = {
    ready(fn) { fn(); },
    render(_element, options) {
      const id = 'widget-' + (++serial);
      const widget = { id, options };
      widgets.set(id, widget);
      window.__turnstileRenders.push({
        sitekey: options.sitekey,
        action: options.action,
        language: options.language,
      });
      window.__armedTurnstile = widget;
      return id;
    },
    reset(id) {
      window.__turnstileResets += 1;
      const widget = widgets.get(id);
      if (!widget) return;
      window.__armedTurnstile = widget;
      if (window.__turnstileManual) return;
      queueMicrotask(() => {
        if (window.__armedTurnstile !== widget) return;
        window.__armedTurnstile = null;
        issue(widget);
      });
    },
    remove(id) { widgets.delete(id); },
  };
})();`;

// The page loads this instead of Cloudflare when TURNSTILE_SCRIPT_URL is set in development.
const turnstile = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api.js' && request.method === 'GET') {
      return new Response(turnstileScript, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return new Response('Not Found', { status: 404 });
  },
});
const scriptUrl = `${turnstile.url.origin}/api.js`;

// Copied from apps/auth/tests/recovery.test.ts's fake Auth and extended with POST /signup.
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

    if (url.pathname === '/authorize' && request.method === 'GET') {
      if ((call.headers.cookie ?? '').split(';').some((cookie) => cookie.trim() === `auth_session=${session}`))
        return new Response('Authorization resumed with the session', { headers });
      const exp = String(Math.floor(Date.now() / 1000) + 300);
      const query = `${url.search.slice(1)}&exp=${exp}`;
      const sig = createHmac('sha256', signingKey).update(query).digest('base64url');
      headers.set('location', `/login?${query}&sig=${sig}`);
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/registration-page' && request.method === 'GET') {
      return Response.json(
        {
          kind: 'registration',
          viewer: null,
          requirements: {
            handle: { minLength: 3, maxLength: 64 },
            email: { maxLength: 254 },
            password: { minLength: 8, maxLength: 128 },
            verification: { provider: 'turnstile', required: true },
          },
          verification: { configured: true },
          actions: { register: true, continue: false },
        },
        { headers },
      );
    }

    if (url.pathname === '/signin' && request.method === 'POST') {
      if (signInStatus === 200) {
        headers.append('set-cookie', `auth_session=${session}; Path=/; HttpOnly; SameSite=Lax`);
        return Response.json({ success: true }, { headers });
      }
      if (signInStatus === 429) headers.set('retry-after', String(retryAfter));
      return Response.json(
        {
          error: signInStatus === 401 ? 'authentication_denied' : signInStatus === 429 ? 'rate_limited' : 'unavailable',
        },
        { status: signInStatus, headers },
      );
    }

    if (url.pathname === '/signup' && request.method === 'POST') {
      if (signupStatus === 201) return Response.json({ accountId }, { status: 201, headers });
      if (signupStatus === 429) headers.set('retry-after', String(retryAfter));
      const error = signupStatus === 429 ? 'rate_limited' : signupStatus === 503 ? 'unavailable' : signupError;
      return Response.json(
        { error, message: signupStatus === 429 ? misleadingRetry : leaked },
        { status: signupStatus, headers },
      );
    }

    return new Response('Not Found', { status: 404, headers });
  },
});

// Copied from apps/auth/tests/recovery.test.ts.
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

// Copied from apps/auth/tests/recovery.test.ts's dev-server start, with the Turnstile development override.
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
        env: {
          ...process.env,
          AUTH_ORIGIN: fake.url.origin,
          TURNSTILE_SITE_KEY: siteKey,
          TURNSTILE_SCRIPT_URL: scriptUrl,
        },
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
          const response = await fetch(`${origin}/signup`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          });
          if (response.status === 200) return origin;
        } catch {}
        if (Date.now() > deadline) throw new Error(`dev server did not serve /signup in time:\n${output}`);
        await Bun.sleep(500);
      }
    }
    throw new Error('could not start the Auth dev server after retrying occupied ports');
  })();
  return started;
}

async function open(path = '/signup', options: BrowserContextOptions = {}) {
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
  page.setDefaultTimeout(15_000);
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.status(), 'the documented dev server serves the page').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin, urls };
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
  turnstile.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

function signupCalls() {
  return calls.filter((call) => new URL(call.url, fake.url).pathname === '/signup' && call.method === 'POST');
}

async function form(page: Page) {
  const handleInput = page.getByLabel('Handle', { exact: true });
  const emailInput = page.getByLabel('Email', { exact: true });
  const passwordInput = page.getByLabel('Password', { exact: true });
  expect(await handleInput.count(), 'sign-up has a labelled handle field').toBe(1);
  expect(await emailInput.count(), 'sign-up has a labelled email field').toBe(1);
  expect(await passwordInput.count(), 'sign-up has a labelled password field').toBe(1);
  return {
    handle: handleInput,
    email: emailInput,
    password: passwordInput,
    submit: page.getByRole('button', { name: 'Create an account', exact: true }),
  };
}

async function waitEnabled(page: Page) {
  await page.waitForFunction(() => {
    const button = document.querySelector('button[type="submit"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
}

async function fill(page: Page, values: { handle?: string; email?: string; password?: string } = {}) {
  const controls = await form(page);
  if ((await controls.handle.inputValue()) === '') await controls.handle.fill(values.handle ?? handle);
  if ((await controls.email.inputValue()) === '') await controls.email.fill(values.email ?? email);
  if ((await controls.password.inputValue()) === '') await controls.password.fill(values.password ?? password);
  await page.waitForFunction(
    () => ((window as unknown as { __turnstileRenders?: unknown[] }).__turnstileRenders?.length ?? 0) > 0,
  );
  await page.evaluate(() => (window as unknown as { __issueTurnstileToken?: () => boolean }).__issueTurnstileToken?.());
  await waitEnabled(page);
  return controls;
}

function assertSecret(page: Page, urls: string[]) {
  for (const url of [...urls, page.url(), ...calls.map((call) => call.url)]) {
    expect(url, 'passwords never appear in any request or navigation URL').not.toContain(password);
    expect(decodeURIComponent(url.replace(/\+/g, ' '))).not.toContain(password);
  }
}

test(
  'a person signs up behind Turnstile, is signed in and resumes the authorization they came from',
  async () => {
    signupStatus = 201;
    signInStatus = 200;
    calls.length = 0;
    const { page, origin, urls } = await open(`/authorize?${authorizationQuery}`);
    try {
      const login = new URL(page.url());
      expect(login.pathname).toBe('/login');
      await Promise.all([
        page.waitForURL(/\/signup\?/),
        page.getByRole('link', { name: 'Create an account', exact: true }).click(),
      ]);
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
      const signupUrl = new URL(page.url());
      expect(signupUrl.pathname).toBe('/signup');
      expect(signupUrl.search).toBe(login.search);
      expect(signupUrl.searchParams.get('max_age')).toBe('600');
      expect(signupUrl.searchParams.has('prompt')).toBe(true);
      const signInLink = page.getByRole('link', { name: 'Sign in', exact: true });
      expect(await signInLink.count()).toBe(1);
      const signInHref = new URL((await signInLink.getAttribute('href'))!, origin);
      expect(signInHref.pathname).toBe('/login');
      expect(signInHref.search).toBe(signupUrl.search);

      const controls = await form(page);
      expect(await controls.email.getAttribute('autocomplete')).toBe('email');
      expect(await controls.password.getAttribute('autocomplete')).toBe('new-password');
      expect(await controls.password.getAttribute('type')).toBe('password');
      await page.getByRole('button', { name: 'Show password', exact: true }).click();
      expect(await controls.password.getAttribute('type')).toBe('text');
      expect(await controls.password.getAttribute('autocomplete')).toBe('new-password');
      await page.getByRole('button', { name: 'Hide password', exact: true }).click();
      expect(await controls.password.getAttribute('type')).toBe('password');

      await controls.handle.fill(handle);
      await controls.email.fill(email);
      await controls.password.fill(password);
      await page.waitForFunction(
        () => ((window as unknown as { __turnstileRenders?: unknown[] }).__turnstileRenders?.length ?? 0) > 0,
      );
      expect(await controls.submit.isEnabled(), 'the submit button stays available before Turnstile is ready').toBe(
        true,
      );
      await page.evaluate(() =>
        (window as unknown as { __issueTurnstileToken: () => boolean }).__issueTurnstileToken(),
      );
      await waitEnabled(page);
      const renders = await page.evaluate(
        () =>
          (window as unknown as { __turnstileRenders: { sitekey: string; action: string; language: string }[] })
            .__turnstileRenders,
      );
      expect(renders.length).toBeGreaterThan(0);
      for (const render of renders) expect(render).toEqual({ sitekey: siteKey, action: 'signup', language: 'en' });
      const turnstileRequests = urls.filter((url) => url.split('?')[0] === scriptUrl);
      expect(turnstileRequests).toEqual([scriptUrl]);
      expect(urls.some((url) => url.includes('challenges.cloudflare.com/turnstile'))).toBe(false);

      const signupResponsePromise = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/signup' && response.request().method() === 'POST',
      );
      const signinResponsePromise = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/signin' && response.request().method() === 'POST',
      );
      await controls.submit.click();
      const signupResponse = await signupResponsePromise;
      expect(signupResponse.status()).toBe(201);
      expect(await signupResponse.json()).toEqual({ accountId });
      expect(signupResponse.headers()['set-cookie'] ?? '').not.toMatch(/auth_session/);
      const signinResponse = await signinResponsePromise;
      expect(signinResponse.status()).toBe(200);

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
      expect(
        authorizations
          .at(-1)!
          .headers.cookie?.split(';')
          .map((cookie) => cookie.trim()),
      ).toContain(`auth_session=${session}`);

      expect(signupCalls()).toHaveLength(1);
      const registration = signupCalls()[0]!;
      expect(registration.method).toBe('POST');
      expect(registration.url).toBe('/signup');
      expect(registration.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
      expect(registration.headers.origin).toBe(origin);
      const payload = JSON.parse(registration.body) as Record<string, unknown>;
      expect(payload).toEqual({
        key: expect.any(String),
        handle,
        email,
        password,
        turnstile_token: expect.any(String),
      });
      expect(payload.key).not.toBe('');
      expect(payload.turnstile_token).not.toBe('');
      const signIns = calls.filter((call) => new URL(call.url, fake.url).pathname === '/signin');
      expect(signIns).toHaveLength(1);
      expect(calls.indexOf(signIns[0]!)).toBeGreaterThan(calls.indexOf(registration));
      expect(JSON.parse(signIns[0]!.body)).toEqual({ email, password, client_id: 'login', scope: [] });
      expect(page.url()).not.toContain(accountId);
      expect(decodeURIComponent(page.url())).not.toContain(accountId);
      assertSecret(page, urls);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  "a submit needs a fresh verification, and a retry keeps the form's key",
  async () => {
    signupStatus = 201;
    calls.length = 0;
    const { page } = await open();
    const bodies: string[] = [];
    let firstRequestArrived!: () => void;
    const firstRequest = new Promise<void>((resolve) => (firstRequestArrived = resolve));
    let releaseFirstRequest!: () => void;
    const firstResponse = new Promise<void>((resolve) => (releaseFirstRequest = resolve));
    await page.route('**/signup', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      bodies.push(route.request().postData() ?? '');
      if (bodies.length === 1) {
        firstRequestArrived();
        await firstResponse;
        await route.abort('connectionfailed');
      } else {
        await route.continue();
      }
    });
    try {
      const controls = await fill(page);
      await page.evaluate(() => {
        (window as unknown as { __turnstileManual?: boolean }).__turnstileManual = true;
      });
      await controls.submit.click();
      await firstRequest;
      await page.waitForFunction(() => {
        const button = document.querySelector('button[type="submit"]');
        return button instanceof HTMLButtonElement && button.disabled;
      });
      releaseFirstRequest();
      await page.waitForFunction(
        () => ((window as unknown as { __turnstileResets?: number }).__turnstileResets ?? 0) > 0,
      );
      expect(bodies).toHaveLength(1);
      expect(await controls.handle.inputValue()).toBe(handle);
      expect(await controls.email.inputValue()).toBe(email);
      expect(await controls.password.inputValue()).toBe(password);
      expect(
        await page.evaluate(() => (window as unknown as { __turnstileResets: number }).__turnstileResets),
      ).toBeGreaterThan(0);
      await page.evaluate(() =>
        (window as unknown as { __issueTurnstileToken: () => boolean }).__issueTurnstileToken(),
      );
      await waitEnabled(page);
      await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/signup' && response.request().method() === 'POST',
        ),
        controls.submit.click(),
      ]);
      expect(bodies).toHaveLength(2);
      const first = JSON.parse(bodies[0]!) as { key: string; turnstile_token: string; handle: string; email: string };
      const second = JSON.parse(bodies[1]!) as {
        key: string;
        turnstile_token: string;
        handle: string;
        email: string;
        password: string;
      };
      expect(first.key).not.toBe('');
      expect(second.key).toBe(first.key);
      expect(first.turnstile_token).not.toBe('');
      expect(second.turnstile_token).not.toBe(first.turnstile_token);
      expect(first.handle).toBe(handle);
      expect(first.email).toBe(email);
      expect(second.handle).toBe(handle);
      expect(second.email).toBe(email);
      expect(second.password).toBe(password);
    } finally {
      releaseFirstRequest();
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a taken handle is shown at the handle field, and other conflicts never reveal whether an address exists',
  async () => {
    signupStatus = 409;
    signupError = 'handle_unavailable';
    calls.length = 0;
    const { page, origin } = await open(`/signup?${authorizationQuery}`);
    try {
      const controls = await fill(page);
      await controls.submit.click();
      await page.waitForFunction(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLInputElement)) return false;
        return [...(element.labels ?? [])].some((label) => label.textContent?.trim() === 'Handle');
      });
      const describedBy = await controls.handle.getAttribute('aria-describedby');
      expect(describedBy, 'the handle error is tied to the handle field').toBeTruthy();
      const handleText = await page.evaluate((ids) => {
        return ids
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
          .trim();
      }, describedBy!);
      expect(handleText).toMatch(/taken|reserved|unavailable/i);
      expect(handleText).not.toContain(leaked);
      expect(handleText).not.toMatch(/email|address/i);

      signupError = 'registration_denied';
      await page.waitForFunction(() => {
        const button = document.querySelector('button[type="submit"]');
        return button instanceof HTMLButtonElement && !button.disabled;
      });
      await Promise.all([
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/signup' && response.request().method() === 'POST',
        ),
        controls.submit.click(),
      ]);
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[role="alert"]')].some((element) => /recover/i.test(element.textContent ?? '')),
      );
      const emailDescribed = await controls.email.getAttribute('aria-describedby');
      expect(emailDescribed ?? '').toBe('');
      const alertText = (await page.getByRole('alert').allInnerTexts()).join('\n');
      expect(alertText).not.toContain(leaked);
      expect(alertText).not.toContain(email);
      expect(alertText).not.toMatch(/already exists|already registered|in use|address exists|email exists/i);
      expect(alertText).toMatch(/sign in/i);
      expect(alertText).toMatch(/recover/i);
      const links = await page.getByRole('link').evaluateAll((elements) =>
        elements.map((element) => ({
          href: (element as HTMLAnchorElement).href,
          text: element.textContent?.trim() ?? '',
        })),
      );
      const signIn = links.filter((link) => new URL(link.href).pathname === '/login');
      expect(signIn.length).toBeGreaterThanOrEqual(1);
      const kept = new URL(page.url()).search;
      expect(kept).toContain('max_age=600');
      for (const link of signIn) expect(link.href).toBe(`${origin}/login${kept}`);
      const recovery = links.filter((link) => new URL(link.href).pathname === '/recovery');
      expect(recovery.length).toBeGreaterThanOrEqual(1);
      expect(recovery.some((link) => /recover/i.test(link.text))).toBe(true);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'passwords outside 8 to 128 characters are refused before sending',
  async () => {
    signupStatus = 201;
    calls.length = 0;
    const { page } = await open();
    try {
      const controls = await form(page);
      await controls.handle.fill(handle);
      await controls.email.fill(email);
      await page.waitForFunction(
        () => ((window as unknown as { __turnstileRenders?: unknown[] }).__turnstileRenders?.length ?? 0) > 0,
      );
      await page.evaluate(() =>
        (window as unknown as { __issueTurnstileToken: () => boolean }).__issueTurnstileToken(),
      );
      for (const value of ['short7', 'x'.repeat(129)]) {
        await controls.password.fill(value);
        await waitEnabled(page);
        await controls.submit.click();
        await page.waitForFunction(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLInputElement)) return false;
          return [...(element.labels ?? [])].some((label) => label.textContent?.trim() === 'Password');
        });
        const describedBy = await controls.password.getAttribute('aria-describedby');
        expect(describedBy, 'the password error is tied to the password field').toBeTruthy();
        const text = (
          await page.evaluate((ids) => {
            return ids
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? '')
              .join(' ');
          }, describedBy!)
        ).trim();
        expect(text).toMatch(/8/);
        expect(text).toMatch(/128/);
        expect(signupCalls()).toHaveLength(0);
      }
      expect(await controls.password.inputValue()).toBe('x'.repeat(129));
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
    const { page } = await open();
    try {
      await fill(page);
      for (const status of [429, 503] as const) {
        signupStatus = status;
        const button = page.getByRole('button', { name: 'Create an account', exact: true });
        await waitEnabled(page);
        await Promise.all([
          page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/signup' && response.request().method() === 'POST',
          ),
          button.click(),
        ]);
        await page.getByRole('alert').waitFor({ state: 'visible' });
        const message = (await page.getByRole('alert').innerText()).trim();
        expect(message).toMatch(/try again|later|wait/i);
        expect(message).not.toContain(misleadingRetry);
        if (status === 429) {
          expect(message).toContain(String(retryAfter));
          expect(message).toMatch(/seconds?/i);
        }
        await page.waitForFunction(() => {
          const button = document.querySelector('button[type="submit"]');
          return button instanceof HTMLButtonElement && !button.disabled;
        });
      }
      expect(signupCalls()).toHaveLength(2);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);
