#!/usr/bin/env bun
import { availableParallelism } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const PACKAGE_ROOT = resolve(import.meta.dir, '..');

/** Files that still wait on real worker processes, silence windows or cross-process locks. */
export const INTEGRATION_TEST_FILES = [
  'src/launch-failure.test.ts',
  'src/launch-smoke.test.ts',
  'src/settlement-contention.test.ts',
  'src/silence-wait.test.ts',
  'src/test-harness-cleanup.test.ts',
  'src/worker-detach.test.ts',
] as const;

export type FileTiming = { file: string; ms: number; status: number; output: string };
export type TestTiming = { file: string; name: string; ms: number; result: string };

export type TimingsResult = {
  status: number;
  output: string;
  files: FileTiming[];
  tests: TestTiming[];
  totalMs: number;
};

const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts)$/;
const TEST_LINE = /^\((pass|fail|skip|todo)\) (.*) \[(\d+(?:\.\d+)?)(ms|s)\]$/;

export function defaultParallel(): number {
  const override = Number.parseInt(process.env.GOAL_TEST_PARALLEL ?? '', 10);
  if (Number.isSafeInteger(override) && override > 0) return override;
  return Math.max(1, Math.min(availableParallelism(), 16));
}

export function selectTestFiles(cwd: string, argv: string[]): string[] {
  const fast = argv.includes('--fast');
  const integrationOnly = argv.includes('--integration');
  const patterns = argv.filter((arg) => !arg.startsWith('--'));
  const glob = new Bun.Glob('**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}');
  const discovered = [...glob.scanSync({ cwd, dot: false })]
    .filter((file) => !file.split('/').includes('node_modules'))
    .filter((file) => TEST_FILE.test(file))
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
  const integration = new Set<string>(INTEGRATION_TEST_FILES);
  let files = discovered;
  if (fast) files = files.filter((file) => !integration.has(file));
  if (integrationOnly) files = files.filter((file) => integration.has(file));
  if (patterns.length) {
    files = files.filter((file) =>
      patterns.some((pattern) => {
        const resolved = (isAbsolute(pattern) ? relative(cwd, pattern) : pattern).replaceAll('\\', '/');
        return file === resolved || file.endsWith(`/${resolved}`) || file.includes(pattern);
      }),
    );
  }
  return files;
}

export function parseTestTimings(file: string, output: string): TestTiming[] {
  const tests: TestTiming[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\x1B\[[0-9;]*m/g, '').trim();
    const match = TEST_LINE.exec(line);
    if (!match) continue;
    const result = match[1]!;
    const name = match[2]!;
    const amount = Number(match[3]);
    const unit = match[4]!;
    tests.push({ file, name, result, ms: unit === 's' ? amount * 1000 : amount });
  }
  return tests;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3)}s`;
}

export function formatTimings(files: FileTiming[], tests: TestTiming[], totalMs: number): string {
  const lines = ['Files (slowest first)'];
  for (const file of [...files].sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file))) {
    lines.push(`${formatSeconds(file.ms).padStart(10)}  ${file.file}`);
  }
  lines.push('', 'Tests (slowest first)');
  for (const test of [...tests].sort(
    (a, b) => b.ms - a.ms || a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  )) {
    lines.push(`${formatSeconds(test.ms).padStart(10)}  ${test.file}  ${test.name}`);
  }
  lines.push('', `Total: ${formatSeconds(totalMs)}`);
  return `${lines.join('\n')}\n`;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runTestTimings(
  options: { cwd?: string; argv?: string[]; bunExecutable?: string; parallel?: number } = {},
): Promise<TimingsResult> {
  const cwd = options.cwd ?? PACKAGE_ROOT;
  const argv = options.argv ?? [];
  if (argv.includes('--help')) {
    return {
      status: 0,
      output:
        'usage: bun tools/goal/scripts/test-timings.ts [--fast|--integration] [pattern...]\n' +
        'Runs tools/goal tests, one isolated process per file, and prints wall time per file and per test.\n',
      files: [],
      tests: [],
      totalMs: 0,
    };
  }
  const files = selectTestFiles(cwd, argv);
  if (!files.length) {
    return { status: 1, output: 'no test files matched\n', files: [], tests: [], totalMs: 0 };
  }
  const bunExecutable = options.bunExecutable ?? process.execPath;
  const parallel = options.parallel ?? defaultParallel();
  const started = performance.now();
  const fileResults = await mapPool(files, parallel, async (file) => {
    const path = join(cwd, file);
    if (!existsSync(path) || !statSync(path).isFile())
      return { file, ms: 0, status: 1, output: `missing test file: ${file}\n` };
    const fileStarted = performance.now();
    const subprocess = Bun.spawn([bunExecutable, 'test', '--no-orphans', file], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(subprocess.stdout).text();
    const stderr = await new Response(subprocess.stderr).text();
    const status = (await subprocess.exited) ?? 1;
    return { file, ms: performance.now() - fileStarted, status, output: `${stdout}${stderr}` };
  });
  const totalMs = performance.now() - started;
  const tests = fileResults.flatMap((file) => parseTestTimings(file.file, file.output));
  const failed = fileResults.filter((file) => file.status !== 0);
  const output =
    formatTimings(fileResults, tests, totalMs) +
    (failed.length
      ? `\n${failed.length} file(s) failed:\n${failed.map((file) => `${file.file}\n${file.output.trimEnd()}`).join('\n\n')}\n`
      : '');
  return { status: failed.length ? 1 : 0, output, files: fileResults, tests, totalMs };
}

if (import.meta.main) {
  const result = await runTestTimings({ argv: process.argv.slice(2) });
  process.stdout.write(result.output);
  process.exit(result.status);
}
