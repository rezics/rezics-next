import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { protectJourneyBrowser } from './network-transport.ts';

test('journey contexts load real resources through transport loss and preserve API and server failures', async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === '/') return new Response('<title>Journey transport</title>', { headers: { 'content-type': 'text/html' } });
    if (path === '/redirect.js') return new Response(null, { status: 302, headers: { location: '/module.js' } });
    if (path === '/broken.js') return new Response('transform failed', { status: 503 });
    return new Response('export const value = 42;', { headers: { 'content-type': 'text/javascript' } });
  } });
  const browser = await chromium.launch();
  const restore = protectJourneyBrowser(browser, server.url.origin);
  try {
    // Both the default-page path and journeys' manually created second contexts are covered.
    const first = await browser.newPage();
    const second = await browser.newContext();
    for (const page of [first, await second.newPage()]) {
      await page.context().setOffline(true);
      await page.goto(server.url.origin);
      expect(await page.title()).toBe('Journey transport');
      expect(await page.evaluate(async () => { const path = '/redirect.js'; return (await import(path)).value; })).toBe(42);
      const failed = page.waitForResponse(`${server.url.origin}/broken.js`);
      expect(await page.evaluate(async () => {
        try { const path = '/broken.js'; await import(path); return 'loaded'; } catch { return 'failed'; }
      })).toBe('failed');
      const response = await failed;
      expect(response.status()).toBe(503);
      expect(await response.text()).toBe('transform failed');
      for (const [path, method] of [['/api/read', 'GET'], ['/api/write', 'POST'], ['/module.js', 'POST']]) {
        expect(await page.evaluate(async ({ path, method }) => {
          try { await fetch(path!, { method }); return 'loaded'; } catch { return 'failed'; }
        }, { path, method })).toBe('failed');
      }
    }
    expect(requests.filter(request => request === 'GET /broken.js')).toHaveLength(2);
    expect(requests.some(request => request.includes('/api/') || request.startsWith('POST'))).toBe(false);
  } finally {
    restore();
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
