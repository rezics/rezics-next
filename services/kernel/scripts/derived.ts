import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, POSTGRES_IMAGE, validateMigrationVersions } from './database.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pid = String(process.pid);
let container = '';

function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(program, args, { cwd: directory, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function docker(args: string[]): string {
  return run('docker', args);
}

function cleanupStale(): void {
  const rows = docker([
    'ps',
    '-a',
    '--filter',
    'label=rezics.kernel.derived.pid',
    '--format',
    '{{.ID}} {{.Label "rezics.kernel.derived.pid"}}',
  ])
    .split('\n')
    .filter(Boolean);
  for (const row of rows) {
    const [id, owner] = row.split(' ');
    try {
      process.kill(Number(owner), 0);
    } catch {
      spawnSync('docker', ['rm', '-f', id!], { cwd: directory, encoding: 'utf8' });
    }
  }
}

function cleanup(): void {
  if (!container) return;
  try {
    docker(['rm', '-f', container]);
  } catch (error) {
    console.error(error);
  }
}

async function main(): Promise<void> {
  const migrations = Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory }));
  validateMigrationVersions(migrations, new Date());
  cleanupStale();
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
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}
