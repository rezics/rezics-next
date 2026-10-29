import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

const root = resolve(import.meta.dir, '../../..');
const app = resolve(root, 'apps/web');
const output = resolve(app, 'storybook-static');
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

type Entry = { id: string; title: string; name: string; type: string; importPath?: string };
type Index = { entries: Record<string, Entry> };

function readIndex(path: string): Index {
  return JSON.parse(readFileSync(path, 'utf8')) as Index;
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

describe('review Storybook catalogue', () => {
  test('publishes the web and composed UI catalogues with the required sidebar groups', async () => {
    const web = readIndex(resolve(output, 'index.json'));
    const ui = readIndex(resolve(output, 'ui/index.json'));
    const webTitles = [...new Set(Object.values(web.entries).map((entry) => entry.title.split('/')[0]!))];
    const uiTitles = [...new Set(Object.values(ui.entries).map((entry) => entry.title.split('/')[0]!))];
    expect(webTitles.slice(0, 2)).toEqual(['Review', 'Pages']);
    expect(uiTitles.at(-1)).toBe('shadcn');

    const pageTitles = [...new Set(Object.values(web.entries).map((entry) => entry.title))].filter((title) =>
      title.startsWith('Pages/'),
    );
    const library = pageTitles.filter((title) => title.startsWith('Pages/Library/'));
    expect(pageTitles.slice(0, library.length)).toEqual(library);
    expect(Object.values(web.entries).some((entry) => entry.title === 'Shell/Page heading')).toBe(true);
    expect(existsSync(resolve(output, 'ui/index.html'))).toBe(true);
  });

  test("retains the base web story exports and resolves the review docs' story links", () => {
    const index = readIndex(resolve(output, 'index.json'));
    const baseFiles = Bun.spawnSync(['git', 'ls-tree', '-r', '--name-only', 'HEAD', 'apps/web/src/stories'], {
      cwd: root,
    })
      .stdout.toString()
      .split('\n')
      .filter((path) => path.endsWith('.stories.tsx'));
    const builtPaths = new Set(Object.values(index.entries).map((entry) => entry.importPath));
    for (const path of baseFiles)
      expect(builtPaths, `missing base story module ${path}`).toContain(`../${path.slice('apps/web/'.length)}`);

    const docs = [
      'apps/web/src/stories/review/start-reviewing.mdx',
      'apps/web/src/stories/review/library-and-collections.mdx',
      'apps/web/src/stories/review/state-coverage.mdx',
    ];
    const stories = Object.values(index.entries).filter((entry) => entry.type === 'story');
    for (const path of docs) {
      const source = readFileSync(resolve(root, path), 'utf8');
      const imports = new Map<string, string>();
      for (const [, names, module] of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g))
        for (const name of names!.split(',').map((item) => item.trim().split(/\s+as\s+/)[0]!))
          imports.set(name, module!);
      for (const [, storyExport] of source.matchAll(/<Story\s+of=\{([A-Za-z_$][\w$]*)\}\s*\/>/g)) {
        const module = imports.get(storyExport!);
        expect(module, `${path} imports rendered story ${storyExport}`).toBeTruthy();
        const moduleSuffix = resolve(root, 'apps/web/src/stories/review', `${module}.stories.tsx`).replace(
          `${app}/`,
          '../',
        );
        expect(
          stories.some((entry) => entry.importPath === moduleSuffix),
          `${path} story module is indexed: ${moduleSuffix}`,
        ).toBe(true);
      }
    }
    for (const title of ['Review/Start reviewing', 'Review/Library and Collections', 'Review/State coverage'])
      expect(Object.values(index.entries).some((entry) => entry.type === 'docs' && entry.title === title)).toBe(true);
  });

  test("Start reviewing displays this build's commit and build time", async () => {
    const metadata = JSON.parse(readFileSync(resolve(output, 'build.json'), 'utf8')) as {
      commit: string;
      builtAt: string;
    };
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${server.url}?path=/docs/review-start-reviewing--docs`);
    await page.getByText(metadata.commit).waitFor();
    await page.getByText(metadata.builtAt).waitFor();
    await page.close();
  });
});
