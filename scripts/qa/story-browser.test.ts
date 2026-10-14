import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { serveStoryAsset } from './story-browser.ts';

test('real modules survive browser transport loss without masking server errors or rerouting APIs', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/') return new Response('<!doctype html><title>Story assets</title>', {
        headers: { 'content-type': 'text/html' },
      });
      if (path === '/broken.js') return new Response('transform failed', { status: 503 });
      return new Response('export const value = 42;', { headers: { 'content-type': 'text/javascript' } });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const origin = server.url.origin;
    await page.route('**/*', route => serveStoryAsset(route, origin));
    await page.goto(origin);
    const failedResponse = page.waitForResponse(`${origin}/broken.js`);
    expect(await page.evaluate(async () => {
      const path = '/broken.js';
      try { await import(path); return 'loaded'; }
      catch { return 'failed'; }
    })).toBe('failed');
    const response = await failedResponse;
    expect(response.status()).toBe(503);
    expect(await response.text()).toBe('transform failed');

    await page.context().setOffline(true);
    expect(await page.evaluate(async () => {
      const path = '/module.js';
      return (await import(path)).value;
    })).toBe(42);
    expect(await page.evaluate(async () => {
      try { await fetch('/api/read'); return 'loaded'; }
      catch { return 'failed'; }
    })).toBe('failed');
    expect(await page.evaluate(async () => {
      const path = '/api/module.js';
      try { await import(path); return 'loaded'; }
      catch { return 'failed'; }
    })).toBe('failed');
    // A failed real module response still fails its import while the browser transport is down.
    expect(await page.evaluate(async () => {
      const path = '/broken.js?offline';
      try { await import(path); return 'loaded'; }
      catch { return 'failed'; }
    })).toBe('failed');
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
