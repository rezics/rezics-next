import type { Browser, Route } from 'playwright';

const resourceTypes = new Set(['script', 'stylesheet', 'font', 'image']);

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
  // Documents keep browser streaming and redirects. Asset redirects stay on Node
  // HTTP too: Playwright does not route a redirected browser request again.
  const response = await route.fetch({ maxRetries: 0 });
  try { await route.fulfill({ response, body: await response.body() }); }
  finally { await response.dispose(); }
}

/** Cover fixture contexts and contexts created manually for a second person or device. */
export function protectJourneyBrowser(browser: Browser, origin: string): () => void {
  const original = browser.newContext;
  browser.newContext = async options => {
    const context = await original.call(browser, options);
    await context.route('**/*', route => serveJourneyResource(route, origin));
    const close = context.close.bind(context);
    context.close = async closeOptions => {
      // Closing a context while Node is fulfilling its last asset otherwise
      // reports a route callback error after the journey has already passed.
      await context.unrouteAll({ behavior: 'wait' });
      await close(closeOptions);
    };
    return context;
  };
  return () => { browser.newContext = original; };
}
