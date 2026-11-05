/** Native browser acceptance, invoked only after the allocated walk stack is ready. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { origins, root } from '../scripts/dev-stack.ts';

export async function verifyFreshCheckoutSignIn(): Promise<void> {
  // Repeat the same setup against the existing migrated stack, as dev:infra did twice.
  const bindings = await Bun.file(resolve(root, 'apps/web/.dev.vars')).text();
  const setup = Bun.spawn([process.execPath, 'services/auth/scripts/dev-stack.ts', 'setup'], {
    cwd: root,
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  assert.equal(await setup.exited, 0);
  assert.equal(await Bun.file(resolve(root, 'apps/web/.dev.vars')).text(), bindings);
  const require = createRequire(resolve(root, 'apps/web/package.json'));
  const { web, issuer, native, kernel } = origins;
  const suffix = randomUUID();
  const { chromium } = require('playwright');
  const { expect: browserExpect } = require('playwright/test');
  const instance = await chromium.launch({ headless: true });

  try {
    const page = await instance.newPage({ locale: 'en-US' });
    await page.route(
      '**/*',
      (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
        const url = new URL(route.request().url());
        return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)
          ? route.continue()
          : route.abort();
      },
    );
    for (const url of [`${issuer}/.well-known/openid-configuration`, `${kernel}/health`, `${web}/`]) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
    }
    await page.goto(`${web}/`);
    await page.locator('a[href^="/auth/sign-in"]').first().click();
    await page.waitForURL('**/login?**');
    await page.locator('a[href^="/signup"]').click();
    const handle = `local_${suffix.replaceAll('-', '').slice(0, 12)}`;
    const email = `${handle}@example.test`;
    const password = 'local stack password 123';
    await page.locator('input[name="handle"]').fill(handle);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form[action="/signup"] button[type="submit"]').click();
    await page.locator('.auth-signup-links a[href^="/login"]').click();
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(`${web}/**`);
    assert.equal(
      (await page.context().cookies()).some((cookie: { name: string }) => cookie.name === '__Host-rezics_session'),
      true,
    );
    await page.locator('#account-menu-button').click();
    await page.locator('form[action="/auth/sign-out"] button[type="submit"]').click();
    await page.waitForURL(`${web}/**`);
    await browserExpect(page.locator('a[href^="/auth/sign-in"]').first()).toBeVisible();
    assert.equal(
      (await page.context().cookies()).some((cookie: { name: string }) => cookie.name === '__Host-rezics_session'),
      false,
    );
    const discovery = await fetch(`${native}/.well-known/openid-configuration`);
    assert.equal(((await discovery.json()) as { issuer: string }).issuer, issuer);
  } finally {
    await instance.close();
  }
}

if (import.meta.main) await verifyFreshCheckoutSignIn();
