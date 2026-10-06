import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { accountFixture, freePort } from '../../../services/account/tests/account-fixture.ts';

test('Accounts guardians: invite, save, accept, renew, withdraw and deletion guidance in a real browser at phone and desktop widths', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const artifacts = resolve(root, '.temp/guardian-browser');
  mkdirSync(artifacts, { recursive: true });
  const f = await accountFixture({ accessDeletionFence: async () => {} }, 'localhost');
  const browser = await chromium.launch({ headless: true });
  let server: ChildProcess | undefined;
  try {
    const owner = await f.signup('browser-owner@example.test');
    const guardian = await f.signup('browser-guardian@example.test');
    const port = await freePort();
    const origin = `http://localhost:${port}`;
    const log = openSync(resolve(artifacts, 'accounts.log'), 'w');
    server = spawn('task', ['accounts:dev', '--', '--port', String(port)], {
      cwd: root,
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ACCOUNT_SERVICE_ORIGIN: f.baseURL,
        ACCOUNT_BASE_URL: f.baseURL,
        ACCOUNT_TURNSTILE_MODE: 'local',
        ACCOUNT_TURNSTILE_SITE_KEY: '',
      },
    });
    closeSync(log);
    const deadline = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (server.exitCode !== null)
        throw new Error(readFileSync(resolve(artifacts, 'accounts.log'), 'utf8'));
      ready = await fetch(`${origin}/sign-in`)
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) break;
      await Bun.sleep(500);
    }
    expect(ready).toBe(true);
    const contextFor = async (cookie: string) => {
      const context = await browser.newContext({
        reducedMotion: 'reduce',
        viewport: { width: 1280, height: 900 },
      });
      await context.addCookies([
        {
          name: 'better-auth.session_token',
          value: /better-auth\.session_token=([^;]+)/.exec(cookie)![1],
          domain: 'localhost',
          path: '/',
        },
      ]);
      return context;
    };
    const ownerContext = await contextFor(owner.cookie);
    const guardianContext = await contextFor(guardian.cookie);
    const ownerPage = await ownerContext.newPage();
    const guardianPage = await guardianContext.newPage();
    const errors: string[] = [];
    for (const page of [ownerPage, guardianPage])
      page.on('pageerror', (error) => errors.push(error.message));
    const capture = async (page: Page, name: string) => {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(150);
        await page.screenshot({ path: resolve(artifacts, `${name}-${width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    };
    await ownerPage.goto(`${origin}/security`);
    await ownerPage.locator('html[data-hydrated]').waitFor();
    await ownerPage.getByRole('link', { name: /Your recovery guardian/ }).click();
    await ownerPage
      .getByRole('heading', { level: 1, name: 'Account recovery', exact: true })
      .waitFor();
    await ownerPage.locator('html[data-hydrated]').waitFor();
    await ownerPage.getByLabel('Guardian email').fill(guardian.email);
    await ownerPage.getByLabel('Current password').fill(owner.password);
    const attempts: Record<string, string>[] = [];
    await ownerPage.route('**/api/account/recovery-policy', async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await ownerPage.getByRole('button', { name: 'Create a code and invite a guardian' }).click();
    await ownerPage
      .getByText('We could not confirm whether setup completed. Keep this code and retry.')
      .waitFor();
    await ownerPage.getByRole('button', { name: 'Retry setup' }).click();
    await ownerPage.getByRole('checkbox', { name: 'I saved this recovery code' }).waitFor();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    const recoveryCode = await ownerPage
      .getByRole('textbox', { name: 'Your new recovery code', exact: true })
      .inputValue();
    expect(recoveryCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ownerPage.url()).not.toContain(recoveryCode);
    await capture(ownerPage, 'save-code');
    expect(await ownerPage.getByRole('button', { name: 'Done', exact: true }).isDisabled()).toBe(
      true,
    );
    await ownerPage.getByRole('checkbox', { name: 'I saved this recovery code' }).check();
    await ownerPage.getByRole('button', { name: 'Done', exact: true }).click();
    await ownerPage.getByText('Waiting for acceptance', { exact: true }).waitFor();
    const read = await f.request('/api/account/recovery-policy/read', {}, owner.cookie);
    const invitationId = (await read.json()).policy.invitationId as string;
    await f.email.drain();
    expect(
      f.messages.some((mail) => mail.to === guardian.email && mail.text.includes(invitationId)),
    ).toBe(true);
    await guardianPage.goto(`${origin}/security/recovery?invitationId=${invitationId}`);
    await guardianPage.locator('html[data-hydrated]').waitFor();
    await guardianPage.getByRole('button', { name: 'Accept invitation', exact: true }).waitFor();
    await capture(guardianPage, 'pending-invitation');
    await guardianPage.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await guardianPage.getByText('Invitation accepted.', { exact: true }).waitFor();
    await capture(guardianPage, 'accepted-guardian');
    await guardianPage.goto(`${origin}/data-privacy/delete-account`);
    await guardianPage.getByRole('link', { name: 'Manage guardianships', exact: true }).waitFor();
    expect(
      await guardianPage.getByRole('button', { name: 'Delete account', exact: true }).isDisabled(),
    ).toBe(true);
    await capture(guardianPage, 'deletion-duty');
    await ownerPage.reload();
    await ownerPage.locator('html[data-hydrated]').waitFor();
    await ownerPage.getByText('Guardian accepted', { exact: true }).waitFor();
    await ownerPage.getByLabel('Current recovery code').fill(recoveryCode);
    await ownerPage.getByLabel('Current password').fill(owner.password);
    await ownerPage.getByRole('button', { name: 'Renew recovery code', exact: true }).click();
    await ownerPage.getByRole('textbox', { name: 'Your new recovery code', exact: true }).waitFor();
    const renewed = await ownerPage
      .getByRole('textbox', { name: 'Your new recovery code', exact: true })
      .inputValue();
    expect(renewed).not.toBe(recoveryCode);
    expect(
      (
        await f.request('/api/account/recovery-claims', {
          claimId: crypto.randomUUID(),
          targetEmail: owner.email,
          recoveryCode,
        })
      ).status,
    ).toBe(403);
    const claimId = crypto.randomUUID();
    expect(
      (
        await f.request('/api/account/recovery-claims', {
          claimId,
          targetEmail: owner.email,
          recoveryCode: renewed,
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.request(`/api/account/recovery-claims/${claimId}/approval`, {}, guardian.cookie))
        .status,
    ).toBe(200);
    await guardianPage.getByRole('link', { name: 'Manage guardianships', exact: true }).click();
    await guardianPage.locator('html[data-hydrated]').waitFor();
    await guardianPage.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await guardianPage
      .getByText('You withdrew. The current recovery code and your approvals are no longer usable.')
      .waitFor();
    await capture(guardianPage, 'withdrawn');
    expect(
      (await f.request(`/api/account/recovery-claims/${claimId}/approval`, {}, guardian.cookie))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request(`/api/account/recovery-claims/${claimId}/activation`, {
          recoveryCode: renewed,
          newPassword: 'new recovered browser password',
        })
      ).ok,
    ).toBe(false);
    await ownerPage.reload();
    await ownerPage.getByText('Guardian withdrew', { exact: true }).waitFor();
    await capture(ownerPage, 'owner-withdrawn');
    await guardianPage.goto(`${origin}/data-privacy/delete-account`);
    await guardianPage.locator('html[data-hydrated]').waitFor();
    expect(
      await guardianPage.getByRole('button', { name: 'Delete account', exact: true }).isDisabled(),
    ).toBe(false);
    expect(
      await guardianPage.getByRole('link', { name: 'Manage guardianships', exact: true }).count(),
    ).toBe(0);
    expect(errors).toEqual([]);
    await ownerContext.close();
    await guardianContext.close();
  } finally {
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* stopped */
      }
      if (server.exitCode === null && server.signalCode === null)
        await new Promise<void>((done) => server!.once('exit', () => done()));
    }
    await browser.close();
    await f.close();
  }
}, 240_000);
