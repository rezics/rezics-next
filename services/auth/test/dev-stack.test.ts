import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, symlink, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { root } from '../scripts/dev-stack.ts';
import { StackFixtureLifetime, waitForFixtureResponse, type StackFixtureChild } from '../scripts/dev-stack-lifetime.ts';
import { admitWalkStack, walkStackEnvironment } from '../../../scripts/walk-stack.ts';

// Exercise the documented commands in a fresh retained-source copy. Never reset a developer's stack.
test('fresh checkout starts native loopback Auth and signs a person into and out of Web without an external service', async () => {
  const suffix = randomUUID();
  // The test keeps its original 300-second budget, including a 30-second resource settlement reserve.
  const lifetime = new StackFixtureLifetime(270_000);
  let slot: Awaited<ReturnType<typeof admitWalkStack>> | undefined;
  const cleanupFailures: unknown[] = [];
  let failure: unknown;
  const settle = async (cleanup: () => Promise<unknown>) => {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  };
  try {
    slot = await admitWalkStack(`auth-${suffix}`, process.env, root, lifetime.signal);
    await mkdir(resolve(root, '.temp'), { recursive: true });
    const checkout = await mkdtemp(resolve(root, '.temp/dev-stack-'));
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
    const selected = walkStackEnvironment(`auth-${suffix}`, slot.index!);
    const database = selected.KERNEL_DATABASE_CONTAINER!;
    const search = selected.KERNEL_SEARCH_CONTAINER!;
    const origins = {
      web: selected.REZICS_LOCAL_STACK_WEB_ORIGIN!,
      issuer: selected.REZICS_LOCAL_STACK_ISSUER_ORIGIN!,
      native: selected.REZICS_LOCAL_STACK_NATIVE_ORIGIN!,
      kernel: selected.REZICS_LOCAL_STACK_KERNEL_ORIGIN!,
    };
    console.error(`stack: fresh fixture ${JSON.stringify({ slot: slot.index, database, search, ...origins })}`);
    const env = {
      ...process.env,
      ...selected,
      // Hold the port lease directly while exercising ordinary setup/start, including pages and the default worker.
      REZICS_WALK_STACK_SLOT: undefined,
      REZICS_WALK_DEFER_FRONTENDS: undefined,
      // The private run holds native services, both Vite graphs and Chromium within 6 GiB.
      // Leave room above the observed 1.5 GiB live Web graph without retaining a large young generation.
      MALLOC_ARENA_MAX: '2',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=1792 --max-semi-space-size=4`.trim(),
      // Fresh setup must read the database it just provisioned, without an inherited compiler URL or SQL cache.
      DATABASE_URL: undefined,
      REYLO_CONFIG: undefined,
      // The Taskfile prepends the checkout's dependency binaries to PATH; the Bun fallback needs the same lookup.
      PATH: [resolve(checkout, 'node_modules/.bin'), process.env.PATH].filter(Boolean).join(':'),
    };
    const commands = (name: string, args: string[], progress = false) =>
      lifetime.command(name, args, { cwd: checkout, env, progress });
    let stack: StackFixtureChild | undefined;
    let browser: { close(): Promise<void> } | undefined;
    let closingBrowser: Promise<void> | undefined;
    const closeBrowser = () => (closingBrowser ??= browser?.close() ?? Promise.resolve());
    const abortBrowser = () => {
      void closeBrowser().catch(() => {});
    };
    lifetime.signal.addEventListener('abort', abortBrowser, { once: true });
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
      for (const [index, command] of infra.entries()) await commands(`setup-first-${index}`, command, true);
      const kernelEnv = await Bun.file(resolve(checkout, 'services/kernel/.env')).text();
      const kernelDatabaseUrl = kernelEnv
        .split('\n')
        .find((line) => line.startsWith('DATABASE_URL='))!
        .slice(13);
      const port = (await commands('database-port', ['docker', 'port', database, '5432/tcp']))
        .trim()
        .split(':')
        .at(-1)!;
      expect(port).toBe(selected.KERNEL_DATABASE_PORT!);
      expect(new URL(kernelDatabaseUrl).port).toBe(port);
      const preparedDirectory = resolve(checkout, '.temp/local-stack/native-website');
      const prepared = await readdir(preparedDirectory);
      expect(prepared).toHaveLength(1);
      const preparedFile = resolve(preparedDirectory, prepared[0]!);
      const preparedAt = (await stat(preparedFile)).mtimeMs;
      for (const [index, command] of infra.entries()) await commands(`setup-repeat-${index}`, command, true); // Existing, migrated development DB is a no-op.
      expect(await Bun.file(resolve(checkout, 'services/kernel/.env')).text()).toBe(kernelEnv);
      expect(await readdir(preparedDirectory)).toEqual(prepared);
      expect((await stat(preparedFile)).mtimeMs).toBe(preparedAt);
      stack = lifetime.start('start', devCommand, {
        cwd: checkout,
        env,
        progress: true,
        outputFile: resolve(checkout, '.temp/stack.log'),
      });
      const instance = await chromium.launch({ headless: true });
      browser = instance;
      if (lifetime.signal.aborted) {
        await instance.close();
        lifetime.signal.throwIfAborted();
      }
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
      // Bundling both apps and every readiness probe share the fixture's original absolute deadline.
      for (const url of [
        `${origins.issuer}/.well-known/openid-configuration`,
        `${origins.kernel}/health`,
        `${origins.web}/`,
      ])
        expect(await waitForFixtureResponse(url, lifetime.signal)).toBe(200);
      const startupLog = await Bun.file(resolve(checkout, '.temp/stack.log')).text();
      expect(startupLog).toContain('Worker ready');
      expect(startupLog.indexOf('stack: web-launched')).toBeGreaterThan(-1);
      expect(startupLog.indexOf('stack: web-launched')).toBeLessThan(startupLog.indexOf('stack: identity ready'));
      expect(startupLog.indexOf('stack: frontend-bindings ready')).toBeGreaterThan(-1);
      expect(startupLog.indexOf('stack: frontend-bindings ready')).toBeLessThan(
        startupLog.indexOf('stack: identity ready'),
      );
      expect(startupLog.slice(startupLog.indexOf('stack: worker ready'))).not.toContain('native-sql-generate starting');
      console.error(`stack: fixture-worker ready utc=${new Date().toISOString()}`);
      await page.goto(`${origins.web}/`);
      await page.locator('a[href^="/auth/sign-in"]:visible').first().click();
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
      await page.waitForURL(`${origins.web}/**`);
      expect(
        (await page.context().cookies()).some((cookie: { name: string }) => cookie.name === '__Host-rezics_session'),
      ).toBe(true);
      await page.locator('#account-menu-button').click();
      await page.locator('form[action="/auth/sign-out"] button[type="submit"]').click();
      await page.waitForURL(`${origins.web}/**`);
      await browserExpect(page.locator('a[href^="/auth/sign-in"]:visible').first()).toBeVisible();
      expect(
        (await page.context().cookies()).some((cookie: { name: string }) => cookie.name === '__Host-rezics_session'),
      ).toBe(false);
      const discovery = await fetch(`${origins.native}/.well-known/openid-configuration`, { signal: lifetime.signal });
      expect(((await discovery.json()) as { issuer: string }).issuer).toBe(origins.issuer);
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
        await closeBrowser();
        await lifetime.stop(stack);
        const remaining = await originalDatabase.query(
          `SELECT pid FROM pg_stat_activity WHERE datname = ANY($1) AND backend_type='client backend'
         AND pid <> pg_backend_pid()`,
          [[new URL(kernelDatabaseUrl).pathname.slice(1), 'rezics_auth']],
        );
        expect(remaining.rows).toEqual([]);
      } finally {
        await originalDatabase.end();
      }
    } catch (error) {
      failure = lifetime.signal.aborted ? lifetime.signal.reason : error;
    } finally {
      // A setup failure reaches the same teardown as a running stack. Stop descendants before removing their DB.
      lifetime.cancel(new Error('Local stack fixture finishing'));
      await settle(closeBrowser);
      await settle(() => lifetime.close());
      lifetime.signal.removeEventListener('abort', abortBrowser);
      const cleanup = new StackFixtureLifetime(20_000);
      const cleanupCommand = (name: string, args: string[]) => cleanup.command(name, args, { cwd: root, env });
      try {
        // Exact admitted names only. Listing first also distinguishes absence from an inspect/daemon failure.
        for (const name of [database, search]) {
          await settle(async () => {
            const containers = await cleanupCommand('container-inspect', [
              'docker',
              'ps',
              '-aq',
              '--filter',
              `name=^${name}$`,
            ]);
            if (containers.trim()) await cleanupCommand('container-remove', ['docker', 'rm', '-f', name]);
            expect(
              (await cleanupCommand('container-verify', ['docker', 'ps', '-aq', '--filter', `name=^${name}$`])).trim(),
            ).toBe('');
          });
          await settle(async () => {
            const volumes = await cleanupCommand('volume-inspect', [
              'docker',
              'volume',
              'ls',
              '-q',
              '--filter',
              `name=^${name}$`,
            ]);
            if (volumes.trim()) await cleanupCommand('volume-remove', ['docker', 'volume', 'rm', name]);
            expect(
              (
                await cleanupCommand('volume-verify', ['docker', 'volume', 'ls', '-q', '--filter', `name=^${name}$`])
              ).trim(),
            ).toBe('');
          });
        }
      } finally {
        await settle(() => cleanup.close());
        await settle(() => rm(checkout, { recursive: true, force: true }));
        console.error(
          `stack: fixture-resources ${cleanupFailures.length ? 'unsettled' : 'settled'} utc=${new Date().toISOString()}`,
        );
      }
    }
  } catch (error) {
    failure ??= error;
  } finally {
    await settle(() => lifetime.close());
    const admittedSlot = slot;
    if (admittedSlot) await settle(() => admittedSlot.release());
  }
  if (failure !== undefined && cleanupFailures.length)
    throw new AggregateError([failure, ...cleanupFailures], 'Local stack fixture failed and cleanup failed', {
      cause: failure,
    });
  if (failure !== undefined) throw failure;
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Local stack fixture cleanup failed');
}, 300_000);
