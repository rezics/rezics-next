import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, moduleExtensionFiles, POSTGRES_IMAGE, schemaDumps, validateMigrationVersions } from './database.ts';
import {
  createRecorder,
  orderFiles,
  type FileTiming,
  parseJunit,
  readLatest,
  timingsDirectory,
  writeTimings,
} from './check-timings.ts';
import { affectedTests } from './affected.ts';
import { buildSearchImage, cgroupArgs, waitForSearch } from './search.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);
let container = '';
let searchContainer = '';

type CheckPlan = { files: string[] | null; tests: string[] };

function moduleTests(moduleDirectory: string): string[] {
  return Array.from(new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: moduleDirectory })).sort();
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function checkPlan(args: string[], moduleDirectory: string): CheckPlan {
  const root = resolve(moduleDirectory);
  const allTests = moduleTests(root);
  if (args.length === 0) return { files: null, tests: allTests };

  let rootRealPath: string | null;
  try {
    rootRealPath = realpathSync(root);
  } catch {
    rootRealPath = null;
  }
  const files = new Set<string>();
  for (const argument of args) {
    const normalized = resolve(root, argument.startsWith('./') ? argument.slice(2) : argument);
    if (!rootRealPath || !pathIsWithin(root, normalized)) {
      throw new Error(`Check path must name an existing file inside ${moduleDirectory}: ${argument}`);
    }

    try {
      if (!statSync(normalized).isFile() || !pathIsWithin(rootRealPath, realpathSync(normalized))) {
        throw new Error();
      }
    } catch {
      throw new Error(`Check path must name an existing file inside ${moduleDirectory}: ${argument}`);
    }

    files.add(relative(root, normalized).split(sep).join('/'));
  }

  const sortedFiles = Array.from(files).sort();
  const testFiles = new Set(allTests);
  return { files: sortedFiles, tests: sortedFiles.filter((file) => testFiles.has(file)) };
}

/** Repository-relative paths changed since `revision`: committed, staged, unstaged and untracked. */
export function gitChangedPaths(revision: string, repository: string = resolve(directory, '../..')): string[] {
  const git = (args: string[]): string => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  const changed = new Set(git(['diff', '--name-only', '--no-relative', '-z', `${revision}...HEAD`]).split('\0'));
  // A rename lists its new path, then its old path as a separate field.
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0');
  for (let index = 0; index < status.length; index += 1) {
    const entry = status[index]!;
    if (entry.length < 4) continue;
    changed.add(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) changed.add(status[(index += 1)] ?? '');
  }
  changed.delete('');
  return Array.from(changed).sort();
}

/** The revision affected mode compares against: the flag wins over the environment; the flag and its value leave `args`. */
function affectedRevision(args: string[], env: NodeJS.ProcessEnv): { revision: string | null; files: string[] } {
  const files: string[] = [];
  let revision: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--affected') {
      revision = args[(index += 1)] ?? '';
      if (revision === '' || revision.startsWith('--')) throw new Error('--affected needs a revision');
    } else if (argument.startsWith('--affected=')) {
      revision = argument.slice('--affected='.length);
      if (revision === '') throw new Error('--affected needs a revision');
    } else {
      files.push(argument);
    }
  }
  return { revision: revision ?? (env.KERNEL_CHECK_AFFECTED || null), files };
}

/**
 * Plan a run from its arguments. With affected mode on and no file arguments, the changed paths choose the test files:
 * a list behaves as if those files were named, `all` as a run with no arguments, and an empty list as a run with
 * arguments that names no test file. The announcement is the line to print first, or null outside affected mode.
 */
export function planCheck(
  args: string[],
  moduleDirectory: string,
  options: { env?: NodeJS.ProcessEnv; changed?: (revision: string) => string[] } = {},
): { plan: CheckPlan; announcement: string | null } {
  const { revision, files } = affectedRevision(args, options.env ?? process.env);
  if (files.length > 0 || revision === null) return { plan: checkPlan(files, moduleDirectory), announcement: null };

  const root = resolve(moduleDirectory);
  const total = moduleTests(root).length;
  const changed = (options.changed ?? gitChangedPaths)(revision);
  const selection = affectedTests(resolve(root, '../..'), root, changed);
  if (selection.kind === 'all') {
    return {
      plan: checkPlan([], moduleDirectory),
      announcement: `Affected mode: all, ${total} of ${total} test files selected (${selection.reason})`,
    };
  }
  return {
    plan: selection.tests.length > 0 ? checkPlan(selection.tests, moduleDirectory) : { files: [], tests: [] },
    announcement: `Affected mode: tests, ${selection.tests.length} of ${total} test files selected`,
  };
}

function diagnosticPath(line: string): string | null | undefined {
  if (/^error TS\d+\b/.test(line)) return null;
  return line.match(/^(.+?)\(\d+,\d+\): error TS\d+\b/)?.[1];
}

export function ownDiagnostics(output: string, files: string[]): string[] {
  const ownedFiles = new Set(files);
  const diagnostics: string[] = [];
  let current: string[] = [];
  let keepCurrent = false;

  const flush = (): void => {
    if (keepCurrent) diagnostics.push(current.join('\n'));
    current = [];
    keepCurrent = false;
  };

  for (const line of output.split(/\r\n?|\n/)) {
    const path = diagnosticPath(line);
    if (path !== undefined) {
      flush();
      current = [line];
      keepCurrent = path === null || ownedFiles.has(path);
    } else if (current.length > 0 && /^[\t ]+/.test(line)) {
      current.push(line);
    } else {
      flush();
    }
  }
  flush();
  return diagnostics;
}

type FileOutcome<T> = { file: string; database: string; output?: T; error?: Error };
type FileRunner<T> = {
  create: (file: string, database: string) => void | Promise<void>;
  run: (file: string, database: string) => T | Promise<T>;
  drop: (file: string, database: string) => void | Promise<void>;
  onComplete?: (outcome: FileOutcome<T>) => void;
};

/** Run the planned test files longest first, each on its own database. */
export function runTestFiles<T>(
  files: string[],
  latest: Record<string, FileTiming>,
  concurrency: number,
  runner: FileRunner<T>,
): Promise<FileOutcome<T>[]> {
  return scheduleFiles(orderFiles(files, latest), concurrency, runner);
}

/** Run independent files through a fixed-size worker pool, cleaning up each created database. */
export async function scheduleFiles<T>(
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
      const database = `kernel_test_${index + 1}`;
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

function hasDiagnosticLine(output: string): boolean {
  return output.split(/\r\n?|\n/).some((line) => diagnosticPath(line) !== undefined);
}

const formatExtensions = new Set([
  '.astro',
  '.cjs',
  '.cts',
  '.css',
  '.gql',
  '.graphql',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.json5',
  '.jsonc',
  '.less',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.scss',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);

function formattedFiles(files: string[]): string[] {
  return files.filter((file) => formatExtensions.has(extname(file).toLowerCase()));
}

export function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(program, args, { cwd: directory, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

// Asynchronous, so the file pool's lanes overlap; a synchronous spawn blocks the event loop and runs them one at a time.
export async function capture(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; output: string }> {
  const child = Bun.spawn([program, ...args], { cwd: directory, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, output: `${stdout}${stderr}` };
}

async function psql(sql: string): Promise<void> {
  const result = await capture('docker', [
    'exec',
    container,
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
  if (result.status !== 0) throw new Error(`psql -c ${sql} failed:\n${result.output}`);
}

/** Kernel tests start containers and compilers; under a loaded host Bun's 5 s per-test default fails them at random. */
export function testCommand(file: string, junitFile: string): string[] {
  return ['test', '--timeout', '60000', '--reporter=junit', `--reporter-outfile=${junitFile}`, `./${file}`];
}

export function docker(args: string[]): string {
  return run('docker', args);
}

type DockerCommand = (args: string[]) => string;

export function startPostgresContainer(dockerCommand: DockerCommand = docker): string {
  return dockerCommand([
    'run',
    '-d',
    ...cgroupArgs(),
    '--label',
    `rezics.kernel.check.pid=${pid}`,
    '-p',
    '127.0.0.1::5432',
    // Six concurrent test databases, growth seeds at three scales and up to max_wal_size of WAL outgrew 1g, and every
    // later file then failed to create its database. tmpfs only takes memory for what is written.
    '--tmpfs',
    '/var/lib/postgresql:rw,size=8g',
    '-e',
    'POSTGRES_USER=rezics',
    '-e',
    'POSTGRES_PASSWORD=rezics',
    '-e',
    'POSTGRES_DB=rezics',
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
    '-c',
    'max_wal_size=256MB',
    // Each concurrent file opens several pools of up to ten connections; the default 100 runs out.
    '-c',
    'max_connections=500',
  ]);
}

export function cleanupStale(kind: 'check' | 'derived' = 'check'): void {
  // One listing carries each owner, so a concurrent run that exits meanwhile cannot fail an inspect.
  const rows = docker([
    'ps',
    '-a',
    '--filter',
    `label=rezics.kernel.${kind}.pid`,
    '--format',
    `{{.ID}} {{.Label "rezics.kernel.${kind}.pid"}}`,
  ])
    .split('\n')
    .filter(Boolean);
  for (const row of rows) {
    const [id, owner] = row.split(' ');
    try {
      process.kill(Number(owner), 0);
    } catch {
      // Removing a container that is already gone is the outcome we want.
      spawnSync('docker', ['rm', '-f', id!], { cwd: directory, encoding: 'utf8' });
    }
  }
}

export function cleanup(
  containers: readonly string[] = [searchContainer, container],
  dockerCommand: DockerCommand = docker,
): void {
  for (const id of containers) {
    if (!id) continue;
    try {
      dockerCommand(['rm', '-f', id]);
    } catch (error) {
      console.error(error);
    }
  }
}

function logPostgresIfStopped(containerId: string): void {
  if (!containerId) return;

  try {
    if (docker(['inspect', '--format', '{{.State.Running}}', containerId]) === 'true') return;
  } catch {
    // Try to fetch logs even if inspect cannot find the container.
  }

  try {
    const logs = docker(['logs', '--tail', '50', containerId]);
    if (logs) process.stderr.write(`${logs}\n`);
  } catch (error) {
    console.error(error);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

let remoteRun: ReturnType<typeof Bun.spawn> | undefined;

/** The hosts file when this check should run on a development host: named, readable and not already on one. */
function remoteHostsFile(): string | null {
  const file = process.env.KERNEL_CHECK_REMOTE;
  if (!file || process.env.KERNEL_CHECK_ON_REMOTE) return null;
  try {
    accessSync(file, constants.R_OK);
    return file;
  } catch {
    process.stderr.write(`KERNEL_CHECK_REMOTE ${file} is not readable; running the check locally\n`);
    return null;
  }
}

/** The plan was computed here, where Git history is; the host runs exactly its files. */
async function runRemotely(plan: CheckPlan): Promise<void> {
  const root = resolve(directory, '../..');
  const forwarded = process.env.KERNEL_CHECK_CONCURRENCY
    ? ['env', `KERNEL_CHECK_CONCURRENCY=${process.env.KERNEL_CHECK_CONCURRENCY}`]
    : [];
  remoteRun = Bun.spawn(
    [
      process.execPath,
      resolve(root, 'scripts/remote-check.ts'),
      '--cwd',
      relative(root, directory),
      root,
      '--',
      ...forwarded,
      'bun',
      'scripts/check.ts',
      ...(plan.files ?? []),
    ],
    { cwd: root, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
  );
  process.exitCode = await remoteRun.exited;
}

async function main(): Promise<void> {
  const { plan, announcement } = planCheck(process.argv.slice(2), directory);
  if (announcement) console.log(announcement);
  const migrationFiles = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrationFiles, new Date());

  // An affected selection of no tests stays here: the remote check reads an empty file list as the whole suite.
  if (remoteHostsFile() && plan.files?.length !== 0) return await runRemotely(plan);
  const extensionFiles = moduleExtensionFiles();
  if (extensionFiles.length) fail(`Module migrations must not create extensions:\n${extensionFiles.join('\n')}`);

  cleanupStale();
  const searchImage = buildSearchImage();
  container = startPostgresContainer();
  searchContainer = docker([
    'run',
    '-d',
    ...cgroupArgs(),
    '--label',
    `rezics.kernel.check.pid=${pid}`,
    '-p',
    '127.0.0.1::9200',
    '--tmpfs',
    '/usr/share/opensearch/data:rw,size=1g,uid=1000,gid=1000,mode=0755',
    '-e',
    'discovery.type=single-node',
    '-e',
    'DISABLE_SECURITY_PLUGIN=true',
    '-e',
    'DISABLE_INSTALL_DEMO_CONFIG=true',
    '-e',
    'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
    searchImage,
  ]);
  const searchPortOutput = docker(['port', searchContainer, '9200/tcp']);
  const searchPortMatch = searchPortOutput.match(/127\.0\.0\.1:(\d+)/);
  if (!searchPortMatch?.[1]) fail(`Could not determine the test search port: ${searchPortOutput}`);
  const searchUrl = `http://127.0.0.1:${searchPortMatch[1]}`;

  const portOutput = docker(['port', container, '5432/tcp']);
  const match = portOutput.match(/127\.0\.0\.1:(\d+)/);
  if (!match?.[1]) fail(`Could not determine the test database port: ${portOutput}`);
  const url = `postgres://rezics:rezics@127.0.0.1:${match[1]}/rezics?sslmode=disable`;
  process.env.KERNEL_DATABASE_CONTAINER = container;
  const env = { ...process.env, DATABASE_URL: url, KERNEL_DATABASE_CONTAINER: container };

  migrate(url);
  for (const [path, dump] of Object.entries(schemaDumps(url))) {
    const file = Bun.file(resolve(directory, path));
    if (!(await file.exists()) || (await file.text()) !== dump) {
      fail(`Schema dump differs from ${path}; run \`bun run db dump\``);
    }
  }

  const tsc = resolve(directory, '../../node_modules/.bin/tsc');
  const oxlint = resolve(directory, '../../node_modules/.bin/oxlint');
  const oxfmt = resolve(directory, '../../node_modules/.bin/oxfmt');
  if (plan.files === null) {
    run(tsc, ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
    run(oxlint, ['--config', '../../.oxlintrc.json', '.'], env);
    run(oxfmt, ['--check', '.'], env);
  } else {
    const typecheck = await capture(
      tsc,
      ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json', '--pretty', 'false'],
      env,
    );
    const diagnostics = ownDiagnostics(typecheck.output, plan.files);
    if (diagnostics.length) fail(diagnostics.join('\n'));
    if (typecheck.status !== 0 && !hasDiagnosticLine(typecheck.output)) {
      fail(`tsc exited with status ${typecheck.status} without diagnostics:\n${typecheck.output}`);
    }

    const lintFiles = plan.files.filter((file) => file.endsWith('.ts'));
    if (lintFiles.length) run(oxlint, ['--config', '../../.oxlintrc.json', ...lintFiles], env);

    const formatFiles = formattedFiles(plan.files);
    if (formatFiles.length) run(oxfmt, ['--check', ...formatFiles], env);
  }

  const testFiles = plan.tests;
  await waitForSearch(searchUrl, searchContainer);
  const concurrency = Number(process.env.KERNEL_CHECK_CONCURRENCY ?? 6);
  if (!Number.isInteger(concurrency) || concurrency < 1) fail('KERNEL_CHECK_CONCURRENCY must be a positive integer');
  const reports = mkdtempSync(join(tmpdir(), 'kernel-check-'));
  const recorder = createRecorder();
  let timingsPath: string | null = null;
  try {
    timingsPath = timingsDirectory(directory);
  } catch (error) {
    console.warn(`Check timings are not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const latest = timingsPath ? readLatest(timingsPath) : {};
  const runner = recorder.wrap(
    {
      // Each file gets a fresh copy so its result cannot depend on writes from another file.
      create: (_file, database) => psql(`CREATE DATABASE ${database} TEMPLATE rezics`),
      run: async (file, database) => {
        const result = await capture('bun', testCommand(file, join(reports, `${database}.xml`)), {
          ...env,
          DATABASE_URL: url.replace(/\/rezics(?=\?)/, `/${database}`),
          OPENSEARCH_URL: searchUrl,
        });
        if (result.status !== 0) throw new Error(`bun test ./${file} failed:\n${result.output}`);
        return result.output;
      },
      drop: (_file, database) => psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
    },
    async (_file, database) => parseJunit(readFileSync(join(reports, `${database}.xml`), 'utf8')),
  );
  const outcomes = await runTestFiles(testFiles, latest, concurrency, {
    ...runner,
    onComplete: (outcome) => {
      if (outcome.output) process.stdout.write(outcome.output.endsWith('\n') ? outcome.output : `${outcome.output}\n`);
      if (outcome.error) process.stderr.write(`${outcome.file}: ${outcome.error.message}\n`);
    },
  });
  rmSync(reports, { recursive: true, force: true });
  if (timingsPath) writeTimings(timingsPath, recorder.timings(), { partial: plan.files !== null });
  const failedFiles = outcomes.filter((outcome) => outcome.error).map((outcome) => outcome.file);
  if (failedFiles.length) fail(`Kernel tests failed for ${failedFiles.length} file(s):\n${failedFiles.join('\n')}`);
}

if (import.meta.main) {
  // A run handed to a host must clean up there; the hand-off removes its run directory and releases its slot on a signal.
  process.on('SIGINT', () => {
    if (remoteRun) return void remoteRun.kill('SIGINT');
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    if (remoteRun) return void remoteRun.kill('SIGTERM');
    cleanup();
    process.exit(143);
  });

  try {
    await main();
  } catch (error) {
    logPostgresIfStopped(container);
    console.error(error);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}
