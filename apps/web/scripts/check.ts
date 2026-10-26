import {
  createRecorder,
  capture,
  parseJunit,
  runTestFiles,
  testCommand,
  type FileOutcome,
  type FileTiming,
} from '../../../scripts/test-lanes.ts';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');
const defaultTimingsFile = join(app, 'check-timings.json');
const browserTest =
  /from\s+['"](?:playwright|@playwright\/|@vitest\/browser)|\b(?:chromium|browser)\.launch\b|\.goto\s*\(|\b(?:spawn|createServer|Bun\.serve)\s*\(/;

export type WebTestLanesOptions = {
  files: string[];
  directory?: string;
  timingsFile?: string;
  env?: NodeJS.ProcessEnv;
  testScript?: string;
  onComplete?: (outcome: FileOutcome<string>) => void;
};

export type WebTestLanesResult = {
  failed: string[];
  concurrency: { browser: number; unit: number };
  timings: Record<string, FileTiming>;
};

function readTimings(path: string): Record<string, FileTiming> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { files?: unknown };
    return parsed.files && typeof parsed.files === 'object' ? (parsed.files as Record<string, FileTiming>) : {};
  } catch {
    return {};
  }
}

function writeTimings(path: string, previous: Record<string, FileTiming>, current: Record<string, FileTiming>): void {
  mkdirSync(dirname(path), { recursive: true });
  const recorded = new Date().toISOString();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ recorded, files: { ...previous, ...current } }, null, 2)}\n`);
  renameSync(temporary, path);
}

function concurrency(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isBrowserTest(file: string, directory: string): boolean {
  return browserTest.test(readFileSync(resolve(directory, file), 'utf8'));
}

function reportOutcome(outcome: FileOutcome<string>): void {
  if (outcome.output) process.stdout.write(outcome.output.endsWith('\n') ? outcome.output : `${outcome.output}\n`);
  if (outcome.error) process.stderr.write(`${outcome.file}: ${outcome.error.message}\n`);
}

function recordRunMarker(directory: string | undefined, phase: 'start' | 'end', file: string): void {
  if (!directory) return;
  const path = join(directory, `${phase}-${file}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(Date.now()));
}

/** Runs every file in its own isolated Bun process, with separate browser and unit lane pools. */
export async function runWebTestLanes(options: WebTestLanesOptions): Promise<WebTestLanesResult> {
  const directory = resolve(options.directory ?? app);
  const timingsFile = resolve(options.timingsFile ?? defaultTimingsFile);
  const env = options.env ?? process.env;
  const testScript = options.testScript ?? 'bun run test';
  const testInvocation = testScript.trim().split(/\s+/);
  if (testInvocation.length < 2 || testInvocation[0] !== 'bun' || testInvocation[1] !== 'run') {
    throw new Error(`The per-file test command must start with "bun run": ${testScript}`);
  }

  const browserConcurrency = concurrency('WEB_BROWSER_CHECK_CONCURRENCY', 6, env);
  const unitConcurrency = concurrency('WEB_UNIT_CHECK_CONCURRENCY', 10, env);
  const browserFiles = options.files.filter((file) => isBrowserTest(file, directory));
  const unitFiles = options.files.filter((file) => !browserFiles.includes(file));
  const previous = readTimings(timingsFile);
  mkdirSync(join(root, '.temp'), { recursive: true });
  const reportDirectory = mkdtempSync(join(root, '.temp/web-check-'));
  const recorder = createRecorder();
  const runner = recorder.wrap<string>(
    {
      create: () => undefined,
      run: async (file, database) => {
        const report = join(reportDirectory, `${database}.xml`);
        recordRunMarker(env.WEB_CHECK_EVENTS, 'start', file);
        try {
          const result = await capture(
            testInvocation[0]!,
            [...testInvocation.slice(1), ...testCommand(file, report).slice(1)],
            env,
            directory,
          );
          if (result.status !== 0) throw new Error(`${testScript} ./${file} failed:\n${result.output}`);
          return result.output;
        } finally {
          recordRunMarker(env.WEB_CHECK_EVENTS, 'end', file);
        }
      },
      drop: () => undefined,
    },
    async (_file, database) => {
      const report = join(reportDirectory, `${database}.xml`);
      return parseJunit(readFileSync(report, 'utf8'));
    },
  );

  try {
    const [browserOutcomes, unitOutcomes] = await Promise.all([
      runTestFiles(
        'web-browser',
        browserFiles,
        previous,
        browserConcurrency,
        {
          ...runner,
          onComplete: options.onComplete ?? reportOutcome,
        },
        env,
      ),
      runTestFiles(
        'web-unit',
        unitFiles,
        previous,
        unitConcurrency,
        {
          ...runner,
          onComplete: options.onComplete ?? reportOutcome,
        },
        env,
      ),
    ]);
    const timings = recorder.timings();
    writeTimings(timingsFile, previous, timings);
    return {
      failed: [...browserOutcomes, ...unitOutcomes]
        .filter((outcome) => outcome.error)
        .map((outcome) => outcome.file)
        .sort(),
      concurrency: { browser: browserConcurrency, unit: unitConcurrency },
      timings,
    };
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
  }
}

async function runCommand(label: string, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  process.stdout.write(`\n[web check] ${label}\n`);
  const started = performance.now();
  const child = Bun.spawn([command, ...args], {
    cwd: app,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const status = await child.exited;
  process.stdout.write(`[web check] ${label} ${(performance.now() - started) / 1000}s\n`);
  if (status !== 0) throw new Error(`${label} failed with status ${status}`);
}

function testScriptArgument(args: string[]): string {
  const index = args.indexOf('--test-command');
  const command = index < 0 ? 'bun run test' : args[index + 1];
  if (command !== 'bun run test')
    throw new Error('Usage: bun scripts/check.ts [--stories] --test-command "bun run test"');
  return command;
}

async function runTests(files: string[], env: NodeJS.ProcessEnv, testScript: string): Promise<void> {
  const result = await runWebTestLanes({ files, env, testScript });
  if (result.failed.length > 0)
    throw new Error(`Web tests failed for ${result.failed.length} file(s):\n${result.failed.join('\n')}`);
}

async function main(args: string[]): Promise<void> {
  const env = process.env;
  const testScript = testScriptArgument(args);
  if (args.includes('--stories')) {
    await runTests(['tests/page-stories.test.ts'], env, testScript);
    return;
  }

  if (!args.includes('--skip-format'))
    await runCommand('format', 'oxfmt', ['--check', '.', '!src/kernel/recorded/*.json'], env);
  await runCommand('generate', 'bun', ['run', 'generate'], env);
  await runCommand('route generation', 'bun', ['run', 'generate:routes'], env);

  const files = [...new Bun.Glob('tests/*.test.ts').scanSync({ cwd: app })]
    .filter((file) => !file.endsWith('.host.test.ts'))
    .sort();
  const results = await Promise.allSettled([
    runCommand('typecheck', 'tsc', ['--noEmit', '-p', 'tsconfig.json'], env),
    runTests(files, env, testScript),
  ]);
  const hostResult = await Promise.allSettled([runCommand('host tests', 'bun', ['run', 'test:host'], env)]);
  const failures = results
    .flatMap((result) =>
      result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    )
    .concat(
      hostResult.flatMap((result) =>
        result.status === 'rejected'
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : [],
      ),
    );
  if (failures.length > 0) throw new Error(failures.join('\n'));

  await runCommand('build', 'bun', ['run', 'build'], env);
  await runCommand('Storybook stories', 'bun', ['run', 'test:stories'], env);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
