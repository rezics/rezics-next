import { spawn, type ChildProcess } from 'node:child_process';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response as PlaywrightResponse,
} from 'playwright';
import { resolve } from 'node:path';
import type { NativeWebStack } from './stack.ts';

export type AuthPersona = 'alice' | 'bob' | 'suspended' | 'newcomer';
export type AuthJourney = {
  url: string;
  context: BrowserContext;
  response(): Promise<PlaywrightResponse>;
  requestHeaders(): Promise<Headers[]>;
};
export type NativeAuthStack = {
  origin: string;
  context(persona: AuthPersona): Promise<BrowserContext>;
  signIn(persona: Exclude<AuthPersona, 'newcomer'>): Promise<AuthJourney>;
  signUp(persona: 'newcomer'): Promise<AuthJourney>;
  stop(): Promise<void>;
};

const authRoot = resolve(import.meta.dir, '../../../auth');
const password = 'semantic outcome registration password with enough entropy';

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}

async function nativeEmail(stack: NativeWebStack, issuer: string, persona: AuthPersona): Promise<string> {
  const credentials = await stack.credentials(persona);
  if (!credentials.cookie) throw new Error(`Native ${persona} persona has no Auth cookie`);
  const response = await fetch(`${issuer}/api/auth/get-session`, { headers: { cookie: credentials.cookie } });
  if (!response.ok) throw new Error(`Could not read native ${persona} identity: ${response.status}`);
  const value = (await response.json()) as { user?: { email?: string } } | null;
  if (!value?.user?.email) throw new Error(`Native ${persona} Auth session did not expose its sign-in email`);
  return value.user.email;
}

async function waitForPage(origin: string, child: ChildProcess, getOutput: () => string): Promise<void> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Auth app exited during startup: ${getOutput()}`);
    try {
      const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(3000) });
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`Auth app startup timed out: ${getOutput()}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const graceful = await Promise.race([exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (graceful) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await exited;
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

export async function startAuthStack(stack: NativeWebStack): Promise<NativeAuthStack> {
  const startupStarted = performance.now();
  const authIssuer = stack.authIssuer;

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const turnstile = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api.js') return new Response('Not Found', { status: 404 });
      return new Response(
        `window.turnstile={render:function(node,options){queueMicrotask(function(){options.callback('native-test-token')});return 'native-widget'},reset:function(){},remove:function(){}};`,
        { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } },
      );
    },
  });
  let output = '';
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: authRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AUTH_ORIGIN: authIssuer,
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SCRIPT_URL: `${turnstile.url.origin}/api.js`,
    },
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-12_000)));
  const contexts = new Map<AuthPersona, BrowserContext>();
  let browser: Browser | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await waitForPage(origin, child, () => output);
    browser = await chromium.launch();
    await stack.restartWeb({ publicOrigin: stack.web, authIssuer: origin });
    console.info(`Native Auth app startup: ${Math.round(performance.now() - startupStarted)}ms`);
    const context = async (persona: AuthPersona) => {
      let value = contexts.get(persona);
      if (!value) {
        value = await browser!.newContext({
          viewport: { width: 1280, height: 860 },
          reducedMotion: 'reduce',
          locale: 'en',
          javaScriptEnabled: true,
        });
        contexts.set(persona, value);
      }
      return value;
    };
    async function journey(persona: AuthPersona, signup: boolean): Promise<AuthJourney> {
      const journeyStarted = performance.now();
      const browserContext = await context(persona);
      const page = await browserContext.newPage();
      page.setDefaultTimeout(15_000);
      const authResponses: PlaywrightResponse[] = [];
      const pageRequests: import('playwright').Request[] = [];
      page.on('request', (request) => pageRequests.push(request));
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/signin') authResponses.push(response);
      });
      const email = signup ? `${crypto.randomUUID()}@example.test` : await nativeEmail(stack, authIssuer, persona);
      await page.goto(`${stack.web}/auth/sign-in`, { waitUntil: 'domcontentloaded' });
      await hydrate(page);
      if (signup) {
        const signupLink = page.getByRole('link', { name: /create an account|sign up/i }).first();
        await signupLink.click();
        await page.waitForURL((url) => url.origin === origin && url.pathname === '/signup');
        await hydrate(page);
        await page.getByLabel('Handle', { exact: true }).fill(`newcomer-${crypto.randomUUID().slice(0, 8)}`);
        await page.getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      } else {
        await page.getByLabel(/email/i).fill(email);
        await page.locator('input[name="password"]').fill(password);
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
          page.getByRole('button', { name: 'Sign in', exact: true }).click(),
        ]);
      }
      if (new URL(page.url()).origin === origin && new URL(page.url()).pathname === '/consent') {
        await hydrate(page);
        const approval = page.getByRole('button', { name: /approve|allow/i }).first();
        if (await approval.count()) await approval.click();
      }
      await page.waitForURL((url) => url.origin === new URL(stack.web).origin, { timeout: 30_000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (signup) {
        const consent = page.getByRole('button', { name: /approve|allow|continue/i }).first();
        if (await consent.count()) await consent.click();
      }
      if (!signup)
        console.info(
          `Native Auth sign-in: ${Math.round(performance.now() - journeyStarted)}ms; browser peak RSS unavailable from Playwright`,
        );
      const current = page.url();
      const response = () => {
        const latest = authResponses.at(-1);
        if (!latest) throw new Error(`Auth did not receive a ${signup ? 'sign-up' : 'sign-in'} submission`);
        return latest;
      };
      return {
        url: current,
        context: browserContext,
        response,
        async requestHeaders() {
          return Promise.all(pageRequests.map(async (request) => new Headers(await request.allHeaders())));
        },
      };
    }
    return {
      origin,
      context,
      signIn(persona) {
        return journey(persona, false);
      },
      signUp(persona) {
        return journey(persona, true);
      },
      stop() {
        return (stopping ??= (async () => {
          const errors: unknown[] = [];
          for (const item of contexts.values())
            try {
              await item.close();
            } catch (error) {
              errors.push(error);
            }
          contexts.clear();
          try {
            await browser?.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            await stopChild(child);
          } catch (error) {
            errors.push(error);
          }
          turnstile.stop(true);
          if (errors.length) throw new AggregateError(errors, 'Native Auth stack cleanup failed');
        })());
      },
    };
  } catch (error) {
    await browser?.close().catch(() => {});
    await stopChild(child).catch(() => {});
    turnstile.stop(true);
    throw error;
  }
}
