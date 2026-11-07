import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, symlink, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { root } from '../scripts/dev-stack.ts';

// Exercise the documented commands in a fresh retained-source copy. Never reset a developer's stack.
test('fresh checkout starts native loopback Auth and signs a person into and out of Web without an external service', async () => {
  await mkdir(resolve(root, '.temp'), { recursive: true });
  const checkout = await mkdtemp(resolve(root, '.temp/dev-stack-'));
  const suffix = randomUUID();
  // Go Task is the documented entry point. Check hosts may have neither `go-task` nor `task` on PATH; the repository
  // binary lives in node_modules/.bin. Without either, the Taskfile's Bun commands are the supported selection.
  const goTask =
    Bun.which('go-task') ??
    Bun.which('task') ??
    ['go-task', 'task'].map((name) => resolve(root, 'node_modules/.bin', name)).find((path) => existsSync(path));
  const bun = process.execPath;
  const infra = goTask
    ? [[goTask, 'dev:infra']]
    : [
        [bun, 'run', '--cwd', 'services/kernel', 'db', 'up'],
        [bun, 'run', '--cwd', 'services/kernel', 'search', 'up'],
        [bun, 'services/auth/scripts/dev-stack.ts', 'setup'],
      ];
  const devCommand = goTask ? [goTask, 'dev'] : [bun, 'services/auth/scripts/dev-stack.ts', 'start'];
  const database = `rezics-dev-stack-db-${suffix}`;
  const search = `rezics-dev-stack-search-${suffix}`;
  const env = {
    ...process.env,
    // Fresh setup must read the database it just provisioned, without an inherited compiler URL or SQL cache.
    DATABASE_URL: undefined,
    REYLO_CONFIG: undefined,
    // The Taskfile prepends the checkout's dependency binaries to PATH; the Bun fallback needs the same lookup.
    PATH: [resolve(checkout, 'node_modules/.bin'), process.env.PATH].filter(Boolean).join(':'),
    KERNEL_DATABASE_CONTAINER: database,
    KERNEL_DATABASE_VOLUME: database,
    KERNEL_SEARCH_CONTAINER: search,
    KERNEL_SEARCH_VOLUME: search,
  };
  const commands = async (args: string[], cwd = checkout, progress = false) => {
    const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: progress ? 'inherit' : 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      progress ? '' : new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      child.exited,
    ]);
    if (code) throw new Error(`${args.join(' ')}: ${stderr}\n${stdout}`);
    return stdout;
  };
  let stack: ReturnType<typeof Bun.spawn> | undefined;
  let browser: { close(): Promise<void> } | undefined;
  try {
    // Check hosts receive source snapshots without Git metadata. Copy retained
    // source, excluding shared dependencies and generated attempt state.
    const skip = new Set([
      'node_modules',
      '.git',
      '.temp',
      '.last-test-file',
      '.last-test-file.pending',
      '.memory-limit-reported',
    ]);
    for (const entry of await readdir(root)) {
      if (skip.has(entry)) continue;
      await cp(resolve(root, entry), resolve(checkout, entry), {
        recursive: true,
        filter: (source) => !skip.has(source.split('/').at(-1)!),
      });
    }
    // Dependency stores are read-only; all generated state belongs to the isolated copy. The stack imports across
    // workspaces (services/importer brings its own typebox), so every workspace with a store is linked.
    const workspaces = [''];
    for await (const manifest of new Bun.Glob('{apps,services,packages}/*/package.json').scan({ cwd: root }))
      workspaces.push(dirname(manifest));
    for (const workspace of workspaces) {
      const store = resolve(root, workspace, 'node_modules');
      if (existsSync(store)) await symlink(store, resolve(checkout, workspace, 'node_modules'));
    }
    for (const command of infra) await commands(command, checkout, true);
    const kernelEnv = await Bun.file(resolve(checkout, 'services/kernel/.env')).text();
    const kernelDatabaseUrl = kernelEnv
      .split('\n')
      .find((line) => line.startsWith('DATABASE_URL='))!
      .slice(13);
    const port = (await commands(['docker', 'port', database, '5432/tcp'])).trim().split(':').at(-1)!;
    expect(new URL(kernelDatabaseUrl).port).toBe(port);
    for (const command of infra) await commands(command, checkout, true); // Existing, migrated development DB is a no-op.
    expect(await Bun.file(resolve(checkout, 'services/kernel/.env')).text()).toBe(kernelEnv);
    stack = Bun.spawn(devCommand, {
      cwd: checkout,
      env,
      stdout: Bun.file(resolve(checkout, '.temp/stack.log')),
      stderr: 'inherit',
    });
    const instance = await chromium.launch({ headless: true });
    browser = instance;
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
    // Startup includes bundling both apps. Retry only transport startup, never a mutation.
    await browserExpect
      .poll(
        async () => {
          try {
            return (await fetch('http://127.0.0.1:4200/.well-known/openid-configuration')).status;
          } catch {
            return 0;
          }
        },
        { timeout: 180_000 },
      )
      .toBe(200);
    for (const url of ['http://127.0.0.1:4100/health', 'http://127.0.0.1:3000/']) {
      await browserExpect
        .poll(
          async () => {
            try {
              return (await fetch(url)).status;
            } catch {
              return 0;
            }
          },
          { timeout: 180_000 },
        )
        .toBe(200);
    }
    await page.goto('http://127.0.0.1:3000/');
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
    await page.waitForURL('http://127.0.0.1:3000/**');
    expect(
      (await page.context().cookies()).some((cookie: { name: string }) => cookie.name === '__Host-rezics_session'),
    ).toBe(true);
    await page.locator('#account-menu-button').click();
    await page.locator('form[action="/auth/sign-out"] button[type="submit"]').click();
    await page.waitForURL('http://127.0.0.1:3000/**');
    await browserExpect(page.locator('a[href^="/auth/sign-in"]').first()).toBeVisible();
    expect(
      (await page.context().cookies()).some((cookie: { name: string }) => cookie.name === '__Host-rezics_session'),
    ).toBe(false);
    const discovery = await fetch('http://127.0.0.1:3100/.well-known/openid-configuration');
    expect(((await discovery.json()) as { issuer: string }).issuer).toBe('http://127.0.0.1:4200');
    const authUrl = new URL(kernelDatabaseUrl);
    authUrl.pathname = '/rezics_auth';
    const originalDatabase = new Pool({ connectionString: authUrl.href });
    try {
      const registered = await originalDatabase.query('SELECT scopes FROM auth_client WHERE client_id=$1', [
        'rezics-website',
      ]);
      const vars = await Bun.file(resolve(checkout, 'apps/web/.dev.vars')).text();
      const scopes = JSON.parse(
        vars
          .split('\n')
          .find((line) => line.startsWith('WEBSITE_SCOPES='))!
          .slice(15),
      );
      expect(registered.rows[0].scopes).toEqual(scopes.split(' '));
      await browser.close();
      browser = undefined;
      stack.kill('SIGTERM');
      await stack.exited;
      stack = undefined;
      const remaining = await originalDatabase.query(
        `SELECT pid FROM pg_stat_activity WHERE datname = ANY($1) AND backend_type='client backend'
         AND pid <> pg_backend_pid()`,
        [[new URL(kernelDatabaseUrl).pathname.slice(1), 'rezics_auth']],
      );
      expect(remaining.rows).toEqual([]);
    } finally {
      await originalDatabase.end();
    }
  } finally {
    await browser?.close();
    if (stack) {
      stack.kill('SIGTERM');
      await stack.exited;
    }
    // Exact UUID-owned names only. A failed setup may have left only a volume.
    for (const name of [database, search]) {
      const inspect = Bun.spawn(['docker', 'inspect', name], { stdout: 'ignore', stderr: 'ignore' });
      if ((await inspect.exited) === 0) await commands(['docker', 'rm', '-f', name]);
      const volume = Bun.spawn(['docker', 'volume', 'inspect', name], { stdout: 'ignore', stderr: 'ignore' });
      if ((await volume.exited) === 0) await commands(['docker', 'volume', 'rm', name]);
    }
    await rm(checkout, { recursive: true, force: true });
  }
}, 300_000);
