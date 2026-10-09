import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import { physicalPath, POSTGRES_SOCKET_LIMIT, postgresSocketRefusal } from '../../../scripts/goal/postgres-socket.ts';
import { processRunning } from './process-liveness.ts';

const root = resolve(import.meta.dir, '../../..');
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What a throwaway cluster's callers actually change. */
export type PostgresClusterOptions = {
  /** Lines appended to postgresql.conf before the server starts. */
  serverSettings?: string;
  /** Extensions created once the server accepts connections. */
  extensions?: readonly string[];
  /** Superuser role. Defaults to the operating-system user, with trust authentication. */
  role?: string;
};

/** Records the directory a cleanup test must see removed. Callers leave this unset. */
export type PostgresClusterProbe = {
  afterInitdb?: (created: { directory: string; dataDirectory: string }) => void;
  afterStart?: (started: { directory: string; dataDirectory: string; port: number }) => void;
};

export type PostgresClusterConnection = {
  host: '127.0.0.1';
  port: number;
  user: string;
  database: 'postgres';
};

export type PostgresCluster = {
  directory: string;
  dataDirectory: string;
  port: number;
  user: string;
  host: '127.0.0.1';
  database: 'postgres';
  connection: PostgresClusterConnection;
  /** Stop the server and keep its files so {@link PostgresCluster.start} can open them again. */
  stop(mode?: 'fast' | 'immediate'): void;
  /** Start a stopped server again on the same port and data directory. */
  start(): void;
  /** Stop the server. Deletes the directory when this cluster created it. */
  remove(): void;
};

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no PostgreSQL test port'));
        return;
      }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function clusterUser(role: string | undefined): string {
  const user = role ?? process.env.USER ?? userInfo().username;
  if (!identifier.test(user)) throw new Error('PostgreSQL test cluster role must be an identifier');
  return user;
}

/** TCP is always enabled. A Unix socket is used only when its path fits `sun_path`. */
function socketArgument(port: number): string {
  const directory = join(root, '.temp', 'pg-sock');
  const socket = join(directory, `.s.PGSQL.${port}`);
  const tooLong = postgresSocketRefusal(root) !== undefined
    || Buffer.byteLength(physicalPath(socket)) > POSTGRES_SOCKET_LIMIT;
  if (tooLong) return '-c unix_socket_directories=';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return `-k ${directory}`;
}

function postmasterPid(dataDirectory: string): number | undefined {
  const path = join(dataDirectory, 'postmaster.pid');
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf8').split('\n')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function pidsUsing(dataDirectory: string): number[] {
  let entries: string[];
  try { entries = readdirSync('/proc'); }
  catch { return []; }
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = readFileSync(join('/proc', entry, 'cmdline'));
      if (command.includes(dataDirectory)) found.push(Number(entry));
    } catch { /* the process exited or is not readable */ }
  }
  return found;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killPid(pid: number): void {
  for (const target of [-pid, pid]) {
    try { process.kill(target, 'SIGKILL'); }
    catch { /* already gone, or the process group cannot be signalled */ }
  }
}

/** pg_ctl first, then the postmaster process group, so a failed start cannot keep running. */
function ensureStopped(dataDirectory: string, mode: 'fast' | 'immediate'): void {
  const pid = postmasterPid(dataDirectory);
  try {
    execFileSync('pg_ctl', ['-D', dataDirectory, '-m', mode, '-t', '30', '-w', 'stop'],
      { stdio: 'ignore', timeout: 40_000 });
  } catch { /* stop reports failure when the server never finished starting */ }
  if (pid !== undefined) killPid(pid);
  for (const leftover of pidsUsing(dataDirectory)) killPid(leftover);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive = [
      ...(pid !== undefined && processRunning(pid) ? [pid] : []),
      ...pidsUsing(dataDirectory).filter(candidate => processRunning(candidate)),
    ];
    if (!alive.length) return;
    pause(20);
  }
  throw new Error(`PostgreSQL is still running in ${dataDirectory}`);
}

function launch(dataDirectory: string, log: string, port: number): void {
  execFileSync('pg_ctl', [
    '-D', dataDirectory, '-l', log,
    '-o', `-h 127.0.0.1 -p ${port} ${socketArgument(port)}`,
    '-t', '60', '-w', 'start',
  ], { stdio: 'pipe', timeout: 90_000 });
}

function connectionFor(port: number, user: string): PostgresClusterConnection {
  return { host: '127.0.0.1', port, user, database: 'postgres' };
}

function openCluster(input: {
  directory: string;
  dataDirectory: string;
  port: number;
  user: string;
  log: string;
  ownsDirectory: boolean;
}): PostgresCluster {
  let running = true;
  let removed = false;
  const stop = (mode: 'fast' | 'immediate' = 'fast') => {
    if (!running) return;
    ensureStopped(input.dataDirectory, mode);
    running = false;
  };
  return {
    directory: input.directory,
    dataDirectory: input.dataDirectory,
    port: input.port,
    user: input.user,
    host: '127.0.0.1',
    database: 'postgres',
    connection: connectionFor(input.port, input.user),
    stop,
    start() {
      if (running || removed) return;
      launch(input.dataDirectory, input.log, input.port);
      running = true;
    },
    remove() {
      if (removed) return;
      stop('immediate');
      removed = true;
      if (input.ownsDirectory) rmSync(input.directory, { recursive: true, force: true });
    },
  };
}

async function createExtensions(connection: PostgresClusterConnection, extensions: readonly string[]): Promise<void> {
  for (const extension of extensions) {
    if (!identifier.test(extension)) throw new Error(`invalid PostgreSQL extension: ${extension}`);
  }
  const client = new Client(connection);
  await client.connect();
  try {
    for (const extension of extensions) await client.query(`CREATE EXTENSION ${extension}`);
  } finally { await client.end(); }
}

/**
 * Start a disposable local PostgreSQL cluster.
 * `--no-sync` skips initdb's initial checkpoint only; the server keeps fsync on.
 * Any failure after that initdb stops the process and deletes the directory.
 */
export async function startPostgresCluster(options: PostgresClusterOptions = {},
  probe: PostgresClusterProbe = {}): Promise<PostgresCluster> {
  const user = clusterUser(options.role);
  const directory = join(root, '.temp', `pg-${randomUUID()}`);
  const dataDirectory = join(directory, 'pgdata');
  const log = join(directory, 'postgres.log');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let started = false;
  const discard = () => {
    if (started || postmasterPid(dataDirectory) !== undefined || pidsUsing(dataDirectory).length) {
      ensureStopped(dataDirectory, 'immediate');
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    execFileSync('initdb', [
      '-D', dataDirectory,
      ...(options.role ? ['-U', options.role] : []),
      '-A', 'trust', '--no-instructions', '--no-sync',
    ], { stdio: 'pipe', timeout: 60_000 });
    if (options.serverSettings?.trim()) {
      appendFileSync(join(dataDirectory, 'postgresql.conf'), `\n${options.serverSettings.trim()}\n`);
    }
    probe.afterInitdb?.({ directory, dataDirectory });
    const port = await freePort();
    launch(dataDirectory, log, port);
    started = true;
    probe.afterStart?.({ directory, dataDirectory, port });
    if (options.extensions?.length) await createExtensions(connectionFor(port, user), options.extensions);
    return openCluster({ directory, dataDirectory, port, user, log, ownsDirectory: true });
  } catch (error) {
    discard();
    throw error;
  }
}

/**
 * Start a data directory the caller already prepared, such as a restored copy.
 * `remove` stops the server and leaves those files for the caller to delete.
 */
export async function startPreparedPostgresCluster(dataDirectory: string,
  options: { role?: string } = {}): Promise<PostgresCluster> {
  const user = clusterUser(options.role);
  const directory = dirname(dataDirectory);
  const log = join(directory, `${basename(dataDirectory)}.log`);
  const port = await freePort();
  try {
    launch(dataDirectory, log, port);
  } catch (error) {
    if (postmasterPid(dataDirectory) !== undefined || pidsUsing(dataDirectory).length) {
      ensureStopped(dataDirectory, 'immediate');
    }
    throw error;
  }
  return openCluster({ directory, dataDirectory, port, user, log, ownsDirectory: false });
}
