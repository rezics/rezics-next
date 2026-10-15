import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { protectJourneyBrowser } from './network-transport.ts';

test('journey contexts load real resources through transport loss and preserve API and server failures', async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === '/') return new Response('<title>Journey transport</title>', { headers: { 'content-type': 'text/html' } });
    if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/destination', 'set-cookie': 'journey=redirected; Path=/' } });
    if (path === '/destination') return new Response('<title>Destination</title>', { headers: { 'content-type': 'text/html' } });
    if (path === '/unavailable') return new Response('<title>Unavailable</title>', { status: 503, headers: { 'content-type': 'text/html' } });
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
      await page.goto(`${server.url.origin}/redirect`);
      expect(new URL(page.url()).pathname).toBe('/destination');
      expect((await page.context().cookies()).find(cookie => cookie.name === 'journey')?.value).toBe('redirected');
      await page.goto(server.url.origin);
      await page.context().setOffline(true);
      expect((await page.reload())?.status()).toBe(200);
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
      expect((await page.goto(`${server.url.origin}/unavailable`))?.status()).toBe(503);
      expect(await page.title()).toBe('Unavailable');
    }
    expect(requests.filter(request => request === 'GET /broken.js')).toHaveLength(2);
    expect(requests.some(request => request.includes('/api/') || request.startsWith('POST'))).toBe(false);
  } finally {
    restore();
    await browser.close();
    await server.stop(true);
  }
}, 30_000);

test('configured Playwright fixture survives navigation with pending resources and closes cleanly', async () => {
  const directory = resolve('.temp', `journey-transport-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const server = createServer(async (request, response) => {
    if (request.url === '/disconnected.js') {
      response.destroy();
      return;
    }
    if (request.url?.endsWith('.js')) {
      await Bun.sleep(200);
      response.setHeader('content-type', 'text/javascript');
      response.end('export const value = 42;');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<title>Journey</title><script type="module" src="/slow.js"></script>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback HTTP port');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    writeFileSync(`${directory}/playwright.config.ts`, `import config from '${resolve('apps/web/playwright.config.ts')}';\nexport default { ...config, testDir: '.', testMatch: 'transport.e2e.ts', tsconfig: '${resolve('apps/web/tests/support/tsconfig.playwright.json')}', reporter: 'list' };\n`);
    writeFileSync(`${directory}/transport.e2e.ts`, `import { test, expect } from '@playwright/test';
test('navigation and teardown', async ({ page, browser }) => {
  for (let index = 0; index < 8; index++) await page.goto('/?page=' + index, { waitUntil: 'commit' });
  await expect(page).toHaveTitle('Journey');
  const context = await browser.newContext();
  const other = await context.newPage();
  await other.goto('/', { waitUntil: 'commit' });
  await context.close();
});
test('a second fixture context uses the configured transport', async ({ page, context }) => {
  await page.goto('/');
  await context.setOffline(true);
  expect(await page.evaluate(async () => { const path = '/offline.js'; return (await import(path)).value; })).toBe(42);
  await page.reload();
  await expect(page).toHaveTitle('Journey');
});
test('a socket hang-up fails the resource inside its own test', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(async () => {
    try { const path = '/disconnected.js'; await import(path); return 'loaded'; } catch { return 'failed'; }
  })).toBe('failed');
  await page.goto('/after-failure');
  await expect(page).toHaveTitle('Journey');
});\n`);
    const child = Bun.spawn(['node', 'node_modules/.bin/playwright', 'test', '--config', `${directory}/playwright.config.ts`, '--timeout=10000'], {
      env: { ...process.env, REZICS_WEB_E2E_BASE_URL: origin, REZICS_E2E_GREP: '', REZICS_E2E_PROJECTS: 'desktop-chrome' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : '' }).toEqual({ code: 0, output: '' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
