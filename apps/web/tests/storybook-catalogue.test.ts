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
    for (let index = 0; index < 30; index++) {
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
    await page.close();
  }, 120_000);

  test('keeps page and pattern stories in their product areas with compact titles', async () => {
    const stories = Object.values(readIndex(resolve(output, 'index.json')).entries).filter(
      (entry) => entry.type === 'story',
    );
    const pageAreas = ['Library', 'Subjects', 'Discovery', 'Community', 'Commerce', 'Account'];
    const pages = stories.filter((entry) => entry.title.startsWith('Pages/'));
    const patterns = stories.filter((entry) => entry.title.startsWith('Patterns/'));
    expect(pages.length).toBeGreaterThan(0);
    expect(
      pages.every((entry) => {
        const [, area, page, extra] = entry.title.split('/');
        return pageAreas.includes(area ?? '') && Boolean(page) && extra === undefined;
      }),
    ).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
    expect(
      patterns.every((entry) => {
        const [, area, pattern, extra] = entry.title.split('/');
        return pageAreas.includes(area ?? '') && Boolean(pattern) && extra === undefined;
      }),
    ).toBe(true);
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
    for (let index = 0; index < 30; index++) {
      const expand = tree.getByLabel('Expand').first();
      if (!(await expand.count())) break;
      await expand.click();
    }
    const visibleCounts = new Map<string, number>();
    for (const entry of stories) {
      if (!entry.title.startsWith('Pages/') && !entry.title.startsWith('Patterns/')) continue;
      if (!(await tree.locator(`[data-item-id="${entry.id}"]`).count())) continue;
      visibleCounts.set(entry.title, (visibleCounts.get(entry.title) ?? 0) + 1);
    }
    expect([...visibleCounts].filter(([, count]) => count > 8)).toEqual([]);
    await page.close();
  });

  test('renders patterns without the site shell and honors a phone-only viewport global', async () => {
    const stories = Object.values(readIndex(resolve(output, 'index.json')).entries).filter(
      (entry) => entry.type === 'story',
    );
    const pattern = stories.find((entry) => entry.title === 'Patterns/Account/Shell' && entry.name === 'Member');
    const phone = stories.find(
      (entry) => entry.title === 'Patterns/Discovery/Search filters' && entry.name === 'Filter sheet open',
    );
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
    await page.goto(`${server.url}index.html?path=/story/${phone!.id}`);
    const phoneFrame = page.frameLocator('#storybook-preview-iframe');
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
