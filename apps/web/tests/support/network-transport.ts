import type { Browser, Route } from 'playwright';

const resourceTypes = new Set(['script', 'stylesheet', 'font', 'image']);

export async function serveJourneyResource(route: Route, origin: string, online = true): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  if (online && url.origin === origin && url.pathname.startsWith('/api/')) {
    // The real BFF still decides every API result. Keep Chrome's host-interface changes
    // out of the transport, without following redirects or replaying a command here.
    let response;
    try {
      response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
      await route.fulfill({ response, body: await response.body() });
    } catch {
      await route.abort('failed').catch(() => {});
    } finally { await response?.dispose(); }
    return;
  }
  if (url.origin !== origin || request.method() !== 'GET' || url.pathname.startsWith('/api/')
    || !resourceTypes.has(request.resourceType())) {
    await route.fallback();
    return;
  }
  // Native Docker changes host interfaces while other QA stacks run. Chromium can
  // cancel healthy loopback requests; Node HTTP keeps the real response alive.
  // Documents keep browser streaming and redirects. Asset redirects stay on Node
  // HTTP too: Playwright does not route a redirected browser request again.
  // A stale loopback keep-alive can reset before returning any HTTP response.
  // Playwright retries only ECONNRESET here, never HTTP errors or API commands.
  const response = await route.fetch({ maxRetries: 2 });
  try { await route.fulfill({ response, body: await response.body() }); }
  finally { await response.dispose(); }
}

/** Cover fixture contexts and contexts created manually for a second person or device. */
export function protectJourneyBrowser(browser: Browser, origin: string): () => void {
  const original = browser.newContext;
  browser.newContext = async options => {
    const context = await original.call(browser, options);
    let online = options?.offline !== true;
    const setOffline = context.setOffline.bind(context);
    context.setOffline = async offline => {
      online = !offline;
      await setOffline(offline);
    };
    await context.route('**/*', route => serveJourneyResource(route, origin, online));
    const close = context.close.bind(context);
    let closing: Promise<void> | undefined;
    context.close = async closeOptions => {
      // Closing a context while Node is fulfilling its last asset otherwise
      // reports a route callback error after the journey has already passed.
      closing ??= (async () => {
        if (!context.isClosed()) await context.unrouteAll({ behavior: 'ignoreErrors' });
        await close(closeOptions);
      })();
      await closing;
    };
    return context;
  };
  return () => { browser.newContext = original; };
}
