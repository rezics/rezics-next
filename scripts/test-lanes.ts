// The lane runner behind the kernel and Auth checks: test files run longest first through a fixed pool of lanes,
// each file in its own `bun test` process on its own database cloned from a migrated template, and every clone is
// dropped. With the host lease on, each file takes a stack slot before its clone is made and holds it through the
// test process and clone drop. A suite inheriting a slot runs one file at a time; with the lease off it uses its full
// check concurrency. `service` names the check (`kernel`, `auth`); it prefixes the clone names, the timings directory
// and the `<SERVICE>_CHECK_*` variables.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireStackSlot, type StackSlot } from './stack-lease.ts';

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

type GrowthFailure = { title: string; message: string };
type ReportedFailure = GrowthFailure & { type: string };
export type RetriableTestFailure = GrowthFailure & { kind?: 'growth' | 'load' };

/** Growth errors and their test titles, when the JUnit report includes complete per-failure metadata. */
function junitFailures(xml: string): ReportedFailure[] | null {
  const root = xml.match(/<testsuites\b[^>]*>/)?.[0];
  if (!root) return null;
  const failures = attribute(root, 'failures');
  const errors = attribute(root, 'errors');
  if (failures === undefined || errors === undefined) return null;
  const expectedCount = Number(failures) + Number(errors);
  if (!Number.isInteger(expectedCount)) return null;

  const results: ReportedFailure[] = [];
  const testcaseRanges: Array<[number, number]> = [];
  const testcases = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g;
  for (const match of xml.matchAll(testcases)) {
    const tag = `<testcase ${match[1]}>`;
    const title = attribute(tag, 'classname');
    const name = attribute(tag, 'name') ?? '';
    const body = match[2] ?? '';
    testcaseRanges.push([match.index!, match.index! + match[0].length]);
    const errorsInTest = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
    for (const failure of body.matchAll(errorsInTest)) {
      const failureTag = `<${failure[1]} ${failure[2]}>`;
      const type = attribute(failureTag, 'type');
      const message = attribute(failureTag, 'message');
      if (type === undefined || message === undefined) return null;
      results.push({ title: title ? `${title} ${name}` : name, message, type });
    }
  }

  // Every reported failure must belong to a test case and have type and message attributes.
  const allFailureTags = Array.from(xml.matchAll(/<(?:failure|error)\b/g));
  if (allFailureTags.length !== expectedCount || results.length !== expectedCount) return null;
  if (
    allFailureTags.some(
      (failure) => !testcaseRanges.some(([start, end]) => failure.index! > start && failure.index! < end),
    )
  ) {
    return null;
  }
  return results;
}

/** Bun's console output fallback when a JUnit report does not preserve failure type and message attributes. */
function outputGrowthFailures(output: string): GrowthFailure[] | null {
  const failures: GrowthFailure[] = [];
  let block: string[] = [];
  let finished = false;
  for (const line of output.split(/\r\n?|\n/)) {
    const failure = line.match(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/);
    if (failure) {
      const message = block.find((candidate) => candidate.startsWith('GrowthBoundError:'));
      if (message === undefined || block.some((candidate) => /^(error:|# Unhandled)/.test(candidate))) return null;
      failures.push({ title: failure[1]!, message: message.slice('GrowthBoundError:'.length).trim() });
      block = [];
    } else if (/^\s*\d+ (pass|fail|skip|todo)\b/.test(line) || line.startsWith('Ran ')) {
      finished = true;
    } else if (!finished) {
      block.push(line);
    }
  }
  return failures.length > 0 && block.every((line) => line.trim() === '') ? failures : null;
}

/**
 * Reruns each eligible file once, in order. Every reported failure must be classified as the same retryable kind;
 * failed files that cannot be classified this way or fail again remain in the result.
 */
export async function rerunGrowthFailures<T>(
  outcomes: FileOutcome<T>[],
  rerun: (file: string) => Promise<FileOutcome<T>>,
  classify: (outcome: FileOutcome<T>) => RetriableTestFailure[] | null,
  write: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<{ failed: FileOutcome<T>[] }> {
  const failed: FileOutcome<T>[] = [];
  const growthSensitive: string[] = [];
  const loadSensitive: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.error) continue;
    const failures = classify(outcome);
    if (!failures || failures.length === 0) {
      failed.push(outcome);
      continue;
    }
    const again = await rerun(outcome.file);
    if (again.error) {
      write(`${outcome.error.message}\n${outcome.file}: failed again alone:\n${again.error.message}\n`);
      failed.push(outcome);
      continue;
    }
    for (const failure of failures) {
      const message = failure.message.split('\n')[0]!;
      const item = `${outcome.file} :: ${failure.title} :: ${message}`;
      if (failure.kind === 'load') loadSensitive.push(`load-sensitive test: ${item}`);
      else growthSensitive.push(`load-sensitive growth check: ${item}`);
    }
  }
  if (growthSensitive.length > 0) {
    write(`Load-sensitive growth checks (passed alone): ${growthSensitive.length}\n${growthSensitive.join('\n')}\n`);
  }
  if (loadSensitive.length > 0) {
    write(`Load-sensitive tests (passed alone): ${loadSensitive.length}\n${loadSensitive.join('\n')}\n`);
  }
  return { failed };
}

function classifyGrowthFailures(outcome: FileOutcome<string>, report: string | undefined): GrowthFailure[] | null {
  if (!outcome.error || outcome.error.message.includes('Database cleanup failed:')) return null;
  if (report) {
    const failures = junitFailures(report);
    if (failures !== null) {
      return failures.length > 0 && failures.every((failure) => failure.type === 'GrowthBoundError')
        ? failures.map(({ title, message }) => ({ title, message }))
        : null;
    }
  }
  return outputGrowthFailures(outcome.error.message);
}

type LoadFailure = GrowthFailure & { kind: 'load' };

const loadFailurePatterns = [
  /\bthis test timed out after \d+ms\b/i,
  /\ba (?:beforeEach|afterEach|beforeAll|afterAll) hook timed out\b/i,
  /\bTimeoutError:\s*.+?:\s*Timeout \d+ms exceeded\b/i,
  /\bAccessUnavailableError:\s*Access unavailable: deadline\b/i,
  /\bdeadline_exceeded\b/i,
];

function isLoadInducedFailure(text: string): boolean {
  return loadFailurePatterns.some((pattern) => pattern.test(text));
}

/** Parse complete JUnit failure details, including implementations that put the error in the element body. */
function junitLoadFailures(xml: string): GrowthFailure[] | null {
  const root = xml.match(/<testsuites\b[^>]*>/)?.[0];
  if (!root) return null;
  const failureCount = attribute(root, 'failures');
  const errorCount = attribute(root, 'errors');
  if (failureCount === undefined || errorCount === undefined) return null;
  const expectedCount = Number(failureCount) + Number(errorCount);
  if (!Number.isInteger(expectedCount)) return null;

  const results: GrowthFailure[] = [];
  const testcaseRanges: Array<[number, number]> = [];
  const testcases = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g;
  for (const match of xml.matchAll(testcases)) {
    const tag = `<testcase ${match[1]}>`;
    const suite = attribute(tag, 'classname');
    const name = attribute(tag, 'name') ?? '';
    const body = match[2] ?? '';
    testcaseRanges.push([match.index!, match.index! + match[0].length]);
    const failures = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
    for (const failure of body.matchAll(failures)) {
      const failureTag = `<${failure[1]} ${failure[2]}>`;
      const type = attribute(failureTag, 'type') ?? '';
      const message = attribute(failureTag, 'message') ?? '';
      const detail = (failure[3] ?? '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const combined = [type, message, detail].filter(Boolean).join(': ');
      if (!combined) return null;
      results.push({ title: suite ? `${suite} ${name}` : name, message: combined });
    }
  }

  const allFailureTags = Array.from(xml.matchAll(/<(?:failure|error)\b/g));
  if (allFailureTags.length !== expectedCount || results.length !== expectedCount) return null;
  if (
    allFailureTags.some(
      (failure) => !testcaseRanges.some(([start, end]) => failure.index! > start && failure.index! < end),
    )
  ) {
    return null;
  }
  return results;
}

/** Bun console output fallback when a JUnit report does not carry complete failure messages. */
export function classifyLoadInducedOutput(output: string): GrowthFailure[] | null {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r\n?|\n/);
  const failures: Array<{ title: string; line: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*\d+ tests? failed:\s*$/.test(line) || /^\s*\d+ (?:pass|fail|skip|todo)\b/.test(line)) break;
    const failure = line.match(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/);
    if (failure) failures.push({ title: failure[1]!, line: index });
  }
  if (failures.length === 0) return null;

  const classified = failures.map((failure, index) => {
    const previous = failures[index - 1]?.line ?? -1;
    const next = failures[index + 1]?.line ?? lines.length;
    const lower = index === 0 ? previous + 1 : Math.floor((previous + failure.line) / 2) + 1;
    const upper = index === failures.length - 1 ? next - 1 : Math.floor((failure.line + next) / 2);
    const messages = lines.slice(lower, upper + 1);
    return { ...failure, messages };
  });

  for (const failure of classified) {
    if (!failure.messages.some((line) => isLoadInducedFailure(line))) return null;
    if (failure.messages.some((line) => /^(?:error:|# Unhandled)/.test(line) && !isLoadInducedFailure(line))) {
      return null;
    }
  }
  return classified.map(({ title, messages }) => ({
    title,
    message: messages.find((line) => isLoadInducedFailure(line))!.trim(),
  }));
}

export function classifyLoadInducedFailures(
  outcome: FileOutcome<string>,
  report: string | undefined,
): LoadFailure[] | null {
  if (!outcome.error || outcome.error.message.includes('Database cleanup failed:')) return null;
  if (report) {
    const failures = junitLoadFailures(report);
    if (failures !== null) {
      return failures.length > 0 && failures.every((failure) => isLoadInducedFailure(failure.message))
        ? failures.map((failure) => ({ ...failure, kind: 'load' as const }))
        : null;
    }
  }
  const failures = classifyLoadInducedOutput(outcome.error.message);
  return failures?.map((failure) => ({ ...failure, kind: 'load' })) ?? null;
}

/** Retry only load-induced failures, once each, after their original lane run has finished. */
export async function rerunLoadFailures<T>(
  outcomes: FileOutcome<T>[],
  rerun: (file: string) => Promise<FileOutcome<T>>,
  classify: (outcome: FileOutcome<T>) => GrowthFailure[] | null,
  write: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<{ failed: FileOutcome<T>[] }> {
  return rerunGrowthFailures(
    outcomes,
    rerun,
    (outcome) => classify(outcome)?.map((failure) => ({ ...failure, kind: 'load' })),
    write,
  );
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
  const configuredConcurrency = laneConcurrency(suite.service, env);
  const inheritedSlot = env.REZICS_STACK_LEASE !== 'off' && env.REZICS_STACK_SLOT !== undefined;
  const concurrency = inheritedSlot ? 1 : configuredConcurrency;
  const reports = mkdtempSync(join(tmpdir(), `${suite.service}-check-`));
  const recorder = createRecorder();
  const slots = new Map<string, StackSlot>();
  const reportsByFile = new Map<string, string>();
  let timingsPath: string | null = null;
  try {
    timingsPath = timingsDirectory(suite.service, suite.directory, env);
  } catch (error) {
    console.warn(`Check timings are not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latest = timingsPath ? readLatest(timingsPath) : {};
  const laneRunner: FileRunner<string> = {
    // Each file gets a fresh copy so its result cannot depend on writes from another file.
    create: async (file, database) => {
      const slot = await acquireStackSlot(file, env);
      slots.set(database, slot);
      try {
        await suite.createDatabase(database);
      } catch (error) {
        slots.delete(database);
        await slot.release();
        throw error;
      }
    },
    run: async (file, database) => {
      const slot = slots.get(database);
      const report = join(reports, `${database}.xml`);
      const result = await capture(
        'bun',
        testCommand(file, report),
        { ...suite.environment(database), ...slot?.env },
        suite.directory,
      );
      try {
        reportsByFile.set(file, readFileSync(report, 'utf8'));
      } catch {
        reportsByFile.delete(file);
      }
      if (result.status !== 0) throw new Error(`bun test ./${file} failed:\n${result.output}`);
      return result.output;
    },
    drop: async (_file, database) => {
      const slot = slots.get(database);
      try {
        await suite.dropDatabase(database);
      } finally {
        slots.delete(database);
        await slot?.release();
      }
    },
  };
  const runner = recorder.wrap<string>(laneRunner, async (_file, database) =>
    parseJunit(readFileSync(join(reports, `${database}.xml`), 'utf8')),
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
    let rerunIndex = 0;
    const { failed } = await rerunGrowthFailures(
      outcomes,
      async (file) => {
        const [outcome] = await scheduleFiles(`${suite.service}_growth_${++rerunIndex}_test`, [file], 1, laneRunner);
        return outcome!;
      },
      (outcome) => {
        const report = reportsByFile.get(outcome.file);
        const growthFailures = classifyGrowthFailures(outcome, report);
        return growthFailures ?? classifyLoadInducedFailures(outcome, report);
      },
    );
    if (timingsPath) writeTimings(timingsPath, recorder.timings(), { partial: suite.partial });
    return { failed: failed.map((outcome) => outcome.file), concurrency };
  } finally {
    rmSync(reports, { recursive: true, force: true });
  }
}
