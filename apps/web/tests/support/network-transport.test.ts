import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { protectJourneyBrowser } from './network-transport.ts';

test('API commands retain their exact body and key without replaying a reset or refusal', async () => {
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
  const restore = protectJourneyBrowser(browser);
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.context().addCookies([{ name: 'test-session', value: 'same-person', url: origin }]);
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

test('closing a journey cancels and drains page and context route reads before returning', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response('<title>Journey</title>', { headers: { 'content-type': 'text/html' } });
  } });
  const browser = await chromium.launch();
  const restore = protectJourneyBrowser(browser);
  try {
    for (const scope of ['context', 'page']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      let entered!: () => void;
      const started = new Promise<void>(done => { entered = done; });
      let finished = false;
      const owner = scope === 'context' ? context : page;
      const registration = await owner.route('**/*', route => route.abort());
      await registration.dispose();
      await page.goto(server.url.origin);
      expect(await page.title()).toBe('Journey');
      await owner.route('**/*', async route => {
        entered();
        try { await route.fetch(); }
        finally { await new Promise(done => setTimeout(done, 100)); finished = true; }
      });
      const navigation = page.goto(server.url.origin).catch(() => {});
      await started;
      await context.close();
      expect(finished).toBe(true);
      await navigation;
    }
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
  expect(await page.evaluate(async () => {
    try { const path = '/offline.js'; await import(path); return 'loaded'; } catch { return 'offline'; }
  })).toBe('offline');
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
