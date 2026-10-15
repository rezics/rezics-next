import type { Browser, BrowserContext, Page } from 'playwright';

type Handler = Parameters<BrowserContext['route']>[1];

/** Preserve handler identity for unroute while tracking the callback's actual lifetime. */
function trackRoutes(owner: BrowserContext | Page, pending: Set<Promise<unknown>>) {
  const route = owner.route.bind(owner);
  const unroute = owner.unroute.bind(owner);
  const handlers = new Map<Handler, Handler>();
  owner.route = async (url, handler, options) => {
    let tracked = handlers.get(handler);
    if (!tracked) {
      tracked = async (route, request) => {
        const serving = Promise.resolve().then(() => handler(route, request));
        pending.add(serving);
        try { await serving; }
        finally { pending.delete(serving); }
      };
      handlers.set(handler, tracked);
    }
    return await route(url, tracked, options);
  };
  owner.unroute = async (url, handler) => { await unroute(url, handler ? handlers.get(handler) ?? handler : undefined); };
}

/** Cancel outstanding Node HTTP reads, then drain every callback before its test ends. */
export async function stopJourneyRoutes(context: BrowserContext): Promise<void> {
  await context.close();
}

/** Own route lifetimes for fixture contexts and manually created second-device contexts. */
export function protectJourneyBrowser(browser: Browser): () => void {
  const original = browser.newContext;
  browser.newContext = async options => {
    const context = await original.call(browser, options);
    const pending = new Set<Promise<unknown>>();
    if (process.env.REZICS_JOURNEY_READ_DIAGNOSTICS === '1') {
      context.on('response', response => {
        if (!response.url().includes('/api/main/') || response.status() < 400
          && !/\/(sessions|edition-preferences|reader-status|work-states)(\/|\?)/.test(response.url())) return;
        const reading = (async () => {
          const body = await response.text().catch(() => 'body unavailable');
          console.log('JOURNEY_READ', response.request().method(), response.status(), response.url(), body.slice(0, 4096));
        })();
        pending.add(reading);
        void reading.finally(() => pending.delete(reading));
      });
      context.on('requestfailed', request => console.log('JOURNEY_TRANSPORT', request.url(), request.failure()));
    }
    trackRoutes(context, pending);
    context.on('page', page => trackRoutes(page, pending));
    const close = context.close.bind(context);
    let closing: Promise<void> | undefined;
    context.close = async closeOptions => {
      closing ??= (async () => {
        if (!context.isClosed()) {
          // Cancel route.fetch before closing its pages. Playwright's route wait
          // can hang on superseded navigations; drain our callbacks after close.
          await context.unrouteAll({ behavior: 'ignoreErrors' });
          await Promise.all(context.pages().map(page => page.unrouteAll({ behavior: 'ignoreErrors' })));
          await context.request.dispose({ reason: 'Journey context is closing' });
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
