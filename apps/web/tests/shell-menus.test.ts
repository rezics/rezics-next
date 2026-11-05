import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { resolveAccountSecurity } from '../src/shell/account-menu-security';

const app = join(import.meta.dir, '..');
const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
const timeout = 300_000;
type Messages = Record<string, string>;
const messages = async (locale: string) => (await Bun.file(join(app, 'messages', `${locale}.json`)).json()) as Messages;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
let browser: Browser | undefined;
const issuer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => Response.json({ error: 'not_found' }, { status: 404 }),
});

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
      env: {
        ...process.env,
        AUTH_ISSUER: `${issuer.url.origin}/auth`,
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'media:read',
        WEBSITE_CLIENT_ID: 'rezics-web-test',
        WEBSITE_CLIENT_KEY: JSON.stringify({ kty: 'EC', crv: 'P-256', d: 'not-used-without-a-session', kid: 'test' }),
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en/ in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

async function open(path: string, viewport = phone): Promise<Page> {
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}

afterAll(async () => {
  await browser?.close();
  issuer.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test(
  'the phone navigation and every shell menu use the responsive bottom sheet; Back closes navigation and restores focus',
  async () => {
    const en = await messages('en');
    const page = await open('/en');
    const route = page.url();
    const navigationTrigger = page.getByRole('button', { name: en.shell_open_navigation!, exact: true });
    await navigationTrigger.click();
    const navigationSheet = page.getByRole('dialog', { name: en.shell_navigation!, exact: true });
    await navigationSheet.waitFor();
    const overlay = page.locator('[data-slot="drawer-overlay"]');
    await overlay.waitFor();
    const backdrop = await overlay.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.backgroundColor, blur: style.backdropFilter };
    });
    expect(backdrop.color).not.toBe('rgba(0, 0, 0, 0)');
    expect(backdrop.blur).toContain('blur');
    const nav = navigationSheet.getByRole('navigation', { name: en.shell_navigation!, exact: true });
    const links = await nav.getByRole('link').evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { height: box.height, right: box.right };
      }),
    );
    expect(links.length).toBeGreaterThan(1);
    expect(links.every((link) => link.height >= 44 && link.right <= 390)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.evaluate(() => history.back());
    await navigationSheet.waitFor({ state: 'hidden' });
    expect(page.url()).toBe(route);
    await expectActive(page, navigationTrigger);

    const language = page.getByRole('button', { name: en.shell_language!, exact: true });
    await language.click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByText('日本語', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    await page.setViewportSize(desktop);
    await language.click();
    await page.getByRole('menu').getByText('日本語', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });

    await page.setViewportSize(phone);
    const theme = page.getByRole('button', { name: en.shell_theme!, exact: true });
    await theme.click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByText(en.shell_theme_dark!, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    await page.setViewportSize(desktop);
    await theme.click();
    await page.getByRole('menu').getByText(en.shell_theme_dark!, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });

    await page.context().close();
  },
  timeout,
);

test(
  'signed-out visitors get a direct sign-in action in the header at both viewport sizes',
  async () => {
    const en = await messages('en');
    const page = await open('/en', phone);
    for (const viewport of [phone, desktop]) {
      await page.setViewportSize(viewport);
      const header = page.getByRole('banner');
      const signIn = header.getByRole('link', { name: en.account_sign_in!, exact: true });
      await signIn.waitFor();
      expect(await signIn.getAttribute('href')).toBe('/auth/sign-in?return_to=%2Fen');
      expect(await header.getByRole('button', { name: en.account_menu!, exact: true }).count()).toBe(0);
      await signIn.focus();
      await expectActive(page, signIn);
    }
    await page.context().close();
  },
  timeout,
);

test('shell menus do not add kernel reads and shell.tsx imports no shadcn dropdown menu', async () => {
  const shell = await Bun.file(join(app, 'src/shell/shell.tsx')).text();
  expect(shell).not.toMatch(/from ['"]@rezics\/ui\/shadcn\/dropdown-menu['"]/);
  expect(
    [...new Set([...shell.matchAll(/useOperation\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]))].sort(),
  ).toEqual(['collection.list', 'follow.list', 'library_entry.list']);
});

async function expectActive(page: Page, locator: Locator): Promise<void> {
  expect(await locator.evaluate((element) => element === document.activeElement)).toBe(true);
}

test('Collections and Following use actual Library routes and Auth security remains honest while issuer resolution is absent or fails', async () => {
  const shell = await Bun.file(join(app, 'src/shell/shell.tsx')).text();
  for (const [guard, route] of [
    ['canOpenCollections', 'collections'],
    ['canOpenFollowing', 'following'],
  ]) {
    expect(shell).toContain(`{${guard} ? (`);
    expect(shell).toContain('href={`/${locale}/library/' + route + '`}');
    const source = await Bun.file(join(app, `src/routes/library/${route}.tsx`)).text();
    expect(source).toContain(`createFileRoute('/library/${route}')`);
    expect(source).toContain('beforeLoad: requireSignedIn');
  }
  expect(shell).not.toContain("useState('/security')");
  expect(shell).toContain('m.account_security_unavailable()');
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    expect((await messages(locale)).account_security_unavailable).toBeTruthy();
  }

  for (const read of [
    async () => '',
    async () => {
      throw new Error('configuration unavailable');
    },
    () => {
      throw new Error('configuration failed synchronously');
    },
    async () => 'not a URL',
    async () => 'http://auth.example.test',
    async () => 'https://user:password@auth.example.test',
    async () => 'https://auth.example.test?return_to=elsewhere',
    async () => 'https://auth.example.test#fragment',
  ]) {
    const result = await new Promise<string | null>((resolve) => resolveAccountSecurity(read, resolve));
    expect(result).toBeNull();
  }
  const trusted = await new Promise<string | null>((resolve) =>
    resolveAccountSecurity(async () => 'https://auth.example.test:8443/oidc', resolve),
  );
  expect(trusted).toBe('https://auth.example.test:8443/security');
});

test('issuer resolution reads once, stays unresolved until completion and ignores disposed success or failure', async () => {
  for (const fails of [false, true]) {
    const pending = Promise.withResolvers<string>();
    let reads = 0;
    const results: (string | null)[] = [];
    const dispose = resolveAccountSecurity(
      () => {
        reads++;
        return pending.promise;
      },
      (href) => results.push(href),
    );
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(results).toEqual([]);
    dispose();
    if (fails) pending.reject(new Error('late configuration failure'));
    else pending.resolve('https://previous-account.example.test');
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([]);
    expect(reads).toBe(1);
  }
});
