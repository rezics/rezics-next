// The lane runner behind the kernel and Auth checks: test files run longest first through a fixed pool of lanes,
// each file in its own `bun test` process on its own database cloned from a migrated template, and every clone is
// dropped. `service` names the check (`kernel`, `auth`); it prefixes the clone names, the timings directory and the
// `<SERVICE>_CHECK_*` variables.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

export type FileOutcome<T> = { file: string; database: string; output?: T; error?: Error };
export type FileRunner<T> = {
  create: (file: string, database: string) => void | Promise<void>;
  run: (file: string, database: string) => T | Promise<T>;
  drop: (file: string, database: string) => void | Promise<void>;
  onComplete?: (outcome: FileOutcome<T>) => void;
};

type Runner<T> = Pick<FileRunner<T>, 'create' | 'run' | 'drop'>;

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

const variable = (service: string, name: string): string => `${service.toUpperCase()}_CHECK_${name}`;

/** The main checkout's timings directory, shared by every worktree; `<SERVICE>_CHECK_TIMINGS` overrides it. */
export function timingsDirectory(
  service: string,
  moduleDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[variable(service, 'TIMINGS')];
  if (override) return resolve(override);
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: moduleDirectory,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`git rev-parse failed: ${result.stderr}`);
  return resolve(dirname(result.stdout.trim()), `.temp/${service}-check/timings`);
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
  service: string,
  files: string[],
  latest: Record<string, FileTiming>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const byName = [...files].sort();
  if (env[variable(service, 'ORDER')] === 'name') return byName;
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

/** Lanes of one check: six, or `<SERVICE>_CHECK_CONCURRENCY` when it names a positive integer. */
export function laneConcurrency(service: string, env: NodeJS.ProcessEnv = process.env): number {
  const name = variable(service, 'CONCURRENCY');
  const concurrency = Number(env[name] ?? 6);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`${name} must be a positive integer`);
  return concurrency;
}

/** Run the planned test files longest first, each on its own database. */
export function runTestFiles<T>(
  service: string,
  files: string[],
  latest: Record<string, FileTiming>,
  concurrency: number,
  runner: FileRunner<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FileOutcome<T>[]> {
  return scheduleFiles(`${service}_test`, orderFiles(service, files, latest, env), concurrency, runner);
}

/** Run independent files through a fixed-size worker pool, cleaning up each created database. */
export async function scheduleFiles<T>(
  databasePrefix: string,
  files: string[],
  concurrency: number,
  runner: FileRunner<T>,
): Promise<FileOutcome<T>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
  const outcomes = new Array<FileOutcome<T>>(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      const file = files[index]!;
      const database = `${databasePrefix}_${index + 1}`;
      let created = false;
      let output: T | undefined;
      let error: Error | undefined;
      try {
        await runner.create(file, database);
        created = true;
        output = await runner.run(file, database);
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause));
      } finally {
        if (created) {
          try {
            await runner.drop(file, database);
          } catch (cause) {
            const dropError = cause instanceof Error ? cause : new Error(String(cause));
            error = error ? new Error(`${error.message}\nDatabase cleanup failed: ${dropError.message}`) : dropError;
          }
        }
      }
      const outcome: FileOutcome<T> = {
        file,
        database,
        ...(output === undefined ? {} : { output }),
        ...(error ? { error } : {}),
      };
      outcomes[index] = outcome;
      runner.onComplete?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  return outcomes;
}

// Asynchronous, so the pool's lanes overlap; a synchronous spawn blocks the event loop and runs them one at a time.
export async function capture(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ status: number; output: string }> {
  const child = Bun.spawn([program, ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, output: `${stdout}${stderr}` };
}

/** Tests start containers and compilers; under a loaded host Bun's 5 s per-test default fails them at random. */
export function testCommand(file: string, junitFile: string): string[] {
  return ['test', '--timeout', '60000', '--reporter=junit', `--reporter-outfile=${junitFile}`, `./${file}`];
}

export type LaneSuite = {
  service: string;
  /** The module directory: `bun test` runs here and the timings directory is found from it. */
  directory: string;
  files: string[];
  /** A run of named files merges its timings into the last recorded ones. */
  partial: boolean;
  createDatabase: (database: string) => Promise<void>;
  dropDatabase: (database: string) => Promise<void>;
  /** The environment of every process one test file starts. */
  environment: (database: string) => NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
};

/** Runs `files` in lanes, prints each file's output as it ends, records the timings; failed files are returned. */
export async function runLaneSuite(suite: LaneSuite): Promise<{ failed: string[]; concurrency: number }> {
  const env = suite.env ?? process.env;
  const concurrency = laneConcurrency(suite.service, env);
  const reports = mkdtempSync(join(tmpdir(), `${suite.service}-check-`));
  const recorder = createRecorder();
  let timingsPath: string | null = null;
  try {
    timingsPath = timingsDirectory(suite.service, suite.directory, env);
  } catch (error) {
    console.warn(`Check timings are not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latest = timingsPath ? readLatest(timingsPath) : {};
  const runner = recorder.wrap<string>(
    {
      // Each file gets a fresh copy so its result cannot depend on writes from another file.
      create: (_file, database) => suite.createDatabase(database),
      run: async (file, database) => {
        const result = await capture(
          'bun',
          testCommand(file, join(reports, `${database}.xml`)),
          suite.environment(database),
          suite.directory,
        );
        if (result.status !== 0) throw new Error(`bun test ./${file} failed:\n${result.output}`);
        return result.output;
      },
      drop: (_file, database) => suite.dropDatabase(database),
    },
    async (_file, database) => parseJunit(readFileSync(join(reports, `${database}.xml`), 'utf8')),
  );
  try {
    const outcomes = await runTestFiles(
      suite.service,
      suite.files,
      latest,
      concurrency,
      {
        ...runner,
        onComplete: (outcome) => {
          if (outcome.output)
            process.stdout.write(outcome.output.endsWith('\n') ? outcome.output : `${outcome.output}\n`);
          if (outcome.error) process.stderr.write(`${outcome.file}: ${outcome.error.message}\n`);
        },
      },
      env,
    );
    if (timingsPath) writeTimings(timingsPath, recorder.timings(), { partial: suite.partial });
    return { failed: outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.file), concurrency };
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
}
