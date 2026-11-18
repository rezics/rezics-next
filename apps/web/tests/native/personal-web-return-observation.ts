import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';

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
    const onRequest = (request: Request) => {
      if (request.resourceType() === 'document' && request.frame() === page.mainFrame()) {
        targetNavigation = isTarget(request.url());
        if (targetNavigation) {
          expectedDocument = request;
          document = pendingDocument();
        }
      } else if (targetNavigation && request.resourceType() === 'script' && request.frame() === page.mainFrame()) {
        scriptRequests.add(request);
        scripts.requested++;
      }
    };
    const onResponse = (response: Response) => {
      const request = response.request();
      if (request === expectedDocument && document) {
        document.status = response.status();
        document.html = /^text\/html(?:;|$)/iu.test(response.headers()['content-type'] ?? '');
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
    snapshot: () => ({ document, scripts, scriptFailures: [...scriptFailures], browserErrors: [...browserErrors] }),
    stop() {
      context.off('page', attach);
      detachPage?.();
    },
  };
}
