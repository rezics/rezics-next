import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POSTGRES_IMAGE = 'postgres:19rc1@sha256:7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108';

type TestDatabase = { readonly url: string; readonly container: string; close: () => void };

export function run(program: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(program, args, { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
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
  const dumpArgs = ['pg_dump', '--schema-only', '--no-owner', '--no-privileges'];
  let args: string[];
  if (fixture) {
    const database = new URL(url);
    database.hostname = '127.0.0.1';
    database.port = '5432';
    args = ['exec', fixture.container, ...dumpArgs, database.href];
  } else {
    args = ['run', '--rm', '--network', 'host', POSTGRES_IMAGE, ...dumpArgs, url];
  }
  const dump = run('docker', args);
  return (
    dump
      .split('\n')
      .filter((line) => !/^\\(?:un)?restrict\b/.test(line) && !/^-- Dumped (?:from|by)\b/.test(line))
      .join('\n') + '\n'
  );
}

export function testDatabase(): TestDatabase {
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
