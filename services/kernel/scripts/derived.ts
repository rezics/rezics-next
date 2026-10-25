import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, POSTGRES_IMAGE, validateMigrationVersions } from './database.ts';
import { cleanup, cleanupStale, docker, run } from './check.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);
let container = '';

async function main(): Promise<void> {
  const migrations = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrations, new Date());
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
  const env = { ...process.env, DATABASE_URL: url, KERNEL_DATABASE_CONTAINER: container };
  migrate(url);
  run('bun', ['scripts/openapi.ts'], env);
  run('bun', ['scripts/client.ts'], env);
}

if (import.meta.main) {
  process.on('SIGINT', () => {
    cleanup([container]);
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup([container]);
    process.exit(143);
  });
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    cleanup([container]);
  }
}
