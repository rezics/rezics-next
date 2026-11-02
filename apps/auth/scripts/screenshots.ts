import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startFakeAuth } from './fake-auth';
import {
  bounded,
  CaptureLifetime,
  captureExitCode,
  captureSignals,
  terminateChild,
  type CaptureChild,
} from './isolated';

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
const cleanupFailed = Symbol('Auth cleanup failed');

function requireClean(owner: CaptureLifetime): void {
  if (owner.cleanupErrors.length) {
    owner.cancel(cleanupFailed);
    throw cleanupFailed;
  }
}

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

export type SiteChild = CaptureChild & {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
};

export type CaptureDependencies = {
  mkdir: (path: string) => Promise<unknown>;
  startFake: () => { url: URL; stop: (force: boolean) => unknown };
  freePort: (owner: CaptureLifetime) => Promise<number>;
  spawn: (authOrigin: string, port: number) => SiteChild | Promise<SiteChild>;
  fetch: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ status: number; body?: { cancel: () => Promise<unknown> } | null }>;
  launch: () => Promise<Browser>;
  sleep: (owner: CaptureLifetime) => Promise<unknown>;
};

export async function freePort(owner: CaptureLifetime, createProbe = createServer): Promise<number> {
  const probe = await owner.own(
    'port probe',
    () => ({ server: createProbe(), controller: new AbortController() }),
    (probe) =>
      new Promise<void>((done, reject) => {
        // Abort also fences a listen request whose native acquisition has not completed yet.
        probe.controller.abort();
        probe.server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done(),
        );
      }),
  );
  try {
    return await owner.step(
      'free port',
      () =>
        new Promise<number>((done, reject) => {
          probe.value.server.once('error', reject);
          probe.value.server.listen({ port: 0, host: '127.0.0.1', signal: probe.value.controller.signal }, () => {
            const address = probe.value.server.address();
            if (!address || typeof address === 'string')
              reject(new Error('Could not determine a free port for the Auth dev server.'));
            else done(address.port);
          });
        }),
    );
  } finally {
    await probe.close();
  }
}

function drain(stream: ReadableStream<Uint8Array> | null) {
  let output = '';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const done = (async () => {
    reader = stream?.getReader();
    if (!reader) return;
    try {
      for (;;) {
        const { done: ended, value } = await reader.read();
        if (ended) return;
        output = (output + new TextDecoder().decode(value)).slice(-12_000);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  // Observe rejection immediately, even while the child is still starting.
  void done.catch(() => {});
  return { tail: () => output, done, cancel: () => reader?.cancel() };
}

async function startSite(owner: CaptureLifetime, deps: CaptureDependencies, authOrigin: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const port = await owner.step('port allocation', () => deps.freePort(owner));
    requireClean(owner);
    const site = await owner.own(
      'Vite child',
      async () => {
        const child = await deps.spawn(authOrigin, port);
        return { child, stdout: drain(child.stdout), stderr: drain(child.stderr) };
      },
      async ({ child, stdout, stderr }) => {
        const outcomes = await Promise.allSettled([
          terminateChild(child, owner.timers, owner.closeTimeout / 4, 'SIGTERM', owner.recordCleanup),
          ...[stdout, stderr].map(async (output) => {
            try {
              await bounded(
                'Vite output EOF',
                () => output.done,
                owner.closeTimeout / 4,
                owner.timers,
                undefined,
                owner.recordCleanup,
              );
            } catch (error) {
              const errors = [error];
              try {
                await bounded(
                  'Vite output cancel',
                  output.cancel,
                  owner.closeTimeout / 4,
                  owner.timers,
                  undefined,
                  owner.recordCleanup,
                );
              } catch (error) {
                errors.push(error);
              }
              throw new AggregateError(errors, 'Vite output settlement was not fully observed.');
            }
          }),
        ]);
        const errors = outcomes.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (errors.length) throw new AggregateError(errors, 'Vite retirement failed.');
      },
    );
    const { child, stdout, stderr } = site.value;
    const origin = `http://127.0.0.1:${port}`;
    const ready = await owner.step(
      'Auth dev server readiness',
      async () => {
        for (let poll = 0; poll < 500; poll += 1) {
          if (child.exitCode !== null) return false;
          const request = new AbortController();
          const cancel = () => request.abort(owner.controller.signal.reason);
          owner.controller.signal.addEventListener('abort', cancel, { once: true });
          try {
            const response = await owner.own(
              'Auth readiness response',
              () => deps.fetch(`${origin}/login`, request.signal),
              (response) => response.body?.cancel(),
              5000,
            );
            const ready = response.value.status === 200;
            await response.close();
            requireClean(owner);
            if (ready) return true;
          } catch {
            if (owner.controller.signal.aborted) throw owner.controller.signal.reason;
            requireClean(owner);
          } finally {
            request.abort();
            owner.controller.signal.removeEventListener('abort', cancel);
          }
          await owner.step('Auth readiness delay', () => deps.sleep(owner));
        }
        throw new Error(`Auth dev server did not serve /login in time:\n${stdout.tail()}\n${stderr.tail()}`);
      },
      startupTimeout,
    );
    if (ready) return { origin };
    await site.close();
    const output = `${stdout.tail()}\n${stderr.tail()}`;
    if (owner.cleanupErrors.length || !output.includes('already in use') || attempt === 3)
      throw new Error(`Auth dev server exited with code ${child.exitCode}:\n${output}`);
  }
  throw new Error('Could not start the Auth dev server after retrying occupied ports.');
}

async function waitForCaptureReady(owner: CaptureLifetime, page: Page): Promise<void> {
  await owner.step('page hydration', () =>
    page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 }),
  );
  await owner.step('page fonts', () =>
    page.evaluate(async () => {
      await document.fonts.ready;
    }),
  );
}

async function createContext(owner: CaptureLifetime, browser: Browser, origin: string, locale: string) {
  const context = await owner.own(
    'browser context',
    () =>
      browser.newContext({
        viewport: desktop,
        reducedMotion: 'reduce',
        locale,
        extraHTTPHeaders: { 'Accept-Language': locale },
        javaScriptEnabled: true,
      }),
    (context) => context.close(),
  );
  await owner.step('context cookies', () =>
    context.value.addCookies([{ name: 'auth_session', value: authSession, url: origin }]),
  );
  return context;
}

async function prepareState(owner: CaptureLifetime, page: Page, state: (typeof states)[number]): Promise<void> {
  if (state === 'login-error') {
    await owner.step('login email', () => page.locator('input[type="email"]').fill('reader@example.test'));
    await owner.step('login password', () => page.locator('input[type="password"]').fill('incorrect-password'));
    await owner.step('login submit', () =>
      Promise.all([
        owner.step('login response', () =>
          page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
        ),
        owner.step('login click', () => page.locator('form button[type="submit"]').click()),
      ]),
    );
    await owner.step('login error', () => page.locator('[role="alert"]').waitFor({ state: 'visible' }));
  } else if (state === 'consent') {
    await owner.step('page state', () => page.locator('main button').first().waitFor({ state: 'visible' }));
  } else if (state === 'recovery-password') {
    await owner.step('page state', () => page.locator('input[type="password"]').waitFor({ state: 'visible' }));
  } else if (state === 'security') {
    await owner.step('page state', () => page.locator('main li article').nth(2).waitFor({ state: 'visible' }));
  } else if (state === 'account-delete') {
    await owner.step('page state', () => page.getByRole('textbox').waitFor({ state: 'visible' }));
  } else if (state === 'organization-new') {
    await owner.step('page state', () => page.locator('input[name="handle"]').waitFor({ state: 'visible' }));
  }
  await waitForCaptureReady(owner, page);
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
  owner: CaptureLifetime,
  context: BrowserContext,
  origin: string,
  state: (typeof states)[number],
  theme: Theme,
  viewport: Viewport,
  destination: string,
): Promise<void> {
  const owned = await owner.own(
    'browser page',
    () => context.newPage(),
    (page) => page.close(),
  );
  const page = owned.value;
  try {
    await owner.step('page defaults', () => page.setDefaultTimeout(30_000));
    await owner.step('page viewport', () => page.setViewportSize(viewport));
    await owner.step('page media', () => page.emulateMedia({ colorScheme: theme }));
    const path = pathFor(state);
    const response = await owner.step('page navigation', () =>
      page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 }),
    );
    if (response?.status() !== 200)
      throw new Error(`Auth page ${path} returned ${response?.status() ?? 'no response'}.`);
    await waitForCaptureReady(owner, page);
    await prepareState(owner, page, state);
    await owner.step('page screenshot', () =>
      page.screenshot({ path: destination, fullPage: true, animations: 'disabled' }),
    );
  } catch (error) {
    owner.cancel(error);
    throw error;
  } finally {
    await owned.close();
  }
  requireClean(owner);
}

export const captureDependencies: CaptureDependencies = {
  mkdir: (output) => mkdir(output, { recursive: true }),
  startFake: startFakeAuth,
  freePort,
  spawn: (authOrigin, port) =>
    Bun.spawn([process.execPath, 'run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, AUTH_ORIGIN: authOrigin, CI: '1' },
    }),
  fetch: (url, signal) => fetch(url, { signal }),
  launch: () => chromium.launch(),
  sleep: (owner) =>
    new Promise<void>((done) => {
      const finish = () => {
        owner.timers.clear(timer);
        owner.controller.signal.removeEventListener('abort', finish);
        done();
      };
      const timer = owner.timers.set(finish, 300);
      owner.controller.signal.addEventListener('abort', finish, { once: true });
      if (owner.controller.signal.aborted) finish();
    }),
};

export async function runCapture(
  output: string,
  deps: CaptureDependencies = captureDependencies,
  owner = new CaptureLifetime(undefined, undefined, (error) => console.error('Auth cleanup:', error)),
  source = process,
): Promise<void> {
  const detach = captureSignals(owner, source);
  let primary: { error: unknown } | undefined;
  try {
    await owner.step('output directory', () => deps.mkdir(output));
    const fake = await owner.own('fake Auth', deps.startFake, (fake) => fake.stop(true));
    const site = await startSite(owner, deps, fake.value.url.origin);
    const browser = await owner.own('browser', deps.launch, (browser) => browser.close());
    for (const locale of locales) {
      const context = await createContext(owner, browser.value, site.origin, locale);
      try {
        for (const theme of themes) {
          for (const state of states) {
            const filename = `${state}.${locale}.${theme}.png`;
            await capture(owner, context.value, site.origin, state, theme, desktop, join(output, filename));
          }
        }
        await capture(
          owner,
          context.value,
          site.origin,
          'login',
          'light',
          phone,
          join(output, `login.${locale}.phone.png`),
        );
      } finally {
        await context.close();
      }
      requireClean(owner);
    }
  } catch (error) {
    if (error !== cleanupFailed) primary = { error };
  } finally {
    await owner.retire();
    detach();
  }
  owner.finish(primary);
}

if (import.meta.main)
  void runCapture(outputDirectory(Bun.argv.slice(2))).catch((error: unknown) => {
    console.error(error);
    process.exitCode = captureExitCode(error);
  });
