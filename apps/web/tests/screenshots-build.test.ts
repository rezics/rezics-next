import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const app = join(import.meta.dir, '..');
const root = resolve(app, '../..');
const timeout = 600_000;

function run(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', STORYBOOK_DISABLE_TELEMETRY: '1' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve) => {
    child.once('exit', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      }),
    );
  });
}

function storyIds(directory: string): string[] {
  const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')) as {
    entries: Record<string, { type: string }>;
  };
  return Object.entries(index.entries)
    .filter(([, entry]) => entry.type === 'story')
    .map(([id]) => id)
    .sort();
}

test('the screenshot build uses Storybook test mode and keeps its other build flags', () => {
  const source = readFileSync(join(app, 'scripts/screenshots.ts'), 'utf8');
  const start = source.indexOf('async function build(');
  const end = source.indexOf('\nasync function settle(', start);
  expect(start, 'The screenshot build function is missing.').toBeGreaterThanOrEqual(0);
  expect(end, 'The screenshot build function boundary is missing.').toBeGreaterThan(start);
  const build = source.slice(start, end);
  expect(build).toMatch(
    /Bun\.spawn\(\[storybook,\s*'build',\s*'--test',\s*'--output-dir',\s*directory,\s*'--disable-telemetry',\s*'--quiet'/,
  );
});

test(
  'a test build indexes every story from the full build',
  async () => {
    const builds = mkdtempSync(join(root, '.temp/screenshots-builds-'));
    try {
      const storybook = join(app, 'node_modules/.bin/storybook');
      for (const [mode, flags] of [
        ['full', []],
        ['test', ['--test']],
      ] as const) {
        const output = join(builds, mode);
        const result = await run(
          storybook,
          ['build', ...flags, '--output-dir', output, '--disable-telemetry', '--quiet'],
          app,
        );
        expect(result.code, `${mode} build failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
      }
      expect(storyIds(join(builds, 'test'))).toEqual(storyIds(join(builds, 'full')));
    } finally {
      rmSync(builds, { recursive: true, force: true });
    }
  },
  timeout,
);

test(
  'the screenshot tool captures the missing-subject story from a test build',
  async () => {
    const out = mkdtempSync(join(root, '.temp/screenshots-capture-'));
    try {
      const result = await run(
        'bun',
        ['run', 'screenshots', '--story', 'pages-missing-subject--*', '--locale', 'en', '--out', out],
        app,
      );
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      const screenshot = 'pages-missing-subject--signed-out.en.light.png';
      expect(readFileSync(join(out, screenshot)).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  },
  timeout,
);
