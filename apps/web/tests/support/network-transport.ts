import type { Browser, Route } from 'playwright';

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
  // Navigation redirects must update the address bar. Asset redirects stay on
  // Node HTTP too: Playwright does not route a redirected browser request again.
  const response = await route.fetch({ maxRedirects: request.isNavigationRequest() ? 0 : 20, maxRetries: 0 });
  try { await route.fulfill({ response, body: await response.body() }); }
  finally { await response.dispose(); }
}

/** Cover fixture contexts and contexts created manually for a second person or device. */
export function protectJourneyBrowser(browser: Browser, origin: string): () => void {
  const original = browser.newContext;
  browser.newContext = async options => {
    const context = await original.call(browser, options);
    await context.route('**/*', route => serveJourneyResource(route, origin));
    return context;
  };
  return () => { browser.newContext = original; };
}
