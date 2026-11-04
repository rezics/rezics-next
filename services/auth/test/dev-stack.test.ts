import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from '../scripts/dev-stack.ts';

// Exercise the documented commands in a fresh retained-source copy. Never reset a developer's stack.
test('fresh checkout starts native loopback Auth and signs a person into and out of Web without an external service', async () => {
  await mkdir(resolve(root, '.temp'), { recursive: true });
  const checkout = await mkdtemp(resolve(root, '.temp/dev-stack-'));
  const suffix = randomUUID();
  const database = `rezics-dev-stack-db-${suffix}`;
  const search = `rezics-dev-stack-search-${suffix}`;
  const env = { ...process.env, KERNEL_DATABASE_CONTAINER: database, KERNEL_DATABASE_VOLUME: database,
    KERNEL_SEARCH_CONTAINER: search, KERNEL_SEARCH_VOLUME: search };
  const commands = async (args: string[], cwd = checkout) => {
    const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(`${args.join(' ')}: ${stderr}\n${stdout}`);
    return stdout;
  };
  let stack: ReturnType<typeof Bun.spawn> | undefined;
  let browser: { close(): Promise<void> } | undefined;
  try {
    const archive = Bun.spawn(['git', 'archive', 'HEAD'], { cwd: root, stdout: 'pipe' });
    const extract = Bun.spawn(['tar', '-x', '-C', checkout], { stdin: archive.stdout });
    expect(await archive.exited).toBe(0); expect(await extract.exited).toBe(0);
    // Dependency stores are read-only; all generated state belongs to the isolated copy.
    for (const workspace of ['', 'services/auth', 'services/kernel', 'apps/auth', 'apps/web'])
      await symlink(resolve(root, workspace, 'node_modules'), resolve(checkout, workspace, 'node_modules'));
    await commands(['go-task', 'dev:infra']);
    await commands(['go-task', 'dev:infra']); // Existing, migrated development DB is a no-op.
    stack = Bun.spawn(['go-task', 'dev'], { cwd: checkout, env, stdout: Bun.file(resolve(checkout, '.temp/stack.log')), stderr: 'inherit' });
    const require = createRequire(resolve(root, 'apps/web/package.json'));
    const { chromium } = require('playwright');
    const { expect: browserExpect } = require('playwright/test');
    const instance = await chromium.launch({ headless: true }); browser = instance;
    const page = await instance.newPage({ locale: 'en-US' });
    await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
      const url = new URL(route.request().url());
      return url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    // Startup includes bundling both apps. Retry only transport startup, never a mutation.
    await browserExpect.poll(async () => {
      try { return (await fetch('http://127.0.0.1:4200/.well-known/openid-configuration')).status; }
      catch { return 0; }
    }, { timeout: 180_000 }).toBe(200);
    await page.goto('http://127.0.0.1:3000/');
    await page.locator('a[href^="/auth/sign-in"]').first().click();
    await page.waitForURL('**/login?**');
    await page.locator('a[href^="/signup"]').click();
    const handle = `local_${suffix.replaceAll('-', '').slice(0, 12)}`;
    const email = `${handle}@example.test`; const password = 'local stack password 123';
    await page.locator('input[name="handle"]').fill(handle);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form[action="/signup"] button[type="submit"]').click();
    await page.locator('.auth-signup-links a[href^="/login"]').click();
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('http://127.0.0.1:3000/**');
    expect((await page.context().cookies()).some((cookie: { name: string }) => cookie.name.includes('session'))).toBe(true);
    // Submit Web's own sign-out form even when its account menu is collapsed.
    await page.locator('form[action="/auth/sign-out"]').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.waitForURL('http://127.0.0.1:3000/**');
    expect(await page.locator('a[href^="/auth/sign-in"]').first().isVisible()).toBe(true);
    const discovery = await fetch('http://127.0.0.1:3100/.well-known/openid-configuration');
    expect((await discovery.json() as { issuer: string }).issuer).toBe('http://127.0.0.1:4200');
  } finally {
    await browser?.close();
    if (stack) { stack.kill('SIGTERM'); await stack.exited; }
    // Exact UUID-owned names only. A failed setup may have left only a volume.
    for (const name of [database, search]) {
      const inspect = Bun.spawn(['docker', 'inspect', name], { stdout: 'ignore', stderr: 'ignore' });
      if (await inspect.exited === 0) await commands(['docker', 'rm', '-f', name]);
      const volume = Bun.spawn(['docker', 'volume', 'inspect', name], { stdout: 'ignore', stderr: 'ignore' });
      if (await volume.exited === 0) await commands(['docker', 'volume', 'rm', name]);
    }
    await rm(checkout, { recursive: true, force: true });
  }
}, 300_000);
