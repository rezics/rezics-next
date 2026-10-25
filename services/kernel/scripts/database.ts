import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POSTGRES_IMAGE = 'postgres:19rc1@sha256:7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108';
const container = 'rezics-kernel-dev';
const volume = 'rezics-kernel-dev';
const port = Number(process.env.KERNEL_DATABASE_PORT ?? '54329');

function command(program: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(program, args, {
    cwd: directory,
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function databaseUrl(databasePort: number): string {
  return `postgres://rezics:rezics@127.0.0.1:${databasePort}/rezics?sslmode=disable`;
}

export function migrate(url: string): void {
  command(resolve(directory, 'node_modules/.bin/dbmate'), [
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

export function schemaDump(url: string): string {
  const dump = command('docker', [
    'run',
    '--rm',
    '--network',
    'host',
    '-e',
    'PGPASSWORD=rezics',
    POSTGRES_IMAGE,
    'pg_dump',
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    url,
  ]);
  return dump
    .split('\n')
    .filter((line) => !/^\\(?:un)?restrict\b/.test(line) && !/^-- Dumped (?:from|by)\b/.test(line))
    .join('\n');
}

function docker(args: string[]): string {
  return command('docker', args);
}

async function up(): Promise<void> {
  const existing = docker(['ps', '-aq', '--filter', `name=^${container}$`]).trim();
  if (existing) {
    const running = docker(['inspect', '-f', '{{.State.Running}}', container]).trim();
    if (running !== 'true') docker(['start', container]);
  } else {
    docker(['volume', 'create', volume]);
    docker([
      'run',
      '-d',
      '--name',
      container,
      '-p',
      `127.0.0.1:${port}:5432`,
      '-v',
      `${volume}:/var/lib/postgresql`,
      '-e',
      'POSTGRES_USER=rezics',
      '-e',
      'POSTGRES_PASSWORD=rezics',
      '-e',
      'POSTGRES_DB=rezics',
      POSTGRES_IMAGE,
    ]);
  }
  const url = databaseUrl(port);
  migrate(url);
  await Bun.write(resolve(directory, '.env'), `DATABASE_URL=${url}\n`);
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'up';
  if (action === 'up') await up();
  else if (action === 'down') {
    const found = docker(['ps', '-aq', '--filter', `name=^${container}$`]).trim();
    if (found) docker(['stop', container]);
  } else if (action === 'reset') {
    const found = docker(['ps', '-aq', '--filter', `name=^${container}$`]).trim();
    if (found) docker(['rm', '-f', container]);
    try {
      docker(['volume', 'rm', volume]);
    } catch {
      // A missing volume is already reset.
    }
    await up();
  } else if (action === 'dump') {
    const url = databaseUrl(port);
    await Bun.write(resolve(directory, 'db/schema.sql'), schemaDump(url));
  } else throw new Error(`Unknown database action: ${action}`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
