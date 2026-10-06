import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Route } from '@playwright/test';
import { accountFixture, freePort } from '../../../services/account/tests/account-fixture.ts';
import { registerRecoveryPasskey } from '../../../services/account/tests/recovery-fixture.ts';

test('Accounts recovery: request, guardian approval, passwordless rebind, lost-response retry and fresh sign-in at phone and desktop widths', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  let server: ChildProcess | undefined;
  let releaseHydration = () => {};
  const root = resolve(import.meta.dir, '../../..');
  const artifacts = resolve(root, '.temp/recovery-ui');
  mkdirSync(artifacts, { recursive: true });
  try {
    const owner = await f.signup('recovery-owner@example.test');
    const guardian = await f.signup('recovery-guardian@example.test');
    const code = randomBytes(32).toString('base64url');
    expect(
      (
        await f.request(
          '/api/account/recovery-policy',
          { guardianEmail: guardian.email, recoveryCode: code, currentPassword: owner.password },
          owner.cookie,
        )
      ).status,
    ).toBe(200);
    const oldPasskey = await registerRecoveryPasskey(f, owner, await browser.newPage());
    expect((await f.request('/api/account/methods/password/remove', {}, owner.cookie)).status).toBe(
      200,
    );

    const port = await freePort();
    const origin = `http://localhost:${port}`;
    const log = openSync(resolve(artifacts, 'accounts.log'), 'w');
    server = spawn('task', ['accounts:dev', '--', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        ACCOUNT_SERVICE_ORIGIN: f.baseURL,
        ACCOUNT_BASE_URL: f.baseURL,
        ACCOUNT_TURNSTILE_MODE: 'local',
      },
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    const until = Date.now() + 90_000;
    let ready = false;
    while (Date.now() < until && !ready) {
      ready = await fetch(`${origin}/forgot-password`)
        .then((response) => response.ok)
        .catch(() => false);
      if (!ready) await Bun.sleep(500);
    }
    expect(ready).toBe(true);
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/forgot-password`);
    await page.locator('html[data-hydrated]').waitFor();
    let heldScripts = 0;
    const hydration = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const holdScripts = async (route: Route) => {
      if (route.request().resourceType() === 'script') {
        heldScripts++;
        await hydration;
      }
      await route.continue();
    };
    await page.route('**/*', holdScripts);
    await page
      .getByRole('link', { name: 'Lost your sign-in methods? Use a recovery code' })
      .click({ noWaitAfter: true });
    await page.getByLabel('Email', { exact: true }).fill(owner.email);
    await page.getByLabel('Recovery code', { exact: true }).fill(code);
    expect(heldScripts).toBeGreaterThan(0);
    expect(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled()).toBe(true);
    releaseHydration();
    await page.locator('html[data-hydrated]').waitFor();
    expect(await page.getByLabel('Recovery code', { exact: true }).inputValue()).toBe(code);
    await page.unroute('**/*', holdScripts);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('Waiting for your recovery guardian’s approval.').waitFor();
    const href = await page.locator('a[href^="/recover-account/approve?"]').getAttribute('href');
    const claimId = new URL(href!, origin).searchParams.get('claimId')!;
    expect(page.url()).not.toContain(code);

    const guardianContext = await browser.newContext();
    const token = /better-auth\.session_token=([^;]+)/.exec(guardian.cookie)![1];
    await guardianContext.addCookies([
      { name: 'better-auth.session_token', value: token, domain: 'localhost', path: '/' },
    ]);
    const approval = await guardianContext.newPage();
    await approval.goto(new URL(href!, origin).toString());
    await approval.locator('html[data-hydrated]').waitFor();
    await approval.getByRole('button', { name: 'Approve recovery', exact: true }).click();
    await approval
      .getByRole('heading', { name: 'Recovery request approved', exact: true })
      .waitFor();
    await guardianContext.close();
    await f.pool.query(
      "UPDATE rezics_account_recovery_claim SET not_before = now() - interval '1 second' WHERE id = $1",
      [claimId],
    );
    await page.getByRole('button', { name: 'Check recovery status' }).click();
    await page.getByLabel('Password', { exact: true }).waitFor();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(artifacts, `rebind-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    const password = 'new independently bound owner password';
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm', { exact: true }).fill(password);
    const attempts: unknown[] = [];
    await page.route('**/api/account/recovery-claims/*/activation', async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        expect((await route.fetch()).status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Recover account', exact: true }).click();
    await page
      .getByText('Retry with the same password to check whether recovery completed.')
      .waitFor();
    await page.getByRole('button', { name: 'Recover account', exact: true }).click();
    await page.getByRole('heading', { name: 'Your account is recovered', exact: true }).waitFor();
    expect(attempts).toEqual([
      { recoveryCode: code, newPassword: password },
      { recoveryCode: code, newPassword: password },
    ]);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(artifacts, `completed-${width}.png`), fullPage: true });
    }
    expect((await oldPasskey()).ok).toBe(false);
    expect(
      await (await f.request('/api/auth/get-session', undefined, owner.cookie)).json(),
    ).toBeNull();
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.locator('html[data-hydrated]').waitFor();
    await page.getByLabel('Email', { exact: true }).fill(owner.email);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByLabel('Enter your password').fill(password);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.waitForURL(`${origin}/security`);
    await page
      .getByRole('heading', { level: 1, name: 'Security & sign-in', exact: true })
      .waitFor();
    expect(
      (
        await f.pool.query('SELECT generation FROM rezics_account_recovery_policy WHERE id = $1', [
          owner.id,
        ])
      ).rows[0].generation,
    ).toBe('1');
    expect(errors).toEqual([]);
    const newCode = randomBytes(32).toString('base64url');
    const newId = randomUUID();
    const current = await f.request('/api/auth/sign-in/email', { email: owner.email, password });
    expect(
      (
        await f.request(
          '/api/account/recovery-policy',
          { guardianEmail: guardian.email, recoveryCode: newCode, currentPassword: password },
          current.headers.get('set-cookie')!,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request('/api/account/recovery-claims', {
          claimId: newId,
          targetEmail: owner.email,
          recoveryCode: newCode,
        })
      ).status,
    ).toBe(200);
    await f.pool.query(
      "UPDATE rezics_account_recovery_claim SET not_before = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1",
      [newId],
    );
    await page.goto(`${origin}/recover-account?claimId=${newId}`);
    await page.locator('html[data-hydrated]').waitFor();
    await page.getByLabel('Recovery code', { exact: true }).fill(newCode);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page
      .getByRole('heading', { name: 'This recovery request expired', exact: true })
      .waitFor();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(artifacts, 'expired-390.png'), fullPage: true });
    await page.getByRole('button', { name: 'Start a new recovery request', exact: true }).click();
    expect(await page.getByLabel('Recovery code', { exact: true }).inputValue()).toBe(newCode);
    await context.close();
  } finally {
    releaseHydration();
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* already stopped */
      }
      if (server.exitCode === null)
        await new Promise<void>((done) => server!.once('exit', () => done()));
    }
    await browser.close();
    await f.close();
  }
}, 180_000);
