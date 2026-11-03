// Reylo prepares `.sql` modules against DATABASE_URL. The root typecheck and the Auth check share this
// preparation so those modules see the kernel schema and the Auth schema.
import { spawnSync } from 'node:child_process';
import { migrate as migrateAuth } from '../services/auth/scripts/database.ts';
import { migrate as migrateKernel, POSTGRES_IMAGE } from '../services/kernel/scripts/database.ts';
import type { StartedDatabase } from './typecheck.ts';

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `docker ${args.join(' ')} failed with status ${result.status}: ${result.stderr?.trim() || '(no stderr)'}`,
    );
  return result.stdout.trim();
}

/** Start a throwaway database and apply the kernel migrations, then the Auth migrations. */
export async function prepareCompilerDatabase(): Promise<StartedDatabase> {
  process.stdout.write(`Compiler database owner PID=${process.pid}\n`);
  const container = docker([
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
  ]);
  let removed = false;
  const remove = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (removed) return;
    removed = true;
    try {
      docker(['rm', '-f', '-v', container]);
    } catch (error) {
      console.error(error);
    }
  };
  const onSigint = (): void => {
    remove();
    process.exit(130);
  };
  const onSigterm = (): void => {
    remove();
    process.exit(143);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    const port = docker(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error('Could not determine the compiler database port');
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    migrateKernel(url);
    migrateAuth(url);
    return { url, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
