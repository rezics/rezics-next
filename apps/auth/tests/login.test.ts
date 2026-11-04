import { afterAll, beforeAll, expect, test } from 'bun:test';
import { signInPage } from './security-page-fixture';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const email = 'reader+login@example.test';
const password = 'private +/&?=#秘密';
const session = randomBytes(24).toString('hex');
const signingKey = randomBytes(32);
const authorizationQuery =
  'response_type=code&client_id=rezics-website' +
  '&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback' +
  '&scope=openid+offline_access&state=opaque%2Bstate%26next%3D%2Fevil' +
  '&nonce=nonce%2Fone&code_challenge=challenge&code_challenge_method=S256' +
  '&resource=https%3A%2F%2Fapi.rezics.test&resource=urn%3Asecond&empty=';

type Call = { method: string; url: string; cookie: string; contentType: string; body: string };
const calls: Call[] = [];
let signInStatus: 200 | 401 | 429 | 503 = 200;
const retryAfter = 37;

// Copied from session.test.ts's fake OpenID provider, reduced to Auth's browser HTTP contract.
// There are no fake kernel responses here: /signin and /authorize belong to Auth, not @rezics/client.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const call: Call = {
      method: request.method,
      url: url.pathname + url.search,
      cookie: request.headers.get('cookie') ?? '',
      contentType: request.headers.get('content-type') ?? '',
      body: await request.text(),
    };
    calls.push(call);
    const headers = new Headers({ 'cache-control': 'no-store' });
    if (url.pathname === '/signin/page' && request.method === 'POST')
      return Response.json(signInPage(JSON.parse(call.body).query, url.origin, { kind: 'signed-out' }), { headers });
    if (url.pathname === '/authorize' && request.method === 'GET') {
      if (call.cookie.split(';').some((cookie) => cookie.trim() === `auth_session=${session}`))
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
        return Response.json({}, { headers });
      }
      if (signInStatus === 429) headers.set('retry-after', String(retryAfter));
      return Response.json(
        {
          error: signInStatus === 401 ? 'authentication_denied' : signInStatus === 429 ? 'rate_limited' : 'unavailable',
        },
        { status: signInStatus, headers },
      );
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

// Copied from session.test.ts, using apps/auth/tests/app.test.ts's Auth origin and readiness page.
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
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/login`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status === 200) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

// Context and navigation steps copied from apps/web/tests/session-controls.test.ts.
async function open(path = '/login', options: BrowserContextOptions = {}) {
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
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.status(), 'the documented dev server serves the page').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    try {
      await page.locator('input[name="email"]').waitFor({ state: 'visible' });
    } catch (cause) {
      throw new Error(
        `Sign-in form unavailable: ${JSON.stringify({
          locale: await page.locator('html').getAttribute('lang'),
          hydrated: await page.locator('html').getAttribute('data-hydrated'),
          alerts: await page.getByRole('alert').allTextContents(),
          status: await page.getByRole('status').allTextContents(),
        })}`,
        { cause },
      );
    }
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
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function form(page: Page) {
  const address = page.getByLabel(/email/i);
  const secret = page.locator('input[name="password"]');
  // Native sign-in advice has loaded before asserting the labelled form.
  expect(await address.count(), 'the login page has a labelled email field').toBe(1);
  expect(await secret.count(), 'the login page has a labelled password field').toBe(1);
  return { address, secret, submit: page.getByRole('button', { name: 'Sign in', exact: true }) };
}

const signIns = () => calls.filter((call) => new URL(call.url, fake.url).pathname === '/signin');
const authorizations = () => calls.filter((call) => new URL(call.url, fake.url).pathname === '/authorize');

function submitted(call: Call | undefined) {
  expect(call, 'Auth receives a sign-in request').toBeDefined();
  expect(call!.method).toBe('POST');
  expect(call!.url).toBe('/signin');
  expect(call!.contentType).toMatch(/^application\/json(?:;|$)/);
  expect(JSON.parse(call!.body)).toEqual({ email, password, client_id: 'login', scope: [] });
}

function privatePassword(page: Page, urls: string[]) {
  for (const url of [...urls, page.url(), ...calls.map((call) => call.url)]) {
    expect(url, 'passwords never appear in any request or navigation URL').not.toContain(password);
    expect(decodeURIComponent(url.replace(/\+/g, ' '))).not.toContain(password);
  }
}

async function submit(page: Page) {
  const controls = await form(page);
  await controls.address.fill(email);
  await controls.secret.fill(password);
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
    controls.submit.click(),
  ]);
  return controls;
}

test(
  'the login page signs in with email and password and resumes the authorization request',
  async () => {
    signInStatus = 200;
    calls.length = 0;
    const { page, origin, urls } = await open(`/authorize?${authorizationQuery}`);
    try {
      const login = new URL(page.url());
      expect(login.pathname).toBe('/login');
      expect(login.searchParams.get('exp')).toMatch(/^\d+$/);
      expect(login.searchParams.get('sig')).toBeTruthy();
      const before = signIns().length;
      await submit(page);
      await page.waitForURL(`${origin}/authorize?${authorizationQuery}`);
      await page.waitForLoadState('networkidle');
      expect(signIns().length).toBe(before + 1);
      submitted(signIns().at(-1));
      expect(authorizations().map((call) => call.url)).toEqual([
        `/authorize?${authorizationQuery}`,
        `/authorize?${authorizationQuery}`,
      ]);
      expect(
        authorizations()
          .at(-1)!
          .cookie.split(';')
          .map((cookie) => cookie.trim()),
      ).toContain(`auth_session=${session}`);
      expect(await page.locator('body').innerText()).toContain('Authorization resumed with the session');
      privatePassword(page, urls);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a direct sign-in without an authorization request goes to security settings',
  async () => {
    signInStatus = 200;
    calls.length = 0;
    const { page, origin, urls } = await open();
    try {
      await submit(page);
      await page.waitForURL(`${origin}/security`);
      await page.waitForLoadState('networkidle');
      expect(page.url()).toBe(`${origin}/security`);
      expect(signIns().length).toBe(1);
      submitted(signIns()[0]);
      expect(authorizations()).toEqual([]);
      expect((await page.context().cookies()).find((cookie) => cookie.name === 'auth_session')?.value).toBe(session);
      privatePassword(page, urls);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a refused sign-in keeps the email, clears the password and says why',
  async () => {
    for (const status of [401, 429, 503] as const) {
      signInStatus = status;
      calls.length = 0;
      const { page, urls } = await open();
      try {
        const { address, secret, submit: button } = await form(page);
        const login = page.url();
        // The enabled button validates by field and prevents invalid requests for both click and Enter.
        for (const [addressValue, secretValue] of [
          ['', ''],
          [email, ''],
          ['', password],
        ]) {
          await address.fill(addressValue!);
          await secret.fill(secretValue!);
          await button.click();
          const firstInvalidName = addressValue ? 'password' : 'email';
          await page.waitForFunction(
            (name) =>
              document.activeElement?.getAttribute('name') === name &&
              document.activeElement?.getAttribute('aria-invalid') === 'true',
            firstInvalidName,
          );
          await (addressValue ? address : secret).press('Enter');
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          expect(signIns(), `no request with an empty field (${status})`).toEqual([]);
        }
        await submit(page);
        const alert = page.getByRole('alert');
        await alert.waitFor({ state: 'visible' });
        // Browser updates are asynchronous after the network response; wait for the resulting focus and clearing.
        await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert');
        expect(await alert.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await address.inputValue()).toBe(email);
        expect(await secret.inputValue()).toBe('');
        expect(page.url()).toBe(login);
        expect(signIns().length).toBe(1);
        submitted(signIns()[0]);
        const message = (await alert.innerText()).trim();
        if (status === 401) {
          expect(message).toMatch(/email\s+or\s+password/i);
          expect(message).toMatch(/incorrect|wrong|invalid/i);
          expect(message).not.toMatch(
            /^(?:the |your )?(?:email|password)\s+(?:is\s+)?(?:incorrect|wrong|invalid|unknown|not found)/i,
          );
          expect(message).not.toMatch(/not registered|does not exist|unknown (?:email|account)/i);
        } else if (status === 429) {
          expect(message).toMatch(/wait|try again|too many/i);
          expect(message).toMatch(new RegExp(`\\b${retryAfter}\\b`));
          expect(message).toMatch(/seconds?/i);
        } else {
          expect(message).toMatch(/sign[ -]?in/i);
          expect(message).toMatch(/unavailable|not available/i);
        }
        expect(authorizations()).toEqual([]);
        privatePassword(page, urls);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

const locales = [
  { locale: 'en', heading: 'Sign in', email: /email/i, password: /password/i },
  { locale: 'zh-Hant', heading: '登入', email: /電子郵件|電郵|信箱/, password: /密碼/ },
  { locale: 'zh-Hans', heading: '登录', email: /电子邮件|电邮|邮箱/, password: /密码/ },
  { locale: 'ja', heading: 'ログイン', email: /メール/, password: /パスワード/ },
  { locale: 'ko', heading: '로그인', email: /이메일|전자우편/, password: /비밀번호/ },
  { locale: 'de', heading: 'Anmelden', email: /e[ -]?mail/i, password: /passwort/i },
  {
    locale: 'fr',
    heading: 'Se connecter',
    email: /e[ -]?mail|courriel|adresse électronique/i,
    password: /mot de passe/i,
  },
  { locale: 'es', heading: 'Iniciar sesión', email: /correo electrónico|email/i, password: /contraseña/i },
];

async function visibleLabel(field: Locator, name: RegExp) {
  const labels = await field.evaluate((element) =>
    Array.from((element as HTMLInputElement).labels ?? []).map((label) => ({
      text: label.textContent ?? '',
      visible: label.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    })),
  );
  expect(
    labels.some((label) => label.visible && name.test(label.text)),
    'the associated label is visible',
  ).toBe(true);
}

test(
  'the login form is labelled, autocompletes and links to recovery and sign-up in every locale',
  async () => {
    const origin = await site();
    const visits = [
      ...locales.map((own) => ({ own, cookie: true })),
      { own: locales.find((entry) => entry.locale === 'ja')!, cookie: false },
    ];
    for (const { own, cookie } of visits) {
      const options: BrowserContextOptions = {
        locale: 'ja',
        extraHTTPHeaders: { 'accept-language': 'ja' },
      };
      // Each of the first eight visits sets a real browser cookie, including English overriding Japanese.
      if (cookie)
        options.storageState = {
          cookies: [
            {
              name: 'rezics_locale',
              value: own.locale,
              domain: new URL(origin).hostname,
              path: '/',
              expires: -1,
              httpOnly: false,
              secure: false,
              sameSite: 'Lax',
            },
          ],
          origins: [],
        };
      const { page } = await open(`/authorize?${authorizationQuery}`, options);
      try {
        const login = new URL(page.url());
        expect(login.pathname).toBe('/login');
        expect(await page.locator('html').getAttribute('lang'), own.locale).toBe(own.locale);
        expect(await page.getByRole('heading', { name: own.heading, exact: true }).count(), own.locale).toBe(1);
        const address = page.getByLabel(own.email);
        const secret = page.locator('input[name="password"]');
        expect(await address.count(), `${own.locale}: the email field has a localized label`).toBe(1);
        expect(await secret.count(), `${own.locale}: the password field has a localized label`).toBe(1);
        expect(await address.getAttribute('type')).toBe('email');
        expect(await address.getAttribute('autocomplete')).toBe('username webauthn');
        expect(await secret.getAttribute('type')).toBe('password');
        expect(await secret.getAttribute('autocomplete')).toBe('current-password');
        await visibleLabel(address, own.email);
        await visibleLabel(secret, own.password);
        const links = await page.getByRole('link').evaluateAll((elements) =>
          elements.map((element) => ({
            href: (element as HTMLAnchorElement).href,
            text: element.textContent?.trim(),
          })),
        );
        const recoveryLink = links.filter((link) => new URL(link.href).pathname === '/recovery');
        expect(recoveryLink.length).toBe(1);
        expect(recoveryLink[0]!.text).toBeTruthy();
        expect(recoveryLink[0]!.href).toBe(`${origin}/recovery`);
        const signup = links.filter((link) => new URL(link.href).pathname === '/signup');
        expect(signup.length).toBe(1);
        expect(signup[0]!.text).toBeTruthy();
        expect(signup[0]!.href).toBe(`${origin}/signup${login.search}`);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);
