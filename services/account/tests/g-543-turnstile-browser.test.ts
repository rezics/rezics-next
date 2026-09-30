import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
import { accountFixture, freePort } from './account-fixture.ts';

test('G-543: offline enrollment works at localhost and permits direct admin setup', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const evidence = join(root, '.temp', 'g-543-browser');
  mkdirSync(evidence, { recursive: true });
  const f = await accountFixture({ turnstileMode: 'local' });
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const log = openSync(join(evidence, 'accounts.log'), 'w');
  const frontend = spawn('task', ['accounts:dev', '--', '--port', String(port)], {
    cwd: root, detached: true, stdio: ['ignore', log, log], env: { ...process.env,
      NODE_ENV: 'development', ACCOUNT_SERVICE_ORIGIN: f.baseURL, ACCOUNT_BASE_URL: f.baseURL,
      ACCOUNT_TURNSTILE_MODE: 'local', ACCOUNT_TURNSTILE_SITE_KEY: '',
      WRANGLER_REGISTRY_PATH: join(evidence, 'wrangler-registry'),
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (frontend.exitCode !== null) throw new Error(readFileSync(join(evidence, 'accounts.log'), 'utf8'));
      try { ready = (await fetch(`${origin}/sign-up`)).ok; } catch { /* compiling */ }
      if (ready) break;
      await Bun.sleep(500);
    }
    expect(ready).toBe(true);
    await page.goto(`${origin}/sign-up`);
    await page.getByRole('heading', { name: 'Create your REZICS Account' }).waitFor();
    const missing = await page.evaluate(async () => {
      const response = await fetch('/api/auth/sign-up/email', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No token',
          email: 'missing-browser@example.test', password: 'a long secure password' }) });
      return response.status;
    });
    expect(missing).toBe(200);
    expect((await f.pool.query('SELECT id FROM "user"')).rowCount).toBe(1);
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value,
      undefined, { timeout: 60_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.screenshot({ path: join(evidence, 'signup-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidence, 'signup-phone.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth
      && !!document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value);
    await page.screenshot({ path: join(evidence, 'signup-narrow-phone.png'), fullPage: true });
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('G543 Browser');
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('enrolled-browser@example.test');
    await page.getByLabel('Password', { exact: true }).fill('a long secure password');
    await page.getByLabel('Confirm', { exact: true }).fill('a long secure password');
    await page.waitForFunction(() => !!document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value
      && !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled);
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/sign-up/email')
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const enrolled = await responsePromise;
    expect(enrolled.status()).toBe(200);
    expect(enrolled.request().headers()['x-captcha-response']).toBeTruthy();
    await page.getByRole('heading', { name: 'Check your email' }).waitFor();
    expect((await f.pool.query('SELECT id FROM "user"')).rowCount).toBe(2);
    await page.screenshot({ path: join(evidence, 'signup-confirmation.png'), fullPage: true });
    expect(errors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: join(evidence, 'signup-failure.png'), fullPage: true });
    console.error(await page.locator('body').innerText(), errors);
    throw error;
  } finally {
    await browser.close();
    if (frontend.pid) {
      try { process.kill(-frontend.pid, 'SIGTERM'); } catch { /* exited */ }
      await new Promise<void>(resolveExit => {
        if (frontend.exitCode !== null || frontend.signalCode !== null) resolveExit();
        else frontend.once('exit', () => resolveExit());
      });
    }
    closeSync(log);
    await f.close();
  }
}, 180_000);
