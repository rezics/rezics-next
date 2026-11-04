import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { securityEnvelope } from '../tests/security-page-fixture';

// Presentation acceptance through the actual page/BFF and existing native HTTP DTOs.
// This fixture does not claim native credential/floor or revocation-writer proof.
const account = 'security-owner';
const created_at = '2026-10-30T09:00:00Z';
const current = {
  id: 'current',
  client_id: 'login',
  current: true,
  user_agent: null,
  created_at,
  expires_at: '2030-11-06T09:00:00Z',
};
const other = { ...current, id: 'other', current: false, client_id: 'rezics-website' };
const passkey = { id: 'key', name: 'Security key', created_at, last_used_at: null };
let sessions = [current, other];
let passkeys = [passkey];
let actor = account;
let signedOut = false;
let unavailable = false;
let denied = false;
let mode: 'lost-applied' | 'lost-unchanged' | 'accepted' | 'last' = 'lost-applied';
const writes: { path: string; body: unknown; cookie: string | null; origin: string | null }[] = [];
const native = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'GET') {
      if (signedOut) return json({ error: 'authentication_denied' }, 401);
      if (denied) return json({ error: 'authentication_denied' }, 403);
      if (path === '/session') return json({ account_id: actor });
      if (unavailable) return json({ error: 'unavailable' }, 503);
      if (path === '/security-page') return json(securityEnvelope(actor, sessions, passkeys));
      if (path === '/sessions') return json({ sessions });
      if (path === '/passkeys') return json({ passkeys });
    }
    if (request.method === 'POST' && ['/sessions/revoke', '/passkeys/remove'].includes(path)) {
      const body = (await request.json()) as { id?: string; session_id?: string };
      writes.push({ path, body, cookie: request.headers.get('cookie'), origin: request.headers.get('origin') });
      if (denied) return json({ error: 'authentication_denied' }, 403);
      if (mode === 'last') return json({ error: 'credential_effect_denied', effect_status: 'not_applied' }, 409);
      if (mode !== 'lost-unchanged') {
        if (path === '/sessions/revoke') sessions = sessions.filter((row) => row.id !== body.session_id);
        else {
          passkeys = passkeys.filter((row) => row.id !== body.id);
          signedOut = true;
        }
      }
      if (mode !== 'accepted') return json({ error: 'unavailable' }, 503);
      return json(path === '/sessions/revoke' ? {} : { success: true });
    }
    if (path === '/clients') return json({ clients: [], next: null });
    if (path === '/consents') return json({ consents: [], next: null });
    return json({ error: 'not_found' }, 404);
  },
});
let child: ChildProcess | undefined;
let browser: Browser;
let origin: string;
beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as { port: number };
      probe.close(() => resolve(address.port));
    });
  });
  origin = `http://127.0.0.1:${port}`;
  let output = '';
  child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: join(import.meta.dir, '..'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AUTH_ORIGIN: native.url.origin },
  });
  child.stdout!.on('data', (data) => {
    output = (output + data).slice(-8000);
  });
  child.stderr!.on('data', (data) => {
    output = (output + data).slice(-8000);
  });
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Auth page exited: ${output}`);
    try {
      if ((await fetch(`${origin}/security`)).status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Auth page did not start: ${output}`);
    await Bun.sleep(500);
  }
  browser = await chromium.launch();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  native.stop(true);
  if (child?.pid) process.kill(-child.pid, 'SIGTERM');
});
async function open() {
  actor = account;
  signedOut = false;
  unavailable = false;
  denied = false;
  sessions = [current, other];
  passkeys = [passkey];
  mode = 'lost-applied';
  writes.length = 0;
  const context = await browser.newContext({ locale: 'en' });
  await context.addCookies([{ name: 'auth_session', value: 'opaque-session', url: origin, httpOnly: true }]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${origin}/security`);
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor();
  return page;
}
async function confirm(page: Page, accept = true) {
  await page.getByRole('button', { name: 'Sign out Unknown device', exact: true }).last().click();
  await decide(page, accept);
}
async function decide(page: Page, accept = true, passkey = false) {
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', {
      name: accept ? (passkey ? 'Confirm passkey removal' : 'Confirm session sign-out') : 'Cancel',
      exact: true,
    })
    .click();
}
const check = (page: Page) => page.getByRole('button', { name: 'Check current security settings', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Try this action again', exact: true });

test('Recover uncertain credential and session actions with current native readback preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  const page = await open();
  try {
    await confirm(page, false);
    expect(writes).toHaveLength(0);
    await confirm(page);
    await check(page).waitFor();
    expect(writes.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: '/sessions/revoke', body: { session_id: 'other' } },
    ]);
    expect(writes[0]!.cookie).toContain('auth_session=opaque-session');
    expect(writes[0]!.origin).toBe(origin);
    expect(await page.getByRole('button', { name: 'Sign out Unknown device', exact: true }).count()).toBe(2);
    expect(await retry(page).count()).toBe(0);
    unavailable = true;
    await check(page).click();
    await page.getByText('Current security settings could not be verified.', { exact: false }).waitFor();
    expect(await retry(page).count()).toBe(0);
    unavailable = false;
    await check(page).click();
    await page
      .getByText(
        'This session is absent from the complete current inventory. This does not establish what the earlier command did.',
        { exact: true },
      )
      .waitFor();
    expect(await page.getByRole('button', { name: 'Sign out Unknown device', exact: true }).count()).toBe(1);
    expect(writes).toHaveLength(1);
  } finally {
    await page.context().close();
  }
}, 180_000);

test('unchanged readback allows only an explicitly confirmed exact-target retry; acknowledgement refreshes native advice', async () => {
  const page = await open();
  try {
    mode = 'lost-unchanged';
    await confirm(page);
    await check(page).click();
    await retry(page).waitFor();
    await retry(page).click();
    await decide(page, false);
    expect(writes).toHaveLength(1);
    mode = 'accepted';
    await retry(page).click();
    await decide(page);
    await page
      .getByText(
        'This session is absent from the complete current inventory. This does not establish what the earlier command did.',
        { exact: true },
      )
      .waitFor();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual({ session_id: 'other' });
    expect(await page.getByRole('button', { name: 'Sign out Unknown device', exact: true }).count()).toBe(1);
    expect(await retry(page).count()).toBe(0);
  } finally {
    await page.context().close();
  }
}, 180_000);

test('current account switch and denied readback clear private data without dispatching or claiming success', async () => {
  const page = await open();
  try {
    actor = 'different-owner';
    await confirm(page);
    await page.getByText('Your account or security authority changed.', { exact: false }).waitFor();
    expect(writes).toHaveLength(0);
    expect(await page.getByRole('heading', { name: 'Sessions', exact: true }).count()).toBe(0);
    await page.reload();
    await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor();
    await confirm(page);
    await check(page).waitFor();
    denied = true;
    await check(page).click();
    await page.getByText('Your account or security authority changed.', { exact: false }).waitFor();
    expect(await page.getByLabel('New password', { exact: true }).count()).toBe(0);
  } finally {
    await page.context().close();
  }
}, 180_000);

test('lost passkey removal and current-session loss require sign-in without inventing removal success', async () => {
  const page = await open();
  try {
    await page.getByRole('button', { name: 'Remove passkey Security key', exact: true }).click();
    await decide(page, true, true);
    await check(page).waitFor();
    await check(page).click();
    await page.getByText('The action result has not been verified.', { exact: false }).waitFor();
    expect(await page.getByText('Security key', { exact: true }).count()).toBe(0);
    expect(await page.getByLabel('New password', { exact: true }).count()).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ id: 'key' });
    expect(await page.getByRole('link', { name: 'Sign in', exact: true }).count()).toBe(1);
  } finally {
    await page.context().close();
  }
}, 180_000);

test('actual browser BFF waiting is finite and a late acknowledgement cannot repeat or overwrite recovery', async () => {
  const page = await open();
  const release = Promise.withResolvers<void>();
  try {
    mode = 'accepted';
    let requests = 0;
    await page.route('**/_serverFn/**', async (route) => {
      requests++;
      // The native writer completes while browser delivery remains withheld.
      const response = await route.fetch();
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await confirm(page);
    await page.getByText('The session sign-out result is unknown.', { exact: false }).waitFor();
    expect(requests).toBe(1);
    expect(writes.map(({ body }) => body)).toEqual([{ session_id: 'other' }]);
    await page.unroute('**/_serverFn/**');
    const readRelease = Promise.withResolvers<void>();
    await page.route('**/_serverFn/**', async (route) => {
      const response = await route.fetch();
      await readRelease.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await check(page).click();
    await page.getByText('Current security settings could not be verified.', { exact: false }).waitFor();
    expect(await retry(page).count()).toBe(0);
    release.resolve();
    readRelease.resolve();
    await page.unroute('**/_serverFn/**');
    await check(page).click();
    await page.getByText('This session is absent from the complete current inventory.', { exact: false }).waitFor();
    expect(writes).toHaveLength(1);
    expect(await retry(page).count()).toBe(0);
  } finally {
    release.resolve();
    await page.context().close();
  }
}, 180_000);
