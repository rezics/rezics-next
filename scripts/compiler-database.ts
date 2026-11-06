// Reylo prepares `.sql` modules against DATABASE_URL. The root typecheck and the Auth check share this
// preparation so those modules see the kernel schema and the Auth schema.
import { spawnSync } from 'node:child_process';
import { migrate as migrateAuth } from '../services/auth/scripts/database.ts';
import { migrate as migrateKernel, POSTGRES_IMAGE } from '../services/kernel/scripts/database.ts';
import { withCommandPhase } from '../services/kernel/scripts/command-phases.ts';
import type { StartedDatabase } from './typecheck.ts';

const CONTAINER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} failed with status ${result.status}: ${result.stderr?.trim() || '(no stderr)'}`,
    );
  return result.stdout.trim();
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

/** Start a throwaway database and apply the kernel migrations, then the Auth migrations. */
export async function prepareCompilerDatabase(): Promise<StartedDatabase> {
  process.stdout.write(`Compiler database owner PID=${process.pid}\n`);
  const network = dockerNetworkArgs();
  const isolated = sharesIsolatedStackNetwork(network);
  const container = await withCommandPhase(
    'database-image',
    () =>
      docker([
        'run',
        '-d',
        '--rm',
        ...network,
        '--label',
        `rezics.compiler.pid=${process.pid}`,
        ...(isolated ? [] : ['-p', '127.0.0.1::5432']),
        '--tmpfs',
        '/var/lib/postgresql:rw,size=1g',
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
      ]),
    process.env,
  );
  let removed = false;
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  const remove = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (removed) {
      if (cleanupFailed) throw cleanupFailure;
      return;
    }
    removed = true;
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
      remove();
    } catch (error) {
      console.error(error);
    }
    process.exit(130);
  };
  const onSigterm = (): void => {
    try {
      remove();
    } catch (error) {
      console.error(error);
    }
    process.exit(143);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const port = isolated
      ? '5432'
      : docker(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error('Could not determine the compiler database port');
    const url = compilerDatabaseListenUrl(port);
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
