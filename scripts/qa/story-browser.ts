import { appendFileSync } from 'node:fs';
import { playwright, type PlaywrightBrowserProvider } from '@vitest/browser-playwright';
import type { Page, Route } from 'playwright';

const assetTypes = new Set(['script', 'stylesheet', 'font', 'image']);

export async function serveStoryAsset(route: Route, origin: string): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  // Documents must keep their real loopback address space for Vitest's WebSocket connection.
  // Application API calls and non-idempotent traffic keep their normal browser boundary too.
  if (url.origin !== origin || request.method() !== 'GET' || url.pathname.startsWith('/api/')
    || !assetTypes.has(request.resourceType())) {
    await route.fallback();
    return;
  }
  // Chromium cancels in-flight loopback module requests with ERR_NETWORK_CHANGED when
  // other QA stacks change host interfaces. Node's HTTP client keeps those requests alive.
  // Retry connection resets only for these idempotent assets. HTTP errors retain
  // their real response; API calls and story execution are never retried here.
  const response = await route.fetch({ timeout: 180_000, maxRetries: 2 });
  try { await route.fulfill({ response, body: await response.body() }); }
  finally { await response.dispose(); }
}

/** Load real Vite assets through host interface changes, with optional initialization diagnostics. */
export function storyBrowser(options: Parameters<typeof playwright>[0] = {}) {
  const provider = playwright(options);
  const log = process.env.STORYBOOK_BROWSER_LOG;
  const factory = provider.providerFactory;
  provider.providerFactory = project => {
    const browser = factory(project) as PlaywrightBrowserProvider;
    const record = (session: string, event: string, detail: unknown) => {
      if (log) appendFileSync(log, `${JSON.stringify({ time: new Date().toISOString(), session, event, detail })}\n`);
    };
    const openPage = browser.openPage.bind(browser);
    browser.openPage = async (session, url, options) => {
      // Install routing and diagnostics before the orchestrator requests its first iframe.
      await openPage(session, 'about:blank', options);
      const page: Page = browser.getPage(session);
      const origin = new URL(url).origin;
      await page.route('**/*', route => serveStoryAsset(route, origin));
      if (log) {
        page.on('console', message => record(session, 'console', {
          type: message.type(), text: message.text(), location: message.location(),
        }));
        page.on('pageerror', error => record(session, 'pageerror', { message: error.message, stack: error.stack }));
        page.on('crash', () => record(session, 'crash', {}));
        page.on('requestfailed', request => record(session, 'requestfailed', {
          url: request.url(), frame: request.frame().url(), failure: request.failure(),
        }));
        page.on('response', async response => {
          const request = response.request();
          record(session, 'response', { url: response.url(), frame: request.frame().url(), status: response.status(),
            ...(response.status() >= 400 ? { body: await response.text().catch(String) } : {}),
          });
        });
      }
      await page.goto(url, { timeout: 0 });
    };
    return browser;
  };
  return provider;
}
