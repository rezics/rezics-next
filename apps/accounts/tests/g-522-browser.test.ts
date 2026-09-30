import { test } from 'bun:test';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, type Browser } from '@playwright/test';
import { accountFixture, freePort } from '../../../services/account/tests/account-fixture.ts';
import { oauthFixture } from '../../../services/account/tests/oauth-fixture.ts';

/** Candidate Accounts and Account code, without mutating the shared backend or
 * starting an Aspire stack. One short-lived frontend serves all four variants. */
test('G522 browser: product sessions sign out and consented apps stay separate on phone/desktop in en/ko', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const artifacts = resolve(root, '.temp/g-522-browser');
  mkdirSync(artifacts, { recursive: true });
  const f = await accountFixture();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const log = openSync(resolve(artifacts, 'accounts.log'), 'w');
  const server = spawn('task', ['accounts:dev', '--', '--port', String(port)], {
    cwd: root, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, ACCOUNT_SERVICE_ORIGIN: f.baseURL, ACCOUNT_BASE_URL: f.baseURL },
  });
  closeSync(log);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    await expect.poll(async () => {
      try { return (await fetch(`${origin}/sign-in`)).ok; } catch { return false; }
    }, { timeout: 60_000 }).toBe(true);
    const oauth = await oauthFixture(f);
    const product = await oauth.createClient(true);
    const thirdParty = await oauth.createClient();
    await f.pool.query('UPDATE "oauthClient" SET name = $1 WHERE "clientId" = $2', ['REZICS', product.client_id]);
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [product.client_id]);
    for (const locale of ['en', 'ko'] as const) {
      for (const phone of [false, true]) {
        const suffix = `${locale}-${phone ? 'phone' : 'desktop'}`;
        const reader = await f.signup(`browser-${suffix}@example.test`);
        const productSession = await f.request('/api/auth/sign-in/email', { email: reader.email, password: reader.password },
          undefined, { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0' });
        const tokens = await oauth.issue(product.client_id, productSession.headers.get('set-cookie')!);
        await oauth.issue(thirdParty.client_id, reader.cookie);
        const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 860 } });
        try {
          await context.addCookies(reader.cookie.split(',').flatMap(value => {
            const [pair] = value.trim().split(';');
            const split = pair!.indexOf('=');
            return split < 1 ? [] : [{ name: pair!.slice(0, split), value: pair!.slice(split + 1), url: origin }];
          }));
          const page = await context.newPage();
          await page.goto(`${origin}/connected-apps?hl=${locale}`);
          await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
          await expect(page.getByRole('heading', { name: 'REZICS', exact: true })).toHaveCount(0);
          await page.screenshot({ path: resolve(artifacts, `apps-${suffix}.png`), fullPage: true });
          await page.goto(`${origin}/security/devices?hl=${locale}`);
          await expect(page.getByRole('heading', { name: locale === 'en' ? 'Devices and sessions' : '기기 및 세션', exact: true })).toBeVisible();
          const action = page.getByRole('button', { name: locale === 'en'
            ? 'Sign out · REZICS · Chrome on Linux' : '로그아웃 · Linux의 Chrome의 REZICS' });
          await expect(action).toBeVisible();
          await page.locator('html[data-hydrated]').waitFor();
          await page.screenshot({ path: resolve(artifacts, `sessions-${suffix}.png`), fullPage: true });
          await action.click();
          await expect(action).toHaveCount(0);
          const refreshed = await oauth.token({ grant_type: 'refresh_token', client_id: product.client_id,
            refresh_token: tokens.refresh_token, resource: f.config.resource });
          expect(refreshed.ok).toBe(false);
          await page.goto(`${origin}/connected-apps?hl=${locale}`);
          await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toBeVisible();
          const removed = await context.request.post(`${origin}/api/account/connected-apps/${thirdParty.client_id}/revoke`,
            { headers: { origin }, data: {} });
          expect(removed.ok()).toBe(true);
          await page.reload();
          await expect(page.getByRole('heading', { name: 'Notes', exact: true })).toHaveCount(0);
          await page.screenshot({ path: resolve(artifacts, `empty-${suffix}.png`), fullPage: true });
        } finally { await context.close(); }
      }
    }
    const context = await browser.newContext();
    try {
      await context.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin },
        data: { email: oauth.owner.email, password: oauth.owner.password } });
      const page = await context.newPage();
      await page.goto(`${origin}/admin/clients`);
      const productRow = page.getByRole('row').filter({ hasText: product.client_id });
      const notesRow = page.getByRole('row').filter({ hasText: thirdParty.client_id });
      await expect(productRow.getByText('First-party', { exact: true })).toBeVisible();
      await expect(notesRow.getByText('First-party', { exact: true })).toHaveCount(0);
      await page.screenshot({ path: resolve(artifacts, 'admin-clients.png'), fullPage: true });
    } finally { await context.close(); }
  } finally {
    await browser?.close();
    if (server.pid && server.exitCode === null) process.kill(-server.pid, 'SIGTERM');
    await f.close();
  }
}, 240_000);
