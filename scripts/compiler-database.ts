// Reylo prepares `.sql` modules against DATABASE_URL. The root typecheck and the Auth check share this
// preparation so those modules see the kernel schema and the Auth schema.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { migrate as migrateAuth } from '../services/auth/scripts/database.ts';
import { migrate as migrateKernel, POSTGRES_IMAGE } from '../services/kernel/scripts/database.ts';
import { withCommandPhase } from '../services/kernel/scripts/command-phases.ts';
import type { StartedDatabase } from './typecheck.ts';

const CONTAINER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const POSTGRES_SOCKET_NAME = '.s.PGSQL.5432';
const READY_TIMEOUT_MS = 60_000;
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

export function dockerTimeoutMs(args: readonly string[]): number {
  const verb = args[0];
  if (verb === 'run' || verb === 'create' || verb === 'start' || verb === 'stop') return DOCKER_RUN_TIMEOUT_MS;
  if (verb === 'rm' && args.includes('-f')) return DOCKER_RUN_TIMEOUT_MS;
  return DOCKER_PROBE_TIMEOUT_MS;
}

/** Forced `rm` is a new session so a 200ms supervisor SIGKILL of the owner group cannot abort it. */
export function dockerSpawnSyncOptions(
  args: readonly string[],
  extra: Pick<SpawnSyncOptions, 'cwd' | 'env'> = {},
): SpawnSyncOptions {
  const forcedRm = args[0] === 'rm' && args.includes('-f');
  return {
    encoding: 'utf8',
    timeout: dockerTimeoutMs(args),
    ...(forcedRm ? { detached: true } : {}),
    ...extra,
  };
}

/**
 * Auth fixture pattern: issue `docker rm -f -v` in its own session and return. The host-lifetime supervisor still
 * waits up to 120s for labelled removal; SIGTERM handlers must not block in spawnSync.
 */
export function beginDetachedDockerRm(
  id: string,
  extra: Pick<SpawnSyncOptions, 'cwd' | 'env'> = {},
): void {
  if (!id || !CONTAINER_IDENTITY.test(id)) return;
  const child = spawn('docker', ['rm', '-f', '-v', id], { detached: true, stdio: 'ignore', ...extra });
  child.unref();
}

function spawnDockerError(args: readonly string[], error: NodeJS.ErrnoException): never {
  if (error.code === 'ETIMEDOUT') {
    throw Object.assign(error, {
      message: `spawnSync docker ETIMEDOUT ${JSON.stringify(['docker', ...args])}`,
    });
  }
  throw error;
}

function docker(args: string[]): string {
  const result = spawnSync('docker', args, dockerSpawnSyncOptions(args));
  if (result.error) spawnDockerError(args, result.error as NodeJS.ErrnoException);
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} failed with status ${result.status}: ${result.stderr?.trim() || '(no stderr)'}`,
    );
  return result.stdout.trim();
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
    `type=volume,destination=/var/lib/postgresql,volume-label=${COMPILER_PID_LABEL}=${pid}`,
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
  ];
}

export function reapCompilerNonce(nonce: string, pid = process.pid, dockerCommand: DockerCommand = docker): void {
  try {
    const ids = dockerCommand(['ps', '-aq', '--filter', `label=${COMPILER_NONCE_LABEL}=${nonce}`])
      .split('\n')
      .filter(Boolean);
    for (const id of ids) {
      try {
        dockerCommand(['rm', '-f', '-v', id]);
      } catch {
        // A concurrent cleanup may already have removed it.
      }
    }
  } catch {
    // Listing may fail after a daemon timeout; labelled stale cleanup still reaps later.
  }
  rmSync(isolatedPostgresSocketDir(pid), { recursive: true, force: true });
}

/** Start the one-run compiler container; a timeout or failed create reaps that nonce before the error escapes. */
export function startCompilerContainer(
  pid = process.pid,
  nonce = newCompilerNonce(pid),
  dockerCommand: DockerCommand = docker,
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    return dockerCommand(compilerDatabaseRunArgs(pid, nonce, dockerNetworkArgs(env)));
  } catch (error) {
    reapCompilerNonce(nonce, pid, dockerCommand);
    throw error;
  }
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
  let last = 'not probed';
  while (now() < deadline) {
    try {
      dockerCommand(postgresContainerReadyArgs(container));
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(50);
  }
  throw new Error(`compiler-database: PostgreSQL in ${container} was not ready: ${last}`);
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
  const deadline = now() + timeoutMs;
  let last = 'not probed';
  while (now() < deadline) {
    const remaining = Math.max(1, deadline - now());
    last = await Promise.race([postgresProtocolReply(host, port), delay(remaining).then(() => 'timeout')]);
    if (last === 'ready') return;
    if (now() >= deadline) break;
    await delay(50);
  }
  throw new Error(`compiler-database: PostgreSQL was not ready at ${url}: ${last}`);
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

/** Remove throwaway compiler databases whose labelled owner pid is gone, including killed owners. */
export function cleanupStaleCompilerDatabases(dockerCommand: DockerCommand = docker): void {
  const rows = dockerCommand([
    'ps',
    '-a',
    '--filter',
    `label=${COMPILER_PID_LABEL}`,
    '--format',
    `{{.ID}} {{.Label "${COMPILER_PID_LABEL}"}}`,
  ])
    .split('\n')
    .filter(Boolean);
  for (const row of rows) {
    const [id, owner] = row.split(' ');
    try {
      process.kill(Number(owner), 0);
    } catch {
      try {
        dockerCommand(['rm', '-f', '-v', id!]);
      } catch {
        // A concurrent cleanup may already have removed it.
      }
      rmSync(isolatedPostgresSocketDir(Number(owner)), { recursive: true, force: true });
    }
  }
}

/** Start a throwaway database and apply the kernel migrations, then the Auth migrations. */
export async function prepareCompilerDatabase(): Promise<StartedDatabase> {
  process.stdout.write(`Compiler database owner ${ownerProcessIdentity()}\n`);
  if (process.env.KERNEL_CHECK_SKIP_STALE_CLEANUP !== '1' && !process.env.KERNEL_CHECK_ON_REMOTE) {
    cleanupStaleCompilerDatabases();
  }
  const nonce = newCompilerNonce();
  const container = await withCommandPhase(
    'database-image',
    () => startCompilerContainer(process.pid, nonce),
    process.env,
  );
  let listen: PostgresListen | undefined;
  let removed = false;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  const remove = (wait = true): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    listen?.stop();
    listen = undefined;
    rmSync(isolatedPostgresSocketDir(), { recursive: true, force: true });
    if (removed) {
      if (cleanupFailed) throw cleanupFailure;
      return;
    }
    removed = true;
    if (!wait) {
      beginDetachedDockerRm(container);
      return;
    }
    try {
      docker(['rm', '-f', '-v', container]);
    } catch (error) {
      cleanupFailed = true;
      cleanupFailure = error;
      throw error;
    }
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
    listen = await resolvePostgresListenUrl(container);
    const url = listen.url;
    await withCommandPhase(
      'migrations',
      () => {
        migrateKernel(url);
        migrateAuth(url);
      },
      process.env,
    );
    return { url, container, remove };
  } catch (error) {
    try {
      remove();
    } catch (cleanupError) {
      const setup = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`Compiler database setup failed (${setup}); cleanup could not be proven (${cleanup})`, {
        cause: error,
      });
    }
    throw error;
  }
}
