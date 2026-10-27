import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { chromium, type Browser } from 'playwright';

const app = join(import.meta.dir, '..');
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let serverPromise: Promise<string> | undefined;
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

async function storybook(): Promise<string> {
  const port = await freePort();
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  const executable = join(app, 'node_modules/.bin/storybook');
  child = spawn(executable, ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: app,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
  });
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(10_000) })).ok) return origin;
    } catch {}
    if (Date.now() > deadline) throw new Error(`Storybook did not serve its index in time:\n${output}`);
    await Bun.sleep(500);
  }
}

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

async function openStory(story: string, visitor: 'Signed In' | 'Signed Out', locale: string) {
  serverPromise ??= storybook();
  const origin = await serverPromise;
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string; title: string }>;
  };
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' &&
      basename(candidate.importPath) === `${story}.stories.tsx` &&
      candidate.name === visitor,
  );
  if (!entry) throw new Error(`Missing ${story} story for ${visitor}.`);
  expect(entry.title.startsWith('Pages/Library/'), `${story} is titled under Pages/Library`).toBe(true);
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:${locale}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('html[data-hydrated]').waitFor();
  await page.getByRole('main').waitFor();
  return { context, page };
}

test('collections use linked cover cards with count and visibility in a two-column grid', async () => {
  const { context, page } = await openStory('library-collections', 'Signed In', 'en');
  try {
    await page.setViewportSize({ width: 390, height: 860 });
    const cards = page.getByRole('main').locator('article.group');
    expect(await cards.count()).toBe(2);
    const first = cards.nth(0);
    expect(await first.getByRole('link', { name: 'To read this winter', exact: true }).count()).toBe(1);
    expect(await first.getByRole('link').count()).toBe(1);
    expect(await first.textContent()).toContain('2 items');
    expect(await first.textContent()).toContain('Private');
    expect(await first.locator('[data-slot=aspect-ratio]').count()).toBe(1);
    const boxes = await cards.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
  } finally {
    await context.close();
  }
}, 900_000);

test('following cards put unfollow in a keyboard and pointer accessible menu', async () => {
  const { context, page } = await openStory('library-following', 'Signed In', 'en');
  try {
    await page.setViewportSize({ width: 390, height: 860 });
    const cards = page.getByRole('main').locator('article.group');
    expect(await cards.count()).toBe(3);
    const space = cards.filter({ hasText: 'A quiet space' });
    expect(await space.getByRole('link').count()).toBe(0);
    expect(await space.getByRole('button', { name: 'More actions for A quiet space' }).count()).toBe(1);
    for (const title of ['Kokoro', 'Quiet novels for long evenings']) {
      const card = cards.filter({ has: page.getByRole('link', { name: title, exact: true }) });
      expect(await card.getByRole('link').count()).toBe(1);
      expect(await card.getByRole('button', { name: 'Unfollow' }).count()).toBe(0);
      const trigger = card.getByRole('button', { name: `More actions for ${title}` });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: 'Unfollow' }).waitFor();
      await page.keyboard.press('Escape');
      await trigger.click();
      await page.getByRole('menuitem', { name: 'Unfollow' }).waitFor();
      await page.keyboard.press('Escape');
    }
  } finally {
    await context.close();
  }
}, 900_000);
