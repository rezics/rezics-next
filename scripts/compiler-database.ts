// Reylo prepares `.sql` modules against DATABASE_URL. The root typecheck and the Auth check share this
// preparation so those modules see the kernel schema and the Auth schema.
// Kernel and Auth helpers load at runtime through a typed dynamic import so control-plane `tsc` does not follow
// `.sql` modules.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { StartedDatabase } from './typecheck.ts';

/** Matches Kernel/Auth `POSTGRES_IMAGE`; kept local so this module typechecks without Kernel source. */
const POSTGRES_IMAGE = 'postgres:19rc1@sha256:b3cb7405059fd06f9ebae4aad4780b3788dfdd2acef1ac248ad9d56ced8abb06';

type KernelDatabaseHelpers = {
  migrate: (url: string, root?: string) => void;
};

type AuthDatabaseHelpers = {
  migrate: (url: string, migrationsDirectory?: string) => void;
};

type CommandPhaseHelpers = {
  withCommandPhase: <T>(phase: string, work: () => Promise<T> | T, env?: NodeJS.ProcessEnv) => Promise<T>;
};

function importHelpers<T>(relativePath: string): Promise<T> {
  return import(new URL(relativePath, import.meta.url).href) as Promise<T>;
}

const CONTAINER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const POSTGRES_SOCKET_NAME = '.s.PGSQL.5432';
const READY_TIMEOUT_MS = 60_000;
const READY_PROBE_TIMEOUT_MS = 1_000;
/** Matches Auth `DEFAULT_RUN_TIMEOUT`: `docker run` on a busy check host exceeds a 10s spawn cap. */
export const DOCKER_RUN_TIMEOUT_MS = 120_000;
/** Inspect/exec/ps/port probes; the 60s readiness loop retries these. */
export const DOCKER_PROBE_TIMEOUT_MS = 5_000;
/** Host-lifetime Python uses seconds; keep it identical to `DOCKER_RUN_TIMEOUT_MS`. */
export const DOCKER_RM_TIMEOUT_SECONDS = DOCKER_RUN_TIMEOUT_MS / 1000;
export const DOCKER_PROBE_TIMEOUT_SECONDS = DOCKER_PROBE_TIMEOUT_MS / 1000;
export const COMPILER_PID_LABEL = 'rezics.compiler.pid';
export const COMPILER_NONCE_LABEL = 'rezics.compiler.nonce';
/** PostgreSQL SSLRequest; a ready postmaster replies with one byte, a half-open listener EOFs. */
const POSTGRES_SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);

export type PostgresListen = {
  url: string;
  port: string;
  stop: () => void;
};

export type DockerCommand = (args: string[]) => string;

export type DockerLabel = { name: string; value: string };

export type DockerSettlement =
  | {
      status: 'settled';
      attempts: number;
      containers: string[];
      volumes: string[];
      requestFailures: string[];
    }
  | {
      status: 'unsettled';
      attempts: number;
      containers: string[];
      volumes: string[];
      error: Error;
    };

const DOCKER_SETTLEMENT_ATTEMPTS = 3;
const DOCKER_RESOURCE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function dockerErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dockerObjectAbsent(error: unknown, id: string): boolean {
  const text = dockerErrorText(error);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\n|: )(?:Error response from daemon: )?No such (?:object|container): ${escaped}(?:$|\\n)`,
    'i',
  ).test(text);
}

function dockerResourceIds(output: string, kind: string): string[] {
  const ids = output
    .split('\n')
    .map((id) => id.trim())
    .filter(Boolean);
  for (const id of ids) {
    // Docker output crosses a process boundary and is passed back as an argv token below.
    if (!DOCKER_RESOURCE_IDENTITY.test(id))
      throw new Error(`compiler-database: Docker returned an invalid ${kind} identity`);
  }
  return [...new Set(ids)];
}

function labelFilters(labels: readonly DockerLabel[]): string[] {
  return labels.flatMap(({ name, value }) => ['--filter', `label=${name}=${value}`]);
}

function settlementError(
  label: string,
  value: string,
  attempts: number,
  containers: string[],
  volumes: string[],
  failures: string[],
): DockerSettlement {
  const details = [
    ...failures,
    ...(containers.length ? [`containers remain: ${containers.join(', ')}`] : []),
    ...(volumes.length ? [`volumes remain: ${volumes.join(', ')}`] : []),
  ];
  const message = `compiler-database: owned Docker attempt ${label}=${value} is unsettled after ${attempts} attempts: ${details.join('; ') || 'Docker state was unavailable'}`;
  return {
    status: 'unsettled',
    attempts,
    containers,
    volumes,
    error: new Error(message),
  };
}

/** A successful fresh observation does not erase an earlier failed cleanup request. */
export function reportDockerSettlement(
  settlement: DockerSettlement,
  context: string,
  write: (message: string) => void = (message) => console.error(message),
): void {
  if (settlement.status !== 'settled' || settlement.requestFailures.length === 0) return;
  write(
    `compiler-database: ${context} settled after Docker request failures: ${settlement.requestFailures.join('; ')}`,
  );
}

/** Image builds and pulls are bounded; they are not the 5s probe window. */
export const DOCKER_BUILD_TIMEOUT_MS = 600_000;

export function dockerTimeoutMs(args: readonly string[]): number {
  const verb = args[0];
  if (verb === 'run' || verb === 'create' || verb === 'start' || verb === 'stop') return DOCKER_RUN_TIMEOUT_MS;
  if (verb === 'rm' && args.includes('-f')) return DOCKER_RUN_TIMEOUT_MS;
  if (verb === 'volume' && (args[1] === 'create' || args[1] === 'rm')) return DOCKER_RUN_TIMEOUT_MS;
  // Labelled reap lists every matching id; that is owned cleanup, not a 5s inspect/exec/port probe.
  if (verb === 'ps' && args.includes('-aq')) return DOCKER_RUN_TIMEOUT_MS;
  if (verb === 'build' || verb === 'pull') return DOCKER_BUILD_TIMEOUT_MS;
  return DOCKER_PROBE_TIMEOUT_MS;
}

export type DockerSpawnSyncOptions = SpawnSyncOptions & { encoding: 'utf8'; timeout: number };

/**
 * Ordinary `docker rm -f` waits in this process so settlement can be proven. A timeout kills with SIGKILL: a docker CLI
 * that ignores SIGTERM would otherwise hold the bounded wait open. Signal-path callers use `beginDetachedDockerRm`.
 */
/** A caller's bound replaces the verb's default; cleanup of a busy container or volume passes its own. */
export type DockerRunOptions = Pick<SpawnSyncOptions, 'cwd' | 'env'> & { timeout?: number };

export function dockerSpawnSyncOptions(args: readonly string[], extra: DockerRunOptions = {}): DockerSpawnSyncOptions {
  const { timeout = dockerTimeoutMs(args), ...rest } = extra;
  return {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    ...rest,
  };
}

/** spawnSync still types stdout as string|Buffer when options are not a literal encoding. */
export function dockerProcessText(value: string | Buffer | null | undefined): string {
  if (value == null) return '';
  return (typeof value === 'string' ? value : Buffer.from(value).toString('utf8')).trim();
}

/** Cleanup never replaces the original failure: both exact messages stay in the thrown error. */
export function retainOriginalAndCleanupFailure(original: unknown, cleanup: unknown, context: string): Error {
  const setup = original instanceof Error ? original.message : String(original);
  const cleaned = cleanup instanceof Error ? cleanup.message : String(cleanup);
  return new Error(`${context} (${setup}); cleanup could not be proven (${cleaned})`, {
    cause: original instanceof Error ? original : undefined,
  });
}

/** Forced removal of one owned container. Its separately labelled data volume is settled by nonce. */
export function compilerDatabaseRemoveArgs(id: string): string[] {
  return ['rm', '-f', '-v', id];
}

export function compilerDatabaseVolumeName(pid: number, nonce: string): string {
  const safeNonce = nonce.replace(/[^A-Za-z0-9_.-]/g, '-');
  return `rezics-compiler-pg-${pid}-${safeNonce}`;
}

export function compilerDatabaseVolumeCreateArgs(pid: number, nonce: string, runId?: string): string[] {
  return [
    'volume',
    'create',
    '--label',
    `${COMPILER_PID_LABEL}=${pid}`,
    '--label',
    `${COMPILER_NONCE_LABEL}=${nonce}`,
    ...(runId ? ['--label', `rezics.check.run=${runId}`] : []),
    compilerDatabaseVolumeName(pid, nonce),
  ];
}

/** Presence check after ordinary removal; a missing object is settlement, not a probe timeout. */
export function compilerDatabaseInspectArgs(id: string): string[] {
  return ['inspect', '-f', '{{.Id}}', id];
}

/** Labelled volumes for this owner pid; ordinary cleanup requires the list to be empty. */
export function compilerDatabaseVolumeLsArgs(pid: number, nonce?: string): string[] {
  return [
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=${COMPILER_PID_LABEL}=${pid}`,
    ...(nonce ? ['--filter', `label=${COMPILER_NONCE_LABEL}=${nonce}`] : []),
  ];
}

export function compilerDatabaseVolumeRemoveArgs(id: string): string[] {
  return ['volume', 'rm', '-f', id];
}

function settleDockerVolumes(labels: readonly DockerLabel[], dockerCommand: DockerCommand): DockerSettlement {
  const failures: string[] = [];
  let volumes: string[] = [];
  for (let attempt = 1; attempt <= DOCKER_SETTLEMENT_ATTEMPTS; attempt += 1) {
    try {
      volumes = dockerResourceIds(dockerCommand(['volume', 'ls', '-q', ...labelFilters(labels)]), 'volume');
    } catch (error) {
      failures.push(`volume listing: ${dockerErrorText(error)}`);
      continue;
    }
    for (const id of volumes) {
      try {
        dockerCommand(compilerDatabaseVolumeRemoveArgs(id));
      } catch (error) {
        failures.push(`volume ${id} removal: ${dockerErrorText(error)}`);
      }
    }
    try {
      volumes = dockerResourceIds(dockerCommand(['volume', 'ls', '-q', ...labelFilters(labels)]), 'volume');
    } catch (error) {
      failures.push(`volume settlement listing: ${dockerErrorText(error)}`);
      continue;
    }
    if (volumes.length === 0) {
      return { status: 'settled', attempts: attempt, containers: [], volumes, requestFailures: failures };
    }
  }
  return settlementError(
    labels.map(({ name, value }) => `${name}=${value}`).join('&'),
    'volumes',
    DOCKER_SETTLEMENT_ATTEMPTS,
    [],
    volumes,
    failures,
  );
}

/**
 * Reconcile one known Docker container. A timed-out rm is only a request: only the exact `No such object` inspect
 * response proves absence. Other inspect failures remain visible and the bounded retry returns explicit uncertainty.
 */
export function settleDockerContainerRemoval(id: string, dockerCommand: DockerCommand = docker): DockerSettlement {
  if (!id || !DOCKER_RESOURCE_IDENTITY.test(id))
    throw new Error('compiler-database: Docker container identity is invalid');
  const failures: string[] = [];
  for (let attempt = 1; attempt <= DOCKER_SETTLEMENT_ATTEMPTS; attempt += 1) {
    try {
      dockerCommand(compilerDatabaseRemoveArgs(id));
    } catch (error) {
      failures.push(`container ${id} removal: ${dockerErrorText(error)}`);
    }
    try {
      const observed = dockerCommand(compilerDatabaseInspectArgs(id)).trim();
      if (observed) {
        failures.push(`container ${id} remains after removal`);
        continue;
      }
      failures.push(`container ${id} inspect returned no identity`);
    } catch (error) {
      if (dockerObjectAbsent(error, id)) {
        return { status: 'settled', attempts: attempt, containers: [], volumes: [], requestFailures: failures };
      }
      failures.push(`container ${id} inspect: ${dockerErrorText(error)}`);
    }
  }
  return settlementError('container', id, DOCKER_SETTLEMENT_ATTEMPTS, [id], [], failures);
}

/**
 * Settle containers and volumes belonging to one exact create nonce. Lists are re-read after removal; an unavailable
 * Docker daemon is returned as `unsettled` instead of being mistaken for absence.
 */
export function settleDockerAttempt(
  label: string,
  value: string,
  volumeLabels: readonly DockerLabel[] = [],
  dockerCommand: DockerCommand = docker,
): DockerSettlement {
  const failures: string[] = [];
  let containers: string[] = [];
  let volumes: string[] = [];
  const filters = [{ name: label, value }];
  for (let attempt = 1; attempt <= DOCKER_SETTLEMENT_ATTEMPTS; attempt += 1) {
    try {
      containers = dockerResourceIds(dockerCommand(['ps', '-aq', ...labelFilters(filters)]), 'container');
    } catch (error) {
      failures.push(`container listing: ${dockerErrorText(error)}`);
      continue;
    }
    for (const id of containers) {
      try {
        dockerCommand(compilerDatabaseRemoveArgs(id));
      } catch (error) {
        failures.push(`container ${id} removal: ${dockerErrorText(error)}`);
      }
    }
    try {
      containers = dockerResourceIds(dockerCommand(['ps', '-aq', ...labelFilters(filters)]), 'container');
    } catch (error) {
      failures.push(`container settlement listing: ${dockerErrorText(error)}`);
      continue;
    }
    if (containers.length) continue;
    if (volumeLabels.length === 0) {
      return { status: 'settled', attempts: attempt, containers, volumes: [], requestFailures: failures };
    }
    try {
      volumes = dockerResourceIds(dockerCommand(['volume', 'ls', '-q', ...labelFilters(volumeLabels)]), 'volume');
    } catch (error) {
      failures.push(`volume listing: ${dockerErrorText(error)}`);
      continue;
    }
    for (const id of volumes) {
      try {
        dockerCommand(compilerDatabaseVolumeRemoveArgs(id));
      } catch (error) {
        failures.push(`volume ${id} removal: ${dockerErrorText(error)}`);
      }
    }
    try {
      volumes = dockerResourceIds(dockerCommand(['volume', 'ls', '-q', ...labelFilters(volumeLabels)]), 'volume');
    } catch (error) {
      failures.push(`volume settlement listing: ${dockerErrorText(error)}`);
      continue;
    }
    if (volumes.length === 0) {
      return { status: 'settled', attempts: attempt, containers, volumes, requestFailures: failures };
    }
  }
  return settlementError(label, value, DOCKER_SETTLEMENT_ATTEMPTS, containers, volumes, failures);
}

export function isDockerTimeout(error: unknown): boolean {
  return (
    (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') ||
    (error instanceof Error && error.cause === undefined && error.message.includes('ETIMEDOUT'))
  );
}

/** A timed-out create already reaped its nonce; retry once with a fresh identity. The second failure stays with the caller. */
export function retryDockerCreateOnce<T>(nonce: string, create: (nonce: string) => T, nextNonce: () => string): T {
  try {
    return create(nonce);
  } catch (error) {
    if (!isDockerTimeout(error)) throw error;
    return create(nextNonce());
  }
}

/**
 * Auth fixture pattern: issue `docker rm -f -v` in its own session and return. The host-lifetime supervisor still
 * waits up to 120s for labelled removal; SIGTERM handlers must not block in spawnSync.
 */
export function beginDetachedDockerRm(id: string, extra: Pick<SpawnSyncOptions, 'cwd' | 'env'> = {}): void {
  if (!id || !CONTAINER_IDENTITY.test(id)) return;
  const child = spawn('docker', compilerDatabaseRemoveArgs(id), { detached: true, stdio: 'ignore', ...extra });
  child.unref();
}

/**
 * Ordinary cleanup waits for `docker rm -f -v` and then proves the container and named, labelled volume are gone.
 * Signal-path callers use `beginDetachedDockerRm` instead: a 200ms SIGKILL must not abort that session.
 */
export function settleCompilerDatabaseRemoval(
  id: string,
  pid = process.pid,
  dockerCommand?: DockerCommand,
  nonces: readonly string[] = [],
): void {
  const run = dockerCommand ?? docker;
  if (!id || !CONTAINER_IDENTITY.test(id)) return;
  if (nonces.length) {
    for (const nonce of new Set(nonces)) {
      const attempt = settleDockerAttempt(
        COMPILER_NONCE_LABEL,
        nonce,
        [
          { name: COMPILER_PID_LABEL, value: String(pid) },
          { name: COMPILER_NONCE_LABEL, value: nonce },
        ],
        run,
      );
      if (attempt.status === 'unsettled') throw attempt.error;
      reportDockerSettlement(attempt, `create nonce ${nonce}`);
    }
    return;
  }
  const container = settleDockerContainerRemoval(id, run);
  if (container.status === 'unsettled') throw container.error;
  reportDockerSettlement(container, `container ${id}`);
  const volumes = settleDockerVolumes([{ name: COMPILER_PID_LABEL, value: String(pid) }], run);
  if (volumes.status === 'unsettled') throw volumes.error;
  reportDockerSettlement(volumes, `volumes owned by pid ${pid}`);
}

/** Cleanup diagnostics stay attached to the original compiler identity; a completed native status is not replaced. */
export function keepCompilerStatusAfterCleanup(
  status: number | undefined,
  cleanup: unknown,
  context: string,
  compilerFailure?: unknown,
): number {
  const error = retainOriginalAndCleanupFailure(
    compilerFailure ?? (status === undefined ? 'compiler did not complete' : `compiler status ${status}`),
    cleanup,
    context,
  );
  console.error(`${context} infrastructure failure: phase=database-cleanup: ${error.message}`);
  return status ?? 75;
}

function spawnDockerError(args: readonly string[], error: NodeJS.ErrnoException): never {
  if (error.code === 'ETIMEDOUT') {
    throw Object.assign(error, {
      message: `spawnSync docker ETIMEDOUT ${JSON.stringify(['docker', ...args])}`,
    });
  }
  throw error;
}

export function runDocker(args: string[], extra: DockerRunOptions = {}): string {
  const result = spawnSync('docker', args, dockerSpawnSyncOptions(args, extra));
  if (result.error) spawnDockerError(args, result.error as NodeJS.ErrnoException);
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} failed with status ${result.status}: ${dockerProcessText(result.stderr) || '(no stderr)'}`,
    );
  return dockerProcessText(result.stdout);
}

function docker(args: string[]): string {
  return runDocker(args);
}

export function reapLabeledContainers(label: string, value: string, dockerCommand: DockerCommand = docker): void {
  try {
    const ids = dockerCommand(['ps', '-aq', '--filter', `label=${label}=${value}`])
      .split('\n')
      .filter(Boolean);
    for (const id of ids) {
      try {
        dockerCommand(compilerDatabaseRemoveArgs(id));
      } catch {
        // A concurrent cleanup may already have removed it.
      }
    }
  } catch {
    // Listing may fail after a daemon timeout; labelled stale cleanup still reaps later.
  }
}

export function newCompilerNonce(pid = process.pid, now = Date.now): string {
  return `${pid}-${now().toString(36)}-${Math.random().toString(16).slice(2)}`;
}

export function compilerDatabaseRunArgs(
  pid = process.pid,
  nonce = newCompilerNonce(pid),
  network = dockerNetworkArgs(),
): string[] {
  const labels = [`${COMPILER_PID_LABEL}=${pid}`, `${COMPILER_NONCE_LABEL}=${nonce}`];
  return [
    'run',
    '-d',
    '--stop-timeout',
    '2',
    '--rm',
    ...network,
    ...labels.flatMap((label) => ['--label', label]),
    ...postgresPublishArgs(pid, network),
    '--mount',
    `type=volume,source=${compilerDatabaseVolumeName(pid, nonce)},destination=/var/lib/postgresql`,
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
    'shared_buffers=32MB',
    '-c',
    'work_mem=8MB',
    '-c',
    'max_connections=40',
    '-c',
    'huge_pages=off',
  ];
}

export function reapCompilerNonce(nonce: string, pid = process.pid, dockerCommand: DockerCommand = docker): void {
  const settlement = settleDockerAttempt(
    COMPILER_NONCE_LABEL,
    nonce,
    [
      { name: COMPILER_PID_LABEL, value: String(pid) },
      { name: COMPILER_NONCE_LABEL, value: nonce },
    ],
    dockerCommand,
  );
  if (settlement.status === 'unsettled') throw settlement.error;
  reportDockerSettlement(settlement, `create nonce ${nonce}`);
  rmSync(isolatedPostgresSocketDir(pid), { recursive: true, force: true });
}

/** Start the one-run compiler container; a timeout or failed create reaps that nonce before the error escapes. */
export function startCompilerContainer(
  pid = process.pid,
  nonce = newCompilerNonce(pid),
  dockerCommand: DockerCommand = docker,
  env: NodeJS.ProcessEnv = process.env,
  attemptNonces: string[] = [],
): string {
  const network = dockerNetworkArgs(env);
  const start = (attemptNonce: string): string => {
    attemptNonces.push(attemptNonce);
    try {
      const volume = compilerDatabaseVolumeName(pid, attemptNonce);
      const created = dockerCommand(compilerDatabaseVolumeCreateArgs(pid, attemptNonce, env.REZICS_CHECK_RUN)).trim();
      if (created !== volume)
        throw new Error(
          `compiler-database: Docker created unexpected volume ${JSON.stringify(created)} (expected ${volume})`,
        );
      return dockerCommand(compilerDatabaseRunArgs(pid, attemptNonce, network));
    } catch (error) {
      try {
        reapCompilerNonce(attemptNonce, pid, dockerCommand);
      } catch (cleanupError) {
        throw retainOriginalAndCleanupFailure(error, cleanupError, 'Compiler database create failed');
      }
      throw error;
    }
  };
  return retryDockerCreateOnce(nonce, start, () => newCompilerNonce(pid));
}

/**
 * Attach a throwaway database to the isolated stack with a Docker-supported network.
 * `ns:/proc/<pid>/ns/net` is a Linux namespace path; Docker treats it as a network name and fails.
 * Use `container:<id>` from REZICS_ISOLATED_STACK_CONTAINER, or a named network from REZICS_DOCKER_NETWORK.
 */
export function dockerNetworkArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const container = env.REZICS_ISOLATED_STACK_CONTAINER?.trim();
  const network = env.REZICS_DOCKER_NETWORK?.trim();
  if (container) {
    if (container.startsWith('ns:') || container.includes('/proc/') || !CONTAINER_IDENTITY.test(container)) {
      throw new Error(
        'compiler-database: Docker treats ns:/proc/... as a network name; use container:<id> via REZICS_ISOLATED_STACK_CONTAINER',
      );
    }
    return ['--network', `container:${container}`];
  }
  if (network) {
    if (network.startsWith('ns:') || network.includes('/proc/') || network.startsWith('container:')) {
      throw new Error(
        'compiler-database: Docker treats ns:/proc/... as a network name; use container:<id> via REZICS_ISOLATED_STACK_CONTAINER',
      );
    }
    if (!NETWORK_NAME.test(network)) throw new Error('compiler-database: Docker network name is invalid');
    return ['--network', network];
  }
  return [];
}

export function sharesIsolatedStackNetwork(network = dockerNetworkArgs()): boolean {
  return network[0] === '--network' && (network[1]?.startsWith('container:') ?? false);
}

export function compilerDatabaseListenUrl(port: string): string {
  return `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
}

/** Short host directory bound to the container's PostgreSQL unix socket. */
export function isolatedPostgresSocketDir(pid = process.pid): string {
  return `/tmp/rzpg-${pid}`;
}

export function isolatedPostgresSocketPath(pid = process.pid): string {
  return join(isolatedPostgresSocketDir(pid), POSTGRES_SOCKET_NAME);
}

/**
 * Isolated stacks cannot publish `-p` from `--network container:<id>`. Bind the unix socket to a short host path
 * instead; published TCP uses an independent forwarding child.
 */
export function postgresPublishArgs(pid = process.pid, network = dockerNetworkArgs()): string[] {
  if (sharesIsolatedStackNetwork(network)) {
    const directory = isolatedPostgresSocketDir(pid);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return ['-v', `${directory}:/var/run/postgresql`];
  }
  return ['-p', '127.0.0.1::5432'];
}

/** PID, parent, group and kernel start time for stage logs through database/seed/readiness. */
export function ownerProcessIdentity(pid = process.pid): string {
  let ppid = '';
  let pgid = '';
  let start = '';
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = (close >= 0 ? stat.slice(close + 2) : stat).split(' ');
    ppid = fields[1] ?? '';
    pgid = fields[2] ?? '';
    start = fields[19] ?? '';
  } catch {
    // /proc is unreadable in some test environments; the pid itself still identifies the owner.
  }
  return `PID=${pid} PPID=${ppid || 'unknown'} PGID=${pgid || 'unknown'} START=${start || 'unknown'}`;
}

export function postgresReadyProbe(url: string): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'host',
    '-e',
    'PGPASSWORD=rezics',
    POSTGRES_IMAGE,
    'pg_isready',
    '-d',
    url,
    '-t',
    '1',
  ];
}

/** Probe the engine inside the owned container; TCP accept alone still EOFs during startup. */
export function postgresContainerReadyArgs(container: string): string[] {
  return ['exec', container, 'pg_isready', '-U', 'rezics', '-d', 'rezics', '-t', '1'];
}

export async function waitForPostgresContainer(
  container: string,
  dockerCommand: DockerCommand = docker,
  timeoutMs = READY_TIMEOUT_MS,
  now = Date.now,
): Promise<void> {
  const deadline = now() + timeoutMs;
  let first = '';
  let last = 'not probed';
  while (now() < deadline) {
    try {
      dockerCommand(postgresContainerReadyArgs(container));
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!first) first = last;
    }
    await delay(50);
  }
  throw new Error(
    `compiler-database: PostgreSQL container ${container} was not ready after ${timeoutMs}ms: first probe=${first || last}; last probe=${last}`,
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForPath(path: string, timeoutMs = READY_TIMEOUT_MS, now = Date.now): Promise<void> {
  const deadline = now() + timeoutMs;
  while (!existsSync(path)) {
    if (now() >= deadline) throw new Error(`compiler-database: PostgreSQL unix socket did not appear: ${path}`);
    await delay(50);
  }
}

function postgresProtocolReply(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const timer = setTimeout(() => done('timeout'), 400);
    const done = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reason);
    };
    socket.on('connect', () => {
      try {
        socket.write(POSTGRES_SSL_REQUEST);
      } catch (error) {
        done(error instanceof Error ? error.message : 'write failed');
      }
    });
    socket.on('data', (chunk) => done(chunk.length > 0 ? 'ready' : 'empty'));
    socket.on('error', (error) => done(error.message));
    socket.on('end', () => done('EOF'));
    socket.on('close', () => done('EOF'));
  });
}

export async function waitForPostgresReady(url: string, timeoutMs = READY_TIMEOUT_MS, now = Date.now): Promise<void> {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = Number(parsed.port || '5432');
  const endpoint = `${host}:${port}${parsed.pathname}`;
  const deadline = now() + timeoutMs;
  let last = 'not probed';
  while (now() < deadline) {
    const remaining = Math.max(1, deadline - now());
    last = await Promise.race([postgresProtocolReply(host, port), delay(remaining).then(() => 'timeout')]);
    if (last === 'ready') return;
    if (now() >= deadline) break;
    await delay(50);
  }
  throw new Error(`compiler-database: PostgreSQL was not ready at ${endpoint}: ${last}`);
}

/** Recheck both the exact container and its host-facing PostgreSQL endpoint before another compiler consumer starts. */
export async function assertCompilerDatabaseReady(
  container: string,
  url: string,
  dockerCommand: DockerCommand = docker,
  timeoutMs = READY_PROBE_TIMEOUT_MS,
): Promise<void> {
  let containerFailure: string | undefined;
  let endpointFailure: string | undefined;
  try {
    dockerCommand(postgresContainerReadyArgs(container));
  } catch (error) {
    containerFailure = dockerErrorText(error);
  }
  try {
    await waitForPostgresReady(url, timeoutMs);
  } catch (error) {
    endpointFailure = dockerErrorText(error);
  }
  if (containerFailure || endpointFailure) {
    throw new Error(
      `compiler-database: PostgreSQL readiness failed for container ${container}; ${[
        ...(containerFailure ? [`first in-container probe=${containerFailure}`] : []),
        ...(endpointFailure ? [`endpoint probe=${endpointFailure}`] : []),
      ].join('; ')}`,
    );
  }
}

/**
 * Independent TCP-to-Unix child. A same-process proxy starves during synchronous Reylo analysis because it shares
 * the parent's event loop; this child keeps forwarding while the owner burns CPU, and exits when the owner closes
 * stdin (including SIGKILL) or the child receives SIGINT/SIGTERM/SIGHUP.
 */
export const POSTGRES_FORWARD_CHILD = `import { createConnection, createServer } from 'node:net';
const path = process.env.REZICS_PG_FORWARD_SOCKET!;
const requested = Number(process.env.REZICS_PG_FORWARD_PORT ?? '0');
const server = createServer((client) => {
  const upstream = createConnection(path);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.listen(Number.isFinite(requested) ? requested : 0, '127.0.0.1', () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : requested;
  process.stdout.write('READY ' + port + '\\n');
});
process.stdin.resume();
const stop = () => {
  server.close();
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
`;

export type PostgresForwarder = {
  port: number;
  child: ReturnType<typeof Bun.spawn>;
  stop: () => void;
};

async function readReadyPort(stdout: ReadableStream<Uint8Array>, timeoutMs: number): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => setTimeout(resolve, remaining)),
    ]);
    if (!chunk || chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
    const match = seen.match(/^READY (\d+)/m);
    if (match) return Number(match[1]);
  }
  throw new Error('compiler-database: PostgreSQL forwarder did not become ready');
}

export async function startPostgresForwarder(
  socketPath: string,
  listenPort = 0,
  spawn: typeof Bun.spawn = Bun.spawn.bind(Bun),
): Promise<PostgresForwarder> {
  const child = spawn([process.execPath, '-e', POSTGRES_FORWARD_CHILD], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      REZICS_PG_FORWARD_SOCKET: socketPath,
      REZICS_PG_FORWARD_PORT: String(listenPort),
    },
  });
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      const stdin = child.stdin;
      if (stdin && typeof stdin === 'object' && 'end' in stdin) void stdin.end();
    } catch {
      // The child may already have exited.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // The child may already have exited.
    }
  };
  try {
    const port = await readReadyPort(child.stdout, 5_000);
    return { port, child, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

export async function resolvePostgresListenUrl(
  container: string,
  pid = process.pid,
  dockerCommand: DockerCommand = docker,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PostgresListen> {
  await waitForPostgresContainer(container, dockerCommand);
  if (sharesIsolatedStackNetwork(dockerNetworkArgs(env))) {
    const socketPath = isolatedPostgresSocketPath(pid);
    await waitForPath(socketPath);
    const forwarder = await startPostgresForwarder(socketPath);
    const port = String(forwarder.port);
    const url = compilerDatabaseListenUrl(port);
    try {
      await waitForPostgresReady(url);
    } catch (error) {
      forwarder.stop();
      throw error;
    }
    return {
      url,
      port,
      stop: () => {
        forwarder.stop();
        rmSync(isolatedPostgresSocketDir(pid), { recursive: true, force: true });
      },
    };
  }
  const port = dockerCommand(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
  if (!port) throw new Error('Could not determine the compiler database port');
  const url = compilerDatabaseListenUrl(port);
  await waitForPostgresReady(url);
  return {
    url,
    port,
    stop: () => rmSync(isolatedPostgresSocketDir(pid), { recursive: true, force: true }),
  };
}

/** Remove throwaway compiler databases and named volumes whose labelled owner pid is gone. */
export function cleanupStaleCompilerDatabases(dockerCommand: DockerCommand = docker): void {
  const containerOwners = dockerCommand([
    'ps',
    '-a',
    '--filter',
    `label=${COMPILER_PID_LABEL}`,
    '--format',
    `{{.Label "${COMPILER_PID_LABEL}"}}`,
  ])
    .split('\n')
    .map((owner) => owner.trim())
    .filter((owner) => owner.length > 0);
  const volumeOwners = dockerCommand([
    'volume',
    'ls',
    '--filter',
    `label=${COMPILER_PID_LABEL}`,
    '--format',
    `{{.Label "${COMPILER_PID_LABEL}"}}`,
  ])
    .split('\n')
    .map((owner) => owner.trim())
    .filter((owner) => owner.length > 0);
  for (const owner of new Set([...containerOwners, ...volumeOwners])) {
    const ownerPid = Number(owner);
    if (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(ownerPid))
      throw new Error(`compiler-database: Docker returned an invalid owner pid: ${owner}`);
    let alive = true;
    try {
      process.kill(ownerPid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') alive = false;
      else if (code !== 'EPERM') throw error;
    }
    if (!alive) {
      const settlement = settleDockerAttempt(
        COMPILER_PID_LABEL,
        owner,
        [{ name: COMPILER_PID_LABEL, value: owner }],
        dockerCommand,
      );
      if (settlement.status === 'unsettled') throw settlement.error;
      rmSync(isolatedPostgresSocketDir(ownerPid), { recursive: true, force: true });
    }
  }
}

/** Start a throwaway database and apply the kernel migrations, then the Auth migrations. */
export async function prepareCompilerDatabase(): Promise<StartedDatabase> {
  const [{ migrate: migrateKernel }, { migrate: migrateAuth }, { withCommandPhase }] = await Promise.all([
    importHelpers<KernelDatabaseHelpers>('../services/kernel/scripts/database.ts'),
    importHelpers<AuthDatabaseHelpers>('../services/auth/scripts/database.ts'),
    importHelpers<CommandPhaseHelpers>('../services/kernel/scripts/command-phases.ts'),
  ]);
  process.stdout.write(`Compiler database owner ${ownerProcessIdentity()}\n`);
  if (process.env.KERNEL_CHECK_SKIP_STALE_CLEANUP !== '1' && !process.env.KERNEL_CHECK_ON_REMOTE) {
    cleanupStaleCompilerDatabases();
  }
  const nonce = newCompilerNonce();
  const attemptNonces: string[] = [];
  let container: string;
  try {
    container = await withCommandPhase(
      'database-image',
      () => startCompilerContainer(process.pid, nonce, docker, process.env, attemptNonces),
      process.env,
    );
  } catch (error) {
    const failures: unknown[] = [];
    for (const attemptNonce of new Set(attemptNonces)) {
      try {
        reapCompilerNonce(attemptNonce, process.pid);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length) {
      const details = failures.map(dockerErrorText);
      throw retainOriginalAndCleanupFailure(
        error,
        new AggregateError(failures, details.join('; ')),
        'Compiler database startup failed',
      );
    }
    throw error;
  }
  let listen: PostgresListen | undefined;
  let removed = false;
  const remove = (wait = true): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    listen?.stop();
    listen = undefined;
    rmSync(isolatedPostgresSocketDir(), { recursive: true, force: true });
    if (removed) return;
    removed = true;
    if (!wait) {
      beginDetachedDockerRm(container);
      return;
    }
    settleCompilerDatabaseRemoval(container, process.pid, docker, attemptNonces);
  };
  const onSigint = (): void => {
    try {
      remove(false);
    } catch (error) {
      console.error(error);
    }
    process.exit(130);
  };
  const onSigterm = (): void => {
    try {
      remove(false);
    } catch (error) {
      console.error(error);
    }
    process.exit(143);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    process.stdout.write(`Compiler database container=${container}\n`);
    listen = await resolvePostgresListenUrl(container);
    const url = listen.url;
    process.stdout.write(`Compiler database ready: container=${container}\n`);
    await withCommandPhase(
      'migrations',
      () => {
        migrateKernel(url);
        migrateAuth(url);
      },
      process.env,
    );
    return {
      url,
      container,
      assertReady: () =>
        withCommandPhase('database-readiness', () => assertCompilerDatabaseReady(container, url), process.env),
      remove,
    };
  } catch (error) {
    try {
      remove();
    } catch (cleanupError) {
      throw retainOriginalAndCleanupFailure(error, cleanupError, 'Compiler database setup failed');
    }
    throw error;
  }
}
