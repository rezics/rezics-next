import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

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
  await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return page;
}

afterAll(async () => {
  await browser?.close();
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
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
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
    const requestsBeforeMenu = requests.length;
    await page.evaluate(() => history.back());
    await navigationSheet.waitFor({ state: 'hidden' });
    await expectActive(page, navigationTrigger);
    expect(requests.slice(requestsBeforeMenu)).toEqual([]);

    const language = page.getByRole('combobox', { name: en.shell_language!, exact: true });
    await language.click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByText('日本語', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    const theme = page.getByRole('button', { name: en.shell_theme!, exact: true });
    await theme.click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByText(en.shell_theme_dark!, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });

    await page.context().close();
  },
  timeout,
);

test(
  'the signed-out account action opens a sheet on phones and a dropdown on desktop',
  async () => {
    const en = await messages('en');
    const phonePage = await open('/en', phone);
    const account = phonePage.getByRole('button', { name: en.account_menu!, exact: true });
    await account.click();
    const accountSheet = phonePage.getByRole('dialog', { name: en.account_menu!, exact: true });
    await accountSheet.waitFor();
    await accountSheet.getByRole('link', { name: en.account_sign_in!, exact: true }).waitFor();
    await phonePage.keyboard.press('Escape');
    await accountSheet.waitFor({ state: 'hidden' });
    await phonePage.context().close();

    const desktopPage = await open('/en', desktop);
    const desktopAccount = desktopPage.getByRole('button', { name: en.account_menu!, exact: true });
    await desktopAccount.click();
    await desktopPage.getByRole('menu').getByRole('link', { name: en.account_sign_in!, exact: true }).waitFor();
    await desktopPage.context().close();
  },
  timeout,
);

test('shell menus do not add kernel reads and shell.tsx imports no shadcn dropdown menu', async () => {
  const shell = await Bun.file(join(app, 'src/shell/shell.tsx')).text();
  expect(shell).not.toMatch(/from ['"]@rezics\/ui\/shadcn\/dropdown-menu['"]/);
  expect([...shell.matchAll(/useOperation\(['"]([^'"]+)['"]\)/g)].map((match) => match[1])).toEqual([
    'library_entry.list',
  ]);
  expect([...shell.matchAll(/<Exposure operation="([^"]+)"/g)].map((match) => match[1])).toEqual([
    'library_entry.list',
    'collection.list',
    'follow.list',
  ]);
});

async function expectActive(page: Page, locator: ReturnType<Page['getByRole']>): Promise<void> {
  expect(await locator.evaluate((element) => element === document.activeElement)).toBe(true);
}
