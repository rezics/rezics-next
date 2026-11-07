import {
  createRecorder,
  capture,
  classifyLoadInducedFailures,
  parseJunit,
  rerunLoadFailures,
  runLaneSuite,
  runTestFiles,
  scheduleFiles,
  testCommand,
  type FileOutcome,
  type FileTiming,
} from '../../../scripts/test-lanes.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StackRun } from '../../../scripts/stack-run.ts';
import { placeWebCheck, requireWebCheckCustody, routeWebCheck, workspacePath } from './check-placement.ts';
import {
  databaseCheck,
  ownDatabase,
  run as runAuthDatabaseCommand,
  TEMPLATE_DATABASE,
} from '../../../services/auth/scripts/database.ts';
import { ensureLocalWorkerVars } from './dev-vars.ts';
import { compileWebPrograms } from './typecheck.ts';
import {
  isWebHostTestFile,
  readWebTestSelectionContext,
  resolveWebTestSelection,
  testSelectorArgumentIndices,
  webTestSelectionContextEnvironment,
  writeWebTestSelectionContext,
  type WebTestSelection,
  type WebTestSelectionContext,
} from './selection.ts';

export { ensureLocalWorkerVars };

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');
const defaultTimingsFile = join(app, '.cache', 'check-timings.json');
const seedTimingsFile = join(app, 'check-timings.json');
export const webCheckTimingsFile = defaultTimingsFile;
const browserTest =
  /from\s+['"](?:playwright|@playwright\/|@vitest\/browser)|\b(?:chromium|browser)\.launch\b|\.goto\s*\(|\b(?:spawn|createServer|Bun\.serve)\s*\(/;

export type WebTestLanesOptions = {
  files: string[];
  directory?: string;
  timingsFile?: string;
  previousTimingsFile?: string;
  seedTimingsFile?: string;
  env?: NodeJS.ProcessEnv;
  testScript?: string;
  /** Bun filters are forwarded to each fresh per-file process. */
  testArgs?: string[];
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

function readTimings(path: string): Record<string, FileTiming> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { files?: unknown };
    return parsed.files && typeof parsed.files === 'object' ? (parsed.files as Record<string, FileTiming>) : null;
  } catch {
    return null;
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
  requireWebCheckCustody(root, options.directory ?? app);
  const directory = resolve(options.directory ?? app);
  const timingsFile = resolve(options.timingsFile ?? defaultTimingsFile);
  const sourceEnvironment = options.env ?? process.env;
  const testScript = options.testScript ?? 'bun run test';
  const testInvocation = testScript.trim().split(/\s+/);
  if (testInvocation.length < 2 || testInvocation[0] !== 'bun' || testInvocation[1] !== 'run') {
    throw new Error(`The per-file test command must start with "bun run": ${testScript}`);
  }

  const browserConcurrency = concurrency('WEB_BROWSER_CHECK_CONCURRENCY', 6, sourceEnvironment);
  const unitConcurrency = concurrency('WEB_UNIT_CHECK_CONCURRENCY', 10, sourceEnvironment);
  const stackConcurrency = sourceEnvironment.REZICS_STACK_SLOT === undefined ? browserConcurrency : 1;
  const browserFiles = options.files.filter((file) => isBrowserTest(file, directory));
  const unitFiles = options.files.filter((file) => !browserFiles.includes(file));
  const previous =
    readTimings(timingsFile) ??
    readTimings(options.previousTimingsFile ?? defaultTimingsFile) ??
    readTimings(options.seedTimingsFile ?? seedTimingsFile) ??
    {};
  mkdirSync(join(root, '.temp'), { recursive: true });
  const reportDirectory = options.reportDirectory
    ? resolve(options.reportDirectory)
    : mkdtempSync(join(root, '.temp/web-check-'));
  mkdirSync(reportDirectory, { recursive: true });
  const recorder = createRecorder();
  const reportsByFile = new Map<string, string>();
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
          const testArguments = (options.testArgs ?? []).filter((argument, index, all) => {
            if (argument === '--reporter' || argument === '--reporter-outfile') return false;
            if (argument.startsWith('--reporter=') || argument.startsWith('--reporter-outfile=')) return false;
            if (all[index - 1] === '--reporter' || all[index - 1] === '--reporter-outfile') return false;
            return argument !== '--dots' && argument !== '--only-failures';
          });
          const result = await capture(
            invocation[0]!,
            [...invocation.slice(1), ...testCommand(file, report, undefined, testArguments).slice(1)],
            env,
            directory,
          );
          try {
            reportsByFile.set(file, readFileSync(report, 'utf8'));
          } catch {
            reportsByFile.delete(file);
          }
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
  const inheritedStateRoot = sourceEnvironment.WEB_TEST_STATE_DIR || undefined;
  const ownedStateRoot = inheritedStateRoot ? undefined : mkdtempSync(join(tmpdir(), 'rezics-web-check-root-'));
  const env: NodeJS.ProcessEnv = {
    ...sourceEnvironment,
    REZICS_TEST_RUNTIME: '1',
    WEB_TEST_STATE_DIR: inheritedStateRoot ?? ownedStateRoot,
  };

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
    let rerunIndex = 0;
    const { failed } = await rerunLoadFailures(
      [...browserOutcomes, ...unitOutcomes],
      async (file) => {
        const [outcome] = await scheduleFiles(`web_rerun_${++rerunIndex}_test`, [file], 1, runner);
        return outcome!;
      },
      (outcome) => classifyLoadInducedFailures(outcome, reportsByFile.get(outcome.file)),
    );
    const timings = recorder.timings();
    writeTimings(timingsFile, previous, timings);
    return {
      failed: failed.map((outcome) => outcome.file).sort(),
      concurrency: { browser: stackConcurrency, unit: unitConcurrency },
      timings,
    };
  } finally {
    try {
      if (!options.retainReport) rmSync(reportDirectory, { recursive: true, force: true });
    } finally {
      if (ownedStateRoot) rmSync(ownedStateRoot, { recursive: true, force: true });
    }
  }
}

export type BrowserPlacement = {
  code: number;
  failed: string[];
  timings: Record<string, FileTiming>;
};

export type BrowserWorkerCommandOptions = {
  files: string[];
  report: string;
  testScript?: string;
  testArgs?: string[];
};

/** Serialize the complete selected Bun invocation for the check-host worker. */
export function browserWorkerCommand(input: BrowserWorkerCommandOptions): string[] {
  return [
    'bun',
    'scripts/check.ts',
    '--browser',
    '--report',
    input.report,
    ...(input.testScript === undefined ? [] : ['--test-command', input.testScript]),
    ...input.files,
    ...(input.testArgs?.length ? ['--', ...input.testArgs] : []),
  ];
}

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
  testArgs?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  if (input.report === '' || input.report.startsWith('/') || input.report.split('/').includes('..')) {
    throw new Error(`report must stay inside the workspace: ${input.report}`);
  }
  requireWebCheckCustody(root, app);
  const reportDirectory = resolve(root, input.report);
  const result = await runWebTestLanes({
    files: input.files,
    ...(input.testArgs === undefined ? {} : { testArgs: input.testArgs }),
    // A placed worker shares one generated source tree and Vite cache between its browser files.
    env: { ...(input.env ?? process.env), WEB_BROWSER_CHECK_CONCURRENCY: '1' },
    ...(input.testScript === undefined ? {} : { testScript: input.testScript }),
    reportDirectory,
    timingsFile: join(reportDirectory, 'timings.json'),
    previousTimingsFile: defaultTimingsFile,
    retainReport: true,
  });
  if (result.failed.length > 0) writeFileSync(join(reportDirectory, 'failed.txt'), `${result.failed.join('\n')}\n`);
  return result.failed.length > 0 ? 1 : 0;
}

/** `--browser` is the command a check host runs; it carries the report directory the caller asked to have back. */
export function browserWorkerRequest(
  args: string[],
): { files: string[]; report: string; testScript: string; testArgs: string[] } | null {
  const separator = args.indexOf('--');
  const checkArgs = separator < 0 ? args : args.slice(0, separator);
  const testArgs = separator < 0 ? [] : args.slice(separator + 1);
  if (!checkArgs.includes('--browser')) return null;
  const testScript = testScriptArgument(checkArgs);
  const reportAt = checkArgs.indexOf('--report');
  const report = reportAt >= 0 ? checkArgs[reportAt + 1] : undefined;
  if (!report || report.startsWith('--')) throw new Error('--browser needs --report <directory>');
  const files: string[] = [];
  for (let index = 0; index < checkArgs.length; index += 1) {
    const argument = checkArgs[index]!;
    if (argument === '--browser' || argument === '--skip-format') continue;
    if (argument === '--report' || argument === '--test-command') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    files.push(argument);
  }
  return { files, report, testScript, testArgs };
}

/**
 * Hands browser files to stack placement and returns their report directory. A check host handles the command through
 * `--browser`, which runs the files without placing them again.
 */
export async function placeBrowserCheck(
  files: string[],
  options: { env?: NodeJS.ProcessEnv; testScript?: string; testArgs?: string[] } = {},
): Promise<BrowserPlacement> {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const report = relative(root, mkdtempSync(join(root, '.temp/web-check-')))
    .split(sep)
    .join('/');
  const directory = resolve(root, report);
  const testScript = options.testScript;
  try {
    const code = await placeWebCheck(
      {
        label: 'web browser check',
        root,
        cwd: app,
        command: browserWorkerCommand({
          files,
          report,
          ...(testScript === undefined ? {} : { testScript }),
          ...(options.testArgs === undefined ? {} : { testArgs: options.testArgs }),
        }),
        returns: [report],
      },
      async (slotEnv) => {
        return runBrowserWorker({
          files,
          report,
          ...(testScript === undefined ? {} : { testScript }),
          ...(options.testArgs === undefined ? {} : { testArgs: options.testArgs }),
          env: { ...(options.env ?? process.env), ...slotEnv },
        });
      },
      options.env ?? process.env,
    );
    const fragment = readReportFragment(directory);
    const failed = fragment.failed.length > 0 ? fragment.failed : code === 0 ? [] : [`browser check exited ${code}`];
    return { code, failed, timings: fragment.timings };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Same two tsc programs as official typecheck; generate already ran in `prepare`. */
async function runWebTypecheck(env: NodeJS.ProcessEnv): Promise<void> {
  process.stdout.write('\n[web check] typecheck\n');
  const started = performance.now();
  const code = await compileWebPrograms(async (args) => {
    const child = Bun.spawn([...args], {
      cwd: app,
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  });
  process.stdout.write(`[web check] typecheck ${(performance.now() - started) / 1000}s\n`);
  if (code !== 0) throw new Error(`typecheck failed with status ${code}`);
}

async function runCommand(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = app,
): Promise<void> {
  process.stdout.write(`\n[web check] ${label}\n`);
  const started = performance.now();
  const routed = await routeWebCheck({ root, cwd, command: [command, ...args] }, env);
  if (routed !== null) {
    if (routed !== 0) throw new Error(`${label} failed with status ${routed}`);
    return;
  }
  const child = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const status = await child.exited;
  process.stdout.write(`[web check] ${label} ${(performance.now() - started) / 1000}s\n`);
  if (status !== 0) throw new Error(`${label} failed with status ${status}`);
}

/** Places Docker-backed host tests through the finite remote driver, without local fallback. */
export async function runHostTests(
  env: NodeJS.ProcessEnv = process.env,
  place: typeof placeWebCheck = placeWebCheck,
  execute: typeof runCommand = runCommand,
): Promise<void> {
  const run: StackRun = {
    label: 'web host tests',
    root,
    cwd: app,
    command: ['bun', 'run', 'test:host'],
  };
  const code = await place(
    run,
    async (slotEnv) => {
      await execute('host tests', 'bun', ['run', 'test:host'], {
        ...env,
        ...slotEnv,
        REZICS_TEST_RUNTIME: '1',
      });
      return 0;
    },
    env,
  );
  if (code !== 0) throw new Error(`host tests failed with status ${code}`);
}

/** Runs the Auth-backed Web host fixture in Auth's database lane without widening the general Web host suite. */
async function runAuthBindingHostTest(
  env: NodeJS.ProcessEnv = process.env,
  testArguments: string[] = [],
): Promise<void> {
  const routed = await routeWebCheck(
    { root, cwd: app, command: ['bun', 'scripts/check.ts', '--auth-binding-host', ...testArguments] },
    env,
  );
  if (routed !== null) {
    if (routed !== 0) throw new Error(`Auth binding host test placement failed with status ${routed}`);
    return;
  }
  const file = 'apps/web/tests/auth-binding.host.test.ts';
  const remoteCommand = ['bun', '../../apps/web/scripts/check.ts', '--auth-binding-host', ...testArguments];
  const code = await databaseCheck(remoteCommand, async () => {
    const database = ownDatabase();
    try {
      const psql = async (sql: string): Promise<void> => {
        runAuthDatabaseCommand('docker', [
          'exec',
          database.container,
          'psql',
          '-U',
          'rezics',
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          sql,
        ]);
      };
      const { failed } = await runLaneSuite({
        service: 'auth',
        directory: root,
        files: [file],
        partial: true,
        testArguments,
        createDatabase: (name) => psql(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`),
        dropDatabase: (name) => psql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
        environment: (name) => {
          const url = database.url.replace(`/${TEMPLATE_DATABASE}?`, `/${name}?`);
          const testEnvironment: NodeJS.ProcessEnv = { ...env };
          delete testEnvironment[webTestSelectionContextEnvironment];
          return {
            ...testEnvironment,
            AUTH_CHECK_CONTAINER: database.container,
            AUTH_CHECK_LANE_OWNER: String(process.pid),
            DATABASE_URL: url,
            AUTH_TEST_DATABASE_URL: url,
          };
        },
        env,
      });
      if (failed.length > 0) throw new Error(`Auth binding host test failed:\n${failed.join('\n')}`);
    } finally {
      database.close();
    }
    return 0;
  });
  if (code !== 0) throw new Error(`Auth binding host test placement failed with status ${code}`);
}

export type WebHostTestRuntime = {
  /** Override the Web root in routing tests; normal checks use the current app. */
  directory?: string;
  /** Runs the Auth fixture through its existing Auth-owned database lane. */
  runAuthBinding?: (env: NodeJS.ProcessEnv, testArguments: string[]) => Promise<void>;
  /** Runs the remaining native host files through Bun's existing host-test runner. */
  runNative?: (
    files: string[],
    env: NodeJS.ProcessEnv,
    execution: { cwd: string; command: string[]; selection?: WebTestSelectionContext },
  ) => Promise<void>;
};

export type WebNativeHostExecution = {
  cwd: string;
  command: string[];
  selection?: WebTestSelectionContext;
};

function selectionTestArguments(selection: WebTestSelectionContext | undefined): string[] {
  if (!selection) return [];
  const argv = selection.normalizedArgv;
  const separator = argv.indexOf('--');
  const checkArgs = separator < 0 ? argv : argv.slice(0, separator);
  const selectors = new Set(testSelectorArgumentIndices(checkArgs, 'web-check'));
  const arguments_: string[] = [];
  for (let index = 0; index < checkArgs.length; index += 1) {
    if (selectors.has(index)) continue;
    const argument = checkArgs[index]!;
    if (argument === '--test-command') {
      index += 1;
      continue;
    }
    if (argument === '--skip-format' || argument === '--tests-only' || argument === '--host') continue;
    arguments_.push(argument);
  }
  if (separator >= 0) arguments_.push('--', ...argv.slice(separator + 1));
  return arguments_;
}

function bunTestFilesCommand(files: string[], testArgs: string[], prefixArgs: string[] = []): string[] {
  const separator = testArgs.indexOf('--');
  const bunArgs = separator < 0 ? testArgs : testArgs.slice(0, separator);
  const programArgs = separator < 0 ? [] : testArgs.slice(separator + 1);
  return [
    'bun',
    'test',
    ...prefixArgs,
    ...bunArgs,
    ...files.map((file) => `./${file}`),
    ...(separator < 0 ? [] : ['--', ...programArgs]),
  ];
}

function discoverWebHostFiles(directory: string): string[] {
  return [...new Set(new Bun.Glob('tests/**/*.host.test.ts').scanSync({ cwd: directory }))].sort();
}

/** Routes every discovered Web host file once, preserving Auth's own database placement boundary. */
export async function runWebHostTests(
  env: NodeJS.ProcessEnv = process.env,
  runtime: WebHostTestRuntime = {},
  selection?: WebTestSelectionContext,
): Promise<void> {
  const directory = runtime.directory ?? app;
  const selectedFiles = selection?.selectedFiles ?? [];
  const files = selectedFiles.length ? selectedFiles.slice() : discoverWebHostFiles(directory);
  const testArguments = selectionTestArguments(selection);
  const authFile = 'tests/auth-binding.host.test.ts';
  const nativeFiles = files.filter((file) => file !== authFile);
  const failures: string[] = [];
  const runAuthBinding = runtime.runAuthBinding ?? runAuthBindingHostTest;
  const nativeExecution: WebNativeHostExecution = {
    cwd: directory,
    command: bunTestFilesCommand(nativeFiles, testArguments, ['--path-ignore-patterns=node_modules/**']),
    ...(selection === undefined ? {} : { selection }),
  };
  const runNative =
    runtime.runNative ??
    ((selected: string[], commandEnv: NodeJS.ProcessEnv, execution: WebNativeHostExecution) => {
      const commandEnvironment = { ...commandEnv };
      delete commandEnvironment[webTestSelectionContextEnvironment];
      return runCommand('host tests', 'bun', execution.command.slice(1), commandEnvironment, execution.cwd);
    });

  if (files.includes(authFile)) {
    try {
      await runAuthBinding(env, testArguments);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (nativeFiles.length > 0) {
    try {
      await runNative(nativeFiles, env, nativeExecution);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) throw new Error(failures.join('\n'));
}

export type WebCheckRuntime = {
  hostTests?: WebHostTestRuntime;
  authBindingHostTest?: (env: NodeJS.ProcessEnv, testArguments: string[]) => Promise<void>;
  /** Lets focused routing tests inspect the exact owning cwd and retained selection context. */
  route?: typeof routeWebCheck;
  invocationDirectory?: string;
};

async function prepare(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand('generate', 'bun', ['run', 'generate'], env);
  await runCommand('route generation', 'bun', ['run', 'generate:routes'], env);
  await runCommand('dependency optimization', 'bun', ['x', 'vite', 'optimize', '--config', 'vite.config.ts'], env);
}

function testScriptArgument(args: string[]): string {
  const index = args.indexOf('--test-command');
  const command = index < 0 ? 'bun run test' : args[index + 1];
  if (command !== 'bun run test')
    throw new Error('Usage: bun scripts/check.ts [--stories] --test-command "bun run test"');
  return command;
}

async function runTests(
  files: string[],
  env: NodeJS.ProcessEnv,
  testScript: string,
  testArgs: string[] = [],
): Promise<void> {
  const browserFiles = files.filter((file) => isBrowserTest(file, app));
  const unitFiles = files.filter((file) => !browserFiles.includes(file));
  const failed: string[] = [];
  let browserTimings: Record<string, FileTiming> = {};
  let unitTimings: Record<string, FileTiming> = {};
  const runBrowser = async () => {
    if (browserFiles.length === 0) return;
    const placed = await placeBrowserCheck(browserFiles, { env, testScript, testArgs });
    browserTimings = placed.timings;
    failed.push(...placed.failed);
  };
  const runUnits = async () => {
    if (unitFiles.length === 0) return;
    const fragment = join(root, '.temp', `web-unit-timings-${process.pid}-${Date.now()}.json`);
    try {
      const result = await runWebTestLanes({
        files: unitFiles,
        testArgs,
        env,
        testScript,
        timingsFile: fragment,
        previousTimingsFile: defaultTimingsFile,
      });
      unitTimings = result.timings;
      failed.push(...result.failed);
    } finally {
      rmSync(fragment, { force: true });
    }
  };
  if (env.WEB_CHECK_SERIAL_LANES === '1') {
    await runBrowser();
    await runUnits();
  } else {
    await Promise.all([runBrowser(), runUnits()]);
  }
  writeTimings(defaultTimingsFile, readTimings(defaultTimingsFile) ?? readTimings(seedTimingsFile) ?? {}, {
    ...unitTimings,
    ...browserTimings,
  });
  const unique = [...new Set(failed)].sort();
  if (unique.length > 0) throw new Error(`Web tests failed for ${unique.length} file(s):\n${unique.join('\n')}`);
}

export async function main(args: string[], runtime: WebCheckRuntime = {}): Promise<void> {
  const routedSelection = args.length === 1 && args[0] === '--routed-selection';
  const inheritedSelection = routedSelection ? readWebTestSelectionContext() : undefined;
  if (routedSelection && !inheritedSelection)
    throw new Error('--routed-selection requires the placed Web test selection context');
  const currentArgs = routedSelection ? inheritedSelection!.normalizedArgv.slice() : args.slice();
  const isSpecialRoute =
    currentArgs[0] === '--personal-host' ||
    currentArgs[0] === '--auth-binding-host' ||
    currentArgs.includes('--browser') ||
    currentArgs.includes('--stories') ||
    currentArgs.includes('--prepare-only');
  const selection: WebTestSelection | undefined = isSpecialRoute
    ? undefined
    : inheritedSelection
      ? { ...inheritedSelection, executionCwd: app, command: inheritedSelection.normalizedArgv.slice() }
      : resolveWebTestSelection(currentArgs, {
          rootDirectory: root,
          appDirectory: app,
          invocationDirectory: runtime.invocationDirectory ?? process.cwd(),
          source: 'apps/web/scripts/check.ts',
          commandKind: 'web-check',
        });
  const routeEnvironment = selection ? writeWebTestSelectionContext(selection) : process.env;
  const routeCommand = selection ? ['--routed-selection'] : currentArgs;
  const workerReport = browserWorkerRequest(currentArgs)?.report;
  const returned = workerReport ? [workspacePath(root, workerReport)] : ['apps/web/.cache/check-timings.json'];
  if (currentArgs.includes('--prepare-only')) returned.push('apps/web/.dev.vars');
  const routed = await (runtime.route ?? routeWebCheck)(
    {
      root,
      cwd: app,
      command: ['bun', 'scripts/check.ts', ...routeCommand],
      returns: returned,
    },
    routeEnvironment,
  );
  if (routed !== null) {
    process.exitCode = routed;
    return;
  }
  if (currentArgs[0] === '--personal-host') {
    if (currentArgs.length !== 1) throw new Error('Usage: bun apps/web/scripts/check.ts --personal-host');
    // Explicit integration gate: keep ordinary host discovery/placement and its
    // parent ownership rules unchanged. The frozen suite owns each factory.
    await runCommand(
      'personal host outcomes',
      'bun',
      ['test', './tests/native/web-personal-driver.host.test.ts'],
      process.env,
    );
    return;
  }
  if (currentArgs[0] === '--auth-binding-host') {
    const testArguments = currentArgs.slice(1);
    const selectors = testSelectorArgumentIndices(['bun', 'test', ...testArguments], 'bun-test');
    if (selectors.length > 0) throw new Error('--auth-binding-host accepts Bun test options, not file selectors');
    await (runtime.authBindingHostTest ?? runAuthBindingHostTest)(process.env, testArguments);
    return;
  }
  if (currentArgs[0] === '--host') {
    const files = selection?.selectedFiles ?? [];
    if (currentArgs.length > 1 && files.length === 0)
      throw new Error('Usage: bun apps/web/scripts/check.ts --host [tests/**/*.host.test.ts]');
    if (files.some((file) => !isWebHostTestFile(file)))
      throw new Error('--host accepts only Web *.host.test.ts selectors');
    await runWebHostTests(process.env, runtime.hostTests, selection);
    return;
  }
  if (currentArgs.includes('--prepare-only')) {
    ensureLocalWorkerVars();
    await prepare(process.env);
    return;
  }
  const worker = browserWorkerRequest(currentArgs);
  if (worker) {
    await prepare(process.env);
    const code = await runBrowserWorker(worker);
    if (code !== 0) {
      const fragment = readReportFragment(resolve(root, worker.report));
      const detail = fragment.failed.length > 0 ? fragment.failed.join('\n') : `status ${code}`;
      throw new Error(`Web tests failed for ${Math.max(fragment.failed.length, 1)} file(s):\n${detail}`);
    }
    return;
  }

  const env = process.env;
  const testScript = testScriptArgument(currentArgs);
  const testArgs = selectionTestArguments(selection);
  if (currentArgs.includes('--stories')) {
    await runTests(['tests/page-stories.test.ts'], env, testScript, testArgs);
    return;
  }

  if (!currentArgs.includes('--skip-format'))
    await runCommand('format', 'oxfmt', ['--check', '.', '!src/kernel/recorded/*.json'], env);
  await prepare(env);

  const requestedFiles = selection?.selectedFiles ?? [];
  const files =
    requestedFiles.length > 0
      ? requestedFiles
      : [...new Bun.Glob('tests/*.test.ts').scanSync({ cwd: app })]
          .filter((file) => !file.endsWith('.host.test.ts'))
          .sort();
  if (requestedFiles.length > 0) {
    const nativeFiles = requestedFiles.filter(isWebHostTestFile);
    const ordinaryFiles = requestedFiles.filter((file) => !isWebHostTestFile(file));
    await runTests(ordinaryFiles, env, testScript, testArgs);
    if (nativeFiles.length > 0) {
      await runWebHostTests(
        env,
        runtime.hostTests,
        selection ? { ...selection, selectedFiles: nativeFiles } : undefined,
      );
    }
    return;
  }
  const results = await Promise.allSettled([runWebTypecheck(env), runTests(files, env, testScript, testArgs)]);
  const hostResult = await Promise.allSettled([runHostTests(env)]);
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
