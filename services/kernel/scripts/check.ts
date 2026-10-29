import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { hostname } from 'node:os';
import {
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
import { migrate, moduleExtensionFiles, POSTGRES_IMAGE, schemaDumps, validateMigrationVersions } from './database.ts';
import {
  capture as captureIn,
  rerunGrowthFailures,
  runLaneSuite,
  runTestFiles as runTestFilesIn,
  scheduleFiles as scheduleFilesIn,
  testCommand,
  type FileOutcome,
  type FileRunner,
  type FileTiming,
} from '../../../scripts/test-lanes.ts';
import { readLatest, timingsDirectory } from './check-timings.ts';
import { runOnCheckHost } from '../../../scripts/stack-run.ts';
import { affectedTests } from './affected.ts';
import { buildSearchImage, cgroupArgs, subjectAutoCreateIndexSetting, waitForSearch } from './search.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);
let container = '';
let searchContainer = '';
let reyloDirectory = '';
let failedFileOutputs: string[] = [];
const POSTGRES_MAX_CONNECTIONS = 500;
const POSTGRES_CONNECTION_SAMPLE_MS = 250;
const POSTGRES_ACTIVITY_QUERY = 'SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname';

// Cloned from the migrated template once and never used as a template; Reylo reads every analysis from it.
const ANALYSIS_DATABASE = 'kernel_analysis';

type CheckPlan = { files: string[] | null; tests: string[] };

function moduleTests(moduleDirectory: string): string[] {
  return Array.from(new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: moduleDirectory })).sort();
}

function affectedMaximum(env: NodeJS.ProcessEnv): number {
  const value = env.KERNEL_CHECK_AFFECTED_MAX;
  if (value === undefined) return 60;
  const maximum = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(maximum)) {
    throw new Error('KERNEL_CHECK_AFFECTED_MAX must be a positive integer');
  }
  return maximum;
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
  const testFiles = new Set(allTests);
  for (const argument of args) {
    const normalized = resolve(root, argument.startsWith('./') ? argument.slice(2) : argument);
    if (!rootRealPath || !pathIsWithin(root, normalized)) {
      throw new Error(`Check path must name an existing file inside ${moduleDirectory}: ${argument}`);
    }

    try {
      const stats = statSync(normalized);
      if (!pathIsWithin(rootRealPath, realpathSync(normalized))) throw new Error();
      if (stats.isDirectory()) {
        let selectsTest = false;
        for (const file of new Bun.Glob('**/*.test.ts').scanSync({ cwd: normalized })) {
          const candidate = resolve(normalized, file);
          if (!pathIsWithin(rootRealPath, realpathSync(candidate))) throw new Error();
          const selected = relative(root, candidate).split(sep).join('/');
          files.add(selected);
          if (testFiles.has(selected)) selectsTest = true;
        }
        if (!selectsTest) throw new Error();
      } else if (stats.isFile()) {
        files.add(relative(root, normalized).split(sep).join('/'));
      } else {
        throw new Error();
      }
    } catch {
      throw new Error(`Check path must name an existing file inside ${moduleDirectory}: ${argument}`);
    }
  }

  const sortedFiles = Array.from(files).sort();
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
  const env = options.env ?? process.env;
  const cap = affectedMaximum(env);
  const changed = (options.changed ?? gitChangedPaths)(revision);
  const selection = affectedTests(resolve(root, '../..'), root, changed);
  if (selection.kind === 'all') {
    return {
      plan: { files: [], tests: [] },
      announcement: `Affected mode: unverified, 0 of ${total} test files selected (${selection.reason})`,
    };
  }
  let latest: Record<string, FileTiming> = {};
  try {
    latest = readLatest(timingsDirectory(moduleDirectory, env));
  } catch {
    // A synthetic module tree or missing Git metadata has no shared timing directory; unknown times rank last.
  }
  const wall = (file: string): number => {
    const value = latest[file]?.wall;
    return typeof value === 'number' && Number.isFinite(value) ? value : Infinity;
  };
  const ranked = selection.tests.sort((a, b) => {
    const distanceA = a.distance ?? Infinity;
    const distanceB = b.distance ?? Infinity;
    if (distanceA !== distanceB) return distanceA < distanceB ? -1 : 1;
    const wallA = wall(a.file);
    const wallB = wall(b.file);
    if (wallA !== wallB) return wallA < wallB ? -1 : 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  const selected = ranked.slice(0, cap).map(({ file }) => file);
  return {
    plan: selected.length > 0 ? checkPlan(selected, moduleDirectory) : { files: [], tests: [] },
    announcement: `Affected mode: tests, ${selected.length} of ${total} test files selected (${ranked.length} reachable, cap ${cap})`,
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

/** Include changed kernel sources in file-mode diagnostics, even when the caller named only test files. */
export function diagnosticFiles(
  files: string[],
  moduleDirectory: string,
  revision: string | null,
  changed: (revision: string) => string[] = gitChangedPaths,
): string[] {
  if (!revision) return files;
  const repository = resolve(moduleDirectory, '../..');
  const prefix = `${relative(repository, resolve(moduleDirectory)).split(sep).join('/')}/`;
  const all = new Set(files);
  for (const file of changed(revision)) if (file.startsWith(prefix)) all.add(file.slice(prefix.length));
  return Array.from(all).sort();
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

export { rerunGrowthFailures, testCommand };

/** Run the planned test files longest first, each on its own database. */
export function runTestFiles<T>(
  files: string[],
  latest: Record<string, FileTiming>,
  concurrency: number,
  runner: FileRunner<T>,
): Promise<FileOutcome<T>[]> {
  return runTestFilesIn('kernel', files, latest, concurrency, runner);
}

/** Run independent files through a fixed-size worker pool, cleaning up each created database. */
export function scheduleFiles<T>(
  files: string[],
  concurrency: number,
  runner: FileRunner<T>,
): Promise<FileOutcome<T>[]> {
  return scheduleFilesIn('kernel_test', files, concurrency, runner);
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

export function capture(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; output: string }> {
  return captureIn(program, args, env, directory);
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

const POSTGRES_LOG_TAIL_LINES = 300;
const POSTGRES_ERROR_SEVERITIES = ['ERROR', 'FATAL', 'PANIC'] as const;
type PostgresErrorSeverity = (typeof POSTGRES_ERROR_SEVERITIES)[number];

type PostgresErrorCount = { count: number; firstMessage: string };

/** Summarize server error records from a bounded tail of PostgreSQL's prefixed log output. */
export function formatPostgresErrors(output: string): string | null {
  const grouped = new Map<string, Map<PostgresErrorSeverity, PostgresErrorCount>>();
  const lines = output.split(/\r\n?|\n/).slice(-POSTGRES_LOG_TAIL_LINES);

  for (const line of lines) {
    const match = line.match(/\[([0-9A-Z]{5})\]\s+(ERROR|FATAL|PANIC):\s*(.*)$/);
    if (!match) continue;

    const sqlstate = match[1]!;
    const severity = match[2] as PostgresErrorSeverity;
    const message = match[3]!.trim();
    const severities = grouped.get(sqlstate) ?? new Map<PostgresErrorSeverity, PostgresErrorCount>();
    const previous = severities.get(severity);
    if (previous) previous.count += 1;
    else severities.set(severity, { count: 1, firstMessage: message });
    grouped.set(sqlstate, severities);
  }

  if (grouped.size === 0) return null;

  const summary = [`PostgreSQL server errors from the last ${POSTGRES_LOG_TAIL_LINES} log lines, grouped by SQLSTATE:`];
  for (const sqlstate of [...grouped.keys()].sort()) {
    for (const severity of POSTGRES_ERROR_SEVERITIES) {
      const entry = grouped.get(sqlstate)!.get(severity);
      if (entry) summary.push(`  ${sqlstate} ${severity}: ${entry.count}; first: ${entry.firstMessage}`);
    }
  }
  return summary.join('\n');
}

/** Read and summarize PostgreSQL's recent error records; this runs only after a failed check. */
export function reportPostgresErrors(
  containerId: string,
  dockerCommand: DockerCommand = docker,
  write: (message: string) => void = (message) => process.stderr.write(message),
): boolean {
  if (!containerId) return false;

  let logs: string;
  try {
    logs = dockerCommand(['logs', '--tail', String(POSTGRES_LOG_TAIL_LINES), containerId]);
  } catch {
    return false;
  }

  const summary = formatPostgresErrors(logs);
  if (summary) write(`${summary}\n`);
  return summary?.split(/\r\n?|\n/).some((line) => /^\s+53100\s/.test(line)) ?? false;
}

type DatabaseDiskUsage = { free: string; size: string };

function parseDatabaseDiskUsage(output: string): DatabaseDiskUsage | null {
  const row = output
    .trim()
    .split(/\r\n?|\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((columns) => columns.at(-1) === '/var/lib/postgresql');
  if (!row || row.length < 6) return null;
  const size = row[1];
  const free = row[3];
  if (!size || !free || !/^\d+$/.test(size) || !/^\d+$/.test(free)) return null;
  return { free, size };
}

/** Report an environment failure only for database storage exhaustion, returning its retryable exit code. */
export function reportCheckFailure(
  containerId: string,
  failedOutputs: readonly string[],
  dockerCommand: DockerCommand = docker,
  write: (message: string) => void = (message) => process.stderr.write(message),
  host = hostname(),
): 1 | 75 {
  const serverStorageFull = reportPostgresErrors(containerId, dockerCommand, write);
  const fileStorageFull = failedOutputs.some((output) => output.includes('No space left on device'));
  if (!serverStorageFull && !fileStorageFull) return 1;

  let { free, size } = { free: 'unknown', size: 'unknown' };
  if (containerId) {
    try {
      const output = dockerCommand(['exec', containerId, 'df', '-B1', '/var/lib/postgresql']);
      const diskUsage = parseDatabaseDiskUsage(output);
      if (diskUsage) ({ free, size } = diskUsage);
    } catch {
      // Disk usage is diagnostic only; a failed df still reports the storage failure.
    }
  }
  write(
    `kernel check: environment failure: database storage full (SQLSTATE 53100) on ${host}; ${free} of ${size} bytes free\n`,
  );
  return 75;
}

export type PostgresActivityRow = { datname: string | null; count: string | number };

export type PostgresConnectionSampler = {
  start: () => void;
  sample: () => Promise<void>;
  stop: () => Promise<void>;
  peakFor: (database: string) => number;
  peakTotal: () => number;
};

/** Sample total and per-database connection peaks without allowing sampling errors to affect a test file. */
export function createPostgresConnectionSampler(
  query: (sql: string) => Promise<PostgresActivityRow[]>,
  intervalMs = POSTGRES_CONNECTION_SAMPLE_MS,
): PostgresConnectionSampler {
  const databasePeaks = new Map<string, number>();
  let totalPeak = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let sampling: Promise<void> | undefined;
  let running = false;

  const sample = async (): Promise<void> => {
    if (sampling) return sampling;
    sampling = (async () => {
      try {
        const rows = await query(POSTGRES_ACTIVITY_QUERY);
        let total = 0;
        for (const row of rows) {
          const count = Number(row.count);
          if (!Number.isFinite(count) || count < 0) continue;
          total += count;
          if (row.datname) databasePeaks.set(row.datname, Math.max(databasePeaks.get(row.datname) ?? 0, count));
        }
        totalPeak = Math.max(totalPeak, total);
      } catch {
        // The sampler is diagnostic only; an unavailable sample must not affect the file being checked.
      }
    })().finally(() => {
      sampling = undefined;
    });
    return sampling;
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      void sample();
      interval = setInterval(() => {
        if (running) void sample();
      }, intervalMs);
    },
    sample,
    stop: async () => {
      running = false;
      if (interval) clearInterval(interval);
      interval = undefined;
      await sampling;
    },
    peakFor: (database) => databasePeaks.get(database) ?? 0,
    peakTotal: () => totalPeak,
  };
}

export function formatFileConnectionResult(file: string, result: 'PASS' | 'FAIL', peak: number): string {
  return `${file}: ${result}; peak database connections ${peak}`;
}

export function formatConnectionRunSummary(
  peakTotal: number,
  filePeaks: ReadonlyMap<string, number>,
  maxConnections = POSTGRES_MAX_CONNECTIONS,
): string {
  const highest = [...filePeaks.entries()]
    .sort(([fileA, peakA], [fileB, peakB]) => peakB - peakA || fileA.localeCompare(fileB))
    .slice(0, 3)
    .map(([file, peak]) => `${file}=${peak}`);
  return `PostgreSQL connections: peak ${peakTotal}/${maxConnections} max_connections; highest file peaks: ${highest.join(', ') || 'none'}`;
}

export function startPostgresContainer(dockerCommand: DockerCommand = docker): string {
  return dockerCommand([
    'run',
    '-d',
    ...cgroupArgs(),
    '--label',
    `rezics.kernel.check.pid=${pid}`,
    '-p',
    '127.0.0.1::5432',
    // Keep PostgreSQL data on disk instead of consuming memory that the check slot admission does not reserve.
    '--mount',
    `type=volume,destination=/var/lib/postgresql,volume-label=rezics.kernel.check.pid=${pid}`,
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
    `max_connections=${POSTGRES_MAX_CONNECTIONS}`,
    '-c',
    'log_line_prefix=%m [%p] [%e] ',
  ]);
}

export function cleanupStale(kind: 'check' | 'derived' = 'check', dockerCommand: DockerCommand = docker): void {
  // One listing carries each owner, so a concurrent run that exits meanwhile cannot fail an inspect.
  const rows = dockerCommand([
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
      try {
        dockerCommand(['rm', '-f', '-v', id!]);
      } catch {
        // A concurrent cleanup may already have removed it.
      }
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
      dockerCommand(['rm', '-f', '-v', id]);
    } catch (error) {
      console.error(error);
    }
  }
  if (reyloDirectory) rmSync(reyloDirectory, { recursive: true, force: true });
}

function fail(message: string): never {
  throw new Error(message);
}

let placing = false;

/**
 * Hands the planned files to the shared placement decision. The plan was computed here, where Git history is; the host
 * runs exactly those files. An affected selection of no tests stays here: an empty file list would be read as the
 * whole suite. Returns the remote exit code, or null when the check runs in this process.
 */
export async function placeKernelCheck(
  plan: CheckPlan,
  env: NodeJS.ProcessEnv = process.env,
  locations: { root: string; cwd: string; moduleDirectory?: string } = {
    root: resolve(directory, '../..'),
    cwd: directory,
  },
): Promise<number | null> {
  if (plan.files?.length === 0) return null;
  let estimateMs: number | undefined;
  if (plan.files !== null) {
    try {
      const latest = readLatest(timingsDirectory(locations.moduleDirectory ?? directory, env));
      const timings = plan.files.map((file) => latest[file]);
      if (timings.every((timing) => timing !== undefined && Number.isFinite(timing.wall) && timing.wall >= 0)) {
        const estimate = Math.ceil(timings.reduce((total, timing) => total + timing!.wall, 0) * 1000);
        if (Number.isSafeInteger(estimate)) estimateMs = estimate;
      }
    } catch {
      // A synthetic module tree or check host without Git metadata has no shared timing directory.
    }
  }
  const forwardedEnv: string[] = [];
  const skipCleanup = env.KERNEL_CHECK_SKIP_STALE_CLEANUP === '1';
  if (skipCleanup) forwardedEnv.push('KERNEL_CHECK_SKIP_STALE_CLEANUP=1');
  if (env.KERNEL_CHECK_CONCURRENCY) {
    if (skipCleanup) forwardedEnv.push('env');
    forwardedEnv.push(`KERNEL_CHECK_CONCURRENCY=${env.KERNEL_CHECK_CONCURRENCY}`);
  }
  return runOnCheckHost(
    {
      label: 'kernel check',
      root: locations.root,
      cwd: locations.cwd,
      command: [
        ...(forwardedEnv.length ? ['env', ...forwardedEnv] : []),
        'bun',
        'scripts/check.ts',
        ...(plan.files ?? []),
      ],
      ...(estimateMs === undefined ? {} : { estimateMs }),
    },
    env,
  );
}

async function main(): Promise<void> {
  const { plan, announcement } = planCheck(process.argv.slice(2), directory);
  if (announcement) console.log(announcement);
  if (announcement?.startsWith('Affected mode: unverified,')) return;
  const migrationFiles = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrationFiles, new Date());

  placing = true;
  let placed: number | null;
  try {
    placed = await placeKernelCheck(plan);
  } finally {
    placing = false;
  }
  if (placed !== null) {
    process.exitCode = placed;
    return;
  }
  const extensionFiles = moduleExtensionFiles();
  if (extensionFiles.length) fail(`Module migrations must not create extensions:\n${extensionFiles.join('\n')}`);

  // Remote hosts are shared: only this run's explicit cleanup may remove their containers.
  if (process.env.KERNEL_CHECK_SKIP_STALE_CLEANUP !== '1' && !process.env.KERNEL_CHECK_ON_REMOTE) cleanupStale();
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
    subjectAutoCreateIndexSetting,
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
  const oxfmt = resolve(directory, '../../node_modules/.bin/oxfmt');
  if (plan.files === null) {
    run(tsc, ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
    run(process.execPath, ['lint', '--no-script', '--config', '../../.oxlintrc.json', '.'], env);
    run(oxfmt, ['--check', '.'], env);
  } else {
    const typecheck = await capture(
      tsc,
      ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json', '--pretty', 'false'],
      env,
    );
    const diagnostics = ownDiagnostics(
      typecheck.output,
      diagnosticFiles(plan.files, directory, process.env.KERNEL_CHECK_AFFECTED || null),
    );
    if (diagnostics.length) fail(diagnostics.join('\n'));
    if (typecheck.status !== 0 && !hasDiagnosticLine(typecheck.output)) {
      fail(`tsc exited with status ${typecheck.status} without diagnostics:\n${typecheck.output}`);
    }

    const lintFiles = plan.files.filter((file) => file.endsWith('.ts'));
    if (lintFiles.length)
      run(process.execPath, ['lint', '--no-script', '--config', '../../.oxlintrc.json', ...lintFiles], env);

    const formatFiles = formattedFiles(plan.files);
    if (formatFiles.length) run(oxfmt, ['--check', '--no-error-on-unmatched-pattern', ...formatFiles], env);
  }

  const testFiles = plan.tests;
  await waitForSearch(searchUrl, searchContainer);
  const samplerClient = new Client({
    connectionString: url.replace(/\/rezics(?=\?)/, '/postgres'),
    application_name: 'kernel-check-connection-sampler',
    connectionTimeoutMillis: 1000,
    query_timeout: 1000,
    statement_timeout: 1000,
  });
  let samplerConnected = false;
  try {
    await samplerClient.connect();
    samplerConnected = true;
  } catch (error) {
    process.stderr.write(
      `PostgreSQL connection sampling is unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  const sampler = createPostgresConnectionSampler(async (sql) => {
    if (!samplerConnected) return [];
    const result = await samplerClient.query(sql);
    return result.rows as PostgresActivityRow[];
  });
  const filePeaks = new Map<string, number>();
  sampler.start();
  let failedFiles: string[] = [];
  const outputByFile = new Map<string, string>();
  try {
    const result = await runLaneSuite({
      service: 'kernel',
      directory,
      files: testFiles,
      partial: plan.files !== null,
      createDatabase: (database) => psql(`CREATE DATABASE ${database} TEMPLATE rezics`),
      dropDatabase: (database) => psql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
      environment: (database) => fileEnvironment(env, { url, database, searchUrl, reyloConfig }),
      onFileComplete: (outcome, timing) => {
        if (outcome.error) outputByFile.set(outcome.file, outcome.error.message);
        else outputByFile.delete(outcome.file);
        const peak = sampler.peakFor(outcome.database);
        timing.peakConnections = peak;
        filePeaks.set(outcome.file, peak);
        process.stdout.write(`${formatFileConnectionResult(outcome.file, outcome.error ? 'FAIL' : 'PASS', peak)}\n`);
      },
    });
    failedFiles = result.failed;
    failedFileOutputs = failedFiles.flatMap((file) => {
      const output = outputByFile.get(file);
      return output === undefined ? [] : [output];
    });
  } finally {
    await sampler.stop();
    if (samplerConnected) await samplerClient.end().catch(() => undefined);
    process.stdout.write(`${formatConnectionRunSummary(sampler.peakTotal(), filePeaks)}\n`);
  }
  const queries = resolve(reyloDirectory, '.reylo/queries');
  process.stderr.write(`Reylo analyses written: ${existsSync(queries) ? readdirSync(queries).length : 0}\n`);
  if (failedFiles.length) fail(`Kernel tests failed for ${failedFiles.length} file(s):\n${failedFiles.join('\n')}`);
}

if (import.meta.main) {
  // While the shared placement has the run, it forwards the signal and releases the host slot. A local run removes
  // the containers this process started.
  process.on('SIGINT', () => {
    if (placing) return;
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    if (placing) return;
    cleanup();
    process.exit(143);
  });

  try {
    await main();
  } catch (error) {
    process.exitCode = reportCheckFailure(container, failedFileOutputs);
    console.error(error);
  } finally {
    cleanup();
  }
}
