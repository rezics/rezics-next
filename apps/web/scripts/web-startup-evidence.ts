import { chromium, errors, type Request } from 'playwright';

const firstMountBudgetMs = 120_000;
const maximumPendingScriptPaths = 12;
const serverFunctionPath = /^\/_serverFn(?:\/|$)/u;

type ServerFunctionCounts = {
  started: number;
  responses: number;
  settled: number;
  failed: number;
  pending: number;
};

type ScriptCounts = {
  started: number;
  completed: number;
  failed: number;
  pending: number;
  firstPaths: string[];
  failedPaths: string[];
  pendingPaths: string[];
};

type ScriptRequest = { path: string; failed: boolean };

export type WebStartupEvidence = {
  documentStatus: number | null;
  documentPath: string | null;
  navigationTimedOut: boolean;
  hydrated: boolean;
  homePresent: boolean;
  homeMounted: boolean | null;
  homeState: string | null;
  homeBusy: boolean | null;
  clientLoadFailed: boolean;
  firstMountMs: number | null;
  homeMountMs: number | null;
  shellControlWorked: boolean;
  shellControlMs: number | null;
  semanticBindingRequested: boolean;
  clientErrors: number;
  firstClientError: string | null;
  scriptsAtReadinessBoundary: ScriptCounts;
  scriptsAtEnd: ScriptCounts;
  serverFunctionsAtReadinessBoundary: ServerFunctionCounts;
  serverFunctionsAtEnd: ServerFunctionCounts;
};

function pageOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password)
    throw new Error('--base-url must be an HTTP origin without credentials');
  return url.origin;
}

function displayPath(path: string): string {
  const storeMarker = '/node_modules/.bun/';
  const storeIndex = path.lastIndexOf(storeMarker);
  return storeIndex < 0 ? path : `package:${path.slice(storeIndex + storeMarker.length)}`;
}

export async function observeColdHomeStartup(baseUrl: string): Promise<WebStartupEvidence> {
  const origin = pageOrigin(baseUrl);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const startedAt = performance.now();
  const deadline = startedAt + firstMountBudgetMs;
  const scripts = new Map<Request, ScriptRequest>();
  const serverFunctions = new Map<Request, { failed: boolean }>();
  const firstScriptPaths: string[] = [];
  const firstFailedScriptPaths: string[] = [];
  let scriptsStarted = 0;
  let scriptsCompleted = 0;
  let scriptsFailed = 0;
  let serverFunctionsStarted = 0;
  let serverFunctionResponses = 0;
  let serverFunctionsSettled = 0;
  let serverFunctionsFailed = 0;
  let clientErrors = 0;
  let firstClientError: string | null = null;
  let navigationTimedOut = false;
  let documentStatus: number | null = null;
  let semanticBindingRequested = false;

  const observeRequest = (request: Request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    if (request.resourceType() === 'script') {
      scriptsStarted++;
      scripts.set(request, { path: url.pathname, failed: false });
      if (firstScriptPaths.length < maximumPendingScriptPaths) firstScriptPaths.push(displayPath(url.pathname));
      if (url.pathname === '/src/features/catalogue/page-render-binding.tsx') semanticBindingRequested = true;
    }
    if (serverFunctionPath.test(url.pathname)) {
      serverFunctionsStarted++;
      serverFunctions.set(request, { failed: false });
    }
  };
  const observeResponse = (response: { request(): Request; status(): number }) => {
    const request = response.request();
    const script = scripts.get(request);
    if (script && response.status() >= 400 && !script.failed) {
      script.failed = true;
      scriptsFailed++;
      if (firstFailedScriptPaths.length < maximumPendingScriptPaths)
        firstFailedScriptPaths.push(displayPath(script.path));
    }
    const serverFunction = serverFunctions.get(request);
    if (!serverFunction) return;
    serverFunctionResponses++;
    if (response.status() >= 400) {
      serverFunctionsFailed++;
      serverFunction.failed = true;
    }
  };
  const observeFinished = (request: Request) => {
    const script = scripts.get(request);
    if (script) {
      scripts.delete(request);
      if (!script.failed) scriptsCompleted++;
    }
    const serverFunction = serverFunctions.get(request);
    if (!serverFunction) return;
    serverFunctions.delete(request);
    serverFunctionsSettled++;
  };
  const observeFailed = (request: Request) => {
    const script = scripts.get(request);
    if (script) {
      scripts.delete(request);
      if (!script.failed) {
        scriptsFailed++;
        if (firstFailedScriptPaths.length < maximumPendingScriptPaths)
          firstFailedScriptPaths.push(displayPath(script.path));
      }
    }
    const serverFunction = serverFunctions.get(request);
    if (!serverFunction) return;
    serverFunctions.delete(request);
    serverFunctionsSettled++;
    if (!serverFunction.failed) serverFunctionsFailed++;
  };
  page.on('request', observeRequest);
  page.on('response', observeResponse);
  page.on('requestfinished', observeFinished);
  page.on('requestfailed', observeFailed);
  page.on('pageerror', (error) => {
    clientErrors++;
    if (firstClientError === null) firstClientError = error.message.slice(0, 500);
  });

  const scriptSnapshot = (): ScriptCounts => ({
    started: scriptsStarted,
    completed: scriptsCompleted,
    failed: scriptsFailed,
    pending: scripts.size,
    firstPaths: [...firstScriptPaths],
    failedPaths: [...firstFailedScriptPaths],
    pendingPaths: [...scripts.values()].slice(0, maximumPendingScriptPaths).map((request) => displayPath(request.path)),
  });
  const serverFunctionSnapshot = (): ServerFunctionCounts => ({
    started: serverFunctionsStarted,
    responses: serverFunctionResponses,
    settled: serverFunctionsSettled,
    failed: serverFunctionsFailed,
    pending: serverFunctions.size,
  });
  const waitFor = async (selector: string): Promise<boolean> => {
    const remaining = Math.max(1, deadline - performance.now());
    try {
      await page.locator(selector).waitFor({ state: 'attached', timeout: remaining });
      return true;
    } catch (error) {
      if (error instanceof errors.TimeoutError) return false;
      throw error;
    }
  };

  try {
    try {
      const response = await page.goto(`${origin}/en`, {
        waitUntil: 'domcontentloaded',
        timeout: firstMountBudgetMs,
      });
      documentStatus = response?.status() ?? null;
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      navigationTimedOut = true;
    }

    const hydrated = documentStatus !== null && (await waitFor('html[data-hydrated]'));
    const firstMountMs = hydrated ? Math.round(performance.now() - startedAt) : null;
    const scriptsAtReadinessBoundary = scriptSnapshot();
    const serverFunctionsAtReadinessBoundary = serverFunctionSnapshot();
    const homeMounted = hydrated && (await waitFor('main[data-home-feed-mounted="true"]'));
    const homeMountMs = homeMounted ? Math.round(performance.now() - startedAt) : null;
    const homeSnapshot = await page.evaluate(() => {
      const home = document.querySelector<HTMLElement>('[data-home-feed-mounted]');
      return {
        documentPath: location.pathname,
        homePresent: home !== null,
        homeMounted: home ? home.dataset.homeFeedMounted === 'true' : null,
        homeState: home?.dataset.homeFeedState ?? null,
        homeBusy: home ? home.getAttribute('aria-busy') === 'true' : null,
        clientLoadFailed: document.documentElement.hasAttribute('data-client-load-failed'),
      };
    });

    let shellControlWorked = false;
    let shellControlMs: number | null = null;
    if (hydrated && performance.now() < deadline) {
      const collapse = page.getByRole('button', { name: 'Collapse navigation', exact: true });
      if ((await collapse.count()) === 1 && (await collapse.isEnabled())) {
        await collapse.click({ timeout: Math.max(1, deadline - performance.now()) });
        shellControlWorked = await waitFor('button[aria-label="Expand navigation"]');
        if (shellControlWorked) shellControlMs = Math.round(performance.now() - startedAt);
      }
    }

    return {
      documentStatus,
      documentPath: homeSnapshot.documentPath,
      navigationTimedOut,
      hydrated,
      homePresent: homeSnapshot.homePresent,
      homeMounted: homeSnapshot.homeMounted,
      homeState: homeSnapshot.homeState,
      homeBusy: homeSnapshot.homeBusy,
      clientLoadFailed: homeSnapshot.clientLoadFailed,
      firstMountMs,
      homeMountMs,
      shellControlWorked,
      shellControlMs,
      semanticBindingRequested,
      clientErrors,
      firstClientError,
      scriptsAtReadinessBoundary,
      scriptsAtEnd: scriptSnapshot(),
      serverFunctionsAtReadinessBoundary,
      serverFunctionsAtEnd: serverFunctionSnapshot(),
    };
  } finally {
    await browser.close();
  }
}

function parseArguments(argv: readonly string[]): { baseUrl: string } {
  if (argv.length !== 2 || argv[0] !== '--base-url' || !argv[1])
    throw new Error('Usage: bun scripts/web-startup-evidence.ts --base-url <web-origin>');
  return { baseUrl: argv[1] };
}

if (import.meta.main) {
  try {
    const evidence = await observeColdHomeStartup(parseArguments(process.argv.slice(2)).baseUrl);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (!evidence.hydrated || !evidence.homeMounted || !evidence.shellControlWorked) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
