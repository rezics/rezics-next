import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type TestTiming = { name: string; time: number };

/** Seconds. `outsideTests` is the wall time minus the tests' own time: module load and hooks. */
export type FileTiming = {
  wall: number;
  create: number;
  drop: number;
  outsideTests: number;
  result: 'pass' | 'fail';
  tests: TestTiming[];
};

type Runner<T> = {
  create: (file: string, database: string) => void | Promise<void>;
  run: (file: string, database: string) => T | Promise<T>;
  drop: (file: string, database: string) => void | Promise<void>;
};

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_match, decimal, hex, name) =>
    name ? entities[name.toLowerCase()]! : String.fromCodePoint(decimal ? Number(decimal) : parseInt(hex, 16)),
  );
}

function attribute(tag: string, name: string): string | undefined {
  const value = tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : unescapeXml(value);
}

/** Each test case's name (prefixed by its suite) and time in seconds, from Bun's JUnit report. */
export function parseJunit(xml: string): TestTiming[] {
  return Array.from(xml.matchAll(/<testcase\b[^>]*>/g), ([tag]) => {
    const suite = attribute(tag, 'classname');
    const name = attribute(tag, 'name') ?? '';
    return { name: suite ? `${suite} ${name}` : name, time: Number(attribute(tag, 'time') ?? 0) };
  });
}

const round = (seconds: number): number => Math.round(seconds * 1e4) / 1e4;

export function createRecorder() {
  const files: Record<string, FileTiming> = {};
  return {
    timings: (): Record<string, FileTiming> => files,
    /** Times each step of a file; `readTests` returns the file's per-test times once its run has ended. */
    wrap<T>(runner: Runner<T>, readTests: (file: string, database: string) => Promise<TestTiming[]>): Runner<T> {
      const pending = new Map<string, FileTiming>();
      return {
        create: async (file, database) => {
          const start = performance.now();
          try {
            await runner.create(file, database);
          } finally {
            pending.set(file, {
              wall: 0,
              create: round((performance.now() - start) / 1000),
              drop: 0,
              outsideTests: 0,
              result: 'fail',
              tests: [],
            });
          }
        },
        run: async (file, database) => {
          const timing = pending.get(file)!;
          const start = performance.now();
          try {
            const output = await runner.run(file, database);
            timing.result = 'pass';
            return output;
          } finally {
            timing.wall = round((performance.now() - start) / 1000);
            timing.tests = await readTests(file, database).catch(() => []);
            const testTime = timing.tests.reduce((sum, test) => sum + test.time, 0);
            timing.outsideTests = round(Math.max(0, timing.wall - testTime));
          }
        },
        drop: async (file, database) => {
          const timing = pending.get(file)!;
          const start = performance.now();
          try {
            await runner.drop(file, database);
          } finally {
            timing.drop = round((performance.now() - start) / 1000);
            files[file] = timing;
            pending.delete(file);
          }
        },
      };
    },
  };
}

/** The main checkout's timings directory, shared by every worktree; `KERNEL_CHECK_TIMINGS` overrides it. */
export function timingsDirectory(moduleDirectory: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.KERNEL_CHECK_TIMINGS) return resolve(env.KERNEL_CHECK_TIMINGS);
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: moduleDirectory,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`git rev-parse failed: ${result.stderr}`);
  return resolve(dirname(result.stdout.trim()), '.temp/kernel-check/timings');
}

/** The last recorded timings by test file; empty when none are readable. */
export function readLatest(directory: string): Record<string, FileTiming> {
  try {
    const parsed = JSON.parse(readFileSync(resolve(directory, 'latest.json'), 'utf8')) as { files?: unknown };
    return parsed.files && typeof parsed.files === 'object' ? (parsed.files as Record<string, FileTiming>) : {};
  } catch {
    return {};
  }
}

/** Files with no recorded time first, then the rest by descending wall time; ties by name. */
export function orderFiles(
  files: string[],
  latest: Record<string, FileTiming>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const byName = [...files].sort();
  if (env.KERNEL_CHECK_ORDER === 'name') return byName;
  const wall = (file: string): number => {
    const value = latest[file]?.wall;
    return typeof value === 'number' && Number.isFinite(value) ? value : Infinity;
  };
  return byName.sort((a, b) => wall(b) - wall(a));
}

function writeAtomically(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/** Writes this run's timings and replaces `latest.json`; a partial run merges into it. Never throws. */
export function writeTimings(
  directory: string,
  files: Record<string, FileTiming>,
  options: { partial: boolean; now?: Date; warn?: (message: string) => void },
): void {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  try {
    mkdirSync(directory, { recursive: true });
    const now = options.now ?? new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '');
    const run = JSON.stringify({ recorded: now.toISOString(), files }, null, 2);
    writeAtomically(resolve(directory, `${stamp}.json`), `${run}\n`);
    const merged = options.partial ? { ...readLatest(directory), ...files } : files;
    writeAtomically(
      resolve(directory, 'latest.json'),
      `${JSON.stringify({ recorded: now.toISOString(), files: merged }, null, 2)}\n`,
    );
  } catch (error) {
    warn(`Check timings were not written to ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
