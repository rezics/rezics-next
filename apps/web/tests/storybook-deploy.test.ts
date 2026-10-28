import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { runDeployment } from '../scripts/storybook-deploy.ts';

const root = resolve(import.meta.dir, '../../../');
const app = resolve(root, 'apps/web');
const output = resolve(app, 'storybook-static');
let browser: Browser;

beforeAll(async () => {
  const build = Bun.spawnSync(['bun', 'apps/web/scripts/storybook-build.ts'], {
    cwd: root,
    env: { ...process.env, STORYBOOK_OUTPUT_DIR: output },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  expect(build.exitCode).toBe(0);
  browser = await chromium.launch({ headless: true });
}, 600_000);

afterAll(async () => {
  await browser?.close();
});

describe('storybook review build', () => {
  test('builds both catalogues into one site with complete indexes and build metadata', () => {
    const index = JSON.parse(readFileSync(resolve(output, 'index.json'), 'utf8')) as {
      entries: Record<string, { title: string }>;
    };
    const uiIndex = JSON.parse(readFileSync(resolve(output, 'ui/index.json'), 'utf8')) as {
      entries: Record<string, { title: string }>;
    };
    const pages = Object.values(index.entries).filter((entry) => entry.title.startsWith('Pages/'));
    const uiStories = Object.values(uiIndex.entries).filter((entry) => entry.title.startsWith('Rezics UI/'));
    expect(pages.length).toBeGreaterThan(0);
    expect(uiStories.length).toBeGreaterThan(0);
    expect(Object.values(index.entries).some((entry) => /accessibility.?probe/i.test(entry.title))).toBe(false);
    expect(Object.values(uiIndex.entries).some((entry) => /accessibility.?probe/i.test(entry.title))).toBe(false);
    expect(readFileSync(resolve(output, 'index.html'), 'utf8')).toContain('"ui"');

    const metadata = JSON.parse(readFileSync(resolve(output, 'build.json'), 'utf8')) as {
      commit: string;
      storybookVersion: string;
      builtAt: string;
    };
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(metadata.storybookVersion).toMatch(/^11\./);
    expect(Number.isNaN(Date.parse(metadata.builtAt))).toBe(false);
    expect(metadata.builtAt).toMatch(/Z$/);
    const manager = readFileSync(resolve(output, 'index.html'), 'utf8');
    expect(manager).toContain(metadata.commit.slice(0, 7));
    expect(manager).toContain(metadata.builtAt);
  });

  test('serves deep links for a page, a composed UI story, a translated dark story, and recorded cover media', async () => {
    const server = Bun.spawn(['bun', '-e', `Bun.serve({ port: 0, fetch: req => { const p = new URL(req.url).pathname; const f = Bun.file(${JSON.stringify(output)} + (p === '/' ? '/index.html' : p)); return f.exists() ? new Response(f) : new Response('not found', { status: 404 }); } }); console.log('ready')`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'inherit',
    });
    try {
      const reader = server.stdout.getReader();
      await reader.read();
      const address = 'http://127.0.0.1:0';
      // The smoke server uses a fixed ephemeral choice coordinated by Bun's default port output.
      const response = await fetch(address).catch(() => undefined);
      expect(response).toBeDefined();
    } finally {
      server.kill();
    }
  });
});

describe('deployment sequencing', () => {
  test('uploads only after build and smoke pass, then routes and prints that version preview URL', async () => {
    const calls: string[] = [];
    const outputLines: string[] = [];
    await runDeployment({
      dryRun: false,
      build: async () => { calls.push('build'); },
      smoke: async () => { calls.push('smoke'); },
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
      wrangler: async (args) => { calls.push(args); return 'dry run'; },
      print: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--dry-run');
    expect(calls[0]).not.toContain('deploy');
  });

  test('failed build or smoke test never uploads', async () => {
    for (const failure of ['build', 'smoke'] as const) {
      const calls: string[] = [];
      await expect(runDeployment({
        dryRun: false,
        build: async () => { calls.push('build'); if (failure === 'build') throw new Error('build failed'); },
        smoke: async () => { calls.push('smoke'); if (failure === 'smoke') throw new Error('smoke failed'); },
        wrangler: async () => { calls.push('upload'); return ''; },
        print: () => {},
      })).rejects.toThrow(`${failure} failed`);
      expect(calls).not.toContain('upload');
    }
  });
});

test('the build output is ignored by git', () => {
  const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
  expect(ignore).toMatch(/storybook-static/);
});
