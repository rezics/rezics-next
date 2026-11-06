// Reylo prepares `.sql` modules against DATABASE_URL. The root typecheck and the Auth standalone typecheck share this
// preparation so those modules see the kernel schema and the Auth schema. Auth `check` reuses its labelled fixture
// instead of this second container.
import { spawnSync } from 'node:child_process';
import { migrate as migrateAuth } from '../services/auth/scripts/database.ts';
import { migrate as migrateKernel, POSTGRES_IMAGE } from '../services/kernel/scripts/database.ts';
import { withCommandPhase } from '../services/kernel/scripts/command-phases.ts';
import type { StartedDatabase } from './typecheck.ts';

const COMPILER_LAUNCH_TIMEOUT = 600_000;
const COMPILER_REMOVE_TIMEOUT = 120_000;
const COMPILER_DOCKER_TIMEOUT = 30_000;

function dockerTimeout(args: string[]): number {
  if (args[0] === 'run' && args.includes('-d')) return COMPILER_LAUNCH_TIMEOUT;
  if (args[0] === 'rm') return COMPILER_REMOVE_TIMEOUT;
  return COMPILER_DOCKER_TIMEOUT;
}

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: dockerTimeout(args) });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw Object.assign(result.error, {
        message: `spawnSync docker ETIMEDOUT ${JSON.stringify(['docker', ...args])}`,
      });
    }
    throw result.error;
  }
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} failed with status ${result.status}: ${result.stderr?.trim() || '(no stderr)'}`,
    );
  return result.stdout.trim();
}

/** Start a throwaway database and apply the kernel migrations, then the Auth migrations. */
export async function prepareCompilerDatabase(): Promise<StartedDatabase> {
  process.stdout.write(`Compiler database owner PID=${process.pid}\n`);
  const container = await withCommandPhase(
    'database-image',
    () =>
      docker([
        'run',
        '-d',
        '--rm',
        '--label',
        `rezics.compiler.pid=${process.pid}`,
        '-p',
        '127.0.0.1::5432',
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
    const port = docker(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error('Could not determine the compiler database port');
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
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
