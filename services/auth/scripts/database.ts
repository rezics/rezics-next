import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POSTGRES_IMAGE = 'postgres:19rc1@sha256:7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108';

export function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(program, args, { cwd: directory, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

export function migrate(url: string): void {
  run(resolve(directory, 'node_modules/.bin/dbmate'), [
    '--url',
    url,
    '--migrations-dir',
    'db/migrations',
    '--no-dump-schema',
    '--migration-lock',
    '--wait',
    'up',
    '--strict',
  ]);
}

export function testDatabase(): { url: string; close: () => void } {
  const label = 'rezics.auth.check.pid';
  for (const id of run('docker', ['ps', '-aq', '--filter', `label=${label}`])
    .split('\n')
    .filter(Boolean)) {
    const owner = run('docker', ['inspect', '-f', `{{ index .Config.Labels "${label}" }}`, id]);
    try {
      process.kill(Number(owner), 0);
    } catch {
      run('docker', ['rm', '-f', id]);
    }
  }
  const container = run('docker', [
    'run',
    '-d',
    '--rm',
    '--label',
    `${label}=${process.pid}`,
    '-p',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql:rw,size=1g',
    '-e',
    'POSTGRES_USER=rezics',
    '-e',
    'POSTGRES_PASSWORD=rezics',
    '-e',
    'POSTGRES_DB=rezics_auth_test',
    POSTGRES_IMAGE,
    '-c',
    'fsync=off',
    '-c',
    'synchronous_commit=off',
    '-c',
    'full_page_writes=off',
  ]);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      run('docker', ['rm', '-f', container]);
    }
  };
  const interrupt = (code: number) => {
    close();
    process.exit(code);
  };
  process.once('SIGINT', () => interrupt(130));
  process.once('SIGTERM', () => interrupt(143));
  try {
    const port = run('docker', ['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error('Cannot determine Auth test database port');
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics_auth_test?sslmode=disable`;
    migrate(url);
    return { url, close };
  } catch (error) {
    close();
    throw error;
  }
}

if (import.meta.main) {
  const url = process.env.AUTH_DATABASE_URL;
  if (!url) throw new Error('Set AUTH_DATABASE_URL to the separate Auth database');
  migrate(url);
}
