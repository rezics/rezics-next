import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POSTGRES_IMAGE = 'postgres:19rc1@sha256:b3cb7405059fd06f9ebae4aad4780b3788dfdd2acef1ac248ad9d56ced8abb06';

export const TEMPLATE_DATABASE = 'rezics_auth_test';
export const DEFAULT_RUN_TIMEOUT = 120_000;

type TestDatabase = { readonly url: string; readonly container: string; close: () => void };

const OWNER_LABEL = 'rezics.auth.check.pid';
const NONCE_LABEL = 'rezics.auth.check.nonce';
const CLEANUP_TIMEOUT = 5_000;
const READY_TIMEOUT = 60_000;
let placed = false;
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', cleanupOwned);
}

export function assertDatabasePlacement(): void {
  if (!placed && !laneContext(process.env)) {
    throw new Error('Auth test databases require placement; use bun run --cwd services/auth check <file>');
  }
}

function spawnError(program: string, args: string[], error: NodeJS.ErrnoException): never {
  if (error.code === 'ETIMEDOUT') {
    throw Object.assign(error, {
      message: `spawnSync ${program} ETIMEDOUT ${JSON.stringify([program, ...args])}`,
    });
  }
  throw error;
}

function cleanupDocker(args: string[]): string {
  const result = spawnSync('docker', args, { cwd: directory, encoding: 'utf8', timeout: CLEANUP_TIMEOUT });
  if (result.error) spawnError('docker', args, result.error);
  return result.stdout?.trim() ?? '';
}

/** Remove only this process's containers, including created containers, and their labelled volumes. */
function cleanupOwned(): void {
  const filter = `label=${OWNER_LABEL}=${process.pid}`;
  const containers = cleanupDocker(['ps', '-aq', '--filter', filter]).split('\n').filter(Boolean);
  if (containers.length) cleanupDocker(['rm', '-f', '-v', ...containers]);
  const volumes = cleanupDocker(['volume', 'ls', '-q', '--filter', filter]).split('\n').filter(Boolean);
  if (volumes.length) cleanupDocker(['volume', 'rm', '-f', ...volumes]);
}

/** Place the whole check: a fixture's loopback URL cannot be handed back from a remote host. */
export async function databaseCheck(command: string[], action: () => Promise<number>): Promise<number> {
  const { stackRun } = await import('../../../scripts/stack-run.ts');
  return stackRun({ label: 'auth check', root: resolve(directory, '../..'), cwd: directory, command }, async () => {
    placed = true;
    registerCleanup();
    try {
      return await action();
    } finally {
      cleanupOwned();
      process.off('exit', cleanupOwned);
      cleanupRegistered = false;
      placed = false;
    }
  });
}

export function run(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  { timeout = DEFAULT_RUN_TIMEOUT }: { timeout?: number } = {},
): string {
  const fixture = program === 'docker' && args[0] === 'run' && args.includes('-d') && args.includes(POSTGRES_IMAGE);
  let nonce: string | undefined;
  if (fixture) {
    assertDatabasePlacement();
    registerCleanup();
    nonce = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    args = [
      'run',
      '--stop-timeout',
      '2',
      '--label',
      `${OWNER_LABEL}=${process.pid}`,
      '--label',
      `${NONCE_LABEL}=${nonce}`,
      ...args.slice(1),
    ];
  }
  const result = spawnSync(program, args, { cwd: directory, env, encoding: 'utf8', timeout });
  if (nonce && (result.error || result.status !== 0)) {
    // docker run can create a container without starting it or returning its id.
    // Reap it synchronously before propagating either a timeout or a non-zero exit.
    const ids = cleanupDocker(['ps', '-aq', '--filter', `label=${NONCE_LABEL}=${nonce}`])
      .split('\n')
      .filter(Boolean);
    if (ids.length) cleanupDocker(['rm', '-f', '-v', ...ids]);
  }
  if (result.error) spawnError(program, args, result.error);
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

// Removal waits on the daemon. Under a full suite that wait exceeds the default
// hook budget, and a non-zero `docker rm -f` (already gone, or removal already
// in progress) then fails the hook. Issue the removal in its own session so the
// caller can return; a later check still collects a fixture whose owner has exited.
function removeContainer(id: string): void {
  const child = spawn('docker', ['rm', '-f', '-v', id], { cwd: directory, detached: true, stdio: 'ignore' });
  child.unref();
}

export function migrate(url: string, migrationsDirectory = 'db/migrations'): void {
  run(resolve(directory, 'node_modules/.bin/dbmate'), [
    '--url',
    url,
    '--migrations-dir',
    migrationsDirectory,
    '--no-dump-schema',
    '--migration-lock',
    '--wait',
    'up',
  ]);
}

export function schemaDump(url: string, fixture?: TestDatabase): string {
  if (fixture && fixture.url !== url) throw new Error('Schema dump URL does not belong to this Auth fixture');
  const dumpArgs = ['pg_dump', '--schema-only', '--no-owner', '--no-privileges', '--exclude-schema=auth_dbos'];
  let args: string[];
  if (fixture) {
    const database = new URL(url);
    database.hostname = '127.0.0.1';
    database.port = '5432';
    args = ['exec', fixture.container, ...dumpArgs, database.href];
  } else {
    args = ['run', '--stop-timeout', '2', '--rm', '--network', 'host', POSTGRES_IMAGE, ...dumpArgs, url];
  }
  const dump = run('docker', args);
  return (
    dump
      .split('\n')
      .filter((line) => !/^\\(?:un)?restrict\b/.test(line) && !/^-- Dumped (?:from|by)\b/.test(line))
      .join('\n') + '\n'
  );
}

/**
 * The migrated Auth database a check lane is handed: a copy of the check's template, in the check's container. The
 * check publishes AUTH_TEST_DATABASE_URL and AUTH_CHECK_CONTAINER; bun-test workers and module imports consume that
 * admitted copy instead of starting another server. A process a test starts for its own child uses withTestDatabaseLane.
 */
type LaneContext = { container: string; url: string };

let laneClaimed = false;
let laneCopies = 0;

function laneContext(env: NodeJS.ProcessEnv): LaneContext | null {
  const container = env.AUTH_CHECK_CONTAINER;
  if (!container) return null;
  if (env.AUTH_TEST_DATABASE_URL) return { container, url: env.AUTH_TEST_DATABASE_URL };
  return env.DATABASE_URL && env.AUTH_CHECK_LANE_OWNER === String(process.ppid)
    ? { container, url: env.DATABASE_URL }
    : null;
}

function laneStatement(container: string, sql: string): string[] {
  return ['exec', container, 'psql', '-U', 'rezics', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql];
}

let childLanes = 0;

/** A direct lane child can own a fresh lane for its own child, in the existing placed server. */
export async function withTestDatabaseLane<T>(
  env: NodeJS.ProcessEnv,
  action: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  // Check the caller's placement, never the environment it wants to give its child.
  const lane = laneContext(process.env);
  if (!lane) throw new Error('Auth child tests require a directly owned check lane');
  const name = `auth_child_${process.pid}_${++childLanes}`;
  const temporaryRoot = resolve(directory, '../../.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const resources = mkdtempSync(resolve(temporaryRoot, 'auth-child-lane-'));
  const copies = resolve(resources, 'copies');
  appendFileSync(copies, '');
  const cleanup = () => {
    // The child records exact copy names before creating them. No database discovery or foreign cleanup.
    const names = new Set(readFileSync(copies, 'utf8').split('\n').filter(Boolean));
    for (const copy of names) {
      if (!copy.startsWith(`${name}_copy_`) || !/^\d+$/.test(copy.slice(`${name}_copy_`.length))) {
        throw new Error('Auth child recorded a database outside its owned lane');
      }
      run('docker', laneStatement(lane.container, `DROP DATABASE IF EXISTS ${copy} WITH (FORCE)`));
    }
    run('docker', laneStatement(lane.container, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    rmSync(resources, { recursive: true, force: true });
  };
  process.once('exit', cleanup);
  const url = new URL(lane.url);
  url.pathname = `/${name}`;
  try {
    run('docker', laneStatement(lane.container, `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`));
    return await action({
      ...env,
      AUTH_CHECK_CONTAINER: lane.container,
      AUTH_CHECK_LANE_OWNER: String(process.pid),
      DATABASE_URL: url.href,
      AUTH_TEST_DATABASE_URL: url.href,
      AUTH_CHECK_LANE_COPIES: copies,
    });
  } finally {
    try {
      cleanup();
    } finally {
      process.off('exit', cleanup);
    }
  }
}

/**
 * A migrated database for one test. Under the check the file's lane already runs against a copy of the migrated
 * template, so the first fixture is that copy and later ones are further copies in the same server; starting a server
 * per fixture is what made files wait on the Docker daemon. Outside the check use the placed check command.
 */
export function testDatabase(): TestDatabase {
  const lane = laneContext(process.env);
  if (!lane) return ownDatabase();
  if (!laneClaimed) {
    laneClaimed = true;
    return { url: lane.url, container: lane.container, close: () => {} };
  }
  const name = `${decodeURIComponent(new URL(lane.url).pathname.slice(1))}_copy_${++laneCopies}`;
  const copies = process.env.AUTH_CHECK_LANE_COPIES;
  if (copies) appendFileSync(copies, `${name}\n`);
  run('docker', laneStatement(lane.container, `CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`));
  const url = new URL(lane.url);
  url.pathname = `/${name}`;
  let closed = false;
  return {
    url: url.href,
    container: lane.container,
    close: () => {
      if (closed) return;
      closed = true;
      // Delegated copies belong to the runner, which drops them after the complete child tree ends.
      if (copies) return;
      const child = spawn('docker', laneStatement(lane.container, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`), {
        cwd: directory,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    },
  };
}

function waitUntilReady(container: string): void {
  const deadline = Date.now() + READY_TIMEOUT;
  let last = '';
  while (Date.now() < deadline) {
    const inspect = run('docker', [
      'inspect',
      '-f',
      `{{.State.Status}} {{.Id}} {{index .Config.Labels "${OWNER_LABEL}"}} {{index .Config.Labels "${NONCE_LABEL}"}}`,
      container,
    ]);
    last = inspect;
    const [status] = inspect.split(' ');
    if (status === 'running') {
      const ready = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'rezics', '-d', TEMPLATE_DATABASE], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (!ready.error && ready.status === 0) return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    Bun.sleepSync(Math.min(250, remaining));
  }
  throw new Error(`Auth test fixture ${container} was not ready: ${last}`);
}

/** A migrated database in a server of its own, removed on close. */
export function ownDatabase(): TestDatabase {
  assertDatabasePlacement();
  const label = OWNER_LABEL;
  // Capture owners with IDs so concurrent cleanup cannot race a separate inspect.
  for (const row of run('docker', [
    'ps',
    '-a',
    '--filter',
    `label=${label}`,
    '--format',
    `{{.ID}} {{.Label "${label}"}}`,
  ])
    .split('\n')
    .filter(Boolean)) {
    const [id, owner, ...extra] = row.split(' ');
    if (!id || !owner || extra.length || !/^[1-9]\d*$/.test(owner)) continue;
    const pid = Number(owner);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      // An inaccessible owner may still be alive; only a missing process is stale.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      // Removing a container that another checker already removed is success.
      const removal = spawnSync('docker', ['rm', '-f', '-v', id], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 120_000,
      });
      if (removal.error) spawnError('docker', ['rm', '-f', '-v', id], removal.error);
    }
  }
  const container = run('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::5432',
    // Keep PostgreSQL data on disk instead of consuming memory that the check slot admission does not reserve.
    '--mount',
    `type=volume,destination=/var/lib/postgresql,volume-label=${label}=${process.pid}`,
    '-e',
    'POSTGRES_USER=rezics',
    '-e',
    'POSTGRES_PASSWORD=rezics',
    '-e',
    `POSTGRES_DB=${TEMPLATE_DATABASE}`,
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
    '-c',
    'max_wal_size=256MB',
    // Each check lane holds pools of its own, and a lane's tests open further copies.
    '-c',
    'max_connections=500',
  ]);
  let closed = false;
  const close = () => {
    if (!closed && container) {
      closed = true;
      removeContainer(container);
    }
  };
  const interrupt = (code: number) => {
    close();
    process.exit(code);
  };
  process.once('SIGINT', () => interrupt(130));
  process.once('SIGTERM', () => interrupt(143));
  try {
    waitUntilReady(container);
    const port = run('docker', ['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error(`Cannot determine Auth test database port for ${container}`);
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/${TEMPLATE_DATABASE}?sslmode=disable`;
    migrate(url);
    return { url, container, close };
  } catch (error) {
    close();
    throw error;
  }
}

if (import.meta.main) {
  const url = process.env.AUTH_DATABASE_URL;
  if (!url) throw new Error('Set AUTH_DATABASE_URL to the separate Auth database');
  if (process.argv[2] === 'dump') await Bun.write(resolve(directory, 'db/schema.sql'), schemaDump(url));
  else if (!process.argv[2] || process.argv[2] === 'migrate') migrate(url);
  else throw new Error('Use db migrate or db dump');
}
