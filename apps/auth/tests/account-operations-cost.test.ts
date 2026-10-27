import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createFakeAuthState, startFakeAuth, type FakeAuthRequest } from '../scripts/fake-auth';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const session = 'account-operation-cost-session';
const state = createFakeAuthState();
const calls: FakeAuthRequest[] = [];
const fake = startFakeAuth({ state, onRequest: (request) => calls.push(request) });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;

function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AUTH_ORIGIN: fake.url.origin },
    });
    let startError: Error | undefined;
    child.on('error', (error) => (startError = error));
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(60_000) });
        if (response.status === 200) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /login in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(path: string) {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, javaScriptEnabled: true });
  await context.addCookies([
    { name: 'auth_session', value: session, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    expect(response?.status()).toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, context };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function reset(scale: number) {
  calls.length = 0;
  Object.assign(state, {
    signedOut: false,
    sessionFresh: true,
    signInSucceeds: false,
    organizationsOpen: true,
    denyAccountOperation: false,
    dropFirstExecuteResponse: false,
    sessionCount: scale,
    organizationCount: scale,
  });
}

beforeAll(async () => {
  await site();
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function assertThreeRequests() {
  expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
    'GET /session',
    'POST /account-operations/approve',
    'POST /account-operations/execute',
  ]);
  expect(calls).toHaveLength(3);
}

test(
  'deleting an account makes three Auth requests whatever the person holds',
  async () => {
    for (const scale of [1, 10, 100]) {
      reset(scale);
      const { page, context } = await open('/account/delete');
      try {
        await page
          .getByRole('textbox', { name: 'Type “delete my account” to confirm.', exact: true })
          .fill('delete my account');
        await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/account-operations/execute' && response.status() === 200,
          ),
          page.getByRole('button', { name: 'Delete account', exact: true }).click(),
        ]);
        await page.getByRole('status').waitFor();
        await assertThreeRequests();
      } finally {
        await context.close();
      }
    }
  },
  timeout,
);

test(
  'creating an organization makes at most three Auth requests whatever the person holds',
  async () => {
    for (const scale of [1, 10, 100]) {
      reset(scale);
      const { page, context } = await open('/organizations/new');
      try {
        await page.getByLabel('Handle', { exact: true }).fill(`scale-${scale}`);
        await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === '/account-operations/execute' && response.status() === 200,
          ),
          page.getByRole('button', { name: 'Create organization', exact: true }).click(),
        ]);
        await page.getByRole('status').waitFor();
        await assertThreeRequests();
      } finally {
        await context.close();
      }
    }
  },
  timeout,
);
