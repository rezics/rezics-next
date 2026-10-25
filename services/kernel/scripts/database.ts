import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
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

function validateMigrationsStrictly(): void {
  const files = readdirSync(resolve(directory, 'db/migrations')).sort();
  const numbers = new Set<string>();
  for (const file of files) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`Invalid migration filename: ${file}`);
    const number = file.slice(0, 4);
    if (numbers.has(number)) throw new Error(`Duplicate migration number: ${number}`);
    numbers.add(number);
    const source = readFileSync(resolve(directory, 'db/migrations', file), 'utf8');
    if (
      (source.match(/^-- migrate:up$/gm) ?? []).length !== 1 ||
      (source.match(/^-- migrate:down$/gm) ?? []).length !== 1
    ) {
      throw new Error(`Migration must contain exactly one up and down section: ${file}`);
    }
  }
}

export function migrate(url: string): void {
  validateMigrationsStrictly();
  command(resolve(directory, 'node_modules/.bin/dbmate'), [
    '--url',
    url,
    '--migrations-dir',
    'db/migrations',
    '--no-dump-schema',
    '--migration-lock',
    '--wait',
    'up',
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

function waitForPort(databasePort: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port: databasePort });
      socket.once('connect', () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > 60_000)
          reject(new Error('PostgreSQL did not accept TCP connections within 60 seconds'));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function up(): Promise<void> {
  const existing = docker(['ps', '-aq', '--filter', `name=^${container}$`]).trim();
  if (existing) {
    const running = docker(['inspect', '-f', '{{.State.Running}}', container]).trim();
    if (running === 'true') {
      await waitForPort(port);
    } else {
      docker(['start', container]);
      await waitForPort(port);
    }
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
    await waitForPort(port);
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
