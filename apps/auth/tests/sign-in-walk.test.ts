// Live account-entry walk. It runs only when REZICS_SIGN_IN_WALK=1 and the origins come from a walk stack, which
// `dev-stack.ts walk` admits, starts and tears down for this task. The walk drives the real Auth and Web pages in
// Chromium and retains secret-free evidence under .temp/acceptance/sign-in-walk. Cookies, tokens, codes and
// passwords are never recorded or printed.
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const WEB = process.env.REZICS_LOCAL_STACK_WEB_ORIGIN ?? 'http://127.0.0.1:3000';
const ISSUER = process.env.REZICS_LOCAL_STACK_ISSUER_ORIGIN ?? 'http://127.0.0.1:4200';
const NATIVE = process.env.REZICS_LOCAL_STACK_NATIVE_ORIGIN ?? 'http://127.0.0.1:3100';
const KERNEL = process.env.REZICS_LOCAL_STACK_KERNEL_ORIGIN ?? 'http://127.0.0.1:4100';
const EVIDENCE_DIR = resolve(ROOT, '.temp/acceptance/sign-in-walk');
const STACK_LOG = resolve(ROOT, '.temp/walk', process.env.GOAL_TASK_ID ?? 'local', 'stack.log');
const LOGIN_COOKIE = '__Host-rezics_login';
const SESSION_COOKIE = '__Host-rezics_session';
const enabled = process.env.REZICS_SIGN_IN_WALK === '1';

type Step = { persona: string; step: string; ok: boolean; url?: string; detail?: string };
type Creds = { email: string; password: string };

const steps: Step[] = [];
const failures: string[] = [];
let lastPage: Page | undefined;

function clean(value: string): string {
  return value.replace(/((?:state|nonce|code_challenge|code|access_token|id_token|refresh_token|iss)=)[^&]+/g, '$1…');
}

function record(step: Omit<Step, 'ok'> & { ok?: boolean }) {
  const entry: Step = { ok: true, ...step, ...(step.url ? { url: clean(step.url) } : {}) };
  steps.push(entry);
  console.log(
    `[walk] ${entry.persona} | ${entry.step} | ${entry.ok ? 'ok' : 'FAILED'}${entry.detail ? ` | ${entry.detail}` : ''}`,
  );
}

function writeEvidence() {
  mkdirSync(EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(EVIDENCE_DIR, 'walk.json'),
    JSON.stringify({ finishedAt: new Date().toISOString(), steps, failures }, null, 2),
    {
      mode: 0o600,
    },
  );
}

function stackTail(pattern: RegExp, limit: number): string {
  if (!existsSync(STACK_LOG)) return '(no walk stack log)';
  const lines = readFileSync(STACK_LOG, 'utf8')
    .split('\n')
    .filter((line) => pattern.test(line));
  return (
    lines
      .slice(-limit)
      .map((line) => line.slice(0, 300))
      .join('\n') || '(no matching walk stack log lines)'
  );
}

async function probe(url: string, accepted: number[]): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    return accepted.includes(response.status);
  } catch {
    return false;
  }
}

// `dev-stack.ts walk` waits only for the Web and issuer roots; the walk also needs native discovery and Kernel health.
async function waitForServices(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready =
      (await probe(`${NATIVE}/.well-known/openid-configuration`, [200])) && (await probe(`${KERNEL}/health`, [200]));
    if (ready) return;
    if (Date.now() > deadline) throw new Error(`native or Kernel service not ready\n${stackTail(/error|Error/, 40)}`);
    await Bun.sleep(2_000);
  }
}

// The persona action prints the generated password, so its output is withheld; only its exit status is kept.
async function providePersona() {
  await waitForServices(10 * 60_000);
  const child = Bun.spawn(['bun', 'services/auth/scripts/dev-stack.ts', 'persona'], {
    cwd: ROOT,
    env: process.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0)
    throw new Error(`persona provisioning exited ${child.exitCode}; its output is withheld`);
  record({ persona: 'stack', step: 'development persona provisioned on the walk stack', ok: true });
}

function developerCredentials(): Creds {
  const keys = JSON.parse(readFileSync(resolve(ROOT, '.temp/local-stack/keys.json'), 'utf8')) as { password?: unknown };
  if (typeof keys.password !== 'string')
    throw new Error('the development persona password is missing from the local keys file');
  return { email: 'developer@rezics.test', password: keys.password };
}

function newCredentials(): Creds {
  const handle = `walk${randomBytes(4).toString('hex')}`;
  return { email: `${handle}@rezics.test`, password: `Walk-${randomBytes(12).toString('base64url')}-9` };
}

async function openPage(
  browser: Browser,
  options: { width: number; height: number; colorScheme?: 'light' | 'dark' },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    locale: 'en',
    reducedMotion: 'reduce',
    colorScheme: options.colorScheme ?? 'light',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(180_000);
  lastPage = page;
  return { context, page };
}

// Auth pages mark hydration on the document element; Web pages do not, so they wait for load and visible content.
async function hydrated(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 420_000 });
}

async function waitForIssuerLogin(page: Page) {
  await page.waitForURL((url) => url.origin === ISSUER && url.pathname === '/login', { timeout: 180_000 });
  await hydrated(page);
}

async function submitPassword(page: Page, creds: Creds) {
  await waitForIssuerLogin(page);
  await page.locator('input[name="email"]').fill(creds.email);
  await page.locator('input[name="password"]').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function waitForPrivateLibrary(page: Page) {
  await page.waitForURL((url) => url.origin === WEB && url.pathname === '/en/library', { timeout: 180_000 });
  await page.waitForLoadState('load');
  await page.getByRole('link', { name: 'Tracked entries', exact: true }).first().waitFor({ timeout: 300_000 });
}

async function signOutFromWeb(page: Page) {
  await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.getByRole('link', { name: 'Tracked entries', exact: true }).first().waitFor({ timeout: 300_000 });
  await page.getByRole('button', { name: /^You/ }).first().click();
  await page.getByText('Sign out', { exact: true }).first().click();
  await page.waitForLoadState('load');
}

async function expectNoWebSession(context: BrowserContext) {
  const names = (await context.cookies(WEB)).map((cookie) => cookie.name);
  expect(names.includes(SESSION_COOKIE), 'the Web session cookie is removed by sign-out').toBe(false);
}

// Security settings and the consent inventory: the signed-in account sees its granted permissions.
async function securityPage(page: Page, persona: string) {
  await page.goto(`${ISSUER}/security`, { waitUntil: 'load' });
  await page.getByRole('heading', { name: 'Account security', exact: true }).waitFor();
  record({ persona, step: 'security settings render for the signed-in account', ok: true, url: page.url() });
  await page
    .getByRole('heading', { name: 'Permissions you granted', exact: true })
    .first()
    .waitFor({ timeout: 180_000 });
  record({
    persona,
    step: 'consent inventory lists the permissions granted to the Web client',
    ok: true,
    url: page.url(),
  });
}

// Failure evidence: where the browser stopped, the visible text and controls. Never includes field values.
async function dumpControls(page: Page): Promise<string> {
  const controls = await page
    .locator('button, a[href], h1, h2, [role="alert"], [role="status"]')
    .evaluateAll((elements) =>
      elements
        .slice(0, 80)
        .map((element) => `${element.tagName} ${(element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`),
    )
    .catch(() => ['(controls unavailable)']);
  const text = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300))
    .catch(() => '(text unavailable)');
  return `at ${clean(page.url()).slice(0, 160)}\ntext: ${text}\n${controls.join('\n')}`;
}

async function memberWalk(browser: Browser, creds: Creds) {
  const persona = 'member';
  const { context, page } = await openPage(browser, { width: 1280, height: 860 });
  let callbackUrl: string | undefined;
  let loginCookie: { name: string; value: string } | undefined;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === WEB && url.pathname === '/auth/callback') callbackUrl = request.url();
  });
  try {
    await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
    await waitForIssuerLogin(page);
    record({ persona, step: 'signed-out private route reaches the issuer sign-in page', ok: true, url: page.url() });
    await page.locator('input[name="email"]').fill(creds.email);
    await page.locator('input[name="password"]').fill(creds.password);
    loginCookie = (await context.cookies(WEB)).find((cookie) => cookie.name === LOGIN_COOKIE);
    expect(loginCookie, 'the Web login transaction cookie is set before the issuer redirect').toBeDefined();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await waitForPrivateLibrary(page);
    record({
      persona,
      step: 'password sign-in returns through the issuer callback to the private destination',
      ok: true,
      url: page.url(),
    });
    await securityPage(page, persona);
    await signOutFromWeb(page);
    await expectNoWebSession(context);
    record({ persona, step: 'sign-out removes the Web session', ok: true });
    await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin === ISSUER && new URL(page.url()).pathname === '/login')
      await submitPassword(page, creds);
    await waitForPrivateLibrary(page);
    record({ persona, step: 'safe re-entry returns to the private destination', ok: true, url: page.url() });
    expect(callbackUrl, 'the callback URL was observed for the replay check').toBeDefined();
    await replayConsumedCallback(browser, persona, callbackUrl!, loginCookie!, creds);
  } finally {
    await context.close();
  }
}

// The login transaction cookie is replayed with the callback the first sign-in consumed; Web must refuse it.
async function replayConsumedCallback(
  browser: Browser,
  persona: string,
  callbackUrl: string,
  loginCookie: { name: string; value: string },
  creds: Creds,
) {
  const { context, page } = await openPage(browser, { width: 1280, height: 860 });
  try {
    await context.addCookies([{ name: loginCookie.name, value: loginCookie.value, url: WEB }]);
    const response = await page.goto(callbackUrl, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), 'a consumed callback is refused without replaying material').toBe(400);
    await expectNoWebSession(context);
    record({
      persona,
      step: 'consumed callback replay is refused and starts no session',
      ok: true,
      detail: `status ${response?.status()}`,
    });
    await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
    await submitPassword(page, creds);
    await waitForPrivateLibrary(page);
    record({ persona, step: 'fresh sign-in after the consumed callback works', ok: true, url: page.url() });
  } finally {
    await context.close();
  }
}

async function newAccountWalk(browser: Browser) {
  const persona = 'new-account';
  const creds = newCredentials();
  const { context, page } = await openPage(browser, { width: 1280, height: 860 });
  try {
    await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
    await waitForIssuerLogin(page);
    await page.getByRole('link', { name: 'Create an account', exact: true }).click();
    await page.waitForURL((url) => url.origin === ISSUER && url.pathname === '/signup', { timeout: 180_000 });
    await hydrated(page);
    await page.getByLabel('Handle', { exact: true }).fill(creds.email.split('@')[0]!);
    await page.getByLabel('Email', { exact: true }).fill(creds.email);
    await page.getByLabel('Password', { exact: true }).fill(creds.password);
    await page.getByLabel('Confirm password', { exact: true }).fill(creds.password);
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await page.getByText('Your account was created. Sign in to continue.', { exact: true }).waitFor();
    record({ persona, step: 'anonymous signup creates the account and asks for sign-in', ok: true, url: page.url() });
    await page.getByRole('link', { name: 'Sign in', exact: true }).first().click();
    await waitForIssuerLogin(page);
    await page.locator('input[name="email"]').fill(creds.email);
    await page.locator('input[name="password"]').fill(creds.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await waitForPrivateLibrary(page);
    record({
      persona,
      step: 'new account signs in through the issuer callback to the private destination',
      ok: true,
      url: page.url(),
    });
    await securityPage(page, persona);
  } finally {
    await context.close();
  }
}

// The server requires step-up once the session's auth_time is more than 600 seconds old (services/auth). The member
// signs in first, the other personas run while that session ages, and the confirmation follows the window.
const STEP_UP_WINDOW_MS = 600_000;
const STEP_UP_MARGIN_MS = 30_000;

type StepUpSession = { context: BrowserContext; page: Page; authTimeBound: number };

async function startStepUp(browser: Browser, creds: Creds): Promise<StepUpSession> {
  const { context, page } = await openPage(browser, { width: 1280, height: 860 });
  try {
    await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
    await submitPassword(page, creds);
    await waitForPrivateLibrary(page);
    // auth_time was set at or before this moment, so the window is measured from here.
    const authTimeBound = Date.now();
    record({ persona: 'member-step-up', step: 'member signs in for the step-up walk', ok: true, url: page.url() });
    return { context, page, authTimeBound };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function finishStepUp(session: StepUpSession, creds: Creds) {
  const persona = 'member-step-up';
  const { context, page, authTimeBound } = session;
  try {
    const ready = authTimeBound + STEP_UP_WINDOW_MS + STEP_UP_MARGIN_MS - Date.now();
    if (ready > 0) await Bun.sleep(ready);
    await page.goto(`${ISSUER}/step-up?return_to=%2Fsecurity`, { waitUntil: 'load' });
    const heading = page.getByRole('heading', { name: 'Verify your identity', exact: true });
    await heading.waitFor({ timeout: 120_000 });
    record({ persona, step: 'step-up is required once the session is stale and is shown', ok: true, url: page.url() });
    const address = page.locator('input[name="email"]');
    if ((await address.count()) > 0) await address.first().fill(creds.email);
    await page.locator('input[type="password"]').first().fill(creds.password);
    await page.locator('form button[type="submit"]').first().click();
    await page.waitForURL((url) => url.origin === ISSUER && url.pathname === '/security', { timeout: 180_000 });
    record({ persona, step: 'step-up confirmation returns to security settings', ok: true, url: page.url() });
  } finally {
    await context.close();
  }
}

// Server functions are the client's data path after hydration, so a client-side navigation under a 503
// fault exercises the private loaders. Document loads render on the server and are not intercepted.
async function outageWalk(browser: Browser, creds: Creds) {
  const persona = 'member-outage';
  for (const code of ['session_unavailable', 'dependency_unavailable'] as const) {
    const { context, page } = await openPage(browser, { width: 1280, height: 860 });
    try {
      await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
      await submitPassword(page, creds);
      await waitForPrivateLibrary(page);
      await page.route('**/_serverFn/**', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            type: `https://rezics.com/problems/${code}`,
            title: 'Unavailable',
            status: 503,
            code,
            retryable: true,
          }),
        }),
      );
      await page.getByRole('link', { name: 'Continue', exact: true }).first().click();
      await page.waitForURL((url) => url.origin === WEB && url.pathname === '/en/library/continue', {
        timeout: 120_000,
      });
      await page.waitForTimeout(3_000);
      const privateContent = await page.getByRole('link', { name: 'Tracked entries', exact: true }).count();
      expect(privateContent, `an indeterminate or unavailable session (${code}) starts no private loader`).toBe(0);
      const recovery = page.locator('a[href^="/auth/sign-in"], button').filter({ hasText: /sign in|try again|retry/i });
      expect(await recovery.count(), `the ${code} prompt offers a safe sign-in or retry control`).toBeGreaterThan(0);
      record({
        persona,
        step: `${code}: client navigation shows the unavailable prompt and starts no private loader`,
        ok: true,
        url: page.url(),
      });
    } finally {
      await context.close();
    }
  }
}

async function phoneLayoutWalk(browser: Browser, creds: Creds) {
  const persona = 'member-phone';
  const { context, page } = await openPage(browser, { width: 390, height: 844, colorScheme: 'dark' });
  try {
    await page.goto(`${WEB}/en/library`, { waitUntil: 'domcontentloaded' });
    await submitPassword(page, creds);
    await waitForPrivateLibrary(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the private library has no horizontal overflow at 390px').toBeLessThanOrEqual(1);
    record({
      persona,
      step: 'phone 390px dark private library has no horizontal overflow',
      ok: true,
      detail: `overflow ${overflow}px`,
    });
  } finally {
    await context.close();
  }
}

async function runPersona(name: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const where = lastPage ? await dumpControls(lastPage).catch(() => '(page unavailable)') : '(no page)';
    failures.push(`${name}: ${message.split('\n')[0]}`);
    record({ persona: name, step: 'walk failed', ok: false, detail: message.split('\n')[0] });
    const serverLines = stackTail(/\[web auth\]|\[auth\]|\berror\b|Error/i, 20);
    console.log(`[walk] ${name} failure detail:\n${message}\n${where}\nserver log:\n${serverLines}`);
  }
}

test.skipIf(!enabled)(
  'account entry, consent, security and safe Web return walk on a walk stack',
  async () => {
    if (!process.env.REZICS_LOCAL_STACK_WEB_ORIGIN)
      throw new Error('run this walk through `dev-stack.ts walk`, which supplies the stack origins');
    try {
      await providePersona();
      const developer = developerCredentials();
      const browser = await chromium.launch({
        headless: true,
        channel: existsSync('/usr/bin/google-chrome') ? 'chrome' : undefined,
      });
      const stepUp: { session?: StepUpSession } = {};
      try {
        await runPersona('member-step-up', async () => {
          stepUp.session = await startStepUp(browser, developer);
        });
        await runPersona('member', () => memberWalk(browser, developer));
        await runPersona('new-account', () => newAccountWalk(browser));
        await runPersona('member-outage', () => outageWalk(browser, developer));
        await runPersona('member-phone', () => phoneLayoutWalk(browser, developer));
        const session = stepUp.session;
        if (session) await runPersona('member-step-up', () => finishStepUp(session, developer));
      } finally {
        await stepUp.session?.context.close().catch(() => {});
        await browser.close();
      }
    } catch (error) {
      failures.push(`stack: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      throw error;
    } finally {
      writeEvidence();
    }
    expect(failures, `the account-entry walk passes; failures: ${failures.join(' | ')}`).toEqual([]);
  },
  120 * 60_000,
);
