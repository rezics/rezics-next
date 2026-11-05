import { createKernelClient } from '@rezics/client';
import { afterAll, expect, mock, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { cleanupAll, ownNodeProcess, type ProcessCustody } from './support/server-custody.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoverCard } from '@rezics/ui/cover-card';
import { Cover, coverRatio, sharedRatio, type CoverRatio } from '@rezics/ui/cover';

const workerEnv: { KERNEL_ORIGIN: string } = { KERNEL_ORIGIN: 'https://definitions-cover-test.invalid' };
const app = join(import.meta.dir, '..');
mock.module('../src/kernel/client.ts', () => ({
  requestLocale: () => 'en',
  kernelClient: () => createKernelClient(workerEnv.KERNEL_ORIGIN),
}));
mock.module('cloudflare:workers', () => ({ env: workerEnv }));
const { typeFrame } = await import('../src/subject/definitions.ts');

const timeout = 900_000;
let storybookChild: ChildProcess | undefined;
let storybookCustody: ProcessCustody | undefined;
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
    const executable = join(app, 'node_modules/.bin/storybook');
    storybookChild = spawn(executable, ['dev', '--ci', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
    });
    const custody = (storybookCustody = ownNodeProcess(storybookChild, { label: 'Cover tile Storybook' }));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (storybookChild.exitCode !== null)
        throw new Error(`Storybook exited with ${storybookChild.exitCode}:\n${custody.diagnostics()}`);
      try {
        const response = await fetch(`${origin}/index.json`, { signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const index = (await response.json()) as { entries: Record<string, StoryEntry> };
          return { origin, entries: index.entries };
        }
      } catch {}
      if (Date.now() > deadline)
        throw new Error(`Storybook did not serve its index in time:\n${custody.diagnostics()}`);
      await Bun.sleep(500);
    }
  })();
  return storybookPromise;
}

function entryFor(entries: Record<string, StoryEntry>, file: string, name: string): StoryEntry {
  const entry = Object.values(entries).find(
    (candidate) => candidate.type === 'story' && basename(candidate.importPath) === file && candidate.name === name,
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
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    await page.goto(`${origin}/iframe.html?id=${entry.id}&viewMode=story&globals=locale:${locale}`, {
      waitUntil: 'networkidle',
    });
    await page.locator('html[data-hydrated]').waitFor();
  } catch (error) {
    await context.close();
    throw new Error(`${entry.id} (${locale}, ${width}px): ${String(error)}\n${errors.join('\n')}`);
  }
  return { context, page };
}

afterAll(async () => {
  await cleanupAll([
    { label: 'Cover tile browser', run: () => browser?.close(), timeoutMs: 5000 },
    { label: 'Cover tile Storybook group', run: () => storybookCustody?.close(), timeoutMs: 7000 },
  ]);
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
  return (tag.match(/\bclass="([^"]*)"/)?.[1] ?? '').replaceAll('&amp;', '&');
}

test('cover cards have no surface and keep the edge-to-edge cover and padded text below', () => {
  const html = renderToStaticMarkup(
    createElement(CoverCard, {
      href: '/book-1',
      title: cover.subject.title,
      cover,
      secondary: 'A creator',
      progress: { value: 0.35, label: '35%' },
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
  const progress = tagWith(html, 'data-slot="progress-row"');
  const actions = tagWith(html, 'data-slot="cover-card-actions"');
  expect(classOf(tile)).not.toMatch(
    /(?:^|\s)(?:bg-[^\s]*|outline(?:-[^\s]*)?|border(?:-[^\s]*)?|shadow(?:-[^\s]*)?)(?:\s|$)/,
  );
  expect(classOf(tile)).toContain('focus-within:ring-2');
  expect(classOf(tile)).not.toMatch(/(?:^|\s)rounded(?:-[^\s]+)?(?:\s|$)/);
  expect(classOf(tile)).not.toMatch(/(?:^|\s)p-[^\s]+/);
  expect(classOf(text)).not.toMatch(
    /(?:^|\s)(?:bg-[^\s]*|outline(?:-[^\s]*)?|border(?:-[^\s]*)?|shadow(?:-[^\s]*)?)(?:\s|$)/,
  );
  expect(classOf(text)).toMatch(/(?:^|\s)p-2(?:\s|$)/);
  expect(classOf(frame)).not.toMatch(/(?:^|\s)(?:bg-[^\s]*|border(?:-[^\s]*)?|p-[^\s]+|rounded(?:-[^\s]+)?)(?:\s|$)/);
  expect(classOf(aspect)).toContain('rounded-lg');
  expect(classOf(aspect)).toContain('bg-transparent');
  expect(classOf(aspect)).toContain('ring-0');
  expect(classOf(aspect)).not.toContain('bg-muted');
  expect(classOf(aspect)).not.toContain('ring-1');
  expect(frame).toContain('data-ratio="5:7"');
  expect(html.indexOf('data-slot="cover"')).toBeLessThan(html.indexOf('data-slot="cover-card-text"'));
  expect(classOf(title)).toContain('text-center');
  expect(classOf(title)).toContain('line-clamp-2');
  expect(classOf(title)).toContain('text-xs');
  expect(classOf(secondary)).toContain('text-center');
  expect(classOf(secondary)).toContain('line-clamp-1');
  expect(classOf(state)).toContain('pt-0.5');
  expect(classOf(progress)).toContain('flex');
  expect(html.indexOf('data-slot="cover-card-actions"')).toBeGreaterThan(html.indexOf('data-slot="cover-card-text"'));
  expect(html.indexOf('>35%</span>')).toBeLessThan(html.indexOf('data-slot="cover-card-actions"'));
  expect(classOf(tagWith(html, 'data-slot="cover-card-actions-row"'))).toContain('mt-auto');
  expect(html.indexOf('role="progressbar"')).toBeLessThan(html.indexOf('>35%</span>'));
  expect(classOf(actions)).not.toContain('absolute');
  expect(html).toContain('tabular-nums');
});

test('a card without progress keeps its menu before its status in the state row', () => {
  const html = renderToStaticMarkup(
    createElement(CoverCard, {
      href: '/book-1',
      title: cover.subject.title,
      cover,
      state: 'Planned',
      menuLabel: 'More actions',
      menu: createElement('span', null, 'Remove'),
    }),
  );
  expect(html).toContain('data-slot="cover-card-actions"');
  expect(html).toContain('>Planned</div>');
  expect(html.indexOf('data-slot="cover-card-actions"')).toBeLessThan(html.indexOf('>Planned</div>'));
  expect(html).not.toContain('role="progressbar"');
});

test('fallback ratios follow the product families and mixed grids tie to 5:7', () => {
  const families: [string[], string][] = [
    [['schema:Book'], '5:7'],
    [['wd:Q47461344'], '5:7'],
    [['bf:Instance'], '5:7'],
    [['wd:Q3331189'], '5:7'],
    [['schema:BookSeries'], '5:7'],
    [['wd:Q277759'], '5:7'],
    [['schema:ComicSeries'], '5:7'],
    [['wd:Q21198342'], '5:7'],
    [['schema:PublicationVolume'], '5:7'],
    [['wd:Q1238720'], '5:7'],
    [['schema:TVSeries'], '5:7'],
    [['wd:Q5398426'], '5:7'],
    [['schema:TVSeason'], '5:7'],
    [['wd:Q3464665'], '5:7'],
    [['schema:Movie'], '5:7'],
    [['wd:Q11424'], '5:7'],
    [['wd:Q1983062'], '5:7'],
    [['wd:Q689445'], '5:7'],
    [['wd:Q7889'], '5:7'],
    [['wd:Q20631656'], '5:7'],
    [['wd:Q209163'], '5:7'],
    [['schema:VideoGame'], '5:7'],
    [['schema:CreativeWork'], '5:7'],
    [['wd:Q7725310'], '5:7'],
    [['schema:Person'], '3:4'],
    [['wd:Q5'], '3:4'],
    [['wd:Q95074'], '3:4'],
    [['schema:MusicAlbum'], '1:1'],
    [['schema:Organization'], '1:1'],
    [['wd:Q43229'], '1:1'],
    [['wd:Q482994'], '1:1'],
    [['wd:Q219239'], '4:3'],
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
  ).toBe('5:7');
});

test('definition ratios reach Cover unchanged and invalid ratios use the subject type default', async () => {
  const originalFetch = globalThis.fetch;
  let release: {
    types: Record<string, { labels?: Record<string, string>; bases?: string[]; coverRatio?: string }>;
    properties: Record<string, unknown>;
  };
  let digest = '';
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const typeId = decodeURIComponent(url.pathname.slice('/v1/definitionTypes/'.length));
    const definition = release.types[typeId];
    if (url.pathname.startsWith('/v1/definitionTypes/') && definition)
      return Response.json({ typeId, releaseDigest: digest, label: 'poster', language: 'en', definition });
    return new Response(null, { status: 404 });
  };

  const renderFrame = (type: string, ratio?: string) =>
    renderToStaticMarkup(
      createElement(Cover, {
        subject: { id: type, title: type, types: [type] },
        cover: null,
        src: () => '',
        size: 'fill',
        ...(ratio ? { ratio: ratio as CoverRatio } : {}),
      }),
    );
  const frameRatio = (html: string) => html.match(/data-ratio="([^"]+)"/)?.[1];

  try {
    for (const [index, ratio] of ['5:7', '9:16'].entries()) {
      digest = `cover-test-release-${index}`;
      workerEnv.KERNEL_ORIGIN = `https://definitions-cover-${index}.invalid`;
      release = {
        types: { 'example:Poster': { labels: { en: 'Poster' }, coverRatio: ratio } },
        properties: {},
      };
      const frame = await typeFrame('example:Poster', 'en');
      expect(frame.ratio).toBe(ratio);
      expect(frameRatio(renderFrame('example:Poster', frame.ratio))).toBe(ratio);
    }

    workerEnv.KERNEL_ORIGIN = 'https://definitions-cover-invalid.invalid';
    digest = 'cover-test-release-invalid';
    release = { types: { 'schema:Book': { labels: { en: 'Book' }, coverRatio: '65:1' } }, properties: {} };
    const invalid = await typeFrame('schema:Book', 'en');
    expect(invalid.ratio).toBeUndefined();
    expect(frameRatio(renderFrame('schema:Book', invalid.ratio))).toBe('5:7');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test(
  'all tile surfaces use CoverCard, and Space uses the localized definition name',
  async () => {
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
        const types = opened.page.locator(
          '[aria-labelledby="realm-published-heading"] [data-slot="cover-card-secondary"]',
        );
        await types.first().waitFor();
        const labels = (await types.allTextContents()).map((label) => label.trim());
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.every((label) => label === (locale === 'zh-Hans' ? '书籍' : 'Book'))).toBe(true);
        expect(labels.some((label) => label === 'schema:Book')).toBe(false);
      } finally {
        await opened.context.close();
      }
    }
  },
  timeout,
);

test(
  'the cover wall default fits two phone columns and about eight wide columns with 8 px gaps',
  async () => {
    const layouts: Record<number, number> = { 390: 2, 1280: 8 };
    let defaultWideTracks = 0;
    for (const [widthText, expected] of Object.entries(layouts)) {
      const width = Number(widthText);
      const opened = await openStory('cover-wall.stories.tsx', 'Default', 'en', width);
      try {
        const grid = opened.page.locator('[data-slot="cover-grid"]');
        await grid.waitFor();
        expect(await grid.locator(':scope > article').count()).toBe(14);
        const layout = await grid.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            tracks: style.gridTemplateColumns.trim().split(/\s+/).length,
            rowGap: style.rowGap,
            columnGap: style.columnGap,
          };
        });
        expect(layout.rowGap).toBe('8px');
        expect(layout.columnGap).toBe('8px');
        if (width === 390) expect(layout.tracks).toBe(expected);
        else {
          expect(layout.tracks).toBeGreaterThanOrEqual(expected - 1);
          expect(layout.tracks).toBeLessThanOrEqual(expected + 1);
          defaultWideTracks = layout.tracks;
        }
      } finally {
        await opened.context.close();
      }
    }

    for (const name of ['Small', 'Large']) {
      const opened = await openStory('cover-wall.stories.tsx', name, 'en', 1280);
      try {
        const grid = opened.page.locator('[data-slot="cover-grid"]');
        await grid.waitFor();
        expect(await grid.locator(':scope > article').count()).toBe(14);
        const tracks = await grid.evaluate(
          (element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
        );
        if (name === 'Small') expect(tracks).toBeGreaterThan(defaultWideTracks);
        else expect(tracks).toBeLessThan(defaultWideTracks);
      } finally {
        await opened.context.close();
      }
    }
  },
  timeout,
);
