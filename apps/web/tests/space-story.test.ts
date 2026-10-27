import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { chromium, type Browser } from 'playwright';

const app = join(import.meta.dir, '..');
const recorded = join(app, 'src/kernel/recorded');
const locales = ['en', 'zh-Hans'];
const timeout = 900_000;
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

async function openStory(visitor: 'Signed In' | 'Signed Out', locale: string) {
  serverPromise ??= storybook();
  const origin = await serverPromise;
  const index = (await (await fetch(`${origin}/index.json`)).json()) as {
    entries: Record<string, { id: string; importPath: string; name: string; type: string }>;
  };
  const entry = Object.values(index.entries).find(
    (candidate) =>
      candidate.type === 'story' &&
      basename(candidate.importPath) === 'space.stories.tsx' &&
      candidate.name === visitor,
  );
  if (!entry) throw new Error(`Missing Space story for ${visitor}.`);
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

afterAll(async () => {
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

test(
  'the Space story shows its recorded Space and published subjects for signed-in and signed-out visitors',
  async () => {
    const space = await Bun.file(join(recorded, 'space.json')).json();
    const published = await Bun.file(join(recorded, 'realm-subjects.json')).json();
    const subjects = Object.values(published.subjects) as {
      subject: { id: string; labels: Record<string, string> };
    }[];
    for (const locale of locales) {
      const own = await Bun.file(join(app, 'messages', `${locale}.json`)).json();
      for (const visitor of ['Signed In', 'Signed Out'] as const) {
        const opened = await openStory(visitor, locale);
        try {
          const main = opened.page.getByRole('main');
          const heading = main.getByRole('heading', { level: 1 });
          await heading.waitFor();
          expect((await heading.textContent())?.trim()).toBe(space.space.title);
          const cards = main.locator('section[aria-labelledby="realm-published-heading"]');
          await cards.waitFor();
          expect(await cards.locator('article').count()).toBe(subjects.length);
          for (const { subject } of subjects) {
            const title = subject.labels[locale] ?? subject.labels.en!;
            const link = cards.getByRole('link', { name: title, exact: true });
            await link.waitFor();
            expect(await link.getAttribute('href')).toBe(`/${locale}/subjects/${subject.id}`);
            expect(await link.evaluate((element) => element.closest('article') !== null)).toBe(true);
          }
        } finally {
          await opened.context.close();
        }
      }
    }
  },
  timeout,
);
