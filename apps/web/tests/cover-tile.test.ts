import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverCard } from '@rezics/ui/cover-card';
import { coverRatio, sharedRatio } from '@rezics/ui/cover';
import { ProgressRow } from '@rezics/ui/progress-row';

const app = join(import.meta.dir, '..');
const timeout = 900_000;
let storybookChild: ChildProcess | undefined;
let browser: Browser | undefined;
let storybookPromise: Promise<{ origin: string; entries: Record<string, StoryEntry> }> | undefined;

type StoryEntry = { id: string; importPath: string; name: string; type: string };

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

async function stories(): Promise<{ origin: string; entries: Record<string, StoryEntry> }> {
  storybookPromise ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    const executable = join(app, 'node_modules/.bin/storybook');
    storybookChild = spawn(executable, ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
    });
    storybookChild.stdout!.on('data', keep);
    storybookChild.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (storybookChild.exitCode !== null)
        throw new Error(`Storybook exited with ${storybookChild.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const index = (await response.json()) as { entries: Record<string, StoryEntry> };
          return { origin, entries: index.entries };
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`Storybook did not serve its index in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return storybookPromise;
}

function entryFor(entries: Record<string, StoryEntry>, file: string, name: string): StoryEntry {
  const entry = Object.values(entries).find(
    (candidate) =>
      candidate.type === 'story' && basename(candidate.importPath) === file && candidate.name === name,
  );
  if (!entry) throw new Error(`Missing ${file} story named ${name}.`);
  return entry;
}

async function openStory(file: string, name: string, locale: string, width: number) {
  const { origin, entries } = await stories();
  const entry = entryFor(entries, file, name);
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:${locale}`, {
    waitUntil: 'networkidle',
  });
  await page.locator('html[data-hydrated]').waitFor();
  return { context, page };
}

afterAll(async () => {
  await browser?.close();
  if (storybookChild?.pid)
    try {
      process.kill(-storybookChild.pid, 'SIGTERM');
    } catch {}
});

const cover = {
  subject: { id: 'book-1', title: 'A title that should stay within two lines', types: ['schema:Book'] },
  cover: null,
  src: () => '',
};

function tagWith(html: string, attribute: string): string {
  return html.match(new RegExp(`<([a-z][a-z0-9-]*)\\b(?=[^>]*${attribute})[^>]*>`, 'i'))?.[0] ?? '';
}

function classOf(tag: string): string {
  return tag.match(/\bclass="([^"]*)"/)?.[1] ?? '';
}

test('subject tiles have only a rounded cover box, with uncluttered text and one progress row', () => {
  const html = renderToStaticMarkup(
    createElement(CoverCard, {
      href: '/book-1',
      title: cover.subject.title,
      cover,
      secondary: 'A creator',
      state: createElement(ProgressRow, { value: 0.35, label: '35%' }),
      menuLabel: 'More actions',
      menu: createElement('span', null, 'Remove'),
    }),
  );
  const tile = html.match(/<article\b[^>]*>/)?.[0] ?? '';
  const text = tagWith(html, 'data-slot="cover-card-text"');
  const frame = tagWith(html, 'data-slot="cover"');
  const aspect = tagWith(html, 'data-slot="aspect-ratio"');
  const title = tagWith(html, 'data-slot="cover-card-title"');
  const secondary = tagWith(html, 'data-slot="cover-card-secondary"');
  const state = tagWith(html, 'data-slot="cover-card-state"');
  const actions = tagWith(html, 'data-slot="cover-card-actions"');
  for (const classes of [classOf(tile), classOf(text)])
    expect(classes).not.toMatch(/(?:^|\s)(?:bg-|border(?:-|\s)|shadow(?:-|\s)|p-[^\s]+)/);
  expect(classOf(frame)).toContain('rounded-lg');
  expect(classOf(aspect)).toContain('rounded-lg');
  expect(classOf(aspect)).not.toContain('ring-');
  expect(frame).toContain('data-ratio="3:4"');
  expect(classOf(title)).toContain('line-clamp-2');
  expect(classOf(secondary)).toContain('line-clamp-1');
  expect(classOf(state)).toContain('flex');
  expect(html.indexOf('data-slot="cover-card-state"')).toBeLessThan(html.indexOf('role="progressbar"'));
  expect(html.indexOf('role="progressbar"')).toBeLessThan(html.indexOf('>35%</span>'));
  expect(classOf(actions)).toContain('absolute');
  expect(html.indexOf('data-slot="cover-card-actions"')).toBeLessThan(html.indexOf('data-slot="cover-card-text"'));
});

test('fallback ratios follow the product families and mixed grids tie to 3:4', () => {
  const families: [string[], string][] = [
    [['schema:Book'], '3:4'],
    [['bf:Instance'], '3:4'],
    [['schema:ComicSeries'], '3:4'],
    [['schema:PublicationVolume'], '3:4'],
    [['schema:TVSeries'], '3:4'],
    [['schema:Movie'], '3:4'],
    [['wd:Q689445'], '3:4'],
    [['schema:VideoGame'], '3:4'],
    [['schema:Person'], '3:4'],
    [['wd:Q95074'], '3:4'],
    [['schema:MusicAlbum'], '1:1'],
    [['schema:Organization'], '1:1'],
    [['rezics:Realm'], '1:1'],
    [['schema:Recipe'], '4:3'],
    [['schema:Place'], '4:3'],
    [['schema:Event'], '4:3'],
  ];
  for (const [types, ratio] of families) expect(coverRatio(types)).toBe(ratio);
  expect(
    sharedRatio([
      { id: 'book', title: 'Book', types: ['schema:Book'] },
      { id: 'album', title: 'Album', types: ['schema:MusicAlbum'] },
    ]),
  ).toBe('3:4');
});

test('all tile surfaces use CoverCard, and Space uses the localized definition name', async () => {
  const surfaces = [
    'src/library/shelf-view.tsx',
    'src/library/continue.tsx',
    'src/features/pages/data.tsx',
    'src/features/pages/cover-list.tsx',
    'src/library/mine-collections-page.tsx',
    'src/library/mine-following-page.tsx',
    'src/community/space-page.tsx',
  ];
  for (const path of surfaces) {
    const source = await Bun.file(join(app, path)).text();
    expect(source, path).toContain('<CoverCard');
  }
  const space = await Bun.file(join(app, 'src/community/space-page.tsx')).text();
  const reader = await Bun.file(join(app, 'src/community/space.ts')).text();
  expect(space).toContain('subject.typeName');
  expect(reader).toContain('typeNames(');

  for (const locale of ['en', 'zh-Hans']) {
    const opened = await openStory('space.stories.tsx', 'Signed Out', locale, 1280);
    try {
      const types = opened.page.locator('[aria-labelledby="realm-published-heading"] [data-slot="cover-card-secondary"]');
      await types.first().waitFor();
      const labels = (await types.allTextContents()).map((label) => label.trim());
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((label) => label === (locale === 'zh-Hans' ? '书籍' : 'book'))).toBe(true);
      expect(labels.some((label) => label === 'Book' || label === 'schema:Book')).toBe(false);
    } finally {
      await opened.context.close();
    }
  }
}, timeout);

test('the cover wall density presets resolve to the expected viewport columns and equal gaps', async () => {
  const columns: Record<string, [number, number]> = {
    Large: [2, 6],
    Medium: [3, 8],
    Small: [4, 10],
  };
  for (const [name, expected] of Object.entries(columns)) {
    const opened = await openStory('cover-wall.stories.tsx', name, 'en', 390);
    try {
      const grid = opened.page.locator('[data-slot="cover-grid"]');
      await grid.waitFor();
      expect(await grid.locator(':scope > article').count()).toBe(14);
      for (const [index, width] of [390, 1280].entries()) {
        if (index > 0) await opened.page.setViewportSize({ width, height: 900 });
        const layout = await grid.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            tracks: style.gridTemplateColumns.trim().split(/\s+/).length,
            rowGap: style.rowGap,
            columnGap: style.columnGap,
          };
        });
        expect(layout.rowGap).toBe(layout.columnGap);
        if (index === 0) expect(layout.tracks).toBe(expected[0]);
        else expect(layout.tracks).toBeGreaterThanOrEqual(expected[1] - 1);
        if (index > 0) expect(layout.tracks).toBeLessThanOrEqual(expected[1] + 1);
      }
    } finally {
      await opened.context.close();
    }
  }
}, timeout);
