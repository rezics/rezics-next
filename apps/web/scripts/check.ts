import {
  createRecorder,
  capture,
  parseJunit,
  runTestFiles,
  testCommand,
  type FileOutcome,
  type FileTiming,
} from '../../../scripts/test-lanes.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stackRun } from '../../../scripts/stack-run.ts';

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
  /** JUnit reports are written here. The caller removes it unless `retainReport` is set. */
  reportDirectory?: string;
  /** Leave the report directory in place so a check host can copy it back after this process exits. */
  retainReport?: boolean;
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
  const stackConcurrency = env.REZICS_STACK_SLOT === undefined ? browserConcurrency : 1;
  const browserFiles = options.files.filter((file) => isBrowserTest(file, directory));
  const unitFiles = options.files.filter((file) => !browserFiles.includes(file));
  const previous = readTimings(timingsFile);
  mkdirSync(join(root, '.temp'), { recursive: true });
  const reportDirectory = options.reportDirectory
    ? resolve(options.reportDirectory)
    : mkdtempSync(join(root, '.temp/web-check-'));
  mkdirSync(reportDirectory, { recursive: true });
  const recorder = createRecorder();
  const runner = recorder.wrap<string>(
    {
      create: () => undefined,
      run: async (file, database) => {
        const report = join(reportDirectory, `${database}.xml`);
        const invocation = browserFiles.includes(file)
          ? ['bun', 'scripts/isolated.ts', 'bun', 'test']
          : ['bun', 'test'];
        recordRunMarker(env.WEB_CHECK_EVENTS, 'start', file);
        try {
          const result = await capture(
            invocation[0]!,
            [...invocation.slice(1), ...testCommand(file, report).slice(1)],
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
        stackConcurrency,
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
      concurrency: { browser: stackConcurrency, unit: unitConcurrency },
      timings,
    };
  } finally {
    if (!options.retainReport) rmSync(reportDirectory, { recursive: true, force: true });
  }
}

export type BrowserPlacement = {
  code: number;
  failed: string[];
  timings: Record<string, FileTiming>;
};

function readReportFragment(directory: string): { failed: string[]; timings: Record<string, FileTiming> } {
  let timings: Record<string, FileTiming> = {};
  const timingsPath = join(directory, 'timings.json');
  if (existsSync(timingsPath)) {
    const parsed = JSON.parse(readFileSync(timingsPath, 'utf8')) as { files?: Record<string, FileTiming> };
    if (parsed.files && typeof parsed.files === 'object') timings = parsed.files;
  }
  const failedPath = join(directory, 'failed.txt');
  const failed = existsSync(failedPath) ? readFileSync(failedPath, 'utf8').split('\n').filter(Boolean) : [];
  return { failed, timings };
}

/**
 * Runs the browser files in the current workspace and leaves `report` in place. A check host runs this after
 * placement; it does not place the work again.
 */
export async function runBrowserWorker(input: {
  files: string[];
  report: string;
  testScript?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  if (input.report === '' || input.report.startsWith('/') || input.report.split('/').includes('..')) {
    throw new Error(`report must stay inside the workspace: ${input.report}`);
  }
  const reportDirectory = resolve(root, input.report);
  const result = await runWebTestLanes({
    files: input.files,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.testScript === undefined ? {} : { testScript: input.testScript }),
    reportDirectory,
    timingsFile: join(reportDirectory, 'timings.json'),
    retainReport: true,
  });
  if (result.failed.length > 0) writeFileSync(join(reportDirectory, 'failed.txt'), `${result.failed.join('\n')}\n`);
  return result.failed.length > 0 ? 1 : 0;
}

/** `--browser` is the command a check host runs; it carries the report directory the caller asked to have back. */
export function browserWorkerRequest(args: string[]): { files: string[]; report: string; testScript: string } | null {
  if (!args.includes('--browser')) return null;
  const testScript = testScriptArgument(args);
  const reportAt = args.indexOf('--report');
  const report = reportAt >= 0 ? args[reportAt + 1] : undefined;
  if (!report || report.startsWith('--')) throw new Error('--browser needs --report <directory>');
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--browser' || argument === '--skip-format') continue;
    if (argument === '--report' || argument === '--test-command') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    files.push(argument);
  }
  return { files, report, testScript };
}

/**
 * Hands browser files to stack placement and returns their report directory. A check host handles the command through
 * `--browser`, which runs the files without placing them again.
 */
export async function placeBrowserCheck(
  files: string[],
  options: { env?: NodeJS.ProcessEnv; testScript?: string } = {},
): Promise<BrowserPlacement> {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const report = relative(root, mkdtempSync(join(root, '.temp/web-check-')))
    .split(sep)
    .join('/');
  const directory = resolve(root, report);
  const testScript = options.testScript;
  try {
    const code = await stackRun(
      {
        label: 'web browser check',
        root,
        cwd: app,
        command: [
          'bun',
          'scripts/check.ts',
          '--browser',
          '--report',
          report,
          ...(testScript === undefined ? [] : ['--test-command', testScript]),
          ...files,
        ],
        returns: [report],
      },
      async (slotEnv) => {
        return runBrowserWorker({
          files,
          report,
          ...(testScript === undefined ? {} : { testScript }),
          env: { ...(options.env ?? process.env), ...slotEnv },
        });
      },
      options.env ?? process.env,
    );
    const fragment = readReportFragment(directory);
    const failed =
      fragment.failed.length > 0 ? fragment.failed : code === 0 ? [] : [`browser check exited ${code}`];
    return { code, failed, timings: fragment.timings };
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
  const browserFiles = files.filter((file) => isBrowserTest(file, app));
  const unitFiles = files.filter((file) => !browserFiles.includes(file));
  const failed: string[] = [];
  let browserTimings: Record<string, FileTiming> = {};
  let unitTimings: Record<string, FileTiming> = {};
  await Promise.all([
    (async () => {
      if (browserFiles.length === 0) return;
      const placed = await placeBrowserCheck(browserFiles, { env, testScript });
      browserTimings = placed.timings;
      failed.push(...placed.failed);
    })(),
    (async () => {
      if (unitFiles.length === 0) return;
      const fragment = join(root, '.temp', `web-unit-timings-${process.pid}-${Date.now()}.json`);
      try {
        const result = await runWebTestLanes({ files: unitFiles, env, testScript, timingsFile: fragment });
        unitTimings = result.timings;
        failed.push(...result.failed);
      } finally {
        rmSync(fragment, { force: true });
      }
    })(),
  ]);
  writeTimings(defaultTimingsFile, readTimings(defaultTimingsFile), { ...unitTimings, ...browserTimings });
  const unique = [...new Set(failed)].sort();
  if (unique.length > 0) throw new Error(`Web tests failed for ${unique.length} file(s):\n${unique.join('\n')}`);
}

async function main(args: string[]): Promise<void> {
  const worker = browserWorkerRequest(args);
  if (worker) {
    const code = await runBrowserWorker(worker);
    if (code !== 0) {
      const fragment = readReportFragment(resolve(root, worker.report));
      const detail = fragment.failed.length > 0 ? fragment.failed.join('\n') : `status ${code}`;
      throw new Error(`Web tests failed for ${Math.max(fragment.failed.length, 1)} file(s):\n${detail}`);
    }
    return;
  }

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
