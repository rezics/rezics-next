import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

const root = resolve(import.meta.dir, '../../..');
const app = resolve(root, 'apps/web');
const output = resolve(app, 'storybook-static');
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

type Entry = { id: string; title: string; name: string; type: string; importPath?: string; tags?: string[] };
type Index = { entries: Record<string, Entry> };

const productAreas = [
  'Library',
  'Subjects',
  'Discovery',
  'Community',
  'Commerce',
  'Account',
  'Catalogue',
  'Zones',
  'Imports',
  'Accounts',
  'Subject',
  'Settings',
  'Following',
  'Navigation',
  'Search',
];
// Supplied shared folders keep their canonical IDs instead of acquiring an artificial product area.
const sharedFolders = new Set([
  'Patterns/Appeal Resolution',
  'Patterns/Collection Editor',
  'Patterns/Collection Preview',
  'Patterns/Collection Row',
  'Patterns/Header Search',
  'Patterns/Moderation Queue',
  'Patterns/Phone Shell',
  'Patterns/Realm Participation',
  'Patterns/Reporter status',
  'Patterns/Subject Community',
  'Patterns/Type Presentation',
  'Pages/Moderation appeals',
  'Pages/Reporter status',
  'Pages/Subject Sources',
]);

function hasCatalogueTitle(title: string): boolean {
  if (sharedFolders.has(title)) return true;
  const [tier, area, name, child, extra] = title.split('/');
  return (
    (tier === 'Pages' || tier === 'Patterns') &&
    productAreas.includes(area ?? '') &&
    Boolean(name?.trim()) &&
    extra === undefined &&
    (child === undefined ||
      (tier === 'Pages' &&
        area === 'Account' &&
        name === 'Management' &&
        ['Account', 'Accounts', 'Organization'].includes(child)))
  );
}

function readIndex(path: string): Index {
  return JSON.parse(readFileSync(path, 'utf8')) as Index;
}

function docsId(title: string): string {
  const entry = Object.values(readIndex(resolve(output, 'index.json')).entries).find(
    (candidate) => candidate.type === 'docs' && candidate.title === title,
  );
  if (!entry) throw new Error(`Missing docs entry: ${title}`);
  return entry.id;
}

beforeAll(async () => {
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  const commit = revision.exitCode === 0 ? revision.stdout.toString().trim() : '0'.repeat(40);
  const build = Bun.spawnSync(['bun', 'run', '--cwd', 'apps/web', 'storybook:build'], {
    cwd: root,
    env: { ...process.env, STORYBOOK_COMMIT: commit },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  expect(build.exitCode).toBe(0);
  browser = await chromium.launch({ headless: true });
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const path = resolve(output, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (!path.startsWith(`${output}/`)) return new Response('not found', { status: 404 });
      const file = Bun.file(path);
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
  });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe('Storybook catalogue', () => {
  test('publishes the web and composed UI catalogues with the required sidebar groups', async () => {
    const web = readIndex(resolve(output, 'index.json'));
    const ui = readIndex(resolve(output, 'ui/index.json'));
    const uiTitles = [
      ...new Set(
        Object.values(ui.entries)
          .filter((entry) => entry.type === 'story')
          .map((entry) => entry.title.split('/')[0]!),
      ),
    ];
    expect(uiTitles).toEqual(['Components', 'shadcn']);
    expect(Object.values(web.entries).some((entry) => entry.title === 'Overview')).toBe(true);
    expect(
      Object.values(web.entries).some((entry) => entry.title === 'Review' || entry.title.startsWith('Review/')),
    ).toBe(false);
    expect(
      Object.values(web.entries).filter((entry) => entry.type === 'docs' && entry.title === 'Overview'),
    ).toHaveLength(1);
    expect(existsSync(resolve(output, 'ui/index.html'))).toBe(true);

    const page = await browser.newPage();
    await page.goto(`${server.url}index.html?path=/docs/${docsId('Overview')}`);
    const tree = page.locator('#storybook-explorer-tree');
    await tree.waitFor();
    for (let index = 0; index < Object.keys(web.entries).length; index++) {
      const expand = tree.getByLabel('Expand').first();
      if (!(await expand.count())) break;
      await expand.click();
    }
    const sidebar = (await tree.innerText()).split('\n');
    const at = (label: string) => sidebar.indexOf(label);
    expect(at('Overview')).toBeGreaterThanOrEqual(0);
    expect(at('Pages')).toBeGreaterThan(at('Overview'));
    expect(at('Patterns')).toBeGreaterThan(at('Pages'));
    for (const [before, after] of [
      ['Library', 'Subjects'],
      ['Subjects', 'Discovery'],
      ['Discovery', 'Community'],
      ['Community', 'Commerce'],
      ['Commerce', 'Account'],
    ])
      expect(at(after!)).toBeGreaterThan(at(before!));
    for (const area of ['Catalogue', 'Zones', 'Imports']) expect(at(area)).toBeGreaterThan(at('Account'));
    await page.close();
  }, 120_000);

  test('keeps complete page and pattern folders with compact canonical titles', async () => {
    const stories = Object.values(readIndex(resolve(output, 'index.json')).entries).filter(
      (entry) => entry.type === 'story',
    );
    const pages = stories.filter((entry) => entry.title.startsWith('Pages/'));
    const patterns = stories.filter((entry) => entry.title.startsWith('Patterns/'));
    expect(pages.length).toBeGreaterThan(0);
    for (const entry of pages) expect(hasCatalogueTitle(entry.title), entry.title).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    for (const entry of patterns) expect(hasCatalogueTitle(entry.title), entry.title).toBe(true);
    expect(new Set(stories.map((entry) => `${entry.title}\0${entry.name}`)).size).toBe(stories.length);
    for (const title of ['Patterns/Unknown shared folder', 'Pages/Unknown/Page', 'Patterns/Library/Entry/Empty'])
      expect(hasCatalogueTitle(title), title).toBe(false);
    expect(pages.some((entry) => entry.title === 'Pages/Discovery/Search')).toBe(true);
    expect(pages.some((entry) => entry.title === 'Pages/Discovery/Search Empty')).toBe(false);
    expect(pages.some((entry) => entry.title === 'Pages/Discovery/Search Typed')).toBe(false);
    const pageAndPatternStories = stories.filter(
      (entry) => entry.title.startsWith('Pages/') || entry.title.startsWith('Patterns/'),
    );
    expect(
      pageAndPatternStories.filter((entry) =>
        /\b(?:390|1280)(?:px)?\b|\b(?:phone|mobile|desktop|tablet|light|dark|english|japanese|chinese|locale)\b/i.test(
          entry.name,
        ),
      ),
    ).toEqual([]);
    expect(pages.some((entry) => entry.title === 'Pages/Library/Collection details')).toBe(false);
    const page = await browser.newPage();
    await page.goto(`${server.url}index.html?path=/docs/${docsId('Overview')}`);
    const tree = page.locator('#storybook-explorer-tree');
    await tree.waitFor();
    for (let index = 0; index < stories.length; index++) {
      const expand = tree.getByLabel('Expand').first();
      if (!(await expand.count())) break;
      await expand.click();
    }
    const visibleCounts = new Map<string, number>();
    const requiredCounts = new Map<string, number>();
    const visibleIds = new Set(
      await tree
        .locator('[data-item-id]')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-item-id'))),
    );
    for (const entry of stories) {
      if (!entry.title.startsWith('Pages/') && !entry.title.startsWith('Patterns/')) continue;
      if (entry.tags?.includes('dev')) requiredCounts.set(entry.title, (requiredCounts.get(entry.title) ?? 0) + 1);
      if (visibleIds.has(entry.id)) visibleCounts.set(entry.title, (visibleCounts.get(entry.title) ?? 0) + 1);
    }
    expect([...visibleCounts].sort()).toEqual([...requiredCounts].sort());
    await page.close();
  }, 120_000);

  test('indexes every existing component-family state with one complete CSF and docs owner', () => {
    const index = readIndex(resolve(output, 'index.json'));
    const families = [
      {
        title: 'Pages/Library/Collection',
        id: 'pages-library-collection',
        file: 'library-collection.stories.tsx',
        states: [
          'signed-in',
          'signed-out',
          'public-item-list-export',
          'public-item-list-export-owner-unavailable',
          'public-item-list-export-incomplete',
          'curator-public-many',
          'grid-layout',
          'reader-public-many',
          'curator-private-empty',
          'reader-private',
          'curator-public-one-page',
          'owner-menu',
          'mixed-types',
          'members-preparing',
          'unavailable',
          'error',
          'another-reader',
          'curator',
          'private-curator',
          'private-not-found',
          'unknown-not-found',
          'unlisted-visitor',
          'public-visitor',
          'empty',
          'one-page',
          'many-pages',
          'notes-and-duplicates',
          'deep-page',
          'final-page',
          'preparing',
          'restart-after-epoch-change',
        ],
      },
      {
        title: 'Pages/Subjects/Subject',
        id: 'pages-subjects-subject',
        file: 'subject.stories.tsx',
        states: [
          'signed-in',
          'signed-out',
          'library-slot-menu-phone',
          'library-slot-menu-desktop',
          'overview-reactions-english-phone',
          'overview-reactions-chinese-phone',
          'cover-viewer-open',
          'cover-viewer-interaction',
          'hero-signed-in-spoilers-hidden',
          'hero-signed-in-spoilers-shown',
          'hero-signed-out-spoilers-hidden',
          'hero-signed-out-spoilers-shown',
          'global-score',
          'realms-and-own-vote',
          'below-threshold',
          'imported-scores',
          'own-vote-forbidden',
          'count-unavailable',
          'exposure-open',
          'exposure-closed',
          'undo-after-library-removal',
          'undo-restored',
          'restore-occupied',
          'restore-stale',
          'restore-expired',
          'public-community',
          'editions',
          'editions-second-page',
        ],
      },
      {
        title: 'Pages/Discovery/Search',
        id: 'pages-discovery-search',
        file: 'search-rating.stories.tsx',
        states: [
          'signed-out',
          'signed-in',
          'typed',
          'empty-query',
          'no-results',
          'facets',
          'active-facet',
          'top-rated',
          'mixed-cards',
          'mixed-unavailable',
          'mixed-preparing',
          'factual-unknown-kind',
          'restart-required',
          'continued-results',
          'more-kind-metadata',
        ],
      },
      {
        title: 'Pages/Community/Thread',
        id: 'pages-community-thread',
        file: 'thread-media.stories.tsx',
        states: [
          'available',
          'unavailable',
          'overflow',
          'image-failure',
          'reply-media-unavailable',
          'reply-media-unknown',
          'thread',
          'editor-mention',
          'composer-submission',
        ],
      },
    ];
    for (const family of families) {
      const entries = Object.values(index.entries).filter((entry) => entry.title === family.title);
      expect(
        entries
          .filter((entry) => entry.type === 'story')
          .map((entry) => entry.id)
          .sort(),
        family.title,
      ).toEqual(family.states.map((state) => `${family.id}--${state}`).sort());
      // Docs and every story must resolve to the same module, rather than the last of several competing metas.
      for (const entry of entries) expect(entry.importPath, entry.id).toEndWith(`src/stories/${family.file}`);
    }
  });

  test('indexes every actual Collection editor state under its supplied canonical folder', () => {
    const index = readIndex(resolve(output, 'index.json'));
    const states = [
      'details',
      'members',
      'selection',
      'reordering',
      'note',
      'save-pending',
      'save-error',
      'dynamic-rule',
      'presentation',
      'removal-and-undo',
      'expired-undo',
      'selection-unavailable',
      'selected-removal',
      'selected-move',
    ];
    for (const state of states) {
      const id = `patterns-collection-editor--${state}`;
      expect(index.entries[id], id).toMatchObject({ id, type: 'story', title: 'Patterns/Collection Editor' });
      expect(index.entries[id]!.importPath).toEndWith('src/stories/library-collection-editor.stories.tsx');
      expect(index.entries[id]!.tags).toContain('dev');
    }
  });

  test('opens the actual Collection Details editor at both viewport globals using the same ID', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    for (const [viewport, width] of [
      ['phone390', 390],
      ['desktop1280', 1280],
    ] as const) {
      await page.goto(
        `${server.url}index.html?path=/story/patterns-collection-editor--details&globals=locale:en;theme:light;viewport.value:${viewport};viewport.isRotated:!false`,
      );
      const frame = page.frameLocator('#storybook-preview-iframe');
      await frame.getByRole('textbox', { name: 'Title', exact: true }).waitFor();
      expect(await frame.locator('header').count()).toBe(0);
      expect(await frame.locator('html').evaluate((element) => element.ownerDocument.defaultView?.innerWidth)).toBe(
        width,
      );
    }
    await page.close();
  }, 120_000);

  test('renders patterns without the site shell and honors a phone-only viewport global', async () => {
    const stories = Object.values(readIndex(resolve(output, 'index.json')).entries).filter(
      (entry) => entry.type === 'story',
    );
    const pattern = stories.find((entry) => entry.title === 'Patterns/Account/Shell' && entry.name === 'Member');
    const phone = stories.find((entry) => entry.id === 'pages-discovery-search--active-facet');
    expect(pattern).toBeDefined();
    expect(phone).toBeDefined();
    expect(
      stories.some((entry) => entry.title === 'Patterns/Library/Cover wall' && entry.name === 'Mixed media wall'),
    ).toBe(true);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${server.url}index.html?path=/story/${pattern!.id}`);
    const frame = page.frameLocator('#storybook-preview-iframe');
    await frame.locator('main').waitFor();
    expect(await frame.locator('header').count()).toBe(0);
    expect(await frame.locator('nav').count()).toBe(0);
    await page.goto(
      `${server.url}index.html?path=/story/${phone!.id}&globals=viewport.value:phone390;viewport.isRotated:!false`,
    );
    const phoneFrame = page.frameLocator('#storybook-preview-iframe');
    await phoneFrame.locator('main').waitFor();
    await phoneFrame.getByRole('button', { name: /^Filters \(\d+\)$/ }).click();
    const filterSheet = phoneFrame.getByRole('dialog');
    await filterSheet.waitFor();
    expect(await phoneFrame.getByRole('checkbox', { name: 'Fable' }).isChecked()).toBe(true);
    expect(await phoneFrame.locator('html').evaluate((element) => element.ownerDocument.defaultView?.innerWidth)).toBe(
      390,
    );
    await page.close();
  }, 60_000);

  test("retains the base web story exports and resolves Overview's story links", () => {
    const index = readIndex(resolve(output, 'index.json'));
    const baseFiles = readdirSync(resolve(app, 'src/stories'), { recursive: true })
      .filter((path): path is string => typeof path === 'string' && path.endsWith('.stories.tsx'))
      .map((path) => `src/stories/${path}`);
    for (const path of baseFiles) {
      const moduleStories = Object.values(index.entries).filter(
        (entry) => entry.type === 'story' && entry.importPath?.endsWith(path),
      );
      const source = readFileSync(resolve(app, path), 'utf8');
      const exports = source.match(/^export\s+(?:const|function|class)\s+[A-Za-z_$][\w$]*/gm) ?? [];
      expect(moduleStories.length, `base story exports resolve from ${path}`).toBe(exports.length);
      for (const story of moduleStories) expect(index.entries[story.id]).toBe(story);
    }

    const docs = ['apps/web/src/stories/overview.mdx'];
    const stories = Object.values(index.entries).filter((entry) => entry.type === 'story');
    for (const path of docs) {
      const source = readFileSync(resolve(root, path), 'utf8');
      for (const [, module] of source.matchAll(/from ['"](\.\.\/[^'"]+\.stories)['"]/g)) {
        const moduleSuffix = `${module!.replace(/^\.\.\//, '')}.tsx`;
        expect(
          stories.some((entry) => entry.importPath?.endsWith(moduleSuffix)),
          `${path} story module is indexed: ${moduleSuffix}`,
        ).toBe(true);
      }
      for (const [, storyId] of source.matchAll(/\?path=\/story\/([\w-]+)/g))
        expect(index.entries[storyId!]?.type, `${path} links to story ${storyId}`).toBe('story');
    }
    expect(Object.values(index.entries).some((entry) => entry.type === 'docs' && entry.title === 'Overview')).toBe(
      true,
    );
  });

  test("Overview displays this build's commit and build time", async () => {
    const metadata = JSON.parse(readFileSync(resolve(output, 'build.json'), 'utf8')) as {
      commit: string;
      builtAt: string;
    };
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${server.url}index.html?path=/docs/${docsId('Overview')}`);
    const preview = page.frameLocator('#storybook-preview-iframe');
    await preview.getByText(metadata.commit).waitFor({ timeout: 15_000 });
    await preview.getByText(metadata.builtAt).waitFor({ timeout: 15_000 });
    await page.close();
  }, 30_000);

  test('renders Overview in English and Japanese across themes and viewport widths', async () => {
    const pages = [[docsId('Overview'), 'Storybook catalogue']] as const;
    const page = await browser.newPage();
    for (const [id, heading] of pages) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${server.url}index.html?path=/docs/${id}`, { waitUntil: 'domcontentloaded' });
      const preview = page.frameLocator('#storybook-preview-iframe');
      await preview.getByRole('heading', { name: heading }).waitFor({ timeout: 15_000 });
      for (const locale of ['en', 'ja']) {
        for (const theme of ['light', 'dark']) {
          for (const width of [390, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            const html = preview.locator('html');
            await html.evaluate(
              (element, globals) => {
                element.lang = globals.locale;
                element.classList.remove('light', 'dark');
                element.classList.add(globals.theme);
              },
              { locale, theme },
            );
            expect(await html.getAttribute('lang')).toBe(locale);
            expect(await html.getAttribute('class')).toContain(theme);
          }
        }
      }
    }
    await page.close();
  }, 300_000);
});
