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
import { launchPrivateBrowser, type PrivateBrowser } from './private-browser.ts';
import {
  currentNativeLifecycle,
  settledWithin,
  type NativeProcessOwnership,
  type NativeTestLifecycle,
} from './lifecycle.ts';

export type AuthPersona = 'alice' | 'bob' | 'suspended' | 'newcomer' | 'anonymous';
export type AuthJourney = {
  url: string;
  context: BrowserContext;
  visitedUrls: string[];
  response(): Promise<PlaywrightResponse>;
  requestHeaders(): Promise<Headers[]>;
  serverFunctionRequests(): Promise<
    { url: string; method: string; headers: Record<string, string>; body: string | null; responseBody: string }[]
  >;
};
export type NativeAuthStack = {
  origin: string;
  context(persona: AuthPersona): Promise<BrowserContext>;
  newContext(persona: AuthPersona): Promise<BrowserContext>;
  signIn(
    persona: Exclude<AuthPersona, 'newcomer' | 'anonymous'>,
    options?: { returnTo?: string; context?: BrowserContext },
  ): Promise<AuthJourney>;
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

async function waitForPage(
  origin: string,
  child: ChildProcess,
  getOutput: () => string,
  lifecycle: NativeTestLifecycle,
): Promise<void> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    lifecycle.assertOpen('wait for Auth app startup');
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Auth app exited during startup: ${getOutput()}`);
    try {
      const response = await fetch(`${origin}/login`, {
        signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(3000)]),
      });
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`Auth app startup timed out: ${getOutput()}`);
}

async function stopChild(owner: NativeProcessOwnership | undefined): Promise<void> {
  if (!owner) return;
  try {
    await owner.close();
  } catch {
    await owner.force();
  }
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

export async function startAuthStack(stack: NativeWebStack): Promise<NativeAuthStack> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Native Auth stack startup requires an active native test lifecycle');
  lifecycle.assertOpen('start native Auth stack');
  const startupStarted = performance.now();

  const port = await freePort();
  lifecycle.assertOpen('start native Auth app');
  const appOrigin = `http://127.0.0.1:${port}`;
  let origin: string | undefined;
  const turnstile = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api.js') return new Response('Not Found', { status: 404 });
      return new Response(
        `window.turnstile={ready:function(callback){callback()},render:function(node,options){queueMicrotask(function(){options.callback('native-test-token')});return 'native-widget'},reset:function(){},remove:function(){}};`,
        { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } },
      );
    },
  });
  lifecycle.register({
    label: 'native Auth Turnstile listener',
    close: () => turnstile.stop(true),
    force: () => turnstile.stop(true),
  });
  let output = '';
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: authRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AUTH_ORIGIN: stack.issuerOrigin,
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SCRIPT_URL: `${turnstile.url.origin}/api.js`,
    },
  });
  const childOwner = lifecycle.ownProcessGroup('native Auth Vite app', child);
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-12_000)));
  const contexts = new Map<AuthPersona, Promise<BrowserContext>>();
  const allContexts = new Set<Promise<BrowserContext>>();
  let browser: Browser | undefined;
  let privateBrowser: PrivateBrowser | undefined;
  let stopping: Promise<void> | undefined;
  let browserPeakMemoryBytes = 0;
  let memorySampler: ReturnType<typeof setInterval> | undefined;
  let sampling = false;
  let sampleMemory = async () => {};
  try {
    await waitForPage(appOrigin, child, () => output, lifecycle);
    lifecycle.assertOpen('route Auth pages');
    origin = await stack.routeAuthPages((request) => {
      const source = new URL(request.url);
      const target = new URL(source.pathname + source.search, appOrigin);
      return fetch(new Request(target, request), { redirect: 'manual' });
    });
    privateBrowser = await launchPrivateBrowser([stack.web, origin, turnstile.url.origin]);
    lifecycle.assertOpen('finish private Auth browser startup');
    browser = privateBrowser.browser;
    const cdp = await browser.newBrowserCDPSession();
    let cdpDetached = false;
    const detachCdp = async () => {
      if (cdpDetached) return;
      const detached = await settledWithin(
        cdp.detach().then(() => true),
        1_000,
      );
      if (!detached) throw new Error('Native Auth browser diagnostics session did not detach');
      cdpDetached = true;
    };
    lifecycle.register({
      label: 'native Auth browser diagnostics session',
      close: detachCdp,
      force: () => cdp.detach().catch(() => {}),
    });
    sampleMemory = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
        const pids = processInfo.map(({ id }) => id).join(',');
        if (!pids) return;
        const result = Bun.spawnSync(['ps', '-o', 'rss=', '-p', pids]);
        if (result.exitCode === 0) {
          const bytes = result.stdout
            .toString()
            .trim()
            .split(/\s+/)
            .map(Number)
            .reduce((sum, rss) => sum + rss * 1024, 0);
          browserPeakMemoryBytes = Math.max(browserPeakMemoryBytes, bytes);
        }
      } finally {
        sampling = false;
      }
    };
    memorySampler = setInterval(() => void sampleMemory().catch(() => {}), 500);
    lifecycle.register({
      label: 'native Auth browser memory sampler',
      close: () => clearInterval(memorySampler),
      force: () => clearInterval(memorySampler),
    });
    await sampleMemory();
    // The Worker already uses this issuer; page routing needs no restart.
    console.info(`Native Auth app startup: ${Math.round(performance.now() - startupStarted)}ms`);
    const createContext = (): Promise<BrowserContext> =>
      browser!.newContext({
        viewport: { width: 1280, height: 860 },
        reducedMotion: 'reduce',
        locale: 'en',
        javaScriptEnabled: true,
      });
    const ownContext = (value: BrowserContext, owner: NativeTestLifecycle, label: string) => {
      const close = async () => {
        const closed = await settledWithin(
          value.close().then(() => true),
          1_500,
        );
        if (!closed) throw new Error(`${label} did not close within 1500ms`);
      };
      owner.register({ label, close, force: () => value.close().catch(() => {}) });
    };
    const assertActive = (operation: string) => {
      lifecycle.assertOpen(operation);
      currentNativeLifecycle()?.assertOpen(operation);
    };
    const context = async (persona: AuthPersona) => {
      assertActive(`open ${persona} browser context`);
      let value = contexts.get(persona);
      if (!value) {
        value = createContext().then((created) => {
          ownContext(created, lifecycle, `native Auth ${persona} context`);
          return created;
        });
        contexts.set(persona, value);
        allContexts.add(value);
      }
      return value;
    };
    async function journey(
      persona: AuthPersona,
      signup: boolean,
      options: { returnTo?: string; context?: BrowserContext } = {},
    ): Promise<AuthJourney> {
      assertActive(signup ? 'start native sign-up journey' : 'start native sign-in journey');
      const journeyStarted = performance.now();
      const browserContext = options.context ?? (await context(persona));
      assertActive('create Auth journey page');
      const page = await browserContext.newPage();
      const pageOwner = currentNativeLifecycle() ?? lifecycle;
      const closePage = async () => {
        const closed = await settledWithin(
          page.close().then(() => true),
          1_500,
        );
        if (!closed) throw new Error('Native Auth journey page did not close within 1500ms');
      };
      pageOwner.register({
        label: 'native Auth journey page',
        close: closePage,
        force: () => page.close().catch(() => {}),
      });
      page.setDefaultTimeout(15_000);
      const authResponses: PlaywrightResponse[] = [];
      const visitedUrls: string[] = [];
      const pageRequests: import('playwright').Request[] = [];
      const functionResponses = new Map<
        import('playwright').Request,
        { resolve(response: PlaywrightResponse): void; promise: Promise<PlaywrightResponse> }
      >();
      page.on('request', (request) => {
        pageRequests.push(request);
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) visitedUrls.push(request.url());
        if (new URL(request.url()).pathname.startsWith('/_serverFn/')) {
          let resolve!: (response: PlaywrightResponse) => void;
          const promise = new Promise<PlaywrightResponse>((done) => (resolve = done));
          functionResponses.set(request, { resolve, promise });
        }
      });
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/signin') authResponses.push(response);
        functionResponses.get(response.request())?.resolve(response);
      });
      assertActive('read native Auth account for browser sign-in');
      const email = signup ? `${crypto.randomUUID()}@example.test` : (await stack.authPersona(persona)).email;
      const formPassword = signup ? `newcomer-${crypto.randomUUID()}` : password;
      const signInUrl = new URL('/auth/sign-in', stack.web);
      if (options.returnTo !== undefined) signInUrl.searchParams.set('return_to', options.returnTo);
      assertActive('open native Auth sign-in page');
      await page.goto(signInUrl.href, { waitUntil: 'domcontentloaded' });
      await hydrate(page);
      if (signup) {
        assertActive('open native Auth sign-up page');
        const signupLink = page.getByRole('link', { name: /create an account|sign up/i }).first();
        await signupLink.click();
        await page.waitForURL((url) => url.origin === origin && url.pathname === '/signup');
        await hydrate(page);
        assertActive('submit native Auth sign-up form');
        await page.getByLabel('Handle', { exact: true }).fill(`newcomer-${crypto.randomUUID().slice(0, 8)}`);
        await page.getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Password', { exact: true }).fill(formPassword);
        await page.getByRole('button', { name: 'Create an account', exact: true }).click();
      } else {
        await page.getByLabel(/email/i).fill(email);
        await page.locator('input[name="password"]').fill(formPassword);
        assertActive('submit native Auth sign-in form');
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
          page.getByRole('button', { name: 'Sign in', exact: true }).click(),
        ]);
      }
      if (persona !== 'suspended') {
        // The callback is also on the web origin. Finish its document redirect
        // before returning a usable served web page. Its account control proves
        // that the web app has read the real session through its server function.
        assertActive('finish native Auth callback');
        await page.waitForURL((url) => url.origin === new URL(stack.web).origin && url.pathname !== '/auth/callback', {
          timeout: 30_000,
        });
        try {
          await page.locator('#account-menu-button').waitFor({ state: 'visible' });
        } catch (error) {
          throw new Error(
            `Signed-in web page was not ready at ${page.url()}: ${await page.locator('body').innerText()}`,
            {
              cause: error,
            },
          );
        }
      }
      await page.waitForLoadState('domcontentloaded');
      await sampleMemory();
      if (!signup)
        console.info(
          `Native Auth sign-in: ${Math.round(performance.now() - journeyStarted)}ms; browser peak RSS: ${browserPeakMemoryBytes}bytes`,
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
        visitedUrls,
        response,
        async requestHeaders() {
          return Promise.all(pageRequests.map(async (request) => new Headers(await request.allHeaders())));
        },
        async serverFunctionRequests() {
          const requests = pageRequests.filter((request) => new URL(request.url()).pathname.startsWith('/_serverFn/'));
          return Promise.all(
            requests.map(async (request) => {
              const response = await functionResponses.get(request)?.promise;
              const headers = await request.allHeaders();
              for (const name of ['cookie', 'authorization', 'host', 'content-length']) delete headers[name];
              return {
                url: request.url(),
                method: request.method(),
                headers,
                body: request.postData(),
                responseBody: response ? await response.text() : '',
              };
            }),
          );
        },
      };
    }
    const closeContexts = async (): Promise<void> => {
      const errors: unknown[] = [];
      const results = await Promise.allSettled(
        [...allContexts].map(async (item) => {
          const result = await settledWithin(
            item.then((value) => value.close().then(() => true)),
            2_000,
          );
          if (!result) throw new Error('Native Auth browser context close exceeded 2000ms');
        }),
      );
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      contexts.clear();
      if (errors.length) throw new AggregateError(errors, 'Native Auth browser contexts did not all close');
    };
    const forceAuth = async (): Promise<void> => {
      clearInterval(memorySampler);
      turnstile.stop(true);
      await Promise.allSettled([privateBrowser?.force(), childOwner.force()]);
    };
    const stop = () =>
      (stopping ??= (async () => {
        const shutdown = (async () => {
          clearInterval(memorySampler);
          await settledWithin(
            sampleMemory().then(() => true),
            1_000,
          );
          console.info(`Native Auth browser peak RSS: ${browserPeakMemoryBytes}bytes`);
          const errors: unknown[] = [];
          try {
            await closeContexts();
          } catch (error) {
            errors.push(error);
          }
          try {
            await detachCdp();
          } catch (error) {
            errors.push(error);
          }
          const operations: Promise<unknown>[] = [];
          if (privateBrowser) operations.push(privateBrowser.close());
          operations.push(stack.routeAuthPages(), stopChild(childOwner));
          const closed = await Promise.allSettled(operations);
          for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
          turnstile.stop(true);
          if (errors.length) throw new AggregateError(errors, 'Native Auth stack cleanup failed');
        })();
        const finished = await settledWithin(
          shutdown.then(() => true),
          18_000,
        );
        if (!finished) {
          await forceAuth();
          throw new Error('Native Auth stack shutdown exceeded 18000ms');
        }
      })());

    lifecycle.register({ label: 'native Auth stack fixture', close: stop, force: forceAuth });
    return {
      origin,
      context,
      async newContext(_persona) {
        const owner = currentNativeLifecycle() ?? lifecycle;
        owner.assertOpen('create native Auth browser context');
        const value = await createContext();
        allContexts.add(Promise.resolve(value));
        ownContext(value, owner, 'native Auth temporary context');
        return value;
      },
      signIn(persona, options) {
        return journey(persona, false, options);
      },
      signUp(persona) {
        return journey(persona, true);
      },
      stop,
    };
  } catch (error) {
    clearInterval(memorySampler);
    if (origin)
      await settledWithin(
        stack.routeAuthPages().then(() => true),
        2_000,
      ).catch(() => {});
    await privateBrowser?.force().catch(() => {});
    await stopChild(childOwner).catch(() => {});
    turnstile.stop(true);
    throw error;
  }
}
