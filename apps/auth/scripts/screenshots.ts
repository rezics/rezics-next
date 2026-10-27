import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startFakeAuth } from './fake-auth';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
const themes = ['light', 'dark'] as const;
const states = [
  'login',
  'login-error',
  'signup',
  'consent',
  'recovery-request',
  'recovery-password',
  'security',
  'account-delete',
  'organization-new',
  'step-up',
] as const;
const desktop = { width: 1280, height: 900 };
const phone = { width: 390, height: 844 };
const authSession = 'auth-screenshot-session';
const startupTimeout = 150_000;

type Theme = (typeof themes)[number];
type Viewport = { width: number; height: number };

function usage(): string {
  return 'Usage: bun run screenshots [--out <directory>]';
}

function outputDirectory(argv: readonly string[]): string {
  let output = resolve(root, '.temp/screenshots/auth');
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (flag !== '--out') throw new Error(`${usage()}\nUnknown argument ${flag}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${usage()}\nMissing value for --out.`);
    output = resolve(value);
    index += 1;
  }
  return output;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not determine a free port for the Auth dev server.'));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function drain(stream: ReadableStream<Uint8Array> | null): { tail: () => string; done: Promise<void> } {
  let output = '';
  const done = (async () => {
    if (!stream) return;
    const reader = stream.getReader();
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) return;
      output = (output + new TextDecoder().decode(value)).slice(-12_000);
    }
  })();
  return { tail: () => output, done };
}

async function startSite(authOrigin: string): Promise<{ origin: string; child: Bun.Subprocess }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = await freePort();
    const child = Bun.spawn(
      [process.execPath, 'run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: app,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, AUTH_ORIGIN: authOrigin, CI: '1' },
      },
    );
    const stdout = drain(child.stdout);
    const stderr = drain(child.stderr);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + startupTimeout;
    for (;;) {
      if (child.exitCode !== null) {
        await Promise.all([stdout.done, stderr.done]);
        const output = `${stdout.tail()}\n${stderr.tail()}`;
        if (output.includes('already in use') && attempt < 3) break;
        throw new Error(`Auth dev server exited with code ${child.exitCode}:\n${output}`);
      }
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(5000) });
        if (response.status === 200) return { origin, child };
      } catch {}
      if (Date.now() >= deadline) {
        child.kill();
        await child.exited;
        await Promise.all([stdout.done, stderr.done]);
        throw new Error(`Auth dev server did not serve /login in time:\n${stdout.tail()}\n${stderr.tail()}`);
      }
      await Bun.sleep(300);
    }
    child.kill();
    await child.exited;
  }
  throw new Error('Could not start the Auth dev server after retrying occupied ports.');
}

async function openPage(
  context: BrowserContext,
  origin: string,
  path: string,
  theme: Theme,
  viewport: Viewport,
): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  if (response?.status() !== 200) {
    await page.close();
    throw new Error(`Auth page ${path} returned ${response?.status() ?? 'no response'}.`);
  }
  await waitForCaptureReady(page);
  return page;
}

async function waitForCaptureReady(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function createContext(
  browser: Browser,
  origin: string,
  locale: string,
  viewport: typeof desktop | typeof phone,
) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: 'reduce',
    locale,
    extraHTTPHeaders: { 'Accept-Language': locale },
    javaScriptEnabled: true,
  });
  await context.addCookies([{ name: 'auth_session', value: authSession, url: origin }]);
  return context;
}

async function prepareState(page: Page, state: (typeof states)[number]): Promise<void> {
  if (state === 'login-error') {
    await page.locator('input[type="email"]').fill('reader@example.test');
    await page.locator('input[type="password"]').fill('incorrect-password');
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
      page.locator('form button[type="submit"]').click(),
    ]);
    await page.locator('[role="alert"]').waitFor({ state: 'visible' });
  } else if (state === 'consent') {
    await page.locator('main button').first().waitFor({ state: 'visible' });
  } else if (state === 'recovery-password') {
    await page.locator('input[type="password"]').waitFor({ state: 'visible' });
  } else if (state === 'security') {
    await page.locator('main li article').nth(2).waitFor({ state: 'visible' });
  } else if (state === 'account-delete') {
    await page.getByRole('textbox').waitFor({ state: 'visible' });
  } else if (state === 'organization-new') {
    await page.locator('input[name="handle"]').waitFor({ state: 'visible' });
  }
  await waitForCaptureReady(page);
}

function pathFor(state: (typeof states)[number]): string {
  if (state === 'login' || state === 'login-error') return '/login';
  if (state === 'signup') return '/signup';
  if (state === 'consent') return '/consent?client_id=screenshot-client&scope=openid+offline_access';
  if (state === 'recovery-request') return '/recovery';
  if (state === 'recovery-password') return '/recovery#account_id=screenshot-account&token=screenshot-token';
  if (state === 'security') return '/security';
  if (state === 'account-delete') return '/account/delete';
  if (state === 'organization-new') return '/organizations/new';
  return '/step-up?return_to=%2Fsecurity';
}

async function capture(
  context: BrowserContext,
  origin: string,
  state: (typeof states)[number],
  theme: Theme,
  viewport: Viewport,
  destination: string,
): Promise<void> {
  const page = await openPage(context, origin, pathFor(state), theme, viewport);
  try {
    await prepareState(page, state);
    await page.screenshot({ path: destination, fullPage: true, animations: 'disabled' });
  } finally {
    await page.close();
  }
}

async function run(): Promise<void> {
  const output = outputDirectory(Bun.argv.slice(2));
  await mkdir(output, { recursive: true });

  const fake = startFakeAuth();
  let child: Bun.Subprocess | undefined;
  let browser: Browser | undefined;
  try {
    const site = await startSite(fake.url.origin);
    child = site.child;
    browser = await chromium.launch();

    for (const locale of locales) {
      const context = await createContext(browser, site.origin, locale, desktop);
      try {
        for (const theme of themes) {
          for (const state of states) {
            const filename = `${state}.${locale}.${theme}.png`;
            await capture(context, site.origin, state, theme, desktop, join(output, filename));
          }
        }
        await capture(context, site.origin, 'login', 'light', phone, join(output, `login.${locale}.phone.png`));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    fake.stop(true);
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
