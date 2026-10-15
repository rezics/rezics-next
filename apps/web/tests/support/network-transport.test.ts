import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { protectJourneyBrowser } from './network-transport.ts';

test('online API commands survive Chrome network loss with their exact body and key, without transport replay', async () => {
  const requests: { path: string; body: string; key: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Journey transport</title>');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url!, body, key: request.headers['idempotency-key'] as string | undefined });
    if (request.url === '/api/reset') { request.socket.destroy(); return; }
    response.writeHead(request.url === '/api/refused' ? 503 : 201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ body, key: request.headers['idempotency-key'], cookie: request.headers.cookie }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const restore = protectJourneyBrowser(browser, origin);
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.context().addCookies([{ name: 'test-session', value: 'same-person', url: origin }]);
    const cdp = await page.context().newCDPSession(page);
    // Model a Chrome network-service outage, independently of a journey's explicit offline setting.
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const answer = await page.evaluate(async () => {
      const response = await fetch('/api/write', { method: 'PUT', body: 'exact-body', headers: { 'idempotency-key': 'exact-key' } });
      return { status: response.status, value: await response.json() };
    });
    expect(answer).toEqual({ status: 201, value: { body: 'exact-body', key: 'exact-key', cookie: 'test-session=same-person' } });
    expect(await page.evaluate(async () => (await fetch('/api/refused')).status)).toBe(503);
    expect(await page.evaluate(async () => {
      try { await fetch('/api/reset', { method: 'POST', body: 'once' }); return 'loaded'; }
      catch { return 'failed'; }
    })).toBe('failed');
    expect(requests).toEqual([{ path: '/api/write', body: 'exact-body', key: 'exact-key' },
      { path: '/api/refused', body: '', key: undefined }, { path: '/api/reset', body: 'once', key: undefined }]);
  } finally {
    restore();
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 30_000);

test('a static GET survives a socket reset before the server sends its response', async () => {
  let attempts = 0;
  const server = createServer((request, response) => {
    if (request.url === '/reset.js') {
      if (++attempts === 1) { request.socket.destroy(); return; }
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('export const value = 42;');
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Journey transport</title>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const restore = protectJourneyBrowser(browser, origin);
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    expect(await page.evaluate(async () => { const path = '/reset.js'; return (await import(path)).value; })).toBe(42);
    expect(attempts).toBe(2);
  } finally {
    restore();
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 30_000);

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
      await page.goto(server.url.origin);
      await page.context().setOffline(true);
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

test('configured Playwright fixture survives navigation with pending resources and closes cleanly', async () => {
  const directory = resolve('.temp', `journey-transport-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith('.js')) {
      await Bun.sleep(200);
      return new Response('export const value = 42;', { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response('<title>Journey</title><script type="module" src="/slow.js"></script>', { headers: { 'content-type': 'text/html' } });
  } });
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
});\n`);
    const child = Bun.spawn(['node', 'node_modules/.bin/playwright', 'test', '--config', `${directory}/playwright.config.ts`], {
      env: { ...process.env, REZICS_WEB_E2E_BASE_URL: server.url.origin, REZICS_E2E_GREP: '', REZICS_E2E_PROJECTS: 'desktop-chrome' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : '' }).toEqual({ code: 0, output: '' });
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
