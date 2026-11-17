import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { type Browser, type BrowserContext, type Page, type Response as PlaywrightResponse } from 'playwright';
import { SESSION_COOKIE } from '../../src/session/cookies.ts';
import type { NativeWebStack } from './stack.ts';
import { launchPrivateBrowser, type PrivateBrowser } from './private-browser.ts';
import { traceWebModuleFailure } from './web-module-failure.ts';
import { createNativeAuthPageApp } from './auth-page-app.ts';
import {
  currentNativeLifecycle,
  settledWithin,
  type NativeProcessOwnership,
  type NativeProcessIdentity,
  type NativeTestLifecycle,
} from './lifecycle.ts';

export type AuthPersona =
  | 'alice'
  | 'bob'
  | 'editor'
  | 'governor'
  | 'suspended'
  | 'newcomer'
  | 'anonymous'
  | 'wrong-rp'
  | 'moderation-alice'
  | 'moderation-author'
  | 'moderator'
  | 'appeal-moderator'
  | 'outsider';
export type AuthJourney = {
  url: string;
  context: BrowserContext;
  visitedUrls: string[];
  /** Reuse the authenticated page and stop adding requests to the sign-in trace. */
  continueOnPage(): Page;
  response(): Promise<PlaywrightResponse>;
  requestHeaders(): Promise<Headers[]>;
  serverFunctionRequests(): Promise<
    {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
      responseBody: string;
    }[]
  >;
};
type NativeSignInOptions = { returnTo?: string; context?: BrowserContext; sessionOnly?: boolean };
type NativeSignup = { accountId: string; handle: string };

export type NativeAuthStack = {
  origin: string;
  pageAppProcess(): NativeProcessIdentity | undefined;
  settlePageApp(): Promise<void>;
  browserMemoryObservation(): { sampledAt: number; rssBytes: number; peakRssBytes: number } | null;
  context(persona: AuthPersona): Promise<BrowserContext>;
  newContext(persona: AuthPersona): Promise<BrowserContext>;
  submitSignIn(page: Page, persona: 'alice' | 'bob'): Promise<void>;
  signIn(persona: Exclude<AuthPersona, 'newcomer' | 'anonymous'>, options?: NativeSignInOptions): Promise<AuthJourney>;
  signUp(
    persona: 'newcomer',
    options?: Pick<NativeSignInOptions, 'returnTo' | 'context'>,
  ): Promise<AuthJourney & { registration: NativeSignup }>;
  stop(): Promise<void>;
};

const authRoot = resolve(import.meta.dir, '../../../auth');
const password = 'semantic outcome registration password with enough entropy';

async function fillNativeSignIn(page: Page, email: string) {
  await page.getByLabel(/email/i).fill(email);
  await page.locator('input[name="password"]').fill(password);
}

/** Private supervisor messages to the existing Auth host, never browser credentials. */
export async function nativeAuthFixtureRequest(
  stack: NativeWebStack,
  key: string,
  body: Record<string, unknown>,
  credentials?: { authorization: string; cookie: string },
): Promise<Response> {
  const response = await fetch(`${stack.authIssuer}/__native/auth-fixture`, {
    method: 'POST',
    headers: {
      origin: stack.issuerOrigin,
      'content-type': 'application/json',
      'x-native-auth-fixture-key': key,
      ...credentials,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(
      `Native Auth fixture ${String(body.command)} returned ${response.status}: ${await response.text()}`,
    );
  return response;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  });
  const port = server.port;
  server.stop(true);
  return port;
}

async function stopChild(owner: NativeProcessOwnership | undefined): Promise<void> {
  if (!owner) return;
  try {
    await owner.close();
  } catch {
    await owner.force();
  }
}

export async function prepareNativeAuthMessages(): Promise<void> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Auth message preparation requires an active native test lifecycle');
  lifecycle.assertOpen('prepare native Auth messages');
  const child = spawn(process.execPath, ['scripts/generate.ts'], {
    cwd: authRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const owner = lifecycle.ownProcessGroup('native Auth messages preparation', child);
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => (output = (output + chunk.toString()).slice(-12_000)));
  try {
    await new Promise<void>((resolveCompletion, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0) resolveCompletion();
        else reject(new Error(`Native Auth messages preparation failed (${signal ?? code}): ${output}`));
      });
    });
  } finally {
    await stopChild(owner);
    owner.release();
  }
}

async function hydrate(page: Page): Promise<void> {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

export async function startAuthStack(
  stack: NativeWebStack,
  options: { nativeFixtureKey?: string; preparedMessages?: boolean; useHeadlessShell?: boolean } = {},
): Promise<NativeAuthStack> {
  const lifecycle = currentNativeLifecycle();
  if (!lifecycle) throw new Error('Native Auth stack startup requires an active native test lifecycle');
  lifecycle.assertOpen('start native Auth stack');
  const startupStarted = performance.now();

  const port = await freePort();
  lifecycle.assertOpen('start native Auth app');
  const appOrigin = `http://127.0.0.1:${port}`;
  const nativeIssuer = new URL(stack.issuerOrigin);
  const turnstileScriptUrl =
    nativeIssuer.hostname === 'auth.native.rezics.com'
      ? new URL('/__native-turnstile.js', nativeIssuer).href
      : undefined;
  let origin: string | undefined;
  const routePages = async (attach = false): Promise<string> => {
    if (options.nativeFixtureKey !== undefined) {
      const response = await nativeAuthFixtureRequest(stack, options.nativeFixtureKey, {
        command: 'pages',
        origin: attach ? pageGateway!.url.origin : null,
      });
      const mounted = (await response.json()) as { issuer: string };
      if (mounted.issuer !== stack.issuerOrigin) throw new Error('Native Auth page bridge changed its issuer');
      return mounted.issuer;
    }
    return stack.routeAuthPages(attach ? forwardPage : undefined);
  };
  const turnstile = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/api.js') return new Response('Not Found', { status: 404 });
      return new Response(
        `window.turnstile={ready:function(callback){callback()},render:function(node,options){queueMicrotask(function(){options.callback('native-test-token')});return 'native-widget'},reset:function(){},remove:function(){}};`,
        {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      );
    },
  });
  lifecycle.register({
    label: 'native Auth Turnstile listener',
    close: () => turnstile.stop(true),
    force: () => turnstile.stop(true),
  });
  const pageApp = createNativeAuthPageApp(lifecycle, authRoot, appOrigin, {
    ...process.env,
    REZICS_TEST_RUNTIME: '1',
    REZICS_AUTH_PREPARED_MESSAGES: options.preparedMessages ? '1' : undefined,
    REZICS_TEST_PERSISTENCE_DIAGNOSTICS: '1',
    AUTH_ORIGIN: stack.authIssuer,
    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
    TURNSTILE_SCRIPT_URL: turnstileScriptUrl ?? `${turnstile.url.origin}/api.js`,
  });
  let activeJourneys = 0;
  const pendingPageResponses = new Set<Promise<void>>();
  let retirementRequested = false;
  const observedContexts = new Set<BrowserContext>();
  const canRetirePages = () =>
    retirementRequested &&
    activeJourneys === 0 &&
    pendingPageResponses.size === 0 &&
    ![...new Set([...browser!.contexts(), ...observedContexts])].some((context) =>
      context.pages().some((page) =>
        page.frames().some((frame) => {
          const address = frame.url();
          return address !== '' && new URL(address).origin === origin;
        }),
      ),
    );
  const retirePages = () => {
    if (browser && canRetirePages()) void pageApp.retire(canRetirePages).catch(() => {});
  };
  const observeContext = (context: BrowserContext) => {
    if (observedContexts.has(context)) return;
    observedContexts.add(context);
    const observePage = (page: Page) => {
      page.on('framenavigated', retirePages);
      page.on('close', retirePages);
    };
    context.pages().forEach(observePage);
    context.on('page', observePage);
    context.on('close', () => {
      observedContexts.delete(context);
      retirePages();
    });
  };
  const forwardPage = async (request: Request) => {
    const drained = Promise.withResolvers<void>();
    pendingPageResponses.add(drained.promise);
    if (request.headers.get('sec-fetch-dest') === 'document') retirementRequested = false;
    const release = () => {
      pendingPageResponses.delete(drained.promise);
      drained.resolve();
      retirePages();
    };
    try {
      await pageApp.ensure();
      const source = new URL(request.url);
      const response = await fetch(new Request(new URL(source.pathname + source.search, appOrigin), request), {
        redirect: 'manual',
      });
      if (!response.body) {
        release();
        return response;
      }
      const stream = new TransformStream();
      void response.body
        .pipeTo(stream.writable)
        .catch(() => {})
        .finally(release);
      return new Response(stream.readable, response);
    } catch (error) {
      release();
      throw error;
    }
  };
  const pageGateway =
    options.nativeFixtureKey === undefined
      ? undefined
      : Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          idleTimeout: 120,
          fetch: forwardPage,
        });
  if (pageGateway)
    lifecycle.register({
      label: 'native Auth page app gateway',
      close: () => pageGateway.stop(true),
      force: () => pageGateway.stop(true),
    });
  const contexts = new Map<AuthPersona, Promise<BrowserContext>>();
  const allContexts = new Set<Promise<BrowserContext>>();
  let browser: Browser | undefined;
  let privateBrowser: PrivateBrowser | undefined;
  let stopping: Promise<void> | undefined;
  let browserPeakMemoryBytes = 0;
  let browserMemory: ReturnType<NativeAuthStack['browserMemoryObservation']> = null;
  let memorySampler: ReturnType<typeof setInterval> | undefined;
  let sampling = false;
  let sampleMemory = async () => {};
  try {
    await pageApp.ensure();
    lifecycle.assertOpen('route Auth pages');
    origin = await routePages(true);
    const moduleFailureTrace =
      process.env.WEB_TEST_MODULE_FAILURE_TRACE === '1'
        ? traceWebModuleFailure(stack.web, stack.memoryObservation?.())
        : undefined;
    privateBrowser = await launchPrivateBrowser(
      [stack.web, origin, turnstile.url.origin],
      moduleFailureTrace,
      options.useHeadlessShell,
    );
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
          browserMemory = { sampledAt: Date.now(), rssBytes: bytes, peakRssBytes: browserPeakMemoryBytes };
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
    const createContext = async (): Promise<BrowserContext> => {
      const context = await browser!.newContext({
        viewport: { width: 1280, height: 860 },
        reducedMotion: 'reduce',
        locale: 'en',
        javaScriptEnabled: true,
        ignoreHTTPSErrors: nativeIssuer.hostname === 'auth.native.rezics.com',
      });
      observeContext(context);
      return context;
    };
    const ownContext = (value: BrowserContext, owner: NativeTestLifecycle, label: string) => {
      const close = async () => {
        const closed = await settledWithin(
          value.close().then(() => true),
          1_500,
        );
        if (!closed) throw new Error(`${label} did not close within 1500ms`);
      };
      owner.register({
        label,
        close,
        force: () => value.close().catch(() => {}),
      });
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
      options: NativeSignInOptions = {},
    ): Promise<AuthJourney & { registration?: NativeSignup }> {
      assertActive(signup ? 'start native sign-up journey' : 'start native sign-in journey');
      const journeyStarted = performance.now();
      await pageApp.ensure();
      const browserContext = options.context ?? (await context(persona));
      observeContext(browserContext);
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
      const releasePage = pageOwner.register({
        label: 'native Auth journey page',
        close: closePage,
        force: () => page.close().catch(() => {}),
      });
      page.once('close', releasePage);
      page.setDefaultTimeout(15_000);
      const webOrigin = new URL(stack.web).origin;
      const authResponses: PlaywrightResponse[] = [];
      const visitedUrls: string[] = [];
      const pageRequests: import('playwright').Request[] = [];
      const webFunctions = { requests: 0, responses: 0, failures: 0 };
      const pageFailures: {
        path: string;
        method: string;
        error: string | undefined;
      }[] = [];
      const recordRequest = (request: import('playwright').Request) => {
        pageRequests.push(request);
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) visitedUrls.push(request.url());
        const { origin, pathname } = new URL(request.url());
        if (origin === webOrigin && pathname.startsWith('/_serverFn/')) webFunctions.requests += 1;
      };
      const recordResponse = (response: PlaywrightResponse) => {
        const url = new URL(response.url());
        if (url.origin === webOrigin && url.pathname.startsWith('/_serverFn/')) {
          webFunctions.responses += 1;
          if (!response.ok()) webFunctions.failures += 1;
        }
        if (url.pathname === '/signin') authResponses.push(response);
      };
      const recordFailure = (request: import('playwright').Request) => {
        if (pageFailures.length >= 8) return;
        const url = new URL(request.url());
        if (url.origin !== webOrigin) return;
        pageFailures.push({ path: url.pathname, method: request.method(), error: request.failure()?.errorText });
      };
      page.on('request', recordRequest);
      page.on('response', recordResponse);
      page.on('requestfailed', recordFailure);
      assertActive('read native Auth account for browser sign-in');
      const email = signup ? `${crypto.randomUUID()}@example.test` : (await stack.authPersona(persona)).email;
      const formPassword = signup ? `newcomer-${crypto.randomUUID()}` : password;
      const signInUrl = new URL('/auth/sign-in', stack.web);
      if (options.returnTo !== undefined) signInUrl.searchParams.set('return_to', options.returnTo);
      assertActive('open native Auth sign-in page');
      await page.goto(signInUrl.href, { waitUntil: 'domcontentloaded' });
      await hydrate(page);
      let callbackResponse: Promise<PlaywrightResponse> | undefined;
      let registration: NativeSignup | undefined;
      if (signup) {
        assertActive('open native Auth sign-up page');
        const signupLink = page.getByRole('link', { name: /create an account|sign up/i }).first();
        await signupLink.click();
        await page.waitForURL((url) => url.origin === origin && url.pathname === '/signup');
        await hydrate(page);
        assertActive('submit native Auth sign-up form');
        const handle = `newcomer-${crypto.randomUUID().slice(0, 8)}`;
        const fields = page.locator('#signup-form input');
        await fields.and(page.getByLabel('Handle', { exact: true })).fill(handle);
        await fields.and(page.getByLabel('Email', { exact: true })).fill(email);
        await fields.and(page.getByLabel('Password', { exact: true })).fill(formPassword);
        await fields.and(page.getByLabel('Confirm password', { exact: true })).fill(formPassword);
        await page.getByText('Loading the security check…', { exact: true }).waitFor({ state: 'hidden' });
        // Capture the native registration receipt separately from the automatic sign-in response.
        const signupResponse = page.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return url.origin === origin && url.pathname === '/signup' && response.request().method() === 'POST';
          },
          { timeout: 30_000 },
        );
        callbackResponse = page.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return url.origin === webOrigin && url.pathname === '/auth/callback';
          },
          { timeout: 30_000 },
        );
        await page.getByRole('button', { name: 'Create an account', exact: true }).click();
        const response = await signupResponse;
        if (response.status() !== 201) throw new Error(`Native Auth sign-up returned HTTP ${response.status()}`);
        const receipt = (await response.json()) as { accountId?: unknown } | null;
        if (typeof receipt?.accountId !== 'string' || !receipt.accountId)
          throw new Error('Native Auth sign-up returned no account ID');
        registration = { accountId: receipt.accountId, handle };
      } else {
        await fillNativeSignIn(page, email);
        assertActive('submit native Auth sign-in form');
        await pageApp.ensure();
        if (persona !== 'suspended')
          callbackResponse = page.waitForResponse(
            (response) => {
              const url = new URL(response.url());
              return url.origin === webOrigin && url.pathname === '/auth/callback';
            },
            { timeout: 30_000 },
          );
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/signin'),
          page.getByRole('button', { name: 'Sign in', exact: true }).click(),
        ]);
      }
      if (persona !== 'suspended') {
        assertActive('finish native Auth callback');
        const callback = await callbackResponse;
        let stage = options.sessionOnly ? 'Web session cookie' : 'Web hydration';
        try {
          if (options.sessionOnly) {
            // Script-free journeys transfer the session established by the real callback.
            if (callback?.status() !== 303) throw new Error('The signed-in callback did not complete');
            const failure = await callback.finished();
            if (failure) throw failure;
            const cookies = await browserContext.cookies(webOrigin);
            if (!cookies.some(({ name, httpOnly, value }) => name === SESSION_COOKIE && httpOnly && value))
              throw new Error('The signed-in callback did not set a website session cookie');
          } else {
            // Public SSR can reach DOMContentLoaded before the client mounts its session observer.
            // Use the return navigation budget for hydration and reserve the account wait for the mounted shell.
            await page.waitForFunction(
              (origin) =>
                location.origin === origin &&
                !location.pathname.startsWith('/auth/') &&
                document.querySelector('html[data-hydrated]') !== null,
              webOrigin,
              { timeout: 30_000 },
            );
            stage = 'Web account menu';
            await page.locator('#account-menu-button').waitFor({ state: 'visible' });
          }
        } catch (cause) {
          const path = new URL(page.url()).pathname;
          const navigation = visitedUrls.slice(-12).map((value) => new URL(value).pathname);
          throw new Error(
            `Signed-in web page was not ready at ${path} (${stage}); sign-in status=${authResponses.at(-1)?.status() ?? 'missing'}; callback status=${callback?.status() ?? 'missing'}; visited=${JSON.stringify(navigation)}; Web server functions=${JSON.stringify(webFunctions)}; failed Web requests=${JSON.stringify(pageFailures)}`,
            { cause },
          );
        }
      }
      if (!options.sessionOnly) await page.waitForLoadState('domcontentloaded');
      await sampleMemory();
      if (!signup)
        console.info(
          `Native Auth sign-in: ${Math.round(performance.now() - journeyStarted)}ms; browser peak RSS: ${browserPeakMemoryBytes}bytes`,
        );
      const current = page.url();
      const response = async () => {
        const latest = authResponses.at(-1);
        if (!latest) throw new Error(`Auth did not receive a ${signup ? 'sign-up' : 'sign-in'} submission`);
        return latest;
      };
      return {
        url: current,
        context: browserContext,
        visitedUrls,
        ...(registration ? { registration } : {}),
        continueOnPage() {
          page.off('request', recordRequest);
          page.off('response', recordResponse);
          page.off('requestfailed', recordFailure);
          retirementRequested = true;
          retirePages();
          return page;
        },
        response,
        async requestHeaders() {
          return Promise.all(pageRequests.map(async (request) => new Headers(await request.allHeaders())));
        },
        async serverFunctionRequests() {
          const requests = pageRequests.filter((request) => new URL(request.url()).pathname.startsWith('/_serverFn/'));
          return Promise.all(
            requests.map(async (request) => {
              const response = await request.response();
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
    const runJourney = async (persona: AuthPersona, signup: boolean, options?: NativeSignInOptions) => {
      activeJourneys++;
      try {
        return await journey(persona, signup, options);
      } finally {
        activeJourneys--;
        retirePages();
      }
    };
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
      await pageGateway?.stop(true);
      await Promise.allSettled([privateBrowser?.force(), pageApp.force()]);
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
          operations.push(routePages());
          operations.push(pageApp.stop());
          const closed = await Promise.allSettled(operations);
          for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
          await pageGateway?.stop(true);
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

    lifecycle.register({
      label: 'native Auth stack fixture',
      close: stop,
      force: forceAuth,
    });
    return {
      origin,
      pageAppProcess: () => pageApp.process(),
      async settlePageApp() {
        while (pendingPageResponses.size) await Promise.all(pendingPageResponses);
        retirePages();
        await pageApp.settled();
      },
      browserMemoryObservation: () => browserMemory,
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
        return runJourney(persona, false, options);
      },
      async submitSignIn(page, persona) {
        assertActive('submit native Auth sign-in form');
        await pageApp.ensure();
        const { email } = await stack.authPersona(persona);
        await fillNativeSignIn(page, email);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      },
      async signUp(persona, options) {
        const result = await runJourney(persona, true, options);
        if (!result.registration) throw new Error('Missing native Auth sign-up receipt');
        return { ...result, registration: result.registration };
      },
      stop,
    };
  } catch (error) {
    clearInterval(memorySampler);
    const cleanupErrors: unknown[] = [];
    if (origin)
      await settledWithin(
        routePages().then(() => true),
        2_000,
      ).catch((cleanup) => cleanupErrors.push(cleanup));
    await privateBrowser?.force().catch((cleanup) => cleanupErrors.push(cleanup));
    await pageApp.stop().catch((cleanup) => cleanupErrors.push(cleanup));
    await pageGateway?.stop(true);
    turnstile.stop(true);
    if (cleanupErrors.length)
      throw new AggregateError([error, ...cleanupErrors], 'Native Auth startup and cleanup failed');
    throw error;
  }
}
