import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';
import { settledWithin } from './lifecycle.ts';
import type { NativeWebStack } from './stack.ts';

const serverFunctionPrefix = '/_serverFn/';
const serverFunctionNames = new Set([
  'readSession',
  'readAnonymousExposure',
  'readViewerExposure',
  'readAuthIssuer',
  'readCurrentShelfPreferences',
  'readPersonalLibraryCurrent',
  'readPersonalLibraryContinue',
  'readLibraryContinuePage',
  'readLibraryNavigationPage',
  'readLibraryPinsPage',
  'readShelfSummaryCurrent',
  'readShelfTypesCurrent',
  'readLabelShelf',
  'readLabelsCurrent',
]);

function serverFunctionName(id: string) {
  // Native Web runs Vite's dev server, which encodes the module and export in the function ID.
  if (!/^[A-Za-z0-9_-]{1,512}$/u.test(id)) return 'other';
  try {
    const decoded = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as {
      export?: unknown;
      file?: unknown;
    } | null;
    const name = typeof decoded?.export === 'string' && decoded.export.replace(/_createServerFn_handler$/u, '');
    if (name === 'readViewerExposure' && typeof decoded?.file === 'string') {
      const file = decoded.file.split('?', 1)[0];
      if (file?.endsWith('/src/session/query.ts')) return 'readViewerExposure (session)';
      if (file?.endsWith('/src/kernel/viewer-exposure.ts')) return 'readViewerExposure (viewer)';
    }
    if (name && serverFunctionNames.has(name)) return name;
  } catch {
    // Never include an unknown ID or its decoded payload in the observation.
  }
  return 'other';
}

const libraryKernelRoutes = new Set([
  '/openapi.json',
  '/v1/platform/exposure',
  '/v1/collections',
  '/v1/definitions/active',
  '/v1/libraryContinue',
  '/v1/libraryEntries',
  '/v1/libraryLabelAssignments',
  '/v1/libraryLabels',
  '/v1/libraryPins',
  '/v1/libraryShelfSummary',
  '/v1/libraryShelfTypes',
]);

function libraryKernelRoute(path: string) {
  if (libraryKernelRoutes.has(path)) return path;
  if (/^\/v1\/accounts\/[^/]+\/preferences$/u.test(path)) return '/v1/accounts/:account/preferences';
  if (/^\/v1\/definitions\/releases\/[^/]+$/u.test(path)) return '/v1/definitions/releases/:digest';
}

export async function sampleLibraryKernelReturn(stack: NativeWebStack, from: number) {
  // A stalled request is evidence. This reads the host's existing observations without waiting for it to finish.
  const requests = await settledWithin(stack.sampleKernelRequests(), 1_500).catch(() => undefined);
  if (!requests) return null;
  let count = 0;
  const samples = [];
  for (const request of requests.slice(from)) {
    if (request.fixtureRequest || request.method !== 'GET') continue;
    const route = libraryKernelRoute(new URL(request.url, stack.kernelOrigin).pathname);
    if (!route) continue;
    count++;
    if (samples.length < 16) {
      const credential = request.authorization !== null || request.session !== null;
      const actor = request.access?.authenticated ? 'account' : credential ? 'unresolved' : 'anonymous';
      samples.push({
        route,
        status: request.responseStatus ?? null,
        actor,
      });
    }
  }
  return { count, samples };
}

function requestFailure(request: Request): string {
  const reason = request.failure()?.errorText ?? '';
  return /^net::ERR_[A-Z0-9_]{1,40}$/u.test(reason) ? reason : 'request-failed';
}

function bootError(message: string): string | undefined {
  if (/mime type|unsupported mime/iu.test(message)) return 'script-mime';
  if (/content security policy/iu.test(message)) return 'script-policy';
  if (/dynamically imported module|importing a module script failed|failed to load module script/iu.test(message))
    return 'module-load';
  if (/hydrat(?:e|ion)/iu.test(message)) return 'hydration';
}

function scriptSource(url: URL, origin: string): string {
  if (url.origin !== origin) return 'outside-web';
  const { pathname } = url;
  if (pathname === '/src/client.tsx' || pathname === '/src/router.tsx' || pathname === '/src/routeTree.gen.ts')
    return pathname;
  if (pathname.includes('tanstack-start-dev-client-entry')) return 'start-dev-client-entry';
  if (pathname.startsWith('/src/routes/library/') || pathname.startsWith('/src/library/')) return 'library';
  if (pathname.startsWith('/src/paraglide/')) return 'paraglide';
  if (pathname.startsWith('/src/')) return 'web-source';
  if (pathname.startsWith('/assets/')) return 'built-asset';
  return 'web-dependency';
}

function pendingDocument() {
  return {
    status: null as number | null,
    html: null as boolean | null,
    finished: false,
    domContentLoaded: false,
    failure: null as string | null,
  };
}

/** Observe the new Auth journey page through the existing readiness wait. */
export function observePersonalWebReturn(context: BrowserContext, target: URL) {
  let document: ReturnType<typeof pendingDocument> | null = null;
  const scripts = { requested: 0, responses: 0, finished: 0, failed: 0 };
  const functions = { requested: 0, responses: 0, failed: 0 };
  const functionSamples: { name: string; atMs: number; status: number | null; failure: string | null }[] = [];
  let startedAt = performance.now();
  const scriptFailures = new Set<string>();
  const browserErrors = new Set<string>();
  const record = (errors: Set<string>, kind: string) => {
    if (errors.size < 8) errors.add(kind);
  };
  const isTarget = (href: string) => {
    const url = new URL(href);
    return url.origin === target.origin && url.pathname === target.pathname;
  };

  let detachPage: (() => void) | undefined;
  const attach = (page: Page) => {
    let expectedDocument: Request | undefined;
    let targetNavigation = false;
    const scriptRequests = new WeakSet<Request>();
    const functionRequests = new WeakMap<Request, (typeof functionSamples)[number] | null>();
    const onRequest = (request: Request) => {
      if (request.resourceType() === 'document' && request.frame() === page.mainFrame()) {
        targetNavigation = isTarget(request.url());
        if (targetNavigation) {
          expectedDocument = request;
          document = pendingDocument();
          startedAt = performance.now();
        }
      } else if (targetNavigation && request.resourceType() === 'script' && request.frame() === page.mainFrame()) {
        scriptRequests.add(request);
        scripts.requested++;
      } else if (targetNavigation && ['fetch', 'xhr'].includes(request.resourceType())) {
        const { origin, pathname } = new URL(request.url());
        if (origin !== target.origin || !pathname.startsWith(serverFunctionPrefix)) return;
        functions.requested++;
        let sample: (typeof functionSamples)[number] | null = null;
        if (functionSamples.length < 8) {
          sample = {
            name: serverFunctionName(pathname.slice(serverFunctionPrefix.length)),
            atMs: Math.round(performance.now() - startedAt),
            status: null,
            failure: null,
          };
          functionSamples.push(sample);
        }
        functionRequests.set(request, sample);
      }
    };
    const onResponse = (response: Response) => {
      const request = response.request();
      if (request === expectedDocument && document) {
        document.status = response.status();
        document.html = /^text\/html(?:;|$)/iu.test(response.headers()['content-type'] ?? '');
      }
      const sample = functionRequests.get(request);
      if (sample !== undefined) {
        functions.responses++;
        if (sample) sample.status = response.status();
      }
      if (!scriptRequests.has(request)) return;
      scripts.responses++;
      if (response.status() >= 400) {
        const source = scriptSource(new URL(request.url()), target.origin);
        record(scriptFailures, `http-${response.status()} (${source})`);
      }
    };
    const onFinished = (request: Request) => {
      if (request === expectedDocument && document) document.finished = true;
      if (scriptRequests.has(request)) scripts.finished++;
    };
    const onFailed = (request: Request) => {
      if (request === expectedDocument && document) document.failure = requestFailure(request);
      const sample = functionRequests.get(request);
      if (sample !== undefined) {
        functions.failed++;
        if (sample) sample.failure = requestFailure(request);
      }
      if (!scriptRequests.has(request)) return;
      scripts.failed++;
      const source = scriptSource(new URL(request.url()), target.origin);
      record(scriptFailures, `${requestFailure(request)} (${source})`);
    };
    const onDomContentLoaded = () => {
      if (document && isTarget(page.url())) document.domContentLoaded = true;
    };
    const onPageError = ({ name, message }: Error) => {
      if (!isTarget(page.url())) return;
      const kind = bootError(message);
      record(
        browserErrors,
        kind ?? (['TypeError', 'SyntaxError', 'ReferenceError', 'RangeError'].includes(name) ? name : 'page-error'),
      );
    };
    const onConsole = (message: ConsoleMessage) => {
      if ((message.type() !== 'error' && message.type() !== 'warning') || !isTarget(page.url())) return;
      const kind = bootError(message.text());
      if (kind) record(browserErrors, kind);
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onFinished);
    page.on('requestfailed', onFailed);
    page.on('domcontentloaded', onDomContentLoaded);
    page.on('pageerror', onPageError);
    page.on('console', onConsole);
    detachPage = () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      page.off('domcontentloaded', onDomContentLoaded);
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
    };
  };

  context.once('page', attach);
  return {
    snapshot: () => ({
      document: document && { ...document },
      elapsedMs: document ? Math.round(performance.now() - startedAt) : null,
      scripts: { ...scripts },
      serverFunctions: { ...functions, samples: functionSamples.map((sample) => ({ ...sample })) },
      scriptFailures: [...scriptFailures],
      browserErrors: [...browserErrors],
    }),
    stop() {
      context.off('page', attach);
      detachPage?.();
    },
  };
}
