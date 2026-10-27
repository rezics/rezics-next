import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, POSTGRES_IMAGE, schemaDumps, validateMigrationVersions } from './database.ts';
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
    if (process.env.KERNEL_CHECK_SKIP_STALE_CLEANUP !== '1' && !process.env.KERNEL_CHECK_ON_REMOTE)
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

function derivedAction(args: readonly string[]): 'schema' | 'contracts' {
  if (args.length === 0) return 'contracts';
  if (args.length === 1 && args[0] === 'schema') return 'schema';
  throw new Error(`Unsupported derived arguments: ${args.join(' ')}`);
}

/** Write every dump from the helper's fresh database, ignoring any inherited development URL or container. */
async function writeSchemaDumps(env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.DATABASE_URL;
  const container = env.KERNEL_DATABASE_CONTAINER;
  if (!url || !container) throw new Error('Throwaway database connection is missing');
  // withThrowawayDatabase also installs the fresh container in process.env for schemaDumps' pg_dump.
  const dumps = schemaDumps(url, directory);
  for (const [path, dump] of Object.entries(dumps)) {
    await Bun.write(resolve(directory, path), dump);
  }
}

async function main(): Promise<void> {
  const action = derivedAction(process.argv.slice(2));
  const migrations = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrations, new Date());
  if (action === 'schema') {
    await withThrowawayDatabase(writeSchemaDumps);
    return;
  }
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
