import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStackSlot } from '../../../scripts/stack-lease.ts';
import { migrate, moduleExtensionFiles, POSTGRES_IMAGE, schemaDumps, validateMigrationVersions } from './database.ts';
import { buildSearchImage, cgroupArgs, waitForSearch } from './search.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);
let container = '';
let searchContainer = '';
let reyloDirectory = '';

// Cloned from the migrated template once and never used as a template; Reylo reads every analysis from it.
const ANALYSIS_DATABASE = 'kernel_analysis';

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

/**
 * Writes the Reylo project file that points every analysis at `analysisUrl`, in `directory`, which then holds `.reylo/`.
 * Reylo keys its entries by database name, so analysing in each file's own copy re-describes every statement there.
 */
export function writeReyloProject(directory: string, analysisUrl: string): string {
  const file = resolve(directory, '.reylo.yaml');
  writeFileSync(file, `direct_url: ${JSON.stringify(analysisUrl)}\n`);
  return file;
}

/** The environment of every process one test file starts: its own database copy, the shared search node and Reylo's analysis database. */
export function fileEnvironment(
  base: NodeJS.ProcessEnv,
  file: { url: string; database: string; searchUrl: string; reyloConfig: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    DATABASE_URL: file.url.replace(/\/rezics(?=\?)/, `/${file.database}`),
    OPENSEARCH_URL: file.searchUrl,
    REYLO_CONFIG: file.reyloConfig,
    KERNEL_POOL_ACQUIRE_TIMEOUT_MS: '2000',
  };
}

export type FileOutcome<T> = { file: string; database: string; output?: T; error?: Error };
export type FileRunner<T> = {
  create: (file: string, database: string) => void | Promise<void>;
  run: (file: string, database: string, env?: Record<string, string>) => T | Promise<T>;
  drop: (file: string, database: string) => void | Promise<void>;
  onComplete?: (outcome: FileOutcome<T>) => void;
};

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

type GrowthFailure = { title: string; message: string; kind: 'growth' | 'load' | 'cascade' };

const loadFailurePatterns = [
  /(?:AccessUnavailableError:\s*)?Access unavailable: (?:overloaded|deadline)\b/i,
  /(?:CommandUnavailableError:\s*)?Command unavailable for partition \d+: (?:overloaded|deadline)\b/i,
  /sorry, too many clients already/i,
  /too many connections for database/i,
  /remaining connection slots are reserved/i,
  /the database system is (?:starting up|shutting down)/i,
  /could not extend file/i,
  /No space left on device/i,
  /\bcode\s*:\s*["']?(?:53300|53100|57P03)\b/i,
  /["']?code["']?\s*:\s*["']?(?:overloaded|deadline_exceeded|transaction_retry_exhausted)\b/i,
  /deadline_exceeded/i,
  /transaction_retry_exhausted/i,
  /\bHTTP\s+503\b|\(503\)/i,
  /this test timed out after \d+ms/i,
  /(?:hook.{0,40}(?:timed out|timeout)|(?:timed out|timeout).{0,40}hook)/i,
];

function isLoadFailureMessage(line: string): boolean {
  return loadFailurePatterns.some((pattern) => pattern.test(line));
}

/** Bun's message text plus Received assertion values; excerpts, frames and Expected values are excluded. */
function errorMessageLines(block: string[]): string[] {
  const messages: string[] = [];
  let inMessage = false;
  for (const line of block) {
    if (/^\s*\d+\s+\|/.test(line)) continue;
    if (/^\s*at\b/.test(line)) break;
    let message = line.trim().replace(/^\^\s*/, '');
    if (!message || /^\((?:pass|fail)\)/.test(message)) continue;
    if (/^Expected:/.test(message)) continue;
    if (/^Received:/.test(message)) {
      messages.push(message);
      continue;
    }

    const errorHeader = /^(?:error|[\w$]+(?:Error|Exception)):/i.test(message);
    if (errorHeader || isLoadFailureMessage(message)) inMessage = true;
    if (inMessage) messages.push(message);
  }
  return messages;
}

/**
 * Failure details for a file that has at least one growth-bound or recognized load failure, else null. Other test
 * failures and unhandled errors are retained as cascades. Bun prints a failure's message before `(fail)`, except that
 * a timeout can be printed immediately after it.
 */
export function growthFailures(output: string): GrowthFailure[] | null {
  const blocks: { title: string; lines: string[] }[] = [];
  let block: string[] = [];
  let previousFailure: { title: string; lines: string[] } | undefined;
  const lines = output.split(/\r\n?|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^# Unhandled\b/.test(line)) {
      block = [];
      const unhandled = { title: 'unhandled error', lines: [line.replace(/^# Unhandled\s*/, '')] };
      while (index + 1 < lines.length && !/^\s*\d+ (?:pass|fail|skip|todo)\b/.test(lines[index + 1]!)) {
        const next = lines[index + 1]!;
        if (/^\(pass\) |^\(fail\) /.test(next) || /^# Unhandled\b/.test(next)) break;
        unhandled.lines.push(next);
        index++;
      }
      blocks.push(unhandled);
      previousFailure = undefined;
      continue;
    }
    const failure = line.match(/^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/);
    if (failure) {
      previousFailure = { title: failure[1]!, lines: block };
      blocks.push(previousFailure);
      block = [];
    } else if (/^\(pass\) /.test(line)) {
      // Passing tests have no failure block; their output must not qualify the next failure.
      block = [];
      previousFailure = undefined;
    } else if (previousFailure && /^\s*\^\s*this test timed out after \d+ms\./i.test(line)) {
      // Bun reports this timeout after `(fail)`; keep it with that test and out of the next block.
      previousFailure.lines.push(line);
    } else if (!/^\s*\d+ (?:pass|fail|skip|todo)\b/.test(line) && !line.startsWith('Ran ')) {
      block.push(line);
      if (line.trim() !== '') previousFailure = undefined;
    }
  }

  const failures = blocks.map(({ title, lines: failureLines }) => {
    const messages = errorMessageLines(failureLines);
    const growth = messages.find((candidate) => candidate.startsWith('GrowthBoundError:'));
    const load = messages.find(isLoadFailureMessage);
    const kind = growth ? 'growth' : load ? 'load' : 'cascade';
    const message = growth
      ? growth.slice('GrowthBoundError:'.length).trim()
      : (load ?? messages[0] ?? 'unhandled error');
    return { title, message, kind } satisfies GrowthFailure;
  });
  return failures.some((failure) => failure.kind !== 'cascade') ? failures : null;
}

/**
 * Reruns, once each and one at a time under a stack slot, files with at least one growth-bound or known load failure.
 * The alone run decides whether the file still fails; other failures in the original run are reported as cascades when
 * the file passes alone. Returns every ineligible outcome and each eligible file that failed again.
 */
export async function rerunGrowthFailures(
  outcomes: FileOutcome<string>[],
  runner: FileRunner<string>,
  lease: <R>(label: string, run: (env: Record<string, string>) => Promise<R>) => Promise<R>,
  write: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<{ failed: FileOutcome<string>[] }> {
  const failed: FileOutcome<string>[] = [];
  const loadSensitive: string[] = [];
  const loadSensitiveGrowth: string[] = [];
  let rerunFiles = 0;
  let passedAlone = 0;
  let aloneMilliseconds = 0;
  for (const outcome of outcomes) {
    if (!outcome.error) continue;
    const failures = outcome.error.message.includes('Database cleanup failed:')
      ? null
      : growthFailures(outcome.error.message);
    if (!failures) {
      failed.push(outcome);
      continue;
    }
    rerunFiles++;
    const startedAt = performance.now();
    const [again] = await lease('kernel growth rerun', (env) =>
      scheduleFiles([outcome.file], 1, { ...runner, run: (file, database) => runner.run(file, database, env) }),
    );
    aloneMilliseconds += performance.now() - startedAt;
    if (again?.error) {
      write(`${outcome.error.message}\n${outcome.file}: failed again alone:\n${again.error.message}\n`);
      failed.push(outcome);
      continue;
    }
    passedAlone++;
    for (const failure of failures) {
      const message = failure.message.split('\n')[0]!;
      if (failure.kind === 'growth') {
        loadSensitiveGrowth.push(`load-sensitive growth check: ${outcome.file} :: ${failure.title} :: ${message}`);
      } else {
        const cascade = failure.kind === 'cascade' ? ' (cascade)' : '';
        loadSensitive.push(`load-sensitive test: ${outcome.file} :: ${failure.title}${cascade} :: ${message}`);
      }
    }
  }
  if (loadSensitive.length > 0) {
    write(`Load-sensitive tests (passed alone): ${loadSensitive.length}\n${loadSensitive.join('\n')}\n`);
  }
  if (loadSensitiveGrowth.length > 0) {
    write(
      `Load-sensitive growth checks (passed alone): ${loadSensitiveGrowth.length}\n${loadSensitiveGrowth.join('\n')}\n`,
    );
  }
  write(
    `Load reruns: ${rerunFiles} files, ${(aloneMilliseconds / 1000).toFixed(2)} s alone (${passedAlone} passed alone)\n`,
  );
  return { failed };
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
  if (reyloDirectory) rmSync(reyloDirectory, { recursive: true, force: true });
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
  const migrationFiles = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrationFiles, new Date());

  const plan = checkPlan(process.argv.slice(2), directory);
  if (remoteHostsFile()) return await runRemotely(plan);
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

  // The copies share the template's schema and object ids, so one analysis holds for all of them.
  await psql(`CREATE DATABASE ${ANALYSIS_DATABASE} TEMPLATE rezics`);
  const temporaryRoot = resolve(directory, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  reyloDirectory = mkdtempSync(resolve(temporaryRoot, 'reylo-'));
  const reyloConfig = writeReyloProject(reyloDirectory, url.replace(/\/rezics(?=\?)/, `/${ANALYSIS_DATABASE}`));

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
  const runner: FileRunner<string> = {
    // Each file gets a fresh copy so its result cannot depend on writes from another file.
    create: (_file, database) => psql(`CREATE DATABASE ${database} TEMPLATE rezics`),
    run: async (file, database, slotEnvironment) => {
      // Kernel tests start containers and compilers; under a loaded host Bun's 5 s per-test default fails them at random.
      const result = await capture('bun', ['test', '--timeout', '60000', `./${file}`], {
        ...fileEnvironment(env, { url, database, searchUrl, reyloConfig }),
        ...slotEnvironment,
      });
      if (result.status !== 0) throw new Error(`bun test ./${file} failed:\n${result.output}`);
      return result.output;
    },
    drop: (_file, database) => psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
    onComplete: (outcome) => {
      if (outcome.output) process.stdout.write(outcome.output.endsWith('\n') ? outcome.output : `${outcome.output}\n`);
      if (outcome.error) process.stderr.write(`${outcome.file}: ${outcome.error.message}\n`);
    },
  };
  const outcomes = await scheduleFiles(testFiles, concurrency, runner);
  const { failed } = await rerunGrowthFailures(outcomes, runner, withStackSlot);
  const queries = resolve(reyloDirectory, '.reylo/queries');
  process.stderr.write(`Reylo analyses written: ${existsSync(queries) ? readdirSync(queries).length : 0}\n`);
  const failedFiles = failed.map((outcome) => outcome.file);
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
