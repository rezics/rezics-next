import type { Browser, BrowserContext, Route } from 'playwright';

const resourceTypes = new Set(['document', 'script', 'stylesheet', 'font', 'image']);

export async function serveJourneyResource(route: Route, origin: string): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin || request.method() !== 'GET' || url.pathname.startsWith('/api/')
    || !resourceTypes.has(request.resourceType())) {
    await route.fallback();
    return;
  }
  // Native Docker changes host interfaces while other QA stacks run. Chromium can
  // cancel healthy loopback requests; Node HTTP keeps the real response alive.
  // A document redirect must still commit its real URL and cookies in the browser.
  // Assets can follow redirects on Node HTTP; they do not change the page address.
  try {
    const response = await route.fetch({ maxRetries: 0,
      ...(request.resourceType() === 'document' ? { maxRedirects: 0 } : {}) });
    try { await route.fulfill({ response, body: await response.body() }); }
    finally { await response.dispose(); }
  } catch {
    // Surface socket failures as failed browser requests, where the journey can
    // observe them. Throwing from a route callback escapes the test's lifetime.
    // A navigation may already have cancelled this request, so abort can be moot.
    await route.abort('failed').catch(() => {});
  }
}

/** Cancel outstanding Node HTTP reads, then drain every callback before its test ends. */
export async function stopJourneyRoutes(context: BrowserContext): Promise<void> {
  await context.close();
}

/** Cover fixture contexts and contexts created manually for a second person or device. */
export function protectJourneyBrowser(browser: Browser, origin: string): () => void {
  const original = browser.newContext;
  browser.newContext = async options => {
    const context = await original.call(browser, options);
    const pending = new Set<Promise<void>>();
    await context.route('**/*', async route => {
      const serving = serveJourneyResource(route, origin);
      pending.add(serving);
      try { await serving; }
      finally { pending.delete(serving); }
    });
    const close = context.close.bind(context);
    let closing: Promise<void> | undefined;
    context.close = async closeOptions => {
      // Closing a context while Node is fulfilling its last asset otherwise
      // reports a route callback error after the journey has already passed.
      closing ??= (async () => {
        if (!context.isClosed()) {
          // Cancel Node HTTP reads before closing the pages that own their routes.
          // Playwright's route wait can hang on already superseded navigations;
          // track our callbacks and drain them after the real context has closed.
          await context.request.dispose({ reason: 'Journey context is closing' });
          await context.unrouteAll({ behavior: 'ignoreErrors' });
        }
        await close(closeOptions);
        await Promise.allSettled(pending);
      })();
      await closing;
    };
    return context;
  };
  return () => { browser.newContext = original; };
}
