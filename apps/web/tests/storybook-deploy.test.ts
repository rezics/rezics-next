import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { runDeployment } from '../scripts/storybook-deploy.ts';
import { smokeStorybook } from '../scripts/storybook-smoke.ts';

const root = resolve(import.meta.dir, '../../../');
const app = resolve(root, 'apps/web');
const output = resolve(app, 'storybook-static');
let browser: Browser;
let previewServer: ReturnType<typeof Bun.serve>;
let expectedCommit: string;

function countStories(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return count + countStories(path);
    if (!entry.name.endsWith('.stories.tsx')) return count;
    return count + (readFileSync(path, 'utf8').match(/^export const \w+\s*:/gm)?.length ?? 0);
  }, 0);
}

beforeAll(async () => {
  const gitCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root });
  expectedCommit = gitCommit.exitCode === 0 ? gitCommit.stdout.toString().trim() : '0'.repeat(40);
  const build = Bun.spawnSync(['bun', 'run', '--cwd', 'apps/web', 'storybook:build'], {
    cwd: root,
    env: { ...process.env, STORYBOOK_COMMIT: expectedCommit, STORYBOOK_OUTPUT_DIR: output },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  expect(build.exitCode).toBe(0);
  browser = await chromium.launch({ headless: true });
  previewServer = Bun.serve({
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
  previewServer?.stop(true);
});

describe('storybook review build', () => {
  test('builds both catalogues into one site with complete indexes and build metadata', () => {
    const index = JSON.parse(readFileSync(resolve(output, 'index.json'), 'utf8')) as {
      entries: Record<string, { title: string; type: string }>;
    };
    const uiIndex = JSON.parse(readFileSync(resolve(output, 'ui/index.json'), 'utf8')) as {
      entries: Record<string, { title: string; type: string }>;
    };
    const pages = Object.values(index.entries).filter(
      (entry) => entry.type === 'story' && entry.title.startsWith('Pages/'),
    );
    expect(pages.length).toBeGreaterThanOrEqual(countStories(resolve(app, 'src/stories')));
    expect(Object.values(index.entries).some((entry) => entry.title === 'Shell/Page heading')).toBe(false);
    expect(Object.values(uiIndex.entries).filter((entry) => entry.type === 'story').length).toBeGreaterThanOrEqual(
      countStories(resolve(root, 'packages/ui/src')),
    );
    expect(Object.values(index.entries).some((entry) => /accessibility.?probe/i.test(entry.title))).toBe(false);
    expect(Object.values(uiIndex.entries).some((entry) => /accessibility.?probe/i.test(entry.title))).toBe(false);
    expect(existsSync(resolve(output, 'ui/index.html'))).toBe(true);

    const metadata = JSON.parse(readFileSync(resolve(output, 'build.json'), 'utf8')) as {
      commit: string;
      storybookVersion: string;
      builtAt: string;
    };
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(metadata.storybookVersion).toMatch(/^11\./);
    expect(Number.isNaN(Date.parse(metadata.builtAt))).toBe(false);
    expect(metadata.builtAt).toMatch(/Z$/);
    expect(metadata.commit).toBe(expectedCommit);
  });

  test('serves deep links for a page, a composed UI story, a translated dark story, and recorded cover media', async () => {
    expect(previewServer).toBeDefined();
    await smokeStorybook(previewServer.url.toString(), browser);
    const metadata = JSON.parse(readFileSync(resolve(output, 'build.json'), 'utf8')) as {
      commit: string;
      builtAt: string;
    };
    const page = await browser.newPage();
    try {
      await page.goto(previewServer.url.toString());
      await page.waitForFunction((expected) => document.title.includes(expected), metadata.commit.slice(0, 7));
      expect(await page.title()).toContain(metadata.builtAt);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe('deployment sequencing', () => {
  test('uploads only after build and smoke pass, then routes and prints that version preview URL', async () => {
    const calls: string[] = [];
    const outputLines: string[] = [];
    await runDeployment({
      dryRun: false,
      build: async () => {
        calls.push('build');
      },
      smoke: async () => {
        calls.push('smoke');
      },
      wrangler: async (args) => {
        calls.push(args[1]!);
        return args[1] === 'upload'
          ? 'Version ID: ver-123\nPreview URL: https://ver-123.storybook.rezics.workers.dev'
          : 'deployed';
      },
      print: (line) => outputLines.push(line),
    });
    expect(calls).toEqual(['build', 'smoke', 'upload', 'deploy']);
    expect(outputLines.join('\n')).toContain('https://ver-123.storybook.rezics.workers.dev');
  });

  test('dry run invokes Wrangler dry run without publishing a version or routing the domain', async () => {
    const calls: string[][] = [];
    await runDeployment({
      dryRun: true,
      build: async () => {},
      smoke: async () => {},
      wrangler: async (args) => {
        calls.push(args);
        return 'dry run';
      },
      print: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--dry-run');
    expect(calls[0]).not.toContain('deploy');
  });

  test('failed build or smoke test never uploads', async () => {
    for (const failure of ['build', 'smoke'] as const) {
      const calls: string[] = [];
      await expect(
        runDeployment({
          dryRun: false,
          build: async () => {
            calls.push('build');
            if (failure === 'build') throw new Error('build failed');
          },
          smoke: async () => {
            calls.push('smoke');
            if (failure === 'smoke') throw new Error('smoke failed');
          },
          wrangler: async () => {
            calls.push('upload');
            return '';
          },
          print: () => {},
        }),
      ).rejects.toThrow(`${failure} failed`);
      expect(calls).not.toContain('upload');
    }
  });
});

test('the build output is ignored by git', () => {
  const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
  expect(ignore).toMatch(/storybook-static/);
  const web = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(web.scripts['storybook:build']).toContain('scripts/storybook-build.ts');
  const configText = readFileSync(resolve(app, 'storybook.wrangler.jsonc'), 'utf8').replace(/,\s*([}\]])/g, '$1');
  const config = JSON.parse(configText) as {
    name: string;
    preview_urls: boolean;
    routes: { pattern: string; custom_domain: boolean }[];
    assets: { directory: string };
  };
  expect(config.name).toBe('rezics-storybook');
  expect(config.preview_urls).toBe(true);
  expect(config.routes).toContainEqual({ pattern: 'storybook.rezics.com', custom_domain: true });
  expect(config.assets.directory).toBe('./storybook-static');
});
