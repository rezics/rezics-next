import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POSTGRES_IMAGE = 'postgres:19rc1@sha256:7c70c2455c1f22cf4fbf90b16345aa4e5f4e3efd68d68f7cd6d014f529a69108';
// src/events/effects.ts launches DBOS on this schema.
const DBOS_SCHEMA = 'dbos';
const container = 'rezics-kernel-dev';
const volume = 'rezics-kernel-dev';
const port = Number(process.env.KERNEL_DATABASE_PORT ?? '54329');

function command(
  program: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? directory,
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

function modules(root: string): string[] {
  const db = resolve(root, 'db');
  return readdirSync(db, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const migrations = resolve(db, entry.name, 'migrations');
      try {
        return statSync(migrations).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => {
      if (!/^[a-z][a-z0-9_]*$/.test(entry.name) || entry.name === 'migrations') {
        throw new Error(`Invalid database module name: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
}

export function moduleExtensionFiles(root = directory): string[] {
  return modules(root).flatMap((name) => {
    const relativeDirectory = `db/${name}/migrations`;
    return readdirSync(resolve(root, relativeDirectory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .filter((entry) =>
        /\bcreate\s+extension\b/i.test(
          readFileSync(resolve(root, relativeDirectory, entry.name), 'utf8').replace(/--[^\r\n]*/g, ''),
        ),
      )
      .map((entry) => `${relativeDirectory}/${entry.name}`);
  });
}

export function migrate(url: string, root = directory): void {
  const migrationDirectories = ['db/migrations', ...modules(root).map((name) => `db/${name}/migrations`)];
  command(
    resolve(directory, 'node_modules/.bin/dbmate'),
    [
      '--url',
      url,
      ...migrationDirectories.flatMap((path) => ['--migrations-dir', path]),
      '--no-dump-schema',
      '--migration-lock',
      '--wait',
      'up',
    ],
    { cwd: root },
  );
  command(process.execPath, [resolve(directory, 'node_modules/.bin/dbos'), 'schema', url, '--schema', DBOS_SCHEMA], {
    cwd: root,
  });
}

function schemaDumpWith(url: string, options: string[] = [], root = directory): string {
  const dump = command(
    'docker',
    [
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
      ...options,
      url,
    ],
    { cwd: root },
  );
  return dump
    .split('\n')
    .filter((line) => !/^\\(?:un)?restrict\b/.test(line) && !/^-- Dumped (?:from|by)\b/.test(line))
    .join('\n');
}

export function schemaDumps(url: string, root = directory): Record<string, string> {
  const moduleNames = modules(root);
  const dumps: Record<string, string> = {};
  dumps['db/schema.sql'] = schemaDumpWith(
    url,
    [...moduleNames, DBOS_SCHEMA].map((name) => `--exclude-schema=${name}`),
    root,
  );
  for (const name of moduleNames) {
    dumps[`db/${name}/schema.sql`] = schemaDumpWith(url, [`--schema=${name}`], root);
  }
  return dumps;
}

export function schemaDump(url: string, root = directory): string {
  return schemaDumpWith(
    url,
    [...modules(root), DBOS_SCHEMA].map((name) => `--exclude-schema=${name}`),
    root,
  );
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
    for (const [path, dump] of Object.entries(schemaDumps(url))) {
      await Bun.write(resolve(directory, path), dump);
    }
  } else throw new Error(`Unknown database action: ${action}`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
