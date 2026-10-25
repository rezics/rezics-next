import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, POSTGRES_IMAGE, validateMigrationVersions } from './database.ts';
import { cleanup, cleanupStale, docker, run } from './check.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);

/** Start a throwaway database, migrate it, run `work`, and always remove the container. */
export async function withThrowawayDatabase<T>(work: (env: NodeJS.ProcessEnv) => Promise<T> | T): Promise<T> {
  let container = '';
  const onSigint = (): void => {
    cleanup([container]);
    process.exit(130);
  };
  const onSigterm = (): void => {
    cleanup([container]);
    process.exit(143);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    cleanupStale('derived');
    container = docker([
      'run',
      '-d',
      '--rm',
      '--label',
      `rezics.kernel.derived.pid=${pid}`,
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
    const port = docker(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error('Could not determine the throwaway database port');
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    process.env.KERNEL_DATABASE_CONTAINER = container;
    process.env.DATABASE_URL = url;
    const env = { ...process.env, DATABASE_URL: url, KERNEL_DATABASE_CONTAINER: container };
    migrate(url);
    return await work(env);
  } finally {
    cleanup([container]);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

async function main(): Promise<void> {
  const migrations = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrations, new Date());
  await withThrowawayDatabase((env) => {
    run('bun', ['scripts/openapi.ts'], env);
    run('bun', ['scripts/client.ts'], env);
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
